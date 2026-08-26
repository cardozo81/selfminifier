import { access, constants, lstat, mkdir } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { validateExternalBackupRoot } from '../configuration/index.js';
import { CONFIGURATION_SCHEMA_VERSIONS, OUTPUT_MODES, PROFILE_DEFINITIONS } from '../domain/index.js';
import {
  NO_SELFMINIFIER_TAG,
  assertPhysicalPath,
  classifySelfMinifierTag,
  hashFileSha256,
  proveDirectoryWritable,
} from '../integrity/index.js';
import { readTechnicalState } from '../integrity/state.js';
import { resolveRuntimePaths } from '../runtime/paths.js';
import { scan } from '../scanner/index.js';
import { ExecutionError } from './errors.js';
import { readSourceUtf8 } from './filesystem.js';
import { calculateExecutionRisk } from './risk.js';

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function minifiedPath(sourcePath) {
  const extension = extname(sourcePath);
  return `${sourcePath.slice(0, -extension.length)}.min${extension}`;
}

function isMinifiedName(sourcePath) {
  return /\.min\.(?:js|css)$/i.test(sourcePath);
}

async function pathState(filePath) {
  try {
    const stats = await lstat(filePath);
    let writable = (stats.mode & 0o222) !== 0;
    if (writable) {
      try { await access(filePath, constants.W_OK); } catch { writable = false; }
    }
    return { exists: true, stats, writable };
  } catch (cause) {
    if (cause?.code === 'ENOENT') return { exists: false, stats: null };
    throw new ExecutionError('DESTINATION_ACCESS_FAILED', `Não foi possível verificar o destino: ${filePath}.`, { filePath, cause });
  }
}

async function loadStateSnapshot(statePath) {
  const stateFile = await pathState(statePath);
  if (!stateFile.exists) return { existed: false, value: { formatVersion: 1, records: [] } };
  return { existed: true, value: await readTechnicalState(statePath) };
}

function findStateRecord(state, sourcePath) {
  const identity = process.platform === 'win32' ? sourcePath.toLowerCase() : sourcePath;
  return state.records.find((record) => (
    (process.platform === 'win32' ? record.sourcePath?.toLowerCase() : record.sourcePath) === identity
  ));
}

const SAFE_EXECUTION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export async function createExecutionPlan({
  configuration,
  minifier,
  runtimeRoot = process.cwd(),
  backupRoot,
  executionId,
  timestamp = new Date().toISOString(),
  meminifyVersion = null,
  scannerOptions = {},
}) {
  if (!configuration || typeof executionId !== 'string' || !SAFE_EXECUTION_ID.test(executionId) || executionId === '.' || executionId === '..') {
    throw new ExecutionError('INVALID_PLAN_INPUT', 'Configuração e executionId são obrigatórios para a pré-análise.');
  }
  if (![CONFIGURATION_SCHEMA_VERSIONS.V2, CONFIGURATION_SCHEMA_VERSIONS.V3].includes(configuration.schemaVersion)) {
    throw new ExecutionError('UNSUPPORTED_CONFIGURATION_SCHEMA', 'A pré-análise exige uma configuração normalizada com schemaVersion=2 ou schemaVersion=3.');
  }
  if (!Object.values(OUTPUT_MODES).includes(configuration.outputMode)) {
    throw new ExecutionError('INVALID_OUTPUT_MODE', 'O modo de saída da pré-análise não é permitido.');
  }
  if (configuration.outputMode === OUTPUT_MODES.BACKUP_OVERWRITE && !backupRoot) {
    throw new ExecutionError('BACKUP_ROOT_REQUIRED', 'A raiz de backup deve ser informada no modo de sobrescrita.');
  }

  let backupRootProof = null;
  if (configuration.outputMode === OUTPUT_MODES.BACKUP_OVERWRITE) {
    const normalizedBackupRoot = normalize(resolve(backupRoot));
    const external = configuration.schemaVersion === CONFIGURATION_SCHEMA_VERSIONS.V3 && configuration.backupRoot !== null;
    if (external) {
      await validateExternalBackupRoot(normalizedBackupRoot, configuration.projectRoot, { proveWritable: true });
    } else {
      await assertPhysicalPath(normalizedBackupRoot, { allowMissing: true });
      await mkdir(normalizedBackupRoot, { recursive: true });
    }
    backupRootProof = await proveDirectoryWritable(normalizedBackupRoot);
  }

  const engineId = configuration.engine;
  const configuredSources = [{ id: 'project-root', path: configuration.projectRoot, recursive: true, type: 'Diretorio' }];
  const runtimePaths = resolveRuntimePaths(runtimeRoot);
  const scannerResult = await scan(configuration, { runtimeRoot, ...scannerOptions });
  const stateSnapshot = await loadStateSnapshot(runtimePaths.technicalState);
  const blockers = scannerResult.errors.map((diagnostic) => ({ ...diagnostic }));
  const ignored = scannerResult.ignored.map((item) => ({ ...item }));
  const sourceById = new Map(configuredSources.map((source) => [String(source.id), source]));

  if (!minifier || minifier.id !== engineId) {
    blockers.push({ code: 'INVALID_ENGINE', message: 'O minificador fornecido não corresponde ao motor configurado.' });
  } else {
    const installation = minifier.validateInstallation();
    if (!installation.valid) blockers.push(...installation.diagnostics);
  }

  const items = [];
  const conflicts = [];
  const destinationIdentities = new Set();
  if (configuration.outputMode === OUTPUT_MODES.BACKUP_OVERWRITE) {
    const executionBackupDirectory = join(normalize(resolve(backupRoot)), executionId);
    if ((await pathState(executionBackupDirectory)).exists) {
      blockers.push({ code: 'EXECUTION_BACKUP_COLLISION', normalizedPath: executionBackupDirectory });
    }
  }
  for (const eligible of scannerResult.eligible) {
    const sourcePath = normalize(resolve(eligible.normalizedPath));
    if (isMinifiedName(sourcePath)) {
      ignored.push({ ...eligible, status: 'ignored', reason: 'ALREADY_MINIFIED_NAME' });
      continue;
    }
    const source = sourceById.get(String(eligible.sourceId));
    if (!source) {
      blockers.push({ code: 'UNKNOWN_SOURCE_ORIGIN', sourceId: eligible.sourceId, normalizedPath: sourcePath });
      continue;
    }
    const sourceHash = await hashFileSha256(sourcePath);
    const sourceStats = await lstat(sourcePath);
    const tagClassification = await classifySelfMinifierTag({
      content: await readSourceUtf8(sourcePath),
      fileType: eligible.fileType,
      currentHash: sourceHash,
      historyDirectory: runtimePaths.historyDirectory,
    });
    if (tagClassification.reason !== NO_SELFMINIFIER_TAG) {
      ignored.push({
        ...eligible,
        status: tagClassification.reason === 'ALREADY_MINIFIED_BY_SELFMINIFIER' ? 'ignored' : 'blocked',
        reason: tagClassification.reason,
        artifactId: tagClassification.artifactId,
        historicalOutputHash: tagClassification.historicalOutputHash,
        historicalExecutionId: tagClassification.historicalExecutionId ?? null,
      });
      continue;
    }
    const recorded = findStateRecord(stateSnapshot.value, sourcePath);
    if (configuration.outputMode === OUTPUT_MODES.BACKUP_OVERWRITE && recorded?.minifiedHash === sourceHash) {
      ignored.push({ ...eligible, status: 'ignored', reason: 'ALREADY_MINIFIED_UNCHANGED' });
      continue;
    }
    const validation = minifier?.validateConfiguration({
      type: eligible.fileType,
      profile: configuration.profile,
      engineId,
    });
    if (!validation?.valid) {
      blockers.push(...(validation?.diagnostics ?? [{ code: 'INVALID_MINIFIER_CONFIGURATION', message: 'Configuração de minificação inválida.' }]));
      continue;
    }
    const destinationPath = configuration.outputMode === OUTPUT_MODES.BACKUP_OVERWRITE
      ? sourcePath
      : minifiedPath(sourcePath);
    const destinationIdentity = process.platform === 'win32' ? destinationPath.toLowerCase() : destinationPath;
    if (destinationIdentities.has(destinationIdentity)) {
      blockers.push({ code: 'DUPLICATE_DESTINATION', normalizedPath: destinationPath });
      continue;
    }
    destinationIdentities.add(destinationIdentity);
    const destination = configuration.outputMode === OUTPUT_MODES.BACKUP_OVERWRITE
      ? { exists: true, stats: sourceStats, hash: sourceHash }
      : await pathState(destinationPath).then(async ({ exists, stats, writable }) => ({
        exists,
        stats,
        writable,
        hash: exists && stats.isFile() && !stats.isSymbolicLink() ? await hashFileSha256(destinationPath) : null,
      }));
    if (destination.exists && (!destination.stats.isFile() || destination.stats.isSymbolicLink())) {
      blockers.push({ code: 'UNSAFE_DESTINATION', normalizedPath: destinationPath });
      continue;
    }
    if (configuration.outputMode === OUTPUT_MODES.PRESERVE_AND_CREATE_MINIFIED && destination.exists) {
      conflicts.push({
        sourcePath,
        destinationPath,
        existingHash: destination.hash,
        classification: 'PREEXISTING_MIN_CONFLICT',
        action: 'skipped',
      });
      ignored.push({
        ...eligible,
        status: 'ignored',
        reason: 'PREEXISTING_MIN_CONFLICT',
        destinationPath,
      });
      continue;
    }
    if (configuration.outputMode === OUTPUT_MODES.PRESERVE_AND_CREATE_MINIFIED && destination.exists && destination.writable === false) {
      blockers.push({ code: 'READONLY_DESTINATION', normalizedPath: destinationPath });
      continue;
    }
    const item = {
      id: `item-${String(items.length + 1).padStart(3, '0')}`,
      sourceId: String(eligible.sourceId),
      backupOriginId: `origem-${String(eligible.sourceId)}`,
      originRoot: normalize(resolve(source.path)),
      sourcePath,
      relativePath: eligible.relativePath ?? null,
      sourceHash,
      sourceSize: sourceStats.size,
      fileType: eligible.fileType,
      destinationPath,
      destinationExistedAtPlan: destination.exists,
      destinationHashAtPlan: destination.hash,
    };
    items.push(item);
    if (configuration.outputMode === OUTPUT_MODES.PRESERVE_AND_CREATE_MINIFIED && destination.exists) {
      conflicts.push({ itemId: item.id, destinationPath, existingHash: destination.hash });
    }
  }

  const executionRisk = calculateExecutionRisk({
    outputMode: configuration.outputMode,
    profile: configuration.profile,
    conflictCount: 0,
  });
  const requiredConfirmations = [
    { type: 'execution', satisfied: false },
  ];
  const ignoredByReason = {};
  for (const item of ignored) ignoredByReason[item.reason] = (ignoredByReason[item.reason] ?? 0) + 1;
  const candidateBytes = items.reduce((total, item) => total + item.sourceSize, 0);
  const classifiedScannerResult = {
    ...scannerResult,
    eligible: items.map((item) => ({
      normalizedPath: item.sourcePath,
      relativePath: item.relativePath,
      sourceId: item.sourceId,
      fileType: item.fileType,
      status: 'eligible',
    })),
    ignored,
    counts: {
      ...scannerResult.counts,
      ignored: ignored.length,
      alreadyMinified: ignored.filter((item) => (
        item.reason === 'ALREADY_MINIFIED' || item.reason === 'ALREADY_MINIFIED_UNCHANGED' || item.reason === 'ALREADY_MINIFIED_BY_SELFMINIFIER'
      )).length,
      eligible: items.length,
      candidateBytes,
      ignoredByReason,
    },
  };

  return deepFreeze({
    formatVersion: 1,
    configurationSchemaVersion: configuration.schemaVersion,
    executionId,
    meminifyVersion,
    timestamp,
    status: blockers.length === 0 ? 'ready' : 'blocked',
    outputMode: configuration.outputMode,
    profile: configuration.profile,
    profileRisk: PROFILE_DEFINITIONS[configuration.profile]?.risk ?? null,
    executionRisk,
    scope: { fileCount: items.length },
    engine: minifier ? { id: minifier.id, version: minifier.version } : { id: engineId, version: null },
    runtimePaths,
    backupRoot: backupRoot ? normalize(resolve(backupRoot)) : null,
    backupRootCanonicalPath: backupRootProof?.canonicalPath ?? null,
    backupRootPhysicalIdentity: backupRootProof?.physicalIdentity ?? null,
    sources: configuredSources.map((source) => ({ id: String(source.id), path: normalize(resolve(source.path)), recursive: source.recursive ?? false, type: source.type })),
    items,
    ignored,
    diagnostics: {
      warnings: scannerResult.warnings.map((item) => ({ ...item })),
      errors: scannerResult.errors.map((item) => ({ ...item })),
      blockers,
    },
    conflicts,
    conflictPolicy: 'skip-existing',
    requiredConfirmations,
    stateBefore: stateSnapshot,
    scannerResult,
    analysisResult: classifiedScannerResult,
  });
}
