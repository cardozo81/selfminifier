import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { TextDecoder } from 'node:util';
import { validateExternalBackupRoot } from '../configuration/index.js';
import { createNewFileExact, inspectRegularFile } from '../execution/filesystem.js';
import {
  ARTIFACT_ID_PATTERN,
  assertPhysicalPath,
  hashContentSha256,
  hashDecompressedGzipFile,
  hashFileSha256,
  inspectSelfMinifierTags,
  listHistoricalExecutionRecords,
  readBackupManifest,
  readVerifiedBackupContent,
} from '../integrity/index.js';
import { resolveRuntimePaths } from '../runtime/paths.js';

const EXACT_MARKER_PATTERN = /^\/\*! SelfMinifier-Tag: ([A-F0-9]{24}) \*\/$/;
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

export const CURRENT_INTEGRITY_STATES = Object.freeze({
  MATCH: 'MATCH',
  CONTENT_CHANGED: 'CONTENT_CHANGED',
  TAG_MISMATCH: 'TAG_MISMATCH',
  TAG_MISSING: 'TAG_MISSING',
  TAG_INVALID: 'TAG_INVALID',
  FILE_UNAVAILABLE: 'FILE_UNAVAILABLE',
});

export const BACKUP_AVAILABILITY_STATES = Object.freeze({
  AVAILABLE: 'AVAILABLE',
  NOT_AVAILABLE: 'NOT_AVAILABLE',
  ROOT_UNAVAILABLE: 'ROOT_UNAVAILABLE',
  PAYLOAD_MISSING: 'PAYLOAD_MISSING',
  MANIFEST_MISSING_OR_INVALID: 'MANIFEST_MISSING_OR_INVALID',
  HASH_MISMATCH: 'HASH_MISMATCH',
  UNSUPPORTED_FORMAT: 'UNSUPPORTED_FORMAT',
});

export class HistoricalRecoveryError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'HistoricalRecoveryError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new HistoricalRecoveryError(code, message, details);
}

function identity(value) {
  const normalized = normalize(resolve(value));
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isInside(rootPath, candidatePath) {
  const value = relative(rootPath, candidatePath);
  return value === '' || (!isAbsolute(value) && value !== '..' && !value.startsWith(`..${sep}`));
}

function diagnostic(error) {
  return {
    code: error?.code ?? error?.name ?? 'HISTORICAL_OBSERVATION_FAILED',
    message: error?.message ?? 'A observação histórica falhou.',
  };
}

export function normalizeHistoricalTagInput(value) {
  if (typeof value !== 'string') fail('INVALID_ARTIFACT_ID', 'A pesquisa exige artifactId ou marcador SelfMinifier-Tag exato.');
  const trimmed = value.trim();
  const marker = EXACT_MARKER_PATTERN.exec(trimmed);
  const artifactId = marker?.[1] ?? trimmed;
  if (!ARTIFACT_ID_PATTERN.test(artifactId)) fail('INVALID_ARTIFACT_ID', 'O artifactId pesquisado é inválido.');
  return artifactId;
}

function historicalFact(execution, artifact) {
  return Object.freeze({
    artifactId: artifact.artifactId,
    executionId: execution.executionId,
    timestamp: artifact.timestamp,
    selfMinifierVersion: execution.selfMinifierVersion,
    projectRoot: execution.projectRoot,
    sourcePath: artifact.sourcePath,
    outputPath: artifact.outputPath,
    engine: artifact.engine,
    engineVersion: artifact.engineVersion,
    profile: artifact.profile,
    outputMode: artifact.outputMode,
    inputHash: artifact.inputHash,
    outputHash: artifact.outputHash,
    sourceSize: artifact.sourceSize,
    outputSize: artifact.outputSize,
    backup: Object.freeze({ ...artifact.backup }),
  });
}

async function recordsFor(projectRoot) {
  try {
    return await listHistoricalExecutionRecords(resolveRuntimePaths(projectRoot).historyDirectory);
  } catch (cause) {
    if (cause?.code === 'DUPLICATE_HISTORICAL_ARTIFACT_ID') {
      fail(
        'HISTORY_ARTIFACT_ID_CONFLICT',
        'O histórico autoritativo contém artifactId duplicado e não pode ser pesquisado com segurança.',
        { cause: diagnostic(cause) },
      );
    }
    throw cause;
  }
}

export async function searchHistoryByTag({ projectRoot = process.cwd(), tag }) {
  const artifactId = normalizeHistoricalTagInput(tag);
  const matches = [];
  for (const execution of await recordsFor(projectRoot)) {
    for (const artifact of execution.artifacts) {
      if (artifact.artifactId === artifactId) matches.push(historicalFact(execution, artifact));
    }
  }
  if (matches.length === 0) {
    fail('TAG_NOT_FOUND', `A SelfMinifier-Tag ${artifactId} não foi encontrada no histórico autoritativo.`, { artifactId });
  }
  if (matches.length > 1) {
    fail('HISTORY_ARTIFACT_ID_CONFLICT', `O artifactId ${artifactId} aparece em mais de um registro histórico.`, {
      artifactId,
      matches: matches.length,
    });
  }
  return matches[0];
}

export async function searchHistoryByPath({ projectRoot = process.cwd(), filePath, order = 'newest-first' }) {
  if (typeof filePath !== 'string' || !isAbsolute(filePath)) {
    fail('INVALID_HISTORY_PATH', 'A pesquisa por caminho exige um caminho absoluto explícito.');
  }
  if (!['newest-first', 'oldest-first'].includes(order)) {
    fail('INVALID_HISTORY_ORDER', 'A ordem histórica deve ser newest-first ou oldest-first.');
  }
  const requested = identity(filePath);
  const matches = [];
  for (const execution of await recordsFor(projectRoot)) {
    for (const artifact of execution.artifacts) {
      const matchedFields = [];
      if (identity(artifact.sourcePath) === requested) matchedFields.push('sourcePath');
      if (identity(artifact.outputPath) === requested) matchedFields.push('outputPath');
      if (matchedFields.length > 0) {
        matches.push({ ...historicalFact(execution, artifact), matchedFields: Object.freeze(matchedFields) });
      }
    }
  }
  const direction = order === 'newest-first' ? -1 : 1;
  matches.sort((left, right) => direction * (
    left.timestamp.localeCompare(right.timestamp)
    || left.executionId.localeCompare(right.executionId)
    || left.artifactId.localeCompare(right.artifactId)
  ));
  return Object.freeze({
    path: normalize(resolve(filePath)),
    order,
    records: Object.freeze(matches),
  });
}

function fileTypeFor(historical) {
  return historical.outputPath.toLowerCase().endsWith('.css') ? 'css' : 'javascript';
}

export async function inspectCurrentHistoricalArtifact(historical, currentPath) {
  const normalizedPath = typeof currentPath === 'string' && isAbsolute(currentPath)
    ? normalize(resolve(currentPath))
    : null;
  if (!normalizedPath) {
    return Object.freeze({ state: CURRENT_INTEGRITY_STATES.FILE_UNAVAILABLE, path: normalizedPath, currentHash: null });
  }
  let proof;
  try {
    proof = await assertPhysicalPath(normalizedPath, { allowMissing: true });
  } catch (cause) {
    return Object.freeze({
      state: CURRENT_INTEGRITY_STATES.FILE_UNAVAILABLE,
      path: normalizedPath,
      currentHash: null,
      diagnostic: diagnostic(cause),
    });
  }
  if (!proof.exists || !proof.stats.isFile() || proof.stats.isSymbolicLink()) {
    return Object.freeze({ state: CURRENT_INTEGRITY_STATES.FILE_UNAVAILABLE, path: normalizedPath, currentHash: null });
  }
  let bytes;
  let content;
  try {
    bytes = await readFile(normalizedPath);
    content = UTF8_DECODER.decode(bytes);
  } catch (cause) {
    return Object.freeze({
      state: CURRENT_INTEGRITY_STATES.TAG_INVALID,
      path: normalizedPath,
      currentHash: null,
      diagnostic: diagnostic(cause),
    });
  }
  const inspected = inspectSelfMinifierTags(content, fileTypeFor(historical));
  const currentHash = hashContentSha256(bytes);
  if (inspected.invalid.length > 0 || inspected.exact.length > 1) {
    return Object.freeze({ state: CURRENT_INTEGRITY_STATES.TAG_INVALID, path: normalizedPath, currentHash });
  }
  if (inspected.exact.length === 0) {
    return Object.freeze({ state: CURRENT_INTEGRITY_STATES.TAG_MISSING, path: normalizedPath, currentHash });
  }
  if (inspected.exact[0].artifactId !== historical.artifactId) {
    return Object.freeze({
      state: CURRENT_INTEGRITY_STATES.TAG_MISMATCH,
      path: normalizedPath,
      currentHash,
      currentArtifactId: inspected.exact[0].artifactId,
    });
  }
  return Object.freeze({
    state: currentHash === historical.outputHash
      ? CURRENT_INTEGRITY_STATES.MATCH
      : CURRENT_INTEGRITY_STATES.CONTENT_CHANGED,
    path: normalizedPath,
    currentHash,
  });
}

function unavailable(state, historical, details = {}) {
  return Object.freeze({
    state,
    recoverable: false,
    backupRoot: historical.backup.backupRoot,
    backupRelativePath: historical.backup.backupRelativePath,
    compression: historical.backup.compression,
    ...details,
  });
}

async function manifestFormatState(manifestPath) {
  try {
    const parsed = JSON.parse(await readFile(manifestPath, 'utf8'));
    return parsed?.formatVersion === 3
      ? null
      : BACKUP_AVAILABILITY_STATES.UNSUPPORTED_FORMAT;
  } catch {
    return null;
  }
}

export async function inspectHistoricalBackup({ projectRoot = process.cwd(), historical }) {
  if (!historical.backup.available) {
    return unavailable(BACKUP_AVAILABILITY_STATES.NOT_AVAILABLE, historical);
  }
  if (historical.inputHash !== historical.backup.originalHash) {
    return unavailable(BACKUP_AVAILABILITY_STATES.HASH_MISMATCH, historical, {
      diagnostic: {
        code: 'HISTORICAL_HASH_CONFLICT',
        message: 'inputHash e backup.originalHash históricos divergem.',
      },
    });
  }

  const backupRoot = normalize(resolve(historical.backup.backupRoot));
  try {
    const internalRoot = normalize(resolve(projectRoot, '_source_versions'));
    if (identity(backupRoot) !== identity(internalRoot)) {
      await validateExternalBackupRoot(backupRoot, historical.projectRoot, { proveWritable: false });
    }
    await assertPhysicalPath(backupRoot, { requireDirectory: true });
  } catch (cause) {
    return unavailable(BACKUP_AVAILABILITY_STATES.ROOT_UNAVAILABLE, historical, { diagnostic: diagnostic(cause) });
  }

  const executionDirectory = normalize(resolve(backupRoot, historical.executionId));
  const manifestPath = join(executionDirectory, 'manifest.json');
  let manifest;
  try {
    const manifestProof = await assertPhysicalPath(manifestPath, { allowMissing: true });
    if (!manifestProof.exists || !manifestProof.stats.isFile() || manifestProof.stats.isSymbolicLink()) {
      return unavailable(BACKUP_AVAILABILITY_STATES.MANIFEST_MISSING_OR_INVALID, historical, { manifestPath });
    }
    manifest = await readBackupManifest(manifestPath);
  } catch (cause) {
    const formatState = await manifestFormatState(manifestPath);
    return unavailable(
      formatState ?? BACKUP_AVAILABILITY_STATES.MANIFEST_MISSING_OR_INVALID,
      historical,
      { manifestPath, diagnostic: diagnostic(cause) },
    );
  }
  if (manifest.executionId !== historical.executionId) {
    return unavailable(BACKUP_AVAILABILITY_STATES.MANIFEST_MISSING_OR_INVALID, historical, {
      manifestPath,
      diagnostic: { code: 'HISTORY_MANIFEST_MISMATCH', message: 'O executionId do manifesto diverge do histórico.' },
    });
  }

  const normalizedRelativePath = historical.backup.backupRelativePath.replaceAll('\\', '/');
  const entries = manifest.files.filter(
    (entry) => entry.backupRelativePath.replaceAll('\\', '/') === normalizedRelativePath,
  );
  if (entries.length !== 1) {
    return unavailable(BACKUP_AVAILABILITY_STATES.MANIFEST_MISSING_OR_INVALID, historical, {
      manifestPath,
      diagnostic: {
        code: 'HISTORY_MANIFEST_MISMATCH',
        message: 'O manifesto não contém exatamente o payload histórico esperado.',
      },
    });
  }
  const entry = entries[0];
  const compression = entry.compression;
  if ((entry.artifactId !== undefined && entry.artifactId !== historical.artifactId)
    || identity(entry.originalPath) !== identity(historical.sourcePath)
    || entry.originalSha256 !== historical.inputHash
    || entry.originalSha256 !== historical.backup.originalHash
    || entry.minifiedSha256 !== historical.outputHash
    || compression !== historical.backup.compression) {
    return unavailable(BACKUP_AVAILABILITY_STATES.MANIFEST_MISSING_OR_INVALID, historical, {
      manifestPath,
      diagnostic: {
        code: 'HISTORY_MANIFEST_MISMATCH',
        message: 'O manifesto contradiz a proveniência histórica do artefato.',
      },
    });
  }

  const backupPath = normalize(resolve(backupRoot, historical.backup.backupRelativePath));
  if (!isInside(executionDirectory, backupPath)) {
    return unavailable(BACKUP_AVAILABILITY_STATES.MANIFEST_MISSING_OR_INVALID, historical, {
      manifestPath,
      diagnostic: {
        code: 'INVALID_BACKUP_MAPPING',
        message: 'O payload não permanece na pasta da execução histórica.',
      },
    });
  }
  let payloadProof;
  try {
    payloadProof = await assertPhysicalPath(backupPath, { allowMissing: true });
  } catch (cause) {
    return unavailable(BACKUP_AVAILABILITY_STATES.PAYLOAD_MISSING, historical, {
      manifestPath,
      backupPath,
      diagnostic: diagnostic(cause),
    });
  }
  if (!payloadProof.exists || !payloadProof.stats.isFile() || payloadProof.stats.isSymbolicLink()) {
    return unavailable(BACKUP_AVAILABILITY_STATES.PAYLOAD_MISSING, historical, { manifestPath, backupPath });
  }

  let actualHash;
  try {
    actualHash = compression === 'gzip'
      ? await hashDecompressedGzipFile(backupPath)
      : await hashFileSha256(backupPath);
  } catch (cause) {
    return unavailable(BACKUP_AVAILABILITY_STATES.HASH_MISMATCH, historical, {
      manifestPath,
      backupPath,
      diagnostic: diagnostic(cause),
    });
  }
  if (actualHash !== historical.backup.originalHash) {
    return unavailable(BACKUP_AVAILABILITY_STATES.HASH_MISMATCH, historical, {
      manifestPath,
      backupPath,
      actualHash,
    });
  }
  return Object.freeze({
    state: BACKUP_AVAILABILITY_STATES.AVAILABLE,
    recoverable: true,
    backupRoot,
    backupRelativePath: historical.backup.backupRelativePath,
    backupPath,
    manifestPath,
    manifestFormatVersion: manifest.formatVersion,
    compression,
    originalHash: historical.backup.originalHash,
  });
}

export async function inspectHistoricalArtifact({ projectRoot = process.cwd(), tag, currentPath = null }) {
  const historical = await searchHistoryByTag({ projectRoot, tag });
  const [currentIntegrity, backupAvailability] = await Promise.all([
    currentPath === null
      ? Promise.resolve(null)
      : inspectCurrentHistoricalArtifact(historical, currentPath),
    inspectHistoricalBackup({ projectRoot, historical }),
  ]);
  return Object.freeze({
    historical,
    observations: Object.freeze({
      currentIntegrity,
      backupAvailability,
      recoveryCapability: backupAvailability.recoverable,
    }),
  });
}

function validateExportDestination(historical, destinationPath) {
  if (typeof destinationPath !== 'string' || !isAbsolute(destinationPath)) {
    fail('INVALID_EXPORT_DESTINATION', 'A exportação histórica exige destino absoluto explícito.');
  }
  if (destinationPath.split(/[\\/]+/).some((part) => part === '..')) {
    fail('UNSAFE_EXPORT_DESTINATION', 'O destino de exportação não pode conter travessia de diretórios.');
  }
  const destination = normalize(resolve(destinationPath));
  if ([historical.sourcePath, historical.outputPath].some(
    (candidate) => identity(candidate) === identity(destination),
  )) {
    fail(
      'HISTORICAL_EXPORT_TARGET_FORBIDDEN',
      'A exportação histórica não pode usar os caminhos históricos de origem ou saída.',
      { destination },
    );
  }
  return destination;
}

export async function recoverHistoricalOriginal({ projectRoot = process.cwd(), tag, destinationPath }) {
  const historical = await searchHistoryByTag({ projectRoot, tag });
  if (!historical.backup.available) {
    fail('HISTORICAL_BACKUP_UNAVAILABLE', `O artefato ${historical.artifactId} não possui payload histórico de origem.`);
  }
  if (historical.inputHash !== historical.backup.originalHash) {
    fail('HISTORICAL_HASH_CONFLICT', 'inputHash e backup.originalHash históricos divergem; a recuperação foi bloqueada.');
  }

  const availability = await inspectHistoricalBackup({ projectRoot, historical });
  if (!availability.recoverable) {
    fail(availability.state, 'O backup histórico não está disponível e íntegro para exportação.', { availability });
  }

  const destination = validateExportDestination(historical, destinationPath);
  const parent = dirname(destination);
  let parentProof;
  try {
    parentProof = await assertPhysicalPath(parent, { requireDirectory: true });
    const targetProof = await assertPhysicalPath(destination, { allowMissing: true });
    if (targetProof.exists) fail('EXPORT_TARGET_EXISTS', `O destino de exportação já existe: ${destination}.`);
  } catch (cause) {
    if (cause instanceof HistoricalRecoveryError) throw cause;
    fail('UNSAFE_EXPORT_DESTINATION', `A pasta de destino não pôde ser comprovada como segura: ${parent}.`, {
      cause: diagnostic(cause),
    });
  }

  let content;
  try {
    content = await readVerifiedBackupContent(
      availability.backupPath,
      availability.compression,
      historical.backup.originalHash,
      resolveRuntimePaths(projectRoot).temporaryDirectory,
    );
  } catch (cause) {
    fail('HASH_MISMATCH', 'O payload histórico falhou na leitura íntegra para exportação.', {
      cause: diagnostic(cause),
    });
  }
  if (hashContentSha256(content) !== historical.inputHash) {
    fail('HISTORICAL_HASH_CONFLICT', 'Os bytes recuperados não correspondem ao inputHash histórico.');
  }

  const currentParentProof = await assertPhysicalPath(parent, { requireDirectory: true });
  if (identity(currentParentProof.canonicalPath) !== identity(parentProof.canonicalPath)
    || currentParentProof.physicalIdentity !== parentProof.physicalIdentity) {
    fail('UNSAFE_EXPORT_DESTINATION', 'A pasta física de destino mudou durante a recuperação histórica.');
  }

  try {
    await createNewFileExact(destination, content, historical.inputHash);
  } catch (cause) {
    if (cause?.code === 'LATE_DESTINATION_CONFLICT') {
      fail('EXPORT_TARGET_EXISTS', `O destino de exportação já existe: ${destination}.`, { cause: diagnostic(cause) });
    }
    fail('HISTORICAL_EXPORT_FAILED', `Não foi possível criar a exportação histórica: ${destination}.`, {
      cause: diagnostic(cause),
    });
  }

  const exported = await inspectRegularFile(destination);
  if (!exported.exists || exported.hash !== historical.inputHash) {
    fail('HISTORICAL_EXPORT_HASH_MISMATCH', 'A exportação criada não corresponde ao hash histórico original.');
  }
  return Object.freeze({
    artifactId: historical.artifactId,
    executionId: historical.executionId,
    destinationPath: destination,
    exportedHash: exported.hash,
    exportedSize: exported.size,
    sourceHash: historical.inputHash,
    compression: availability.compression,
    status: 'EXPORTED',
  });
}
