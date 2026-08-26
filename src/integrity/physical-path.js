import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { access, constants, lstat, open, realpath, rm } from 'node:fs/promises';
import { join, normalize, parse, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { IntegrityError } from './errors.js';

const execFileAsync = promisify(execFile);
const WINDOWS_NOT_REPARSE_ERROR = /\b4390\b/;

function identity(filePath) {
  const normalized = normalize(resolve(filePath));
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function physicalIdentity(stats) {
  if (stats?.dev === undefined || stats?.ino === undefined || stats.ino === 0 || stats.ino === 0n) {
    throw new IntegrityError('PHYSICAL_IDENTITY_UNPROVEN', 'O filesystem não forneceu identidade física inequívoca para o caminho.');
  }
  return `${String(stats.dev)}:${String(stats.ino)}`;
}

function physicalIdentityOrNull(stats) {
  try {
    return physicalIdentity(stats);
  } catch {
    return null;
  }
}

async function assertWindowsPathIsNotReparse(filePath, run = execFileAsync) {
  if (process.platform !== 'win32') return;
  const systemRoot = process.env.SystemRoot;
  if (typeof systemRoot !== 'string' || systemRoot === '') {
    throw new IntegrityError('REPARSE_STATUS_UNPROVEN', 'A variável SystemRoot não está disponível para a prova nativa de reparse point.', { filePath });
  }
  const executable = join(systemRoot, 'System32', 'fsutil.exe');
  try {
    await run(executable, ['reparsepoint', 'query', filePath], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
  } catch (cause) {
    const output = `${cause?.stdout ?? ''}\n${cause?.stderr ?? ''}`;
    if (Number(cause?.code) === 1 && WINDOWS_NOT_REPARSE_ERROR.test(output)) return;
    throw new IntegrityError(
      'REPARSE_STATUS_UNPROVEN',
      `O Windows não confirmou que o caminho é um objeto físico ordinário: ${filePath}.`,
      { filePath, cause },
    );
  }
  throw new IntegrityError('REPARSE_POINT_NOT_ALLOWED', `Reparse points não são permitidos: ${filePath}.`, { filePath });
}

export async function assertPhysicalPath(filePath, { allowMissing = false, requireDirectory = false, memo = null } = {}) {
  const normalizedPath = normalize(resolve(filePath));
  const rootPath = parse(normalizedPath).root;
  const parts = relative(rootPath, normalizedPath).split(/[\\/]+/).filter(Boolean);
  const candidates = [rootPath];
  let childPath = rootPath;
  for (const part of parts) {
    childPath = join(childPath, part);
    candidates.push(childPath);
  }
  for (const currentPath of candidates) {
    let stats;
    try {
      stats = await lstat(currentPath);
    } catch (cause) {
      if (allowMissing && cause?.code === 'ENOENT') {
        return Object.freeze({ path: normalizedPath, canonicalPath: null, exists: false });
      }
      throw new IntegrityError('PHYSICAL_PATH_ACCESS_FAILED', `Não foi possível acessar o caminho físico: ${currentPath}.`, { filePath: currentPath, cause });
    }
    if (stats.isSymbolicLink()) {
      throw new IntegrityError('LINK_NOT_ALLOWED', `Links simbólicos e junctions não são permitidos: ${currentPath}.`, { filePath: currentPath });
    }
    const memoKey = identity(currentPath);
    const currentIdentity = physicalIdentityOrNull(stats);
    const reparseProven = currentIdentity !== null && memo?.get(memoKey) === currentIdentity;
    if (!reparseProven) {
      await assertWindowsPathIsNotReparse(currentPath);
      if (memo && currentIdentity !== null) memo.set(memoKey, currentIdentity);
    }
    let canonicalPath;
    try {
      canonicalPath = normalize(resolve(await realpath(currentPath)));
    } catch (cause) {
      throw new IntegrityError('CANONICAL_PATH_UNAVAILABLE', `Não foi possível obter o caminho canônico: ${currentPath}.`, { filePath: currentPath, cause });
    }
    if (identity(canonicalPath) !== identity(currentPath)) {
      throw new IntegrityError('PHYSICAL_PATH_ALIAS_NOT_ALLOWED', `O caminho informado redireciona para outra localização física: ${currentPath}.`, {
        filePath: currentPath,
        canonicalPath,
      });
    }
  }
  let finalStats;
  try {
    finalStats = await lstat(normalizedPath);
  } catch (cause) {
    if (allowMissing && cause?.code === 'ENOENT') {
      return Object.freeze({ path: normalizedPath, canonicalPath: null, exists: false });
    }
    throw new IntegrityError('PHYSICAL_PATH_ACCESS_FAILED', `Não foi possível acessar o caminho físico: ${normalizedPath}.`, { filePath: normalizedPath, cause });
  }
  if (requireDirectory && !finalStats.isDirectory()) {
    throw new IntegrityError('DIRECTORY_REQUIRED', `O caminho deve ser um diretório físico existente: ${normalizedPath}.`, { filePath: normalizedPath });
  }
  const canonicalPath = normalize(resolve(await realpath(normalizedPath)));
  return Object.freeze({
    path: normalizedPath,
    canonicalPath,
    physicalIdentity: physicalIdentity(finalStats),
    exists: true,
    stats: finalStats,
  });
}

export async function proveDirectoryWritable(directoryPath, { openFile = open } = {}) {
  const proven = await assertPhysicalPath(directoryPath, { requireDirectory: true });
  try {
    await access(proven.path, constants.R_OK | constants.W_OK);
  } catch (cause) {
    throw new IntegrityError('BACKUP_ROOT_ACCESS_DENIED', `A pasta de backups não está acessível para leitura e escrita: ${proven.path}.`, { cause });
  }
  const proofPath = join(proven.path, `.selfminifier-write-proof-${randomBytes(16).toString('hex')}.tmp`);
  let handle;
  let created = false;
  let operationError = null;
  try {
    handle = await openFile(proofPath, 'wx');
    created = true;
    await handle.writeFile('SelfMinifier write proof\n', 'utf8');
    await handle.sync();
  } catch (cause) {
    operationError = new IntegrityError('BACKUP_ROOT_NOT_WRITABLE', `A escrita exclusiva de prova falhou na pasta de backups: ${proven.path}.`, { proofPath, cause });
  } finally {
    try { await handle?.close(); } catch (cause) {
      operationError ??= new IntegrityError('BACKUP_ROOT_WRITE_PROOF_CLOSE_FAILED', `A prova de escrita não pôde ser fechada com segurança: ${proofPath}.`, { proofPath, cause });
    }
    if (created) {
      try { await rm(proofPath); } catch (cause) {
        throw new IntegrityError('BACKUP_ROOT_WRITE_PROOF_CLEANUP_FAILED', `O arquivo exclusivo de prova não pôde ser removido: ${proofPath}.`, { proofPath, cause, operationError });
      }
    }
  }
  if (operationError) throw operationError;
  return proven;
}
