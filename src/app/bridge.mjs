import { access, copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { deriveEffectiveConfiguration, identifyConfigurationSchema, parseConfiguration, parseV2Configuration, validateV2Configuration } from '../configuration/index.js';
import { readUtf8File } from '../configuration/utf8.js';
import { OUTPUT_MODES } from '../domain/index.js';
import { createDefaultMinifierRegistry } from '../minifiers/index.js';
import { createExecutionPlan, executePlan, ExecutionError } from '../execution/index.js';
import { listArtifacts, readArtifact, writeOperationalReports, writeTechnicalLog } from '../observability/index.mjs';
import { createBackupRestorePlan, createLastMinRestorePlan, executeRestorePlan, listKnownBackups } from '../restore/index.js';
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
    const text = await readUtf8File(filePaths.configuration);
    const schema = identifyConfigurationSchema(text);
    const configuration = schema.kind === 'v2'
      ? parseV2Configuration(text, { allowedEngines })
      : parseConfiguration(text, { allowedEngines });
    return {
      ok: true,
      schema: schema.kind,
      configuration,
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
  const isV2 = persistent.configuration?.schemaVersion === 2;
  const adjustments = adjustmentsFrom(request);
  const allowedEngines = new Set(registry.list().map((item) => item.id));
  if (isV2 && Object.keys(adjustments).some((key) => key !== 'outputMode')) {
    throw new ExecutionError('V2_UNSUPPORTED_TEMPORARY_ADJUSTMENT', 'A execução V2 recebeu um ajuste temporário não permitido.');
  }
  const effective = isV2
    ? validateV2Configuration({ ...persistent.configuration, ...adjustments }, { allowedEngines })
    : deriveEffectiveConfiguration(persistent.configuration, adjustments, { allowedEngines });
  const engineId = isV2 ? effective.engine : effective.engineId;
  const plan = await createExecutionPlan({
    configuration: effective,
    minifier: registry.get(engineId),
    runtimeRoot: persistent.projectRoot,
    backupRoot: effective.outputMode === 'BackupESobrescreverOriginais' ? paths(persistent.projectRoot).backupRoot : undefined,
    executionId: request.executionId ?? `exec-${Date.now()}`,
    meminifyVersion: applicationVersion,
  });
  return { plan, minifier: registry.get(engineId), effective };
}

export async function runBridgeRequest(request, { projectRoot = resolveApplicationRoot() } = {}) {
  const application = await loadApplicationMetadata(projectRoot);
  if (request.command === 'version') return { ok: true, ...application };
  const persistent = await loadPersistent(projectRoot);
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
    return { ok: true, application, configuration: persistent.ok ? persistent.configuration : null, ...persistent, projectRoot: resolve(projectRoot) };
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
    const filePath = paths(projectRoot).configuration;
    const temporaryPath = `${filePath}.tmp-${process.pid}`;
    try {
      const text = await readFile(filePath, 'utf8');
      const lineEnding = text.includes('\r\n') ? '\r\n' : '\n';
      const modeLine = `ModoSaida=${request.outputMode}`;
      const updated = /^ModoSaida\s*=.*$/m.test(text)
        ? text.replace(/^ModoSaida\s*=.*$/m, modeLine)
        : text.replace(/^(\[Configuracao\].*)$/m, `$1${lineEnding}${modeLine}`);
      await writeFile(temporaryPath, updated, 'utf8');
      await rename(temporaryPath, filePath);
      return { ok: true, configurationPath: filePath, outputMode: request.outputMode, updated: true };
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => {});
      return { ok: false, diagnostic: diagnostic(error) };
    }
  }
  if (!persistent.ok) return { ok: false, ...persistent };
  persistent.projectRoot = resolve(projectRoot);
  try {
    if (request.command === 'scan-analysis') {
      if (persistent.configuration?.schemaVersion !== 2) {
        return { ok: false, code: 'V2_CONFIGURATION_REQUIRED', message: 'A análise quantitativa exige uma configuração com VersaoSchema=2.' };
      }
      const configuration = persistent.configuration;
      const { plan } = await createPlan(request, persistent, application.version);
      const analysis = buildAnalysis(plan.scannerResult, {
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
          authorizeOverwriteConflicts: request.authorizeOverwriteConflicts === true,
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
