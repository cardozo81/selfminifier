import { IntegrityError } from './errors.js';

export const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function isNullableString(value) {
  return value === null || typeof value === 'string';
}

function isNullableSize(value) {
  return value === null || (Number.isSafeInteger(value) && value >= 0);
}

export function requireObject(value, code, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new IntegrityError(code, `${label} deve ser um objeto JSON.`);
  }
}

export function validateRecord(record, code, label) {
  requireObject(record, code, label);
  const requiredStrings = ['sourcePath', 'outputPath', 'outputMode', 'minificationTimestamp', 'engine', 'engineVersion', 'profile'];
  for (const field of requiredStrings) {
    if (!isNullableString(record[field])) throw new IntegrityError(code, `${label}.${field} deve ser texto ou null.`);
  }
  for (const field of ['sourceHash', 'minifiedHash']) {
    if (record[field] !== null && !SHA256_PATTERN.test(record[field])) throw new IntegrityError(code, `${label}.${field} deve ser SHA-256 hexadecimal minúsculo ou null.`);
  }
  for (const field of ['sourceSize', 'minifiedSize']) {
    if (!isNullableSize(record[field])) throw new IntegrityError(code, `${label}.${field} deve ser inteiro não negativo ou null.`);
  }
  if (record.executionRisk !== undefined && !isNullableString(record.executionRisk)) throw new IntegrityError(code, `${label}.executionRisk deve ser texto ou null.`);
  if (record.executionId !== undefined && (typeof record.executionId !== 'string' || !record.executionId)) throw new IntegrityError(code, `${label}.executionId deve ser texto não vazio quando presente.`);
  if (record.artifactId !== undefined && !/^[A-F0-9]{24}$/.test(record.artifactId)) throw new IntegrityError(code, `${label}.artifactId deve conter 24 caracteres hexadecimais maiúsculos quando presente.`);
}

export function validateManifestEntry(entry, index) {
  const code = 'INVALID_MANIFEST';
  const label = `manifest.files[${index}]`;
  requireObject(entry, code, label);
  for (const field of ['originId', 'originalPath', 'backupRelativePath', 'status']) {
    if (typeof entry[field] !== 'string' || entry[field].length === 0) throw new IntegrityError(code, `${label}.${field} deve ser texto não vazio.`);
  }
  for (const field of ['engine', 'engineVersion', 'profile', 'minificationDate']) {
    if (!isNullableString(entry[field])) throw new IntegrityError(code, `${label}.${field} deve ser texto ou null.`);
  }
  if (entry.executionRisk !== undefined && !isNullableString(entry.executionRisk)) throw new IntegrityError(code, `${label}.executionRisk deve ser texto ou null.`);
  if (entry.artifactId !== undefined && !/^[A-F0-9]{24}$/.test(entry.artifactId)) throw new IntegrityError(code, `${label}.artifactId deve conter 24 caracteres hexadecimais maiúsculos quando presente.`);
  if (!Number.isSafeInteger(entry.originalSize) || entry.originalSize < 0) throw new IntegrityError(code, `${label}.originalSize deve ser inteiro não negativo.`);
  if (!SHA256_PATTERN.test(entry.originalSha256)) throw new IntegrityError(code, `${label}.originalSha256 deve ser SHA-256 hexadecimal minúsculo.`);
  if (!isNullableSize(entry.minifiedSize)) throw new IntegrityError(code, `${label}.minifiedSize deve ser inteiro não negativo ou null.`);
  if (entry.minifiedSha256 !== null && !SHA256_PATTERN.test(entry.minifiedSha256)) throw new IntegrityError(code, `${label}.minifiedSha256 deve ser SHA-256 hexadecimal minúsculo ou null.`);
}
