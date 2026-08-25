import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import { IntegrityError } from './errors.js';
import { hashFileSha256 } from './hash.js';

function hashReadable(stream) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    stream.on('error', (cause) => reject(cause));
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

export async function gzipFileToFile(sourcePath, destinationPath) {
  try {
    await pipeline(createReadStream(sourcePath), createGzip(), createWriteStream(destinationPath, { flags: 'wx' }));
  } catch (cause) {
    throw new IntegrityError('GZIP_WRITE_FAILED', `Não foi possível criar o backup gzip: ${destinationPath}.`, { destinationPath, cause });
  }
  let handle;
  try {
    handle = await open(destinationPath, 'r+');
    await handle.sync();
  } catch (cause) {
    throw new IntegrityError('GZIP_SYNC_FAILED', `Não foi possível sincronizar o backup gzip: ${destinationPath}.`, { destinationPath, cause });
  } finally {
    await handle?.close().catch(() => {});
  }
  return hashFileSha256(destinationPath);
}

export async function hashDecompressedGzipFile(gzipPath) {
  try {
    const stream = createReadStream(gzipPath).pipe(createGunzip());
    return await hashReadable(stream);
  } catch (cause) {
    throw new IntegrityError('GZIP_DECOMPRESS_FAILED', `Não foi possível descompactar o backup gzip: ${gzipPath}.`, { gzipPath, cause });
  }
}

export async function gunzipFileToFile(gzipPath, destinationPath) {
  try {
    await pipeline(createReadStream(gzipPath), createGunzip(), createWriteStream(destinationPath, { flags: 'wx' }));
  } catch (cause) {
    throw new IntegrityError('GZIP_DECOMPRESS_FAILED', `Não foi possível descompactar o backup gzip: ${gzipPath}.`, { gzipPath, cause });
  }
  let handle;
  try {
    handle = await open(destinationPath, 'r+');
    await handle.sync();
  } catch (cause) {
    throw new IntegrityError('GZIP_SYNC_FAILED', `Não foi possível sincronizar a saída descompactada: ${destinationPath}.`, { destinationPath, cause });
  } finally {
    await handle?.close().catch(() => {});
  }
  return hashFileSha256(destinationPath);
}

export async function readVerifiedBackupContent(backupPath, compression, expectedDecompressedHash, temporaryDirectory) {
  if (compression === 'none') {
    const hash = await hashFileSha256(backupPath);
    if (hash !== expectedDecompressedHash) {
      throw new IntegrityError('BACKUP_HASH_MISMATCH', `O backup não corresponde ao SHA-256 original: ${backupPath}.`, { backupPath, expected: expectedDecompressedHash, actual: hash });
    }
    return readFile(backupPath);
  }
  if (compression === 'gzip') {
    await mkdir(temporaryDirectory, { recursive: true });
    const temporaryPath = join(temporaryDirectory, `.backup-descompactado-${process.pid}-${randomUUID()}.tmp`);
    try {
      const decompressedHash = await gunzipFileToFile(backupPath, temporaryPath);
      if (decompressedHash !== expectedDecompressedHash) {
        throw new IntegrityError('BACKUP_HASH_MISMATCH', `O conteúdo descompactado do backup não corresponde ao SHA-256 original: ${backupPath}.`, {
          backupPath,
          expected: expectedDecompressedHash,
          actual: decompressedHash,
        });
      }
      return await readFile(temporaryPath);
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => {});
    }
  }
  throw new IntegrityError('UNSUPPORTED_COMPRESSION', `A compactação do backup não é suportada: ${compression}.`, { compression });
}
