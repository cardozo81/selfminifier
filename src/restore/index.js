import { lstat, readFile, readdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { OUTPUT_MODES } from '../domain/index.js';
import { assertPathHasNoLinks, hashFileSha256, readBackupManifest, readTechnicalState, writeTechnicalState } from '../integrity/index.js';
import { readJsonUtf8, writeJsonUtf8Atomic } from '../integrity/json-store.js';
import { inspectRegularFile, createNewFileExact, createValidatedRecoveryCopy, removeExactFile, replaceFileExact } from '../execution/filesystem.js';
import { readExecutionJournal, writeExecutionJournal } from '../execution/journal.js';
import { recoverInterruptedExecution } from '../execution/recovery.js';
import { resolveRuntimePaths } from '../runtime/paths.js';

export class RestoreError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = 'RestoreError'; this.code = code; this.details = details; }
}

function fail(code, message, details = {}) { throw new RestoreError(code, message, details); }
function identity(value) { return process.platform === 'win32' ? value.toLowerCase() : value; }
function isInside(rootPath, candidatePath) {
  const value = relative(rootPath, candidatePath);
  return value === '' || (!value.startsWith(`..${sep}`) && value !== '..' && !isAbsolute(value));
}
function freeze(value) { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); Object.values(value).forEach(freeze); } return value; }

async function readState(path) {
  try { return await readTechnicalState(path); }
  catch (error) { if (error?.details?.cause?.code === 'ENOENT') return { formatVersion: 1, records: [] }; throw error; }
}
function stateRecord(state, sourcePath) { return state.records.find((record) => identity(record.sourcePath) === identity(sourcePath)); }
function withoutStateRecord(state, sourcePath) { return { ...state, records: state.records.filter((record) => identity(record.sourcePath) !== identity(sourcePath)) }; }

function validateRestoreJournal(value) {
  const statuses = new Set(['planned', 'running', 'completed', 'cancelled', 'rolled-back', 'recovery-required']);
  if (!value || value.formatVersion !== 1 || typeof value.restoreId !== 'string' || !['backup', 'last-min'].includes(value.kind) || !statuses.has(value.status) || !Array.isArray(value.items) || !value.stateBefore) {
    fail('INVALID_RESTORE_JOURNAL', 'O journal da restauração manual é inválido ou incompleto.');
  }
  for (const item of value.items) if (!item || typeof item.id !== 'string' || typeof item.status !== 'string' || typeof item.path !== 'string') fail('INVALID_RESTORE_JOURNAL', 'O journal da restauração contém item inválido.');
  return value;
}

async function safetyGate(runtimePaths) {
  await recoverInterruptedExecution(runtimePaths.lastExecutionJournal);
  try {
    const restore = validateRestoreJournal(await readJsonUtf8(runtimePaths.manualRestoreJournal, 'MANUAL_RESTORE'));
    if (!['completed', 'cancelled', 'rolled-back'].includes(restore.status)) fail('RESTORE_RECOVERY_REQUIRED', 'Uma restauração manual anterior está incompleta e exige recuperação comprovada.', { restore });
  } catch (error) {
    if (error?.code !== 'MANUAL_RESTORE_READ_FAILED' || error?.details?.cause?.code !== 'ENOENT') throw error;
  }
}

export async function listKnownBackups(projectRoot = process.cwd()) {
  const root = resolve(projectRoot, '_source_versions');
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const known = [];
  for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const directory = join(root, entry.name);
    try {
      const plan = await createBackupRestorePlan({ projectRoot, backupDirectory: directory, skipGate: true });
      known.push({ executionId: plan.sourceExecutionId, directory, files: plan.items.length, status: 'valid' });
    } catch (error) {
      known.push({ executionId: entry.name, directory, files: 0, status: 'invalid', diagnostic: { code: error.code, message: error.message } });
    }
  }
  return known;
}

export async function createBackupRestorePlan({ projectRoot = process.cwd(), backupDirectory, skipGate = false }) {
  const runtimePaths = resolveRuntimePaths(projectRoot);
  if (!skipGate) await safetyGate(runtimePaths);
  const directory = normalize(resolve(backupDirectory));
  await assertPathHasNoLinks(directory);
  const manifest = await readBackupManifest(join(directory, 'manifest.json'));
  if (manifest.executionId !== basename(directory)) fail('BACKUP_DIRECTORY_MISMATCH', 'A pasta selecionada não corresponde ao ID registrado no manifesto.');
  const state = await readState(runtimePaths.technicalState);
  const backupRoot = dirname(directory);
  const origins = new Map(manifest.origins.map((origin) => [origin.originId, normalize(resolve(origin.rootPath))]));
  const items = [];
  for (let index = 0; index < manifest.files.length; index += 1) {
    const entry = manifest.files[index];
    if (!entry.minifiedSha256) fail('INVALID_MANIFEST', 'O manifesto não registra o SHA-256 minificado necessário à restauração.');
    const backupPath = normalize(resolve(backupRoot, entry.backupRelativePath));
    if (!isInside(directory, backupPath)) fail('INVALID_BACKUP_MAPPING', 'O arquivo de backup não permanece na pasta da execução.', { backupPath });
    await assertPathHasNoLinks(backupPath);
    const backup = await inspectRegularFile(backupPath);
    if (!backup.exists || backup.hash !== entry.originalSha256) fail('BACKUP_HASH_MISMATCH', `O backup falhou na validação SHA-256: ${backupPath}.`);
    const origin = origins.get(entry.originId);
    const originalPath = normalize(resolve(entry.originalPath));
    if (!origin || !(originalPath === origin || isInside(origin, originalPath))) fail('INVALID_ORIGINAL_MAPPING', `O destino original não corresponde à origem do manifesto: ${originalPath}.`);
    await assertPathHasNoLinks(originalPath, { allowMissing: true });
    const record = stateRecord(state, originalPath);
    if (!record || record.sourceHash !== entry.originalSha256 || record.minifiedHash !== entry.minifiedSha256 || record.outputMode !== OUTPUT_MODES.BACKUP_OVERWRITE) {
      fail('STATE_MANIFEST_MISMATCH', `O estado técnico não comprova o backup selecionado: ${originalPath}.`);
    }
    const current = await inspectRegularFile(originalPath);
    const classification = !current.exists ? 'missing-current' : (current.hash === entry.minifiedSha256 ? 'unchanged-minified' : 'changed-after-minification');
    items.push({ id: `restore-${String(index + 1).padStart(3, '0')}`, operation: 'restore-source', sourcePath: originalPath, destinationPath: originalPath, backupPath, backupHash: entry.originalSha256, currentHash: current.hash, currentExists: current.exists, classification, requiresChangedConfirmation: classification !== 'unchanged-minified', fileType: originalPath.toLowerCase().endsWith('.css') ? 'css' : 'javascript', sourceSize: entry.originalSize });
  }
  return freeze({ formatVersion: 1, kind: 'backup', restoreId: `restore-${Date.now()}`, sourceExecutionId: manifest.executionId, outputMode: OUTPUT_MODES.BACKUP_OVERWRITE, profile: manifest.files[0]?.profile ?? null, engine: { id: manifest.files[0]?.engine ?? null, version: manifest.files[0]?.engineVersion ?? null }, backupRoot: directory, runtimePaths, stateBefore: structuredClone(state), items, ignored: [], diagnostics: { errors: [], blockers: [] }, status: 'ready' });
}

export async function createLastMinRestorePlan({ projectRoot = process.cwd() } = {}) {
  const runtimePaths = resolveRuntimePaths(projectRoot);
  await safetyGate(runtimePaths);
  const journal = await readExecutionJournal(runtimePaths.lastExecutionJournal);
  if (!journal || journal.status !== 'completed' || journal.outputMode !== OUTPUT_MODES.PRESERVE_AND_CREATE_MINIFIED) fail('LAST_MIN_EXECUTION_UNAVAILABLE', 'Não há última execução .min concluída disponível para restauração.');
  const state = await readState(runtimePaths.technicalState);
  const items = [];
  const ignored = [];
  for (const journalItem of journal.items) {
    if (journalItem.operation !== 'create-output') {
      ignored.push({ id: journalItem.id, normalizedPath: journalItem.destinationPath, status: 'ignored', reason: 'PREEXISTING_MIN_NOT_RESTORED', fileType: journalItem.destinationPath.toLowerCase().endsWith('.css') ? 'css' : 'javascript' });
      continue;
    }
    const current = await inspectRegularFile(journalItem.destinationPath);
    const classification = !current.exists ? 'already-absent' : (current.hash === journalItem.expectedOutputHash ? 'eligible-delete' : 'changed-after-creation');
    items.push({ id: journalItem.id, operation: 'delete-created-min', sourcePath: journalItem.sourcePath, destinationPath: journalItem.destinationPath, expectedHash: journalItem.expectedOutputHash, currentHash: current.hash, currentExists: current.exists, classification, requiresChangedConfirmation: classification === 'changed-after-creation', fileType: journalItem.destinationPath.toLowerCase().endsWith('.css') ? 'css' : 'javascript', sourceSize: current.size });
  }
  return freeze({ formatVersion: 1, kind: 'last-min', restoreId: `restore-${Date.now()}`, sourceExecutionId: journal.executionId, outputMode: journal.outputMode, profile: state.records.find((record) => record.outputMode === journal.outputMode)?.profile ?? null, engine: { id: state.records.find((record) => record.outputMode === journal.outputMode)?.engine ?? null, version: state.records.find((record) => record.outputMode === journal.outputMode)?.engineVersion ?? null }, backupRoot: null, runtimePaths, stateBefore: structuredClone(state), items, ignored, diagnostics: { errors: [], blockers: [] }, status: 'ready' });
}

async function writeRestoreJournal(plan, status, items) {
  const journal = validateRestoreJournal({ formatVersion: 1, restoreId: plan.restoreId, kind: plan.kind, sourceExecutionId: plan.sourceExecutionId, status, stateBefore: plan.stateBefore, items });
  await writeJsonUtf8Atomic(plan.runtimePaths.manualRestoreJournal, journal, 'MANUAL_RESTORE');
  return journal;
}

async function annotateLastExecution(plan, resultItems) {
  const journal = await readExecutionJournal(plan.runtimePaths.lastExecutionJournal);
  if (!journal || journal.executionId !== plan.sourceExecutionId) return;
  for (const result of resultItems) {
    if (!['restored', 'deleted-min', 'already-absent'].includes(result.status)) continue;
    const planned = plan.items.find((candidate) => candidate.id === result.id);
    const item = journal.items.find((candidate) => candidate.id === result.id || (planned && identity(candidate.sourcePath) === identity(planned.sourcePath)));
    if (item) item.manualRestoreStatus = result.status === 'restored' ? 'restored-source' : result.status;
  }
  await writeExecutionJournal(plan.runtimePaths.lastExecutionJournal, journal);
}

export async function executeRestorePlan(plan, { confirmed = false, confirmChanged = false } = {}, dependencies = {}) {
  if (confirmed !== true) return { status: 'cancelled', items: plan.items.map((item) => ({ id: item.id, status: 'skipped-by-user', reason: 'RESTORE_CONFIRMATION_DENIED' })) };
  await safetyGate(plan.runtimePaths);
  const mutableItems = plan.items.map((item) => ({ id: item.id, status: 'planned', operation: item.operation, path: item.destinationPath }));
  await writeRestoreJournal(plan, 'planned', mutableItems);
  let state = structuredClone(plan.stateBefore);
  const recoveryCopies = [];
  let activeItem = null;
  try {
    await writeRestoreJournal(plan, 'running', mutableItems);
    for (let index = 0; index < plan.items.length; index += 1) {
      const item = plan.items[index];
      activeItem = item;
      const tracked = mutableItems[index];
      if (item.requiresChangedConfirmation && confirmChanged !== true) { tracked.status = 'skipped-by-user'; tracked.reason = item.classification; await writeRestoreJournal(plan, 'running', mutableItems); continue; }
      const current = await inspectRegularFile(item.destinationPath);
      if (current.exists !== item.currentExists || current.hash !== item.currentHash) fail('RESTORE_TARGET_CHANGED', `O destino mudou após o plano: ${item.destinationPath}.`);
      if (item.operation === 'restore-source') {
        if (await hashFileSha256(item.backupPath) !== item.backupHash) fail('BACKUP_HASH_MISMATCH', `O backup mudou após o plano: ${item.backupPath}.`);
        const content = await readFile(item.backupPath);
        tracked.status = 'mutation-intent'; await writeRestoreJournal(plan, 'running', mutableItems);
        if (current.exists) await replaceFileExact(item.destinationPath, content, item.currentHash, item.backupHash);
        else await createNewFileExact(item.destinationPath, content, item.backupHash);
        tracked.status = 'restored';
      } else if (item.classification === 'already-absent') {
        tracked.status = 'already-absent';
      } else {
        const recoveryPath = join(plan.runtimePaths.recoveryDirectory, plan.restoreId, item.id, 'saida-removida.bkp');
        recoveryCopies.push({ item, recovery: await createValidatedRecoveryCopy(item.destinationPath, recoveryPath) });
        tracked.status = 'mutation-intent'; await writeRestoreJournal(plan, 'running', mutableItems);
        if (!await removeExactFile(item.destinationPath, item.currentHash)) fail('RESTORE_TARGET_CHANGED', `A saída .min mudou antes da exclusão: ${item.destinationPath}.`);
        tracked.status = 'deleted-min';
      }
      state = withoutStateRecord(state, item.sourcePath);
      await writeTechnicalState(state, plan.runtimePaths.technicalState);
      await dependencies.afterItem?.({ item, index });
      await writeRestoreJournal(plan, 'running', mutableItems);
    }
    await annotateLastExecution(plan, mutableItems);
    const status = mutableItems.some((item) => item.status === 'skipped-by-user') ? 'completed-with-skips' : 'completed';
    await writeRestoreJournal(plan, 'completed', mutableItems);
    return { status, items: mutableItems };
  } catch (error) {
    let rollbackSafe = plan.kind === 'last-min';
    if (rollbackSafe) {
      for (const copy of [...recoveryCopies].reverse()) {
        const current = await inspectRegularFile(copy.item.destinationPath);
        if (current.exists) { rollbackSafe = false; break; }
        const content = await readFile(copy.recovery.path);
        try { await createNewFileExact(copy.item.destinationPath, content, copy.recovery.hash); } catch { rollbackSafe = false; break; }
        const tracked = mutableItems.find((item) => item.id === copy.item.id);
        if (tracked) tracked.status = 'rolled-back';
      }
      if (rollbackSafe) await writeTechnicalState(plan.stateBefore, plan.runtimePaths.technicalState).catch(() => { rollbackSafe = false; });
    }
    const status = rollbackSafe ? 'rolled-back' : 'recovery-required';
    await writeRestoreJournal(plan, status, mutableItems);
    const causeCode = error?.code ?? error?.name ?? 'RESTORE_INTERNAL_FAILURE';
    const causeMessage = error?.message ?? 'Falha interna sem mensagem disponível.';
    throw new RestoreError(
      status === 'recovery-required' ? 'RESTORE_RECOVERY_REQUIRED' : 'RESTORE_FAILED_ROLLED_BACK',
      `A restauração falhou e terminou em ${status}. Causa: ${causeCode}: ${causeMessage}`,
      {
        cause: error,
        causeCode,
        causeMessage,
        failedItem: activeItem ? {
          id: activeItem.id,
          operation: activeItem.operation,
          destinationPath: activeItem.destinationPath,
        } : null,
        items: mutableItems,
      },
    );
  }
}
