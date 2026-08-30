import { access } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import {
  deriveEffectiveConfiguration,
  loadConfiguration,
  resolveEffectiveBackupRoot,
  validateExternalBackupRoot,
  validateV2Configuration,
  validateV3Configuration,
  writeV2Configuration,
  writeV3Configuration,
} from '../configuration/index.js';
import { DEFAULT_OUTPUT_MODE, OUTPUT_MODES, PROFILES, V2_DEFAULT_FILE_TYPES } from '../domain/index.js';
import { assertPhysicalPath } from '../integrity/index.js';
import { createDefaultMinifierRegistry } from '../minifiers/index.js';
import { createExecutionPlan, executePlan, ExecutionError } from '../execution/index.js';
import { listArtifacts, readArtifact, writeOperationalReports, writeTechnicalLog } from '../observability/index.mjs';
import { executeArtifactCleanup, previewArtifactCleanup } from '../observability/cleanup.js';
import { measureStorageDirectory, STORAGE_STATES, summarizeStorageUsage } from '../observability/storage.js';
import { createBackupRestorePlan, createLastMinRestorePlan, executeRestorePlan, listKnownBackups } from '../restore/index.js';
import {
  inspectHistoricalArtifact,
  recoverHistoricalOriginal,
  searchHistoryByPath,
  searchHistoryByTag,
} from '../history/index.js';
import { resolveApplicationPaths, resolveApplicationRoot, resolveRuntimePaths } from '../runtime/paths.js';
import { buildAnalysis } from '../scanner/index.js';
import { loadApplicationMetadata } from '../runtime/version.js';

function paths(projectRoot) {
  return resolveApplicationPaths(projectRoot);
}

async function exists(filePath) {
  try { await access(filePath, constants.F_OK); return true; } catch { return false; }
}

function diagnostic(error) {
  return {
    code: error?.code ?? 'BRIDGE_ERROR',
    message: error?.message ?? 'A operação não pôde ser concluída.',
    details: error?.details ?? {},
  };
}

async function loadPersistent(projectRoot) {
  const filePaths = paths(projectRoot);
  if (!await exists(filePaths.configuration)) {
    return { ok: false, code: 'CONFIGURATION_MISSING', configurationPath: filePaths.configuration, examplePath: filePaths.example, projectRoot: filePaths.root };
  }
  try {
    const registry = createDefaultMinifierRegistry();
    const allowedEngines = new Set(registry.list().map((item) => item.id));
    const loaded = await loadConfiguration(filePaths.configuration, { allowedEngines });
    return {
      ok: true,
      schema: loaded.schema.kind,
      configuration: loaded.configuration,
      configurationPath: filePaths.configuration,
      examplePath: filePaths.example,
      projectRoot: filePaths.root,
    };
  } catch (error) {
    return { ok: false, configurationPath: filePaths.configuration, examplePath: filePaths.example, projectRoot: filePaths.root, diagnostic: diagnostic(error) };
  }
}

function summarizePlan(plan) {
  const summary = {
    formatVersion: plan.formatVersion,
    configurationSchemaVersion: plan.configurationSchemaVersion,
    executionId: plan.executionId,
    status: plan.status,
    outputMode: plan.outputMode,
    profile: plan.profile,
    profileRisk: plan.profileRisk,
    executionRisk: plan.executionRisk,
    scope: plan.scope,
    engine: plan.engine,
    sources: plan.sources,
    counts: { found: plan.items.length + plan.ignored.length, eligible: plan.items.length, ignored: plan.ignored.length },
    items: plan.items,
    ignored: plan.ignored,
    conflicts: plan.conflicts,
    conflictPolicy: plan.conflictPolicy,
    diagnostics: plan.diagnostics,
    requiredConfirmations: plan.requiredConfirmations,
    backupRoot: plan.backupRoot,
    runtimePaths: plan.runtimePaths,
  };
  const { executionId: ignoredExecutionId, ...confirmable } = summary;
  return {
    ...summary,
    confirmationFingerprint: createHash('sha256').update(JSON.stringify(confirmable)).digest('hex'),
  };
}

function adjustmentsFrom(request) {
  return request.adjustments && typeof request.adjustments === 'object' ? request.adjustments : {};
}

async function persistArtifacts({ projectRoot, plan, result = null, resultStatus = null, error = null, startedAt, phases = [], applicationVersion }) {
  const artifacts = {};
  const failures = [];
  try {
    artifacts.reports = await writeOperationalReports({ projectRoot, plan, result, resultStatus, durationMs: Math.round(performance.now() - startedAt), applicationVersion });
  } catch (cause) { failures.push({ code: 'REPORT_WRITE_FAILED', message: cause.message }); }
  try {
    artifacts.log = await writeTechnicalLog({ projectRoot, executionId: plan.executionId, phases, result, error, technicalPaths: plan.runtimePaths, runtime: { node: process.version }, applicationVersion });
  } catch (cause) { failures.push({ code: 'LOG_WRITE_FAILED', message: cause.message }); }
  if (failures.length) artifacts.diagnostics = failures;
  return artifacts;
}

const STORAGE_CATEGORY_LABELS = Object.freeze({
  backups: 'Backups',
  history: 'Histórico',
  reports: 'Relatórios',
  logs: 'Logs técnicos',
});

function storageCategory(key, path, status, bytes, complete, extra = {}) {
  return Object.freeze({ key, label: STORAGE_CATEGORY_LABELS[key], path, status, bytes, complete, ...extra });
}

function hasNestedCode(error, code) {
  const seen = new Set();
  const pending = [error];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    if (current.code === code) return true;
    if (current.cause) pending.push(current.cause);
    if (current.details && typeof current.details === 'object') pending.push(current.details);
  }
  return false;
}

async function measureInternalCategory(directoryPath, memo) {
  try {
    const proof = await assertPhysicalPath(directoryPath, { requireDirectory: true, allowMissing: true, memo });
    if (!proof.exists) return { status: STORAGE_STATES.ABSENT, bytes: 0, complete: true };
  } catch {
    return { status: STORAGE_STATES.UNAVAILABLE, bytes: 0, complete: false };
  }
  return measureStorageDirectory(directoryPath);
}

async function measureBackupStorage(projectRoot, persistent) {
  const backupRoot = resolveApplicationPaths(projectRoot).backupRoot;
  const mode = persistent.ok && persistent.schema === 'v3' && persistent.configuration.backupRoot !== null
    ? 'external'
    : 'internal';
  if (mode === 'external') {
    let effectiveRoot;
    try {
      effectiveRoot = await resolveEffectiveBackupRoot(persistent.configuration, projectRoot);
    } catch {
      return { mode, path: backupRoot, status: STORAGE_STATES.UNAVAILABLE, bytes: 0, complete: false };
    }
    try {
      await validateExternalBackupRoot(effectiveRoot, persistent.configuration.projectRoot, { proveWritable: false });
    } catch (error) {
      const status = hasNestedCode(error, 'ENOENT') ? STORAGE_STATES.ABSENT : STORAGE_STATES.UNAVAILABLE;
      return { mode, path: effectiveRoot, status, bytes: 0, complete: status === STORAGE_STATES.ABSENT };
    }
    return { mode, path: effectiveRoot, ...(await measureStorageDirectory(effectiveRoot)) };
  }
  const measured = await measureInternalCategory(backupRoot, new Map());
  return { mode, path: backupRoot, ...measured };
}

async function storageUsage(projectRoot, persistent) {
  const runtime = resolveRuntimePaths(projectRoot);
  const memo = new Map();
  const reportsDirectory = join(resolve(projectRoot), 'Dados', 'Relatorios');
  const logsDirectory = join(resolve(projectRoot), 'Dados', 'Logs');
  const backups = await measureBackupStorage(projectRoot, persistent);
  const history = await measureInternalCategory(runtime.historyDirectory, memo);
  const reports = await measureInternalCategory(reportsDirectory, memo);
  const logs = await measureInternalCategory(logsDirectory, memo);
  const categories = [
    storageCategory('backups', backups.path, backups.status, backups.bytes, backups.complete, { mode: backups.mode }),
    storageCategory('history', runtime.historyDirectory, history.status, history.bytes, history.complete),
    storageCategory('reports', reportsDirectory, reports.status, reports.bytes, reports.complete),
    storageCategory('logs', logsDirectory, logs.status, logs.bytes, logs.complete),
  ];
  const summary = summarizeStorageUsage(categories);
  return Object.freeze({
    ok: true,
    categories,
    totalContabilizado: summary.totalContabilizado,
    complete: summary.complete,
  });
}

function summarizeHistoricalResult(command, result) {
  if (command === 'search-history-by-path') {
    return {
      order: result.order,
      recordCount: result.records?.length ?? 0,
      artifactIds: (result.records ?? []).map((record) => record.artifactId),
    };
  }
  if (command === 'inspect-historical-artifact') {
    return {
      artifactId: result.historical?.artifactId,
      executionId: result.historical?.executionId,
      currentIntegrity: result.observations?.currentIntegrity?.state,
      backupAvailability: result.observations?.backupAvailability?.state,
      recoveryCapability: result.observations?.recoveryCapability,
    };
  }
  if (command === 'recover-historical-original') {
    return {
      artifactId: result.artifactId,
      executionId: result.executionId,
      destinationPath: result.destinationPath,
      exportedHash: result.exportedHash,
      exportedSize: result.exportedSize,
      status: result.status,
    };
  }
  return { artifactId: result.artifactId, executionId: result.executionId };
}

async function runHistoricalOperation({ projectRoot, applicationVersion, command, requestSummary, action }) {
  const startedAt = performance.now();
  try {
    const result = await action();
    try {
      await writeTechnicalLog({
        projectRoot,
        executionId: result.executionId ?? result.historical?.executionId ?? ('history-' + command),
        phases: [{
          name: 'operação histórica',
          command,
          status: 'completed',
          durationMs: Math.round(performance.now() - startedAt),
          request: requestSummary,
        }],
        result: summarizeHistoricalResult(command, result),
        technicalPaths: resolveRuntimePaths(projectRoot),
        runtime: { node: process.version },
        applicationVersion,
      });
    } catch {
      // O logging é diagnóstico e não altera o contrato nem o resultado da operação histórica.
    }
    return { ok: true, result };
  } catch (error) {
    try {
      await writeTechnicalLog({
        projectRoot,
        executionId: 'history-' + command,
        phases: [{
          name: 'operação histórica',
          command,
          status: 'blocked',
          durationMs: Math.round(performance.now() - startedAt),
          code: error?.code ?? 'BRIDGE_ERROR',
          request: requestSummary,
        }],
        error,
        technicalPaths: resolveRuntimePaths(projectRoot),
        runtime: { node: process.version },
        applicationVersion,
      });
    } catch {
      // A falha ao registrar não mascara o diagnóstico funcional original.
    }
    return { ok: false, diagnostic: diagnostic(error) };
  }
}

async function createPlan(request, persistent, applicationVersion) {
  const registry = createDefaultMinifierRegistry();
  const adjustments = adjustmentsFrom(request);
  const allowedEngines = new Set(registry.list().map((item) => item.id));
  const effective = deriveEffectiveConfiguration(persistent.configuration, adjustments, { allowedEngines });
  const engineId = effective.engine;
  const backupRoot = effective.outputMode === OUTPUT_MODES.BACKUP_OVERWRITE
    ? await resolveEffectiveBackupRoot(effective, persistent.projectRoot, {
      validateExternal: true,
      proveWritable: true,
      prepareInternal: true,
    })
    : undefined;
  const plan = await createExecutionPlan({
    configuration: effective,
    minifier: registry.get(engineId),
    runtimeRoot: persistent.projectRoot,
    backupRoot,
    executionId: request.executionId ?? `exec-${Date.now()}`,
    meminifyVersion: applicationVersion,
  });
  return { plan, minifier: registry.get(engineId), effective };
}

const EDITABLE_V2_FIELDS = new Set(['projectRoot', 'fileTypes', 'ignoredFolders', 'ignoredFiles', 'profile']);

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function normalizePersistentConfiguration(configuration, schema, options) {
  return schema === 'v2'
    ? validateV2Configuration(configuration, options)
    : validateV3Configuration(configuration, options);
}

async function writePersistentConfiguration(filePath, configuration, schema, options) {
  return schema === 'v2'
    ? writeV2Configuration(filePath, configuration)
    : writeV3Configuration(filePath, configuration, options);
}

async function updateV2Configuration(request, persistent) {
  if (!persistent.ok) return { ok: false, ...persistent };

  const updates = {};
  for (const key of EDITABLE_V2_FIELDS) {
    if (Object.hasOwn(request, key)) updates[key] = request[key];
  }
  if (Object.keys(updates).length === 0) {
    return { ok: false, code: 'INVALID_UPDATE_REQUEST', message: 'Nenhum campo editável foi informado para atualização.' };
  }
  if (request.confirmed !== true) {
    return { ok: false, code: 'CONFIRMATION_REQUIRED', message: 'A alteração exige confirmação explícita.' };
  }

  const registry = createDefaultMinifierRegistry();
  const allowedEngines = new Set(registry.list().map((item) => item.id));
  const configurationPath = paths(persistent.projectRoot).configuration;
  let normalized;
  try {
    normalized = await normalizePersistentConfiguration(
      { ...persistent.configuration, ...updates },
      persistent.schema,
      { allowedEngines },
    );
  } catch (error) {
    return { ok: false, diagnostic: diagnostic(error), changed: false };
  }

  try {
    await writePersistentConfiguration(configurationPath, normalized, persistent.schema, { allowedEngines });
  } catch (error) {
    return { ok: false, diagnostic: diagnostic(error), changed: false };
  }

  const reloaded = await loadPersistent(persistent.projectRoot);
  if (!reloaded.ok || reloaded.schema !== persistent.schema) {
    return {
      ok: false,
      code: 'CONFIGURATION_RELOAD_FAILED',
      message: 'A configuração foi gravada, mas a releitura não pôde ser confirmada.',
      diagnostic: reloaded.diagnostic,
      configuration: reloaded.configuration ?? null,
      changed: true,
    };
  }

  const mismatches = [...EDITABLE_V2_FIELDS].filter((key) => (
    Object.hasOwn(updates, key) && !sameValue(normalized[key], reloaded.configuration[key])
  ));
  if (mismatches.length > 0) {
    return {
      ok: false,
      code: 'CONFIGURATION_RELOAD_MISMATCH',
      message: 'A configuração foi gravada, mas a releitura não confirmou os valores esperados.',
      configuration: reloaded.configuration,
      changed: true,
    };
  }

  return { ok: true, configuration: reloaded.configuration, updated: Object.keys(updates) };
}

const BACKUP_ROOT_PRESERVED_FIELDS = Object.freeze([
  'engine',
  'profile',
  'outputMode',
  'projectRoot',
  'fileTypes',
  'ignoredFolders',
  'ignoredFiles',
]);

async function updateBackupRoot(request, persistent) {
  if (!persistent.ok) return { ok: false, ...persistent };
  if (request.confirmed !== true) {
    return { ok: false, code: 'CONFIRMATION_REQUIRED', message: 'A alteração da pasta de backups exige confirmação explícita.' };
  }
  if (!Object.hasOwn(request, 'backupRoot')) {
    return { ok: false, code: 'INVALID_UPDATE_REQUEST', message: 'A alteração exige backupRoot explícito como caminho externo ou null.' };
  }
  const registry = createDefaultMinifierRegistry();
  const allowedEngines = new Set(registry.list().map((item) => item.id));
  const requestedBackupRoot = request.backupRoot === '' ? null : request.backupRoot;
  let normalized;
  try {
    normalized = await validateV3Configuration({
      ...persistent.configuration,
      schemaVersion: 3,
      backupRoot: requestedBackupRoot,
    }, { allowedEngines });
  } catch (error) {
    return { ok: false, diagnostic: diagnostic(error), changed: false };
  }
  const unrelatedMismatch = BACKUP_ROOT_PRESERVED_FIELDS.find((field) => (
    !sameValue(normalized[field], persistent.configuration[field])
  ));
  if (unrelatedMismatch) {
    return {
      ok: false,
      code: 'BACKUP_ROOT_UPDATE_SCOPE_MISMATCH',
      message: `A alteração de PastaBackups tentaria modificar o campo não relacionado '${unrelatedMismatch}'.`,
      changed: false,
    };
  }
  const configurationPath = paths(persistent.projectRoot).configuration;
  try {
    await writeV3Configuration(configurationPath, normalized, { allowedEngines });
  } catch (error) {
    return { ok: false, diagnostic: diagnostic(error), changed: false };
  }
  const reloaded = await loadPersistent(persistent.projectRoot);
  if (!reloaded.ok || reloaded.schema !== 'v3') {
    return {
      ok: false,
      code: 'CONFIGURATION_RELOAD_FAILED',
      message: 'A configuração V3 foi gravada, mas a releitura não pôde ser confirmada.',
      diagnostic: reloaded.diagnostic,
      changed: true,
    };
  }
  const mismatch = reloaded.configuration.schemaVersion !== 3
    || !sameValue(reloaded.configuration.backupRoot, normalized.backupRoot)
    || BACKUP_ROOT_PRESERVED_FIELDS.some((field) => !sameValue(reloaded.configuration[field], persistent.configuration[field]));
  if (mismatch) {
    return {
      ok: false,
      code: 'CONFIGURATION_RELOAD_MISMATCH',
      message: 'A releitura não confirmou PastaBackups e a preservação dos demais campos.',
      configuration: reloaded.configuration,
      changed: true,
    };
  }
  return {
    ok: true,
    configurationPath,
    configuration: reloaded.configuration,
    backupRoot: reloaded.configuration.backupRoot,
    backupStorageMode: reloaded.configuration.backupRoot === null ? 'internal' : 'external',
    migratedFromV2: persistent.schema === 'v2',
    updated: true,
  };
}

const DEFAULT_IGNORED_FOLDERS = Object.freeze(['node_modules', '.git', 'vendor']);

function buildInitialConfiguration(projectRoot) {
  const registry = createDefaultMinifierRegistry();
  const allowedEngines = new Set(registry.list().map((item) => item.id));
  const engineId = registry.list()[0].id;
  return validateV2Configuration({
    engine: engineId,
    profile: PROFILES.PADRAO,
    outputMode: DEFAULT_OUTPUT_MODE,
    projectRoot,
    fileTypes: V2_DEFAULT_FILE_TYPES,
    ignoredFolders: [...DEFAULT_IGNORED_FOLDERS],
    ignoredFiles: [],
  }, { allowedEngines });
}

async function createInitialConfiguration(request, projectRoot) {
  const filePaths = paths(projectRoot);
  if (await exists(filePaths.configuration)) {
    return { ok: false, code: 'CONFIGURATION_EXISTS', configurationPath: filePaths.configuration };
  }
  if (typeof request.projectRoot !== 'string' || request.projectRoot.trim() === '') {
    return { ok: false, code: 'PROJECT_ROOT_REQUIRED', message: 'Informe explicitamente a pasta raiz do projeto (PastaRaiz).' };
  }
  let normalized;
  try {
    normalized = buildInitialConfiguration(request.projectRoot);
  } catch (error) {
    return { ok: false, diagnostic: diagnostic(error) };
  }
  try {
    await assertPhysicalPath(normalized.projectRoot, { requireDirectory: true });
  } catch (error) {
    return { ok: false, diagnostic: diagnostic(error) };
  }
  if (request.confirmed !== true) {
    return { ok: true, preview: true, configuration: normalized, configurationPath: filePaths.configuration };
  }
  try {
    await writeV2Configuration(filePaths.configuration, normalized);
  } catch (error) {
    return { ok: false, diagnostic: diagnostic(error) };
  }
  const reloaded = await loadPersistent(projectRoot);
  if (!reloaded.ok || reloaded.schema !== 'v2') {
    return {
      ok: false,
      code: 'CONFIGURATION_RELOAD_FAILED',
      message: 'A configuração foi gravada, mas a releitura e a validação normais não puderam ser confirmadas.',
      diagnostic: reloaded.diagnostic,
      configurationPath: filePaths.configuration,
    };
  }
  if (JSON.stringify(normalized) !== JSON.stringify(reloaded.configuration)) {
    return {
      ok: false,
      code: 'CONFIGURATION_RELOAD_MISMATCH',
      message: 'A configuração gravada não corresponde aos valores normalizados esperados.',
      configurationPath: filePaths.configuration,
      configuration: reloaded.configuration,
    };
  }
  return {
    ok: true,
    created: true,
    configurationPath: filePaths.configuration,
    configuration: reloaded.configuration,
  };
}

export async function runBridgeRequest(request, { projectRoot } = {}) {
  if (request.command === 'cleanup-artifacts' && (typeof projectRoot !== 'string' || projectRoot.trim() === '')) {
    return { ok: false, diagnostic: { code: 'PROJECT_ROOT_REQUIRED', message: 'A limpeza de logs e relatórios exige uma pasta raiz explícita e válida.' } };
  }
  const application = await loadApplicationMetadata(projectRoot);
  if (request.command === 'version') return { ok: true, ...application };
  const persistent = await loadPersistent(projectRoot);
  if (request.command === 'search-history-by-tag') {
    return runHistoricalOperation({
      projectRoot,
      applicationVersion: application.version,
      command: request.command,
      requestSummary: { tag: request.tag ?? request.artifactId },
      action: () => searchHistoryByTag({ projectRoot, tag: request.tag ?? request.artifactId }),
    });
  }
  if (request.command === 'search-history-by-path') {
    return runHistoricalOperation({
      projectRoot,
      applicationVersion: application.version,
      command: request.command,
      requestSummary: { path: request.path, order: request.order ?? 'newest-first' },
      action: () => searchHistoryByPath({ projectRoot, filePath: request.path, order: request.order ?? 'newest-first' }),
    });
  }
  if (request.command === 'inspect-historical-artifact') {
    return runHistoricalOperation({
      projectRoot,
      applicationVersion: application.version,
      command: request.command,
      requestSummary: { artifactId: request.tag ?? request.artifactId, currentPath: request.currentPath ?? null },
      action: () => inspectHistoricalArtifact({
        projectRoot,
        tag: request.tag ?? request.artifactId,
        currentPath: request.currentPath ?? null,
      }),
    });
  }
  if (request.command === 'recover-historical-original') {
    return runHistoricalOperation({
      projectRoot,
      applicationVersion: application.version,
      command: request.command,
      requestSummary: { artifactId: request.tag ?? request.artifactId, destinationPath: request.destinationPath },
      action: () => recoverHistoricalOriginal({
        projectRoot,
        tag: request.tag ?? request.artifactId,
        destinationPath: request.destinationPath,
      }),
    });
  }
  if (request.command === 'update-backup-root') return updateBackupRoot(request, persistent);
  if (request.command === 'list-backups') {
    try { return { ok: true, backups: await listKnownBackups(projectRoot) }; }
    catch (error) { return { ok: false, diagnostic: diagnostic(error) }; }
  }
  if (request.command === 'plan-restore') {
    if (!['backup', 'last-min'].includes(request.kind)) return { ok: false, diagnostic: { code: 'INVALID_RESTORE_KIND', message: 'O tipo de restauração é inválido.' } };
    try {
      const plan = request.kind === 'backup'
        ? await createBackupRestorePlan({ projectRoot, backupDirectory: request.backupDirectory })
        : await createLastMinRestorePlan({ projectRoot });
      return { ok: true, plan };
    } catch (error) { return { ok: false, diagnostic: diagnostic(error) }; }
  }
  if (request.command === 'execute-restore') {
    if (!['backup', 'last-min'].includes(request.kind)) return { ok: false, diagnostic: { code: 'INVALID_RESTORE_KIND', message: 'O tipo de restauração é inválido.' } };
    const startedAt = performance.now();
    let plan = null;
    try {
      plan = request.kind === 'backup'
        ? await createBackupRestorePlan({ projectRoot, backupDirectory: request.backupDirectory })
        : await createLastMinRestorePlan({ projectRoot });
      const result = await executeRestorePlan(plan, { confirmed: request.confirmed === true, confirmChanged: request.confirmChanged === true });
      const artifacts = await persistArtifacts({ projectRoot, plan, result, resultStatus: result.status, startedAt, phases: [{ name: 'restauração manual', status: result.status }], applicationVersion: application.version });
      return { ok: true, plan, result, artifacts };
    } catch (error) {
      const reportPlan = plan ?? { executionId: 'restore-validation', outputMode: request.kind, profile: null, engine: { id: null, version: null }, backupRoot: request.backupDirectory ?? null, runtimePaths: resolveRuntimePaths(projectRoot), items: [], ignored: [], diagnostics: { errors: [{ code: error.code, message: error.message }], blockers: [{ code: error.code, message: error.message }] } };
      const artifacts = await persistArtifacts({ projectRoot, plan: reportPlan, resultStatus: error.code === 'RESTORE_RECOVERY_REQUIRED' ? 'recovery-required' : 'validation-failure', error, startedAt, phases: [{ name: 'restauração manual', status: 'falha', code: error.code }], applicationVersion: application.version });
      return { ok: false, diagnostic: diagnostic(error), artifacts };
    }
  }
  if (request.command === 'list-artifacts') {
    try { return { ok: true, kind: request.kind, names: await listArtifacts(projectRoot, request.kind) }; }
    catch (error) { return { ok: false, diagnostic: diagnostic(error) }; }
  }
  if (request.command === 'read-artifact') {
    try { return { ok: true, kind: request.kind, name: request.name, content: await readArtifact(projectRoot, request.kind, request.name) }; }
    catch (error) { return { ok: false, diagnostic: diagnostic(error) }; }
  }
  if (request.command === 'cleanup-artifacts') {
    try {
      if (request.confirmed === true) {
        const candidates = request.candidates == null ? [] : (Array.isArray(request.candidates) ? request.candidates : [request.candidates]);
        const result = await executeArtifactCleanup(projectRoot, request.kind, candidates);
        return { ok: true, ...result };
      }
      const preview = await previewArtifactCleanup(projectRoot, request.kind);
      return { ok: true, ...preview };
    } catch (error) {
      return { ok: false, diagnostic: diagnostic(error) };
    }
  }
  if (request.command === 'storage-usage') {
    try { return await storageUsage(projectRoot, persistent); }
    catch (error) { return { ok: false, diagnostic: diagnostic(error) }; }
  }
  if (request.command === 'summary') {
    const effectiveBackupRoot = persistent.ok
      ? await resolveEffectiveBackupRoot(persistent.configuration, projectRoot)
      : null;
    const backupStorageMode = persistent.ok && persistent.schema === 'v3' && persistent.configuration.backupRoot !== null
      ? 'external'
      : 'internal';
    return {
      ok: true,
      application,
      configuration: persistent.ok ? persistent.configuration : null,
      effectiveBackupRoot,
      backupStorageMode,
      ...persistent,
      projectRoot: resolve(projectRoot),
    };
  }
  if (request.command === 'create-configuration') {
    return createInitialConfiguration(request, projectRoot);
  }
  if (request.command === 'update-output-mode') {
    if (!Object.values(OUTPUT_MODES).includes(request.outputMode)) {
      return { ok: false, code: 'INVALID_OUTPUT_MODE', message: 'O modo de saída solicitado não é permitido.' };
    }
    if (!persistent.ok) return { ok: false, ...persistent };
    if (request.confirmed !== true) return { ok: false, code: 'CONFIRMATION_REQUIRED', message: 'A alteração exige confirmação explícita.' };
    const registry = createDefaultMinifierRegistry();
    const allowedEngines = new Set(registry.list().map((item) => item.id));
    const filePath = paths(projectRoot).configuration;
    let normalized;
    try {
      normalized = await normalizePersistentConfiguration(
        { ...persistent.configuration, outputMode: request.outputMode },
        persistent.schema,
        { allowedEngines },
      );
      await writePersistentConfiguration(filePath, normalized, persistent.schema, { allowedEngines });
    } catch (error) {
      return { ok: false, diagnostic: diagnostic(error), changed: false };
    }
    const reloaded = await loadPersistent(projectRoot);
    if (!reloaded.ok || reloaded.schema !== persistent.schema) {
      return {
        ok: false,
        code: 'CONFIGURATION_RELOAD_FAILED',
        message: 'A configuração foi gravada, mas a releitura não pôde ser confirmada.',
        diagnostic: reloaded.diagnostic,
        changed: true,
      };
    }
    if (reloaded.configuration.outputMode !== normalized.outputMode) {
      return {
        ok: false,
        code: 'CONFIGURATION_RELOAD_MISMATCH',
        message: 'A configuração foi gravada, mas a releitura não confirmou o modo de saída esperado.',
        configuration: reloaded.configuration,
        changed: true,
      };
    }
    return { ok: true, configurationPath: filePath, configuration: reloaded.configuration, outputMode: reloaded.configuration.outputMode, updated: true };
  }
  if (request.command === 'update-configuration-v2') {
    return updateV2Configuration(request, persistent);
  }
  if (!persistent.ok) return { ok: false, ...persistent };
  persistent.projectRoot = resolve(projectRoot);
  try {
    if (request.command === 'scan-analysis') {
      const configuration = persistent.configuration;
      const { plan } = await createPlan(request, persistent, application.version);
      const analysis = buildAnalysis(plan.analysisResult ?? plan.scannerResult, {
        projectRoot: configuration.projectRoot,
        fileTypes: configuration.fileTypes,
        ignoredFolders: configuration.ignoredFolders,
        ignoredFiles: configuration.ignoredFiles,
      });
      return {
        ok: true,
        schema: persistent.schema,
        analysis: {
          ...analysis,
          execution: summarizePlan(plan),
        },
      };
    }
    if (request.command === 'analyze') {
      const startedAt = performance.now();
      const { plan } = await createPlan(request, persistent, application.version);
      const analysis = summarizePlan(plan);
      const artifacts = await persistArtifacts({ projectRoot, plan, resultStatus: 'analisado', startedAt, phases: [{ name: 'pré-análise', status: plan.status }], applicationVersion: application.version });
      return { ok: true, analysis, artifacts };
    }
    if (request.command === 'execute') {
      const startedAt = performance.now();
      let plan = null;
      try {
        const created = await createPlan(request, persistent, application.version);
        plan = created.plan;
        const confirmedPlan = summarizePlan(plan);
        if (request.confirmed === true && request.confirmationFingerprint !== confirmedPlan.confirmationFingerprint) {
          throw new ExecutionError('PLAN_CHANGED_AFTER_ANALYSIS', 'O escopo ou as condições mudaram após a análise. Analise novamente antes de confirmar a execução.');
        }
        const result = await executePlan(plan, created.minifier, {
          confirmed: request.confirmed === true,
          meminifyVersion: application.version,
        });
        const artifacts = await persistArtifacts({ projectRoot, plan, result, resultStatus: result.status, startedAt, phases: [{ name: 'execução', status: result.status }], applicationVersion: application.version });
        return { ok: true, plan: confirmedPlan, result, artifacts };
      } catch (error) {
        const executionStatus = error.code === 'RECOVERY_REQUIRED'
          ? 'recovery-required'
          : (error.details?.rollbackStatus === 'rolled-back' ? 'falha (rollback comprovado)' : 'falha');
        const artifacts = plan ? await persistArtifacts({ projectRoot, plan, resultStatus: executionStatus, error, startedAt, phases: [{ name: 'execução', status: executionStatus, code: error.code }], applicationVersion: application.version }) : {};
        return { ok: false, diagnostic: diagnostic(error), artifacts };
      }
    }
    return { ok: false, code: 'UNKNOWN_COMMAND', message: `Comando não suportado: ${request.command ?? '(vazio)'}.` };
  } catch (error) {
    return { ok: false, diagnostic: diagnostic(error) };
  }
}

if (process.argv[2] === '--bridge') {
  let request = {};
  try { request = JSON.parse(readFileSync(0, 'utf8')); } catch (error) {
    console.log(JSON.stringify({ ok: false, diagnostic: { code: 'INVALID_REQUEST', message: 'A requisição JSON é inválida.' } }));
    process.exitCode = 2;
  }
  if (process.exitCode !== 2) {
    const result = await runBridgeRequest(request, { projectRoot: resolveApplicationRoot() });
    console.log(JSON.stringify(result));
    if (!result.ok) process.exitCode = 1;
  }
}
