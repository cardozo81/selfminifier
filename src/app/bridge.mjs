import { access, copyFile, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import {
  deriveEffectiveConfiguration,
  loadConfiguration,
  resolveEffectiveBackupRoot,
  validateV2Configuration,
  validateV3Configuration,
  writeV2Configuration,
  writeV3Configuration,
} from '../configuration/index.js';
import { OUTPUT_MODES } from '../domain/index.js';
import { createDefaultMinifierRegistry } from '../minifiers/index.js';
import { createExecutionPlan, executePlan, ExecutionError } from '../execution/index.js';
import { listArtifacts, readArtifact, writeOperationalReports, writeTechnicalLog } from '../observability/index.mjs';
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

export async function runBridgeRequest(request, { projectRoot = resolveApplicationRoot() } = {}) {
  const application = await loadApplicationMetadata(projectRoot);
  if (request.command === 'version') return { ok: true, ...application };
  const persistent = await loadPersistent(projectRoot);
  if (request.command === 'search-history-by-tag') {
    try { return { ok: true, result: await searchHistoryByTag({ projectRoot, tag: request.tag ?? request.artifactId }) }; }
    catch (error) { return { ok: false, diagnostic: diagnostic(error) }; }
  }
  if (request.command === 'search-history-by-path') {
    try {
      return {
        ok: true,
        result: await searchHistoryByPath({ projectRoot, filePath: request.path, order: request.order ?? 'newest-first' }),
      };
    } catch (error) { return { ok: false, diagnostic: diagnostic(error) }; }
  }
  if (request.command === 'inspect-historical-artifact') {
    try {
      return {
        ok: true,
        result: await inspectHistoricalArtifact({
          projectRoot,
          tag: request.tag ?? request.artifactId,
          currentPath: request.currentPath ?? null,
        }),
      };
    } catch (error) { return { ok: false, diagnostic: diagnostic(error) }; }
  }
  if (request.command === 'recover-historical-original') {
    try {
      return {
        ok: true,
        result: await recoverHistoricalOriginal({
          projectRoot,
          tag: request.tag ?? request.artifactId,
          destinationPath: request.destinationPath,
        }),
      };
    } catch (error) { return { ok: false, diagnostic: diagnostic(error) }; }
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
    const filePaths = paths(projectRoot);
    if (request.confirmed !== true) return { ok: false, code: 'CONFIRMATION_REQUIRED', message: 'A criação exige confirmação explícita.' };
    if (await exists(filePaths.configuration)) return { ok: false, code: 'CONFIGURATION_EXISTS', configurationPath: filePaths.configuration };
    try {
      await mkdir(resolve(filePaths.configuration, '..'), { recursive: true });
      await copyFile(filePaths.example, filePaths.configuration);
      return { ok: true, configurationPath: filePaths.configuration, created: true };
    } catch (error) {
      return { ok: false, diagnostic: diagnostic(error) };
    }
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
    const result = await runBridgeRequest(request);
    console.log(JSON.stringify(result));
    if (!result.ok) process.exitCode = 1;
  }
}
