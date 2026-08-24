import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const semver = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export async function loadApplicationMetadata(root = defaultRoot) {
  let metadata;
  try {
    metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT' || root === defaultRoot) throw error;
    metadata = JSON.parse(await readFile(join(defaultRoot, 'package.json'), 'utf8'));
  }
  if (typeof metadata.version !== 'string' || !semver.test(metadata.version)) {
    const error = new Error('A versão do package.json não é um SemVer válido.');
    error.code = 'INVALID_APPLICATION_VERSION';
    throw error;
  }
  return Object.freeze({ name: metadata.name ?? 'selfminifier', version: metadata.version });
}
