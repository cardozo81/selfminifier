import { access, constants, lstat, readdir, readlink, realpath } from 'node:fs/promises';
import { isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { ScannerError } from './errors.js';

const TECHNICAL_DIRECTORY_NAMES = new Set(['node_modules', '.git', '_source_versions']);

export function normalizeAbsolutePath(filePath) {
  return normalize(resolve(filePath));
}

function pathIdentity(filePath) {
  const normalized = normalizeAbsolutePath(filePath);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function pathParts(filePath) {
  return normalizeAbsolutePath(filePath).split(/[\\/]+/).filter(Boolean).map((part) => (
    process.platform === 'win32' ? part.toLowerCase() : part
  ));
}

function isInsideOrSame(candidate, directory) {
  const candidateIdentity = pathIdentity(candidate);
  const directoryIdentity = pathIdentity(directory);
  const relativePath = relative(directoryIdentity, candidateIdentity);
  return relativePath === '' || (
    !isAbsolute(relativePath)
    && relativePath !== '..'
    && !relativePath.startsWith(`..${sep}`)
  );
}

function hasTechnicalDirectoryName(filePath) {
  return pathParts(filePath).some((part) => TECHNICAL_DIRECTORY_NAMES.has(part));
}

export function isTechnicalExclusion(filePath, temporaryDirectory) {
  return hasTechnicalDirectoryName(filePath)
    || (temporaryDirectory !== undefined && isInsideOrSame(filePath, temporaryDirectory));
}

async function safeLinkTarget(filePath) {
  try {
    return await readlink(filePath);
  } catch {
    return undefined;
  }
}

export async function isReadonlyFile(filePath, stats) {
  const writeMask = typeof stats.mode === 'bigint' ? 0o222n : 0o222;
  const noWriteBits = typeof stats.mode === 'bigint' ? 0n : 0;
  if ((stats.mode & writeMask) === noWriteBits) return true;
  try {
    await access(filePath, constants.W_OK);
    return false;
  } catch {
    return true;
  }
}

function hasPhysicalIdentity(stats) {
  return stats.ino !== undefined && stats.ino !== 0 && stats.ino !== 0n;
}

function physicalIdentity(stats, canonicalPath) {
  if (hasPhysicalIdentity(stats)) return `${String(stats.dev)}:${String(stats.ino)}`;
  return pathIdentity(canonicalPath);
}

function comparableRelativePath(filePath) {
  const normalized = normalize(filePath).replaceAll('\\', '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

async function createFileEvent(filePath, relativePath, source, stats, canonicalPath) {
  const identityPath = canonicalPath ?? await realpath(filePath).catch(() => filePath);
  return {
    kind: 'file',
    path: filePath,
    normalizedPath: normalizeAbsolutePath(filePath),
    identity: physicalIdentity(stats, identityPath),
    canonicalPath: normalizeAbsolutePath(identityPath),
    identityProven: Number(stats.nlink) <= 1 || hasPhysicalIdentity(stats),
    linkCount: Number(stats.nlink),
    relativePath: relativePath.replaceAll('\\', '/'),
    sourceId: source.id,
    readonly: await isReadonlyFile(filePath, stats),
  };
}

async function proveProjectPath(filePath, relativePath, boundary) {
  let canonicalPath;
  try {
    canonicalPath = normalizeAbsolutePath(await realpath(filePath));
  } catch (error) {
    return { safe: false, reason: 'CANONICAL_PATH_UNAVAILABLE', error };
  }
  if (!isInsideOrSame(canonicalPath, boundary.canonicalRoot)) {
    return { safe: false, reason: 'CANONICAL_PATH_OUTSIDE_ROOT', canonicalPath };
  }

  const lexicalRelative = relative(boundary.lexicalRoot, normalizeAbsolutePath(filePath));
  const canonicalRelative = relative(boundary.canonicalRoot, canonicalPath);
  if (
    comparableRelativePath(lexicalRelative) !== comparableRelativePath(canonicalRelative)
    || comparableRelativePath(relativePath) !== comparableRelativePath(lexicalRelative)
  ) {
    return { safe: false, reason: 'FILESYSTEM_INDIRECTION_BLOCKED', canonicalPath };
  }
  return { safe: true, canonicalPath };
}

function compareDirectoryNames(left, right) {
  const leftIdentity = process.platform === 'win32' ? left.toLowerCase() : left;
  const rightIdentity = process.platform === 'win32' ? right.toLowerCase() : right;
  if (leftIdentity < rightIdentity) return -1;
  if (leftIdentity > rightIdentity) return 1;
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

async function inspectProjectPath(filePath, relativePath, source, options) {
  let stats;
  try {
    stats = await lstat(filePath, { bigint: true });
  } catch (error) {
    return [{ kind: 'error', path: normalizeAbsolutePath(filePath), relativePath, sourceId: source.id, reason: 'INACCESSIBLE_PATH', error }];
  }

  if (stats.isSymbolicLink()) {
    return [{
      kind: 'link',
      path: normalizeAbsolutePath(filePath),
      relativePath,
      sourceId: source.id,
      fileType: process.platform === 'win32' ? 'symlink-or-junction' : 'symlink',
      target: await safeLinkTarget(filePath),
    }];
  }

  const proof = await proveProjectPath(filePath, relativePath, options.boundary);
  if (!proof.safe) {
    return [{
      kind: 'unsafe-path',
      path: normalizeAbsolutePath(filePath),
      canonicalPath: proof.canonicalPath,
      relativePath,
      sourceId: source.id,
      fileType: stats.isDirectory() ? 'directory' : (stats.isFile() ? 'file' : 'other'),
      reason: proof.reason,
      error: proof.error,
    }];
  }

  if (isTechnicalExclusion(filePath, options.temporaryDirectory)) {
    return [{ kind: 'technical-exclusion', path: normalizeAbsolutePath(filePath), relativePath, sourceId: source.id, fileType: stats.isDirectory() ? 'directory' : 'file', reason: 'MANDATORY_TECHNICAL_EXCLUSION' }];
  }
  if (stats.isFile()) return [await createFileEvent(filePath, relativePath, source, stats, proof.canonicalPath)];
  if (!stats.isDirectory()) {
    return [{ kind: 'unsupported-entry', path: normalizeAbsolutePath(filePath), relativePath, sourceId: source.id, fileType: 'other' }];
  }
  if (options.ignoredFolderIdentities.has(comparableRelativePath(relativePath))) {
    return [{ kind: 'ignored-folder', path: normalizeAbsolutePath(filePath), relativePath, sourceId: source.id, fileType: 'directory' }];
  }

  const directoryIdentity = physicalIdentity(stats, proof.canonicalPath);
  const previousDirectory = options.visitedDirectories.get(directoryIdentity);
  if (previousDirectory !== undefined && previousDirectory !== comparableRelativePath(relativePath)) {
    return [{ kind: 'unsafe-path', path: normalizeAbsolutePath(filePath), canonicalPath: proof.canonicalPath, relativePath, sourceId: source.id, fileType: 'directory', reason: 'DUPLICATE_DIRECTORY_IDENTITY' }];
  }
  options.visitedDirectories.set(directoryIdentity, comparableRelativePath(relativePath));

  let names;
  try {
    names = (await readdir(filePath)).sort(compareDirectoryNames);
  } catch (error) {
    return [{ kind: 'error', path: normalizeAbsolutePath(filePath), relativePath, sourceId: source.id, reason: 'INACCESSIBLE_DIRECTORY', error }];
  }
  const events = [];
  for (const name of names) {
    const childRelativePath = relativePath ? join(relativePath, name) : name;
    events.push(...await inspectProjectPath(join(filePath, name), childRelativePath, source, options));
  }
  return events;
}


export async function collectProjectEntries(projectRoot, ignoredFolders, { temporaryDirectory } = {}) {
  const sourcePath = normalizeAbsolutePath(projectRoot);
  const source = { id: 'project-root', path: sourcePath, type: 'Diretorio', recursive: true };
  let stats;
  try {
    stats = await lstat(sourcePath, { bigint: true });
  } catch (error) {
    return [{ kind: 'source-error', path: sourcePath, sourceId: source.id, reason: 'PROJECT_ROOT_MISSING_OR_INACCESSIBLE', error }];
  }
  if (stats.isSymbolicLink()) {
    return [{ kind: 'source-error', path: sourcePath, sourceId: source.id, reason: 'UNSAFE_PROJECT_ROOT_LINK', error: new Error('A raiz do projeto é um link simbólico, junction ou ponto de redirecionamento reconhecido.') }];
  }
  if (!stats.isDirectory()) {
    return [{ kind: 'source-error', path: sourcePath, sourceId: source.id, reason: 'PROJECT_ROOT_NOT_DIRECTORY' }];
  }

  let canonicalRoot;
  try {
    canonicalRoot = normalizeAbsolutePath(await realpath(sourcePath));
  } catch (error) {
    return [{ kind: 'source-error', path: sourcePath, sourceId: source.id, reason: 'PROJECT_ROOT_CANONICALIZATION_FAILED', error }];
  }
  if (pathIdentity(canonicalRoot) !== pathIdentity(sourcePath)) {
    return [{ kind: 'source-error', path: sourcePath, canonicalPath: canonicalRoot, sourceId: source.id, reason: 'UNSAFE_PROJECT_ROOT_ALIAS', error: new Error('A representação configurada da raiz não corresponde ao caminho canônico.') }];
  }

  return inspectProjectPath(sourcePath, '', source, {
    temporaryDirectory,
    boundary: { lexicalRoot: sourcePath, canonicalRoot },
    ignoredFolderIdentities: new Set(ignoredFolders.map(comparableRelativePath)),
    visitedDirectories: new Map(),
  });
}
