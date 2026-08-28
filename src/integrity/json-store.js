import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { TextDecoder } from 'node:util';
import { IntegrityError } from './errors.js';

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });
const WINDOWS_RENAME_RETRY_DELAYS_MS = Object.freeze([50, 100, 200]);

async function renameAtomicWithWindowsRetry(oldPath, newPath, renameFile, wait, platform, reportAttempts) {
  let attempts = 0;
  while (true) {
    attempts += 1;
    reportAttempts(attempts);
    try {
      await renameFile(oldPath, newPath);
      return attempts;
    } catch (cause) {
      const retryDelay = WINDOWS_RENAME_RETRY_DELAYS_MS[attempts - 1];
      if (platform !== 'win32' || cause?.code !== 'EPERM' || retryDelay === undefined) {
        throw cause;
      }
      await wait(retryDelay);
    }
  }
}

async function readJsonUtf8Document(filePath, kind) {
  let bytes;
  try {
    bytes = await readFile(filePath);
  } catch (cause) {
    throw new IntegrityError(`${kind}_READ_FAILED`, `Não foi possível ler ${filePath}.`, { filePath, cause });
  }

  let text;
  try {
    text = UTF8_DECODER.decode(bytes);
  } catch (cause) {
    throw new IntegrityError(`${kind}_INVALID_UTF8`, `O arquivo não contém UTF-8 válido: ${filePath}.`, { filePath, cause });
  }

  try {
    return { value: JSON.parse(text), bytes };
  } catch (cause) {
    throw new IntegrityError(`${kind}_INVALID_JSON`, `O arquivo contém JSON inválido: ${filePath}.`, { filePath, cause });
  }
}

export async function readJsonUtf8(filePath, kind) {
  return (await readJsonUtf8Document(filePath, kind)).value;
}

export async function readJsonUtf8WithBytes(filePath, kind) {
  return readJsonUtf8Document(filePath, kind);
}

export async function writeJsonUtf8Atomic(filePath, value, kind, dependencies = {}) {
  const makeDirectory = dependencies.mkdir ?? mkdir;
  const openFile = dependencies.open ?? open;
  const renameFile = dependencies.rename ?? rename;
  const removeFile = dependencies.rm ?? rm;
  const wait = dependencies.wait ?? delay;
  const platform = dependencies.platform ?? process.platform;
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  let operation = 'create-parent-directory';
  let attempts = 0;
  try {
    await makeDirectory(dirname(filePath), { recursive: true });
    operation = 'open-temporary-file';
    handle = await openFile(temporaryPath, 'wx');
    operation = 'write-temporary-file';
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    operation = 'flush-temporary-file';
    await handle.sync();
    operation = 'close-temporary-file';
    await handle.close();
    handle = undefined;
    operation = 'rename-temporary-to-target';
    await renameAtomicWithWindowsRetry(
      temporaryPath,
      filePath,
      renameFile,
      wait,
      platform,
      (currentAttempts) => { attempts = currentAttempts; },
    );
  } catch (cause) {
    await handle?.close().catch(() => {});
    let cleanupCause;
    try {
      await removeFile(temporaryPath, { force: true });
    } catch (error) {
      cleanupCause = error;
    }
    const causeCode = cause?.code ?? 'UNKNOWN_FILESYSTEM_ERROR';
    const causeMessage = cause?.message ?? 'O sistema de arquivos não informou a causa.';
    const cleanupCauseCode = cleanupCause?.code ?? null;
    const cleanupCauseMessage = cleanupCause?.message ?? null;
    throw new IntegrityError(
      `${kind}_WRITE_FAILED`,
      `Não foi possível persistir ${filePath} com segurança (operação ${operation}; causa ${causeCode}: ${causeMessage}).`,
      {
        filePath,
        targetPath: filePath,
        temporaryPath,
        operation,
        attempts,
        causeCode,
        causeMessage,
        cleanupCauseCode,
        cleanupCauseMessage,
        cause,
      },
    );
  }
}
