import { readFile, mkdir, open, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { TextDecoder } from 'node:util';
import { ConfigurationError } from './errors.js';

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

export async function readUtf8File(filePath) {
  const bytes = await readFile(filePath);

  try {
    return UTF8_DECODER.decode(bytes);
  } catch (error) {
    throw new ConfigurationError(
      'INVALID_UTF8',
      `O arquivo de configuração não está em UTF-8 válido: ${filePath}.`,
      { filePath, cause: error },
    );
  }
}

export async function writeUtf8FileAtomic(filePath, content, kind = 'CONFIGURATION') {
  if (typeof content !== 'string') {
    throw new ConfigurationError('INVALID_TEXT_CONTENT', 'O conteúdo a persistir deve ser texto.');
  }
  await mkdir(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporaryPath, 'wx');
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, filePath);
  } catch (cause) {
    await handle?.close().catch(() => {});
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw new ConfigurationError(`${kind}_WRITE_FAILED`, `Não foi possível persistir ${filePath} com segurança.`, { filePath, cause });
  }
}
