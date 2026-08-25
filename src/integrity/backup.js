import { constants, copyFile, lstat, mkdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { IntegrityError } from './errors.js';
import { hashFileSha256 } from './hash.js';
import { assertPhysicalPath } from './physical-path.js';

async function assertBackupRootIdentity(backupRoot, expectedIdentity) {
  if (!expectedIdentity) {
    await assertPhysicalPath(backupRoot, { allowMissing: true });
    await mkdir(backupRoot, { recursive: true });
  }
  const proof = await assertPhysicalPath(backupRoot, { requireDirectory: true });
  if (expectedIdentity && proof.physicalIdentity !== expectedIdentity) {
    throw new IntegrityError('BACKUP_ROOT_IDENTITY_CHANGED', 'A raiz física de backup mudou depois da pré-análise.', {
      backupRoot,
      expectedIdentity,
      actualIdentity: proof.physicalIdentity,
    });
  }
  return proof;
}

const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function requireSafeIdentifier(value, field) {
  if (typeof value !== 'string' || !SAFE_IDENTIFIER.test(value) || value === '.' || value === '..') {
    throw new IntegrityError('INVALID_BACKUP_MAPPING', `${field} não é um identificador seguro para backup.`);
  }
}

function isInside(rootPath, candidatePath) {
  const relativePath = relative(rootPath, candidatePath);
  return relativePath === '' || (!relativePath.startsWith(`..${sep}`) && relativePath !== '..' && !isAbsolute(relativePath));
}

async function requireRegularPathWithoutLinks(rootPath, sourcePath) {
  if (!isInside(rootPath, sourcePath)) throw new IntegrityError('SOURCE_OUTSIDE_ORIGIN', 'O arquivo de origem está fora da raiz informada.');
  await assertPathHasNoLinks(sourcePath);
  const sourceStats = await lstat(sourcePath);
  if (!sourceStats.isFile()) throw new IntegrityError('SOURCE_NOT_FILE', 'A origem do backup deve ser um arquivo regular.');
  return sourceStats;
}

export async function assertPathHasNoLinks(filePath, { allowMissing = false } = {}) {
  return assertPhysicalPath(filePath, { allowMissing });
}

export async function createValidatedSourceBackup(input, dependencies = {}) {
  const { sourcePath, originRoot, backupRoot, executionId, originId, expectedBackupRootIdentity } = input;
  requireSafeIdentifier(executionId, 'executionId');
  requireSafeIdentifier(originId, 'originId');
  const normalizedSource = normalize(resolve(sourcePath));
  const normalizedOrigin = normalize(resolve(originRoot));
  const normalizedBackupRoot = normalize(resolve(backupRoot));
  await assertBackupRootIdentity(normalizedBackupRoot, expectedBackupRootIdentity);
  if (isInside(normalizedBackupRoot, normalizedSource)) {
    throw new IntegrityError('SOURCE_IN_BACKUP_AREA', 'A origem não pode estar dentro da área técnica de backup.');
  }
  const originStats = await lstat(normalizedOrigin).catch((cause) => {
    throw new IntegrityError('SOURCE_ACCESS_FAILED', `Não foi possível acessar a raiz da origem: ${normalizedOrigin}.`, { filePath: normalizedOrigin, cause });
  });
  if (originStats.isFile() && normalizedOrigin !== normalizedSource) {
    throw new IntegrityError('SOURCE_OUTSIDE_ORIGIN', 'A origem explícita não corresponde ao arquivo solicitado para backup.');
  }
  const sourceStats = await requireRegularPathWithoutLinks(
    originStats.isFile() ? dirname(normalizedOrigin) : normalizedOrigin,
    normalizedSource,
  );
  const sourceRelativePath = originStats.isFile() ? basename(normalizedSource) : relative(normalizedOrigin, normalizedSource);
  if (!sourceRelativePath || sourceRelativePath.startsWith('..') || isAbsolute(sourceRelativePath)) throw new IntegrityError('INVALID_BACKUP_MAPPING', 'Não foi possível mapear a origem no backup.');
  const backupRelativePath = join(executionId, originId, sourceRelativePath);
  const backupPath = join(normalizedBackupRoot, backupRelativePath);
  const hash = dependencies.hashFile ?? hashFileSha256;
  const copy = dependencies.copyFile ?? copyFile;
  const sourceSha256 = await hash(normalizedSource);
  await assertPathHasNoLinks(dirname(backupPath), { allowMissing: true });
  await assertBackupRootIdentity(normalizedBackupRoot, expectedBackupRootIdentity);
  await mkdir(dirname(backupPath), { recursive: true });
  await assertBackupRootIdentity(normalizedBackupRoot, expectedBackupRootIdentity);
  await assertPathHasNoLinks(dirname(backupPath));
  try {
    await copy(normalizedSource, backupPath, constants.COPYFILE_EXCL);
  } catch (cause) {
    throw new IntegrityError('BACKUP_COPY_FAILED', `Não foi possível criar o backup: ${backupPath}.`, { backupPath, cause });
  }
  let backupStats;
  try { backupStats = await lstat(backupPath); } catch (cause) {
    throw new IntegrityError('BACKUP_VALIDATION_FAILED', `O backup criado não pôde ser validado: ${backupPath}.`, { backupPath, cause });
  }
  if (!backupStats.isFile() || backupStats.isSymbolicLink()) throw new IntegrityError('BACKUP_VALIDATION_FAILED', 'O destino do backup não é um arquivo regular validável.');
  const backupSha256 = await hash(backupPath);
  if (sourceSha256 !== backupSha256) throw new IntegrityError('BACKUP_HASH_MISMATCH', 'O SHA-256 do backup não corresponde ao SHA-256 da origem.', { sourceSha256, backupSha256 });
  return Object.freeze({
    valid: true,
    sourcePath: normalizedSource,
    originId,
    originRoot: normalizedOrigin,
    backupPath,
    backupRelativePath: backupRelativePath.replaceAll('\\', '/'),
    originalSize: sourceStats.size,
    originalSha256: sourceSha256,
    backupSha256,
  });
}
