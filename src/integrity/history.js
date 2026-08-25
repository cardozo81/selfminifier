import { randomBytes, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, readdir, rm } from 'node:fs/promises';
import { basename, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { OUTPUT_MODES } from '../domain/index.js';
import { resolveRuntimePaths } from '../runtime/paths.js';
import { assertPathHasNoLinks } from './backup.js';
import { IntegrityError } from './errors.js';
import { hashContentSha256, hashFileSha256 } from './hash.js';
import { readJsonUtf8, writeJsonUtf8Atomic } from './json-store.js';
import { SHA256_PATTERN, requireObject } from './schema.js';

export const ARTIFACT_ID_PATTERN = /^[A-F0-9]{24}$/;
const SAFE_EXECUTION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const HISTORY_TEMPORARY_FILE = /^\.history-write-[A-Za-z0-9.-]+\.tmp$/;

function requireSafeExecutionId(executionId) {
  if (typeof executionId !== 'string' || !SAFE_EXECUTION_ID.test(executionId) || executionId === '.' || executionId === '..') {
    throw new IntegrityError('INVALID_HISTORY_EXECUTION_ID', 'O executionId não é seguro para uso no histórico persistente.');
  }
}

function isInside(rootPath, candidatePath) {
  const relativePath = relative(rootPath, candidatePath);
  return relativePath === '' || (!isAbsolute(relativePath) && relativePath !== '..' && !relativePath.startsWith(`..${sep}`));
}

function validateBackupProvenance(backup, label) {
  requireObject(backup, 'INVALID_HISTORY_RECORD', label);
  if (typeof backup.available !== 'boolean') throw new IntegrityError('INVALID_HISTORY_RECORD', `${label}.available deve ser booleano.`);
  if (backup.compression !== 'none') throw new IntegrityError('INVALID_HISTORY_RECORD', `${label}.compression deve ser none nesta versão.`);
  if (backup.available) {
    if (typeof backup.backupRoot !== 'string' || !isAbsolute(backup.backupRoot)) throw new IntegrityError('INVALID_HISTORY_RECORD', `${label}.backupRoot deve ser um caminho absoluto.`);
    if (typeof backup.backupRelativePath !== 'string' || !backup.backupRelativePath || isAbsolute(backup.backupRelativePath)
      || backup.backupRelativePath.split(/[\\/]+/).some((part) => part === '..')) {
      throw new IntegrityError('INVALID_HISTORY_RECORD', `${label}.backupRelativePath deve permanecer relativo à área de backup.`);
    }
    if (!SHA256_PATTERN.test(backup.originalHash)) throw new IntegrityError('INVALID_HISTORY_RECORD', `${label}.originalHash deve ser SHA-256 hexadecimal minúsculo.`);
    return;
  }
  if (backup.backupRoot !== null || backup.backupRelativePath !== null || backup.originalHash !== null) {
    throw new IntegrityError('INVALID_HISTORY_RECORD', `${label} não pode afirmar payload de backup quando available=false.`);
  }
}

export function generateArtifactId(randomBytesFunction = randomBytes) {
  const bytes = randomBytesFunction(12);
  if (!Buffer.isBuffer(bytes) || bytes.length !== 12) {
    throw new IntegrityError('ARTIFACT_ID_GENERATION_FAILED', 'A fonte criptográfica não produziu os 96 bits exigidos para artifactId.');
  }
  return bytes.toString('hex').toUpperCase();
}

export function validateHistoricalExecutionRecord(record) {
  requireObject(record, 'INVALID_HISTORY_RECORD', 'Registro histórico');
  if (record.formatVersion !== 1) throw new IntegrityError('INVALID_HISTORY_RECORD', 'A versão do formato do histórico não é suportada.');
  requireSafeExecutionId(record.executionId);
  if (record.meminifyVersion !== null && typeof record.meminifyVersion !== 'string') throw new IntegrityError('INVALID_HISTORY_RECORD', 'Registro histórico.meminifyVersion deve ser texto ou null.');
  for (const field of ['timestamp', 'outputMode', 'projectRoot']) {
    if (typeof record[field] !== 'string' || !record[field]) throw new IntegrityError('INVALID_HISTORY_RECORD', `Registro histórico.${field} deve ser texto não vazio.`);
  }
  if (!Object.values(OUTPUT_MODES).includes(record.outputMode)) throw new IntegrityError('INVALID_HISTORY_RECORD', 'Registro histórico.outputMode não é homologado.');
  if (!isAbsolute(record.projectRoot)) throw new IntegrityError('INVALID_HISTORY_RECORD', 'Registro histórico.projectRoot deve ser absoluto.');
  if (!Array.isArray(record.artifacts)) throw new IntegrityError('INVALID_HISTORY_RECORD', 'Registro histórico.artifacts deve ser uma lista.');
  const artifactIds = new Set();
  record.artifacts.forEach((artifact, index) => {
    const label = `Registro histórico.artifacts[${index}]`;
    requireObject(artifact, 'INVALID_HISTORY_RECORD', label);
    if (!ARTIFACT_ID_PATTERN.test(artifact.artifactId)) throw new IntegrityError('INVALID_HISTORY_RECORD', `${label}.artifactId deve conter 24 caracteres hexadecimais maiúsculos.`);
    if (artifactIds.has(artifact.artifactId)) throw new IntegrityError('INVALID_HISTORY_RECORD', `artifactId duplicado no registro histórico: ${artifact.artifactId}.`);
    artifactIds.add(artifact.artifactId);
    for (const field of ['sourcePath', 'outputPath', 'engine', 'engineVersion', 'profile', 'outputMode', 'timestamp']) {
      if (typeof artifact[field] !== 'string' || !artifact[field]) throw new IntegrityError('INVALID_HISTORY_RECORD', `${label}.${field} deve ser texto não vazio.`);
    }
    if (!isAbsolute(artifact.sourcePath) || !isAbsolute(artifact.outputPath)) throw new IntegrityError('INVALID_HISTORY_RECORD', `${label} deve conter caminhos absolutos de origem e saída.`);
    if (!SHA256_PATTERN.test(artifact.inputHash) || !SHA256_PATTERN.test(artifact.outputHash)) throw new IntegrityError('INVALID_HISTORY_RECORD', `${label} deve conter hashes SHA-256 válidos.`);
    for (const field of ['sourceSize', 'outputSize']) {
      if (!Number.isSafeInteger(artifact[field]) || artifact[field] < 0) throw new IntegrityError('INVALID_HISTORY_RECORD', `${label}.${field} deve ser inteiro não negativo.`);
    }
    if (artifact.outputMode !== record.outputMode) throw new IntegrityError('INVALID_HISTORY_RECORD', `${label}.outputMode diverge do modo da execução.`);
    validateBackupProvenance(artifact.backup, `${label}.backup`);
  });
  return record;
}

export function createHistoricalExecutionRecord(input) {
  return validateHistoricalExecutionRecord({
    formatVersion: 1,
    executionId: input.executionId,
    meminifyVersion: input.meminifyVersion ?? null,
    timestamp: input.timestamp,
    outputMode: input.outputMode,
    projectRoot: normalize(resolve(input.projectRoot)),
    artifacts: input.artifacts ?? [],
  });
}

export function historicalExecutionRecordHash(record) {
  validateHistoricalExecutionRecord(record);
  return hashContentSha256(`${JSON.stringify(record, null, 2)}\n`);
}

export function resolveHistoricalExecutionPath(historyDirectory, executionId) {
  requireSafeExecutionId(executionId);
  const normalizedDirectory = normalize(resolve(historyDirectory));
  const recordPath = normalize(resolve(normalizedDirectory, `${executionId}.json`));
  if (!isInside(normalizedDirectory, recordPath)) throw new IntegrityError('HISTORY_PATH_ESCAPE', 'O caminho do histórico escaparia de Dados\\Historico.');
  return recordPath;
}

async function ensureSafeHistoryDirectory(historyDirectory, { create = false } = {}) {
  const normalizedDirectory = normalize(resolve(historyDirectory));
  await assertPathHasNoLinks(normalizedDirectory, { allowMissing: true });
  if (create) await mkdir(normalizedDirectory, { recursive: true });
  let stats;
  try { stats = await lstat(normalizedDirectory); } catch (cause) {
    if (!create && cause?.code === 'ENOENT') return null;
    throw new IntegrityError('HISTORY_DIRECTORY_ACCESS_FAILED', `Não foi possível acessar o diretório histórico: ${normalizedDirectory}.`, { cause });
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new IntegrityError('UNSAFE_HISTORY_DIRECTORY', 'Dados\\Historico deve ser um diretório físico seguro.');
  await assertPathHasNoLinks(normalizedDirectory);
  return normalizedDirectory;
}

export async function assertHistoricalExecutionWritable(historyDirectory, executionId) {
  const normalizedDirectory = await ensureSafeHistoryDirectory(historyDirectory, { create: true });
  const recordPath = resolveHistoricalExecutionPath(normalizedDirectory, executionId);
  try {
    const stats = await lstat(recordPath);
    throw new IntegrityError(
      stats.isFile() && !stats.isSymbolicLink() ? 'HISTORY_RECORD_COLLISION' : 'UNSAFE_HISTORY_RECORD',
      `Já existe uma entrada no caminho histórico reservado: ${recordPath}.`,
    );
  } catch (cause) {
    if (cause?.code === 'ENOENT') return recordPath;
    throw cause;
  }
}

export async function writeHistoricalExecutionRecord(historyDirectory, record) {
  validateHistoricalExecutionRecord(record);
  const recordPath = await assertHistoricalExecutionWritable(historyDirectory, record.executionId);
  for (const artifact of record.artifacts) {
    const existing = await findHistoricalArtifact(historyDirectory, artifact.artifactId);
    if (existing) {
      throw new IntegrityError('HISTORY_ARTIFACT_ID_COLLISION', `O artifactId ${artifact.artifactId} já pertence a outro registro histórico.`);
    }
  }
  const temporaryPath = join(normalize(resolve(historyDirectory)), `.history-write-${randomUUID()}.tmp`);
  try {
    await writeJsonUtf8Atomic(temporaryPath, record, 'HISTORY_RECORD');
    try {
      await link(temporaryPath, recordPath);
    } catch (cause) {
      const code = cause?.code === 'EEXIST' ? 'HISTORY_RECORD_COLLISION' : 'HISTORY_RECORD_WRITE_FAILED';
      throw new IntegrityError(code, `Não foi possível criar o registro histórico imutável: ${recordPath}.`, { cause, recordPath });
    }
    const persisted = await readHistoricalExecutionRecord(historyDirectory, record.executionId);
    const expectedHash = historicalExecutionRecordHash(record);
    const actualHash = await hashFileSha256(recordPath);
    if (JSON.stringify(persisted) !== JSON.stringify(record) || actualHash !== expectedHash) {
      throw new IntegrityError('HISTORY_RECORD_VERIFICATION_FAILED', 'O registro histórico persistido não corresponde ao conteúdo esperado.', { recordPath });
    }
    return { path: recordPath, hash: actualHash, record: persisted };
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => {});
  }
}

export async function readHistoricalExecutionRecord(historyDirectory, executionId) {
  const normalizedDirectory = await ensureSafeHistoryDirectory(historyDirectory);
  if (!normalizedDirectory) throw new IntegrityError('HISTORY_RECORD_READ_FAILED', 'O diretório histórico não existe.');
  const recordPath = resolveHistoricalExecutionPath(normalizedDirectory, executionId);
  await assertPathHasNoLinks(recordPath);
  const stats = await lstat(recordPath).catch((cause) => {
    throw new IntegrityError('HISTORY_RECORD_READ_FAILED', `Não foi possível acessar o registro histórico: ${recordPath}.`, { cause });
  });
  if (!stats.isFile() || stats.isSymbolicLink()) throw new IntegrityError('UNSAFE_HISTORY_RECORD', `O registro histórico não é um arquivo físico regular: ${recordPath}.`);
  const record = validateHistoricalExecutionRecord(await readJsonUtf8(recordPath, 'HISTORY_RECORD'));
  if (record.executionId !== executionId) throw new IntegrityError('HISTORY_RECORD_ID_MISMATCH', 'O executionId interno diverge do nome do registro histórico.');
  return record;
}

export async function listHistoricalExecutionRecords(historyDirectory = resolveRuntimePaths().historyDirectory) {
  const normalizedDirectory = await ensureSafeHistoryDirectory(historyDirectory);
  if (!normalizedDirectory) return [];
  const entries = await readdir(normalizedDirectory, { withFileTypes: true });
  const executionIds = [];
  for (const entry of entries) {
    if (entry.isFile() && HISTORY_TEMPORARY_FILE.test(entry.name)) continue;
    if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith('.json')) {
      throw new IntegrityError('UNSAFE_HISTORY_ENTRY', `Dados\\Historico contém uma entrada não reconhecida: ${entry.name}.`);
    }
    const executionId = basename(entry.name, '.json');
    requireSafeExecutionId(executionId);
    executionIds.push(executionId);
  }
  executionIds.sort((left, right) => left.localeCompare(right));
  const records = [];
  const artifactIds = new Set();
  for (const executionId of executionIds) {
    const record = await readHistoricalExecutionRecord(normalizedDirectory, executionId);
    for (const artifact of record.artifacts) {
      if (artifactIds.has(artifact.artifactId)) {
        throw new IntegrityError('DUPLICATE_HISTORICAL_ARTIFACT_ID', `O artifactId ${artifact.artifactId} aparece em mais de um registro histórico.`);
      }
      artifactIds.add(artifact.artifactId);
    }
    records.push(record);
  }
  return records;
}

export async function findHistoricalArtifact(historyDirectory, artifactId) {
  if (!ARTIFACT_ID_PATTERN.test(artifactId)) throw new IntegrityError('INVALID_ARTIFACT_ID', 'O artifactId pesquisado é inválido.');
  let match = null;
  for (const execution of await listHistoricalExecutionRecords(historyDirectory)) {
    for (const artifact of execution.artifacts) {
      if (artifact.artifactId !== artifactId) continue;
      if (match) throw new IntegrityError('DUPLICATE_HISTORICAL_ARTIFACT_ID', `O artifactId ${artifactId} aparece em mais de um registro histórico.`);
      match = { execution, artifact };
    }
  }
  return match;
}
