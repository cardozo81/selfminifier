import { randomUUID } from 'node:crypto';
import { constants, copyFile, link, lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { TextDecoder } from 'node:util';
import { assertPathHasNoLinks, hashContentSha256, hashFileSha256, readVerifiedBackupContent } from '../integrity/index.js';
import { ExecutionError } from './errors.js';

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

export async function inspectRegularFile(filePath) {
  try {
    const stats = await lstat(filePath);
    if (!stats.isFile() || stats.isSymbolicLink()) throw new ExecutionError('UNSAFE_FILESYSTEM_ENTRY', `O caminho não é um arquivo regular seguro: ${filePath}.`);
    return { exists: true, hash: await hashFileSha256(filePath), size: stats.size };
  } catch (cause) {
    if (cause?.code === 'ENOENT') return { exists: false, hash: null, size: null };
    if (cause instanceof ExecutionError) throw cause;
    throw new ExecutionError('FILESYSTEM_ACCESS_FAILED', `Não foi possível acessar o arquivo: ${filePath}.`, { filePath, cause });
  }
}

export async function readSourceUtf8Snapshot(filePath, dependencies = {}) {
  const read = dependencies.readFile ?? readFile;
  let bytes;
  try { bytes = await read(filePath); } catch (cause) {
    throw new ExecutionError('SOURCE_READ_FAILED', `Não foi possível ler a fonte: ${filePath}.`, { filePath, cause });
  }
  let content;
  try { content = UTF8_DECODER.decode(bytes); } catch (cause) {
    throw new ExecutionError('SOURCE_INVALID_UTF8', `A fonte não contém UTF-8 válido: ${filePath}.`, { filePath, cause });
  }
  return { content, hash: hashContentSha256(bytes), size: bytes.byteLength };
}

export async function readSourceUtf8(filePath) {
  return (await readSourceUtf8Snapshot(filePath)).content;
}

async function writeDurableTemporary(targetPath, content, expectedHash) {
  const temporaryPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporaryPath, 'wx');
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (await hashFileSha256(temporaryPath) !== expectedHash) throw new ExecutionError('TEMPORARY_HASH_MISMATCH', 'O arquivo temporário não corresponde ao resultado esperado.');
    return temporaryPath;
  } catch (cause) {
    await handle?.close().catch(() => {});
    await rm(temporaryPath, { force: true }).catch(() => {});
    if (cause instanceof ExecutionError) throw cause;
    throw new ExecutionError('TEMPORARY_WRITE_FAILED', `Não foi possível preparar a escrita segura de ${targetPath}.`, { targetPath, cause });
  }
}

export async function createNewFileExact(targetPath, content, expectedHash) {
  if ((await inspectRegularFile(targetPath)).exists) throw new ExecutionError('LATE_DESTINATION_CONFLICT', `O destino passou a existir após a pré-análise: ${targetPath}.`);
  const temporaryPath = await writeDurableTemporary(targetPath, content, expectedHash);
  try {
    await link(temporaryPath, targetPath);
  } catch (cause) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw new ExecutionError(cause?.code === 'EEXIST' ? 'LATE_DESTINATION_CONFLICT' : 'DESTINATION_CREATE_FAILED', `Não foi possível criar o destino: ${targetPath}.`, { targetPath, cause });
  }
  await rm(temporaryPath, { force: true }).catch(() => {});
  const created = await inspectRegularFile(targetPath);
  if (created.hash !== expectedHash) throw new ExecutionError('OUTPUT_HASH_MISMATCH', `O destino criado falhou na validação SHA-256: ${targetPath}.`);
}

export async function replaceFileExact(targetPath, content, expectedCurrentHash, expectedOutputHash) {
  const before = await inspectRegularFile(targetPath);
  if (!before.exists || before.hash !== expectedCurrentHash) throw new ExecutionError('TARGET_CHANGED', `O destino mudou desde a última prova: ${targetPath}.`, { expectedCurrentHash, actualHash: before.hash });
  const temporaryPath = await writeDurableTemporary(targetPath, content, expectedOutputHash);
  const immediatelyBefore = await inspectRegularFile(targetPath);
  if (!immediatelyBefore.exists || immediatelyBefore.hash !== expectedCurrentHash) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw new ExecutionError('TARGET_CHANGED', `O destino mudou antes da substituição: ${targetPath}.`, { expectedCurrentHash, actualHash: immediatelyBefore.hash });
  }
  try { await rename(temporaryPath, targetPath); } catch (cause) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw new ExecutionError('DESTINATION_REPLACE_FAILED', `Não foi possível substituir o destino com segurança: ${targetPath}.`, { targetPath, cause });
  }
  const replaced = await inspectRegularFile(targetPath);
  if (replaced.hash !== expectedOutputHash) throw new ExecutionError('OUTPUT_HASH_MISMATCH', `O destino substituído falhou na validação SHA-256: ${targetPath}.`);
}

export async function createValidatedRecoveryCopy(sourcePath, recoveryPath) {
  const source = await inspectRegularFile(sourcePath);
  if (!source.exists) throw new ExecutionError('RECOVERY_SOURCE_MISSING', `O arquivo a preservar não existe: ${sourcePath}.`);
  await assertPathHasNoLinks(dirname(recoveryPath), { allowMissing: true });
  await mkdir(dirname(recoveryPath), { recursive: true });
  await assertPathHasNoLinks(dirname(recoveryPath));
  try { await copyFile(sourcePath, recoveryPath, constants.COPYFILE_EXCL); } catch (cause) {
    throw new ExecutionError('RECOVERY_COPY_FAILED', `Não foi possível preservar o destino preexistente: ${sourcePath}.`, { sourcePath, recoveryPath, cause });
  }
  const recovery = await inspectRegularFile(recoveryPath);
  if (recovery.hash !== source.hash) throw new ExecutionError('RECOVERY_HASH_MISMATCH', 'A cópia de recuperação falhou na validação SHA-256.');
  return { path: recoveryPath, hash: recovery.hash };
}

export async function restoreExactFile(targetPath, recoveryPath, expectedCurrentHash, expectedRecoveryHash, compression = 'none') {
  const current = await inspectRegularFile(targetPath);
  if (!current.exists || current.hash !== expectedCurrentHash) return false;
  const recovery = await inspectRegularFile(recoveryPath);
  if (!recovery.exists) return false;
  let content;
  if (compression === 'gzip') {
    try {
      content = await readVerifiedBackupContent(recoveryPath, 'gzip', expectedRecoveryHash, dirname(targetPath));
    } catch {
      return false;
    }
  } else {
    if (recovery.hash !== expectedRecoveryHash) return false;
    content = await readFile(recoveryPath);
  }
  await replaceFileExact(targetPath, content, expectedCurrentHash, expectedRecoveryHash);
  return (await inspectRegularFile(targetPath)).hash === expectedRecoveryHash;
}

export async function removeExactFile(targetPath, expectedHash) {
  const current = await inspectRegularFile(targetPath);
  if (!current.exists) return true;
  if (current.hash !== expectedHash) return false;
  await rm(targetPath);
  return !(await inspectRegularFile(targetPath)).exists;
}

export { hashContentSha256 };
