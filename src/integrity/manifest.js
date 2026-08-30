import { isAbsolute } from 'node:path';
import { IntegrityError } from './errors.js';
import { readJsonUtf8, writeJsonUtf8Atomic } from './json-store.js';
import { requireObject, validateManifestEntry } from './schema.js';

export function createBackupManifest({ executionId, timestamp, selfMinifierVersion = null, origins = [], files = [] }) {
  return validateBackupManifest({ formatVersion: 3, executionId, timestamp, selfMinifierVersion, origins, files });
}

export function createBackupManifestEntry(backup, metadata = {}) {
  return {
    originId: backup.originId,
    originalPath: backup.sourcePath,
    backupRelativePath: backup.backupRelativePath,
    compression: backup.compression ?? 'none',
    engine: metadata.engine ?? null,
    engineVersion: metadata.engineVersion ?? null,
    profile: metadata.profile ?? null,
    executionRisk: metadata.executionRisk ?? null,
    ...(metadata.artifactId === undefined ? {} : { artifactId: metadata.artifactId }),
    originalSize: backup.originalSize,
    originalSha256: backup.originalSha256,
    minifiedSize: metadata.minifiedSize ?? null,
    minifiedSha256: metadata.minifiedSha256 ?? null,
    status: metadata.status ?? 'backup-validado',
    minificationDate: metadata.minificationDate ?? null,
  };
}

export function validateBackupManifest(manifest) {
  requireObject(manifest, 'INVALID_MANIFEST', 'Manifesto');
  if (manifest.formatVersion !== 3) throw new IntegrityError('INVALID_MANIFEST', 'A versão do formato do manifesto não é suportada.');
  for (const field of ['executionId', 'timestamp']) {
    if (typeof manifest[field] !== 'string' || manifest[field].length === 0) throw new IntegrityError('INVALID_MANIFEST', `Manifesto.${field} deve ser texto não vazio.`);
  }
  if (manifest.selfMinifierVersion !== null && typeof manifest.selfMinifierVersion !== 'string') throw new IntegrityError('INVALID_MANIFEST', 'Manifesto.selfMinifierVersion deve ser texto ou null.');
  if (!Array.isArray(manifest.origins) || !Array.isArray(manifest.files)) throw new IntegrityError('INVALID_MANIFEST', 'Manifesto.origins e Manifesto.files devem ser listas.');
  const originIds = new Set();
  manifest.origins.forEach((origin, index) => {
    requireObject(origin, 'INVALID_MANIFEST', `Manifesto.origins[${index}]`);
    if (typeof origin.originId !== 'string' || !origin.originId || typeof origin.rootPath !== 'string' || !origin.rootPath) {
      throw new IntegrityError('INVALID_MANIFEST', `Manifesto.origins[${index}] deve conter originId e rootPath.`);
    }
    if (!isAbsolute(origin.rootPath)) throw new IntegrityError('INVALID_MANIFEST', `Manifesto.origins[${index}].rootPath deve ser absoluto.`);
    if (originIds.has(origin.originId)) throw new IntegrityError('INVALID_MANIFEST', `Manifesto contém originId duplicado: ${origin.originId}.`);
    originIds.add(origin.originId);
  });
  const backupPaths = new Set();
  manifest.files.forEach((entry, index) => {
    validateManifestEntry(entry, index);
    if (entry.compression !== 'gzip') {
      throw new IntegrityError('INVALID_MANIFEST', `Manifesto.files[${index}].compression deve ser gzip no formato v3.`);
    }
    if (!originIds.has(entry.originId)) throw new IntegrityError('INVALID_MANIFEST', `Manifesto.files[${index}].originId não possui raiz mapeada.`);
    if (!isAbsolute(entry.originalPath)) throw new IntegrityError('INVALID_MANIFEST', `Manifesto.files[${index}].originalPath deve ser absoluto.`);
    if (isAbsolute(entry.backupRelativePath) || entry.backupRelativePath.split(/[\\/]+/).some((part) => part === '..')) {
      throw new IntegrityError('INVALID_MANIFEST', `Manifesto.files[${index}].backupRelativePath deve permanecer relativo à área de backup.`);
    }
    if (backupPaths.has(entry.backupRelativePath)) throw new IntegrityError('INVALID_MANIFEST', `Manifesto contém caminho de backup duplicado: ${entry.backupRelativePath}.`);
    backupPaths.add(entry.backupRelativePath);
  });
  return manifest;
}

export async function readBackupManifest(filePath) {
  return validateBackupManifest(await readJsonUtf8(filePath, 'MANIFEST'));
}

export async function writeBackupManifest(filePath, manifest) {
  validateBackupManifest(manifest);
  await writeJsonUtf8Atomic(filePath, manifest, 'MANIFEST');
  return manifest;
}
