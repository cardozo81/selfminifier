import { mkdir } from 'node:fs/promises';
import { isAbsolute, normalize, relative, resolve, sep, win32 } from 'node:path';
import { CONFIGURATION_SCHEMA_VERSIONS } from '../domain/index.js';
import { assertPhysicalPath, proveDirectoryWritable } from '../integrity/index.js';
import { resolveApplicationPaths } from '../runtime/paths.js';
import { ConfigurationError } from './errors.js';

const GLOB_METACHARS = /[*?[\]{}!]/;
const ENV_VAR_PATTERN = /%[^%]+%|\$env:|\$\{[^}]+\}|\$[A-Za-z_][A-Za-z0-9_]*/i;

function fail(code, message, details = {}) {
  throw new ConfigurationError(code, message, details);
}

function isInsideOrSame(rootPath, candidatePath) {
  const value = relative(rootPath, candidatePath);
  return value === '' || (!isAbsolute(value) && value !== '..' && !value.startsWith(`..${sep}`));
}

export function normalizeBackupRootValue(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') fail('INVALID_BACKUP_ROOT', 'PastaBackups deve ser texto ou ficar vazia.');
  if (ENV_VAR_PATTERN.test(value)) fail('ENV_EXPANSION_NOT_ALLOWED', 'PastaBackups não aceita variáveis de ambiente.', { value });
  if (GLOB_METACHARS.test(value)) fail('GLOB_NOT_ALLOWED', 'PastaBackups não aceita padrões glob ou curingas.', { value });
  if (value.split(/[\\/]+/).some((part) => part === '..')) fail('PARENT_TRAVERSAL_NOT_ALLOWED', "PastaBackups não pode conter '..'.", { value });
  const parsed = win32.parse(value);
  if (!win32.isAbsolute(value) || parsed.root === '\\' || parsed.root === '/' || parsed.root === '') {
    fail('ABSOLUTE_BACKUP_PATH_REQUIRED', 'PastaBackups deve ser um caminho Windows absoluto com unidade ou UNC.', { value });
  }
  return win32.normalize(value);
}

function assertDisjoint(projectLexical, projectCanonical, backupLexical, backupCanonical) {
  const lexicalOverlap = isInsideOrSame(projectLexical, backupLexical) || isInsideOrSame(backupLexical, projectLexical);
  const physicalOverlap = isInsideOrSame(projectCanonical, backupCanonical) || isInsideOrSame(backupCanonical, projectCanonical);
  if (lexicalOverlap || physicalOverlap) {
    fail('BACKUP_PROJECT_ROOT_OVERLAP', 'PastaBackups e PastaRaiz devem ser diretórios física e lexicalmente separados.', {
      projectRoot: projectLexical,
      projectCanonical,
      backupRoot: backupLexical,
      backupCanonical,
    });
  }
}

export async function validateExternalBackupRoot(backupRoot, projectRoot, { proveWritable = true } = {}) {
  const normalizedBackupRoot = normalizeBackupRootValue(backupRoot);
  if (normalizedBackupRoot === null) return null;
  const normalizedProjectRoot = normalize(resolve(projectRoot));
  let project;
  let backup;
  try {
    project = await assertPhysicalPath(normalizedProjectRoot, { requireDirectory: true });
    backup = proveWritable
      ? await proveDirectoryWritable(normalizedBackupRoot)
      : await assertPhysicalPath(normalizedBackupRoot, { requireDirectory: true });
  } catch (cause) {
    fail('UNSAFE_EXTERNAL_BACKUP_ROOT', `PastaBackups não pôde ser comprovada como diretório físico seguro: ${normalizedBackupRoot}.`, { backupRoot: normalizedBackupRoot, cause });
  }
  assertDisjoint(project.path, project.canonicalPath, backup.path, backup.canonicalPath);
  return normalizedBackupRoot;
}

export async function resolveEffectiveBackupRoot(configuration, applicationRoot, { validateExternal = false, proveWritable = false, prepareInternal = false } = {}) {
  if (!configuration || ![CONFIGURATION_SCHEMA_VERSIONS.V2, CONFIGURATION_SCHEMA_VERSIONS.V3].includes(configuration.schemaVersion)) {
    fail('UNSUPPORTED_CONFIGURATION_SCHEMA', 'A raiz efetiva de backup exige configuração normalizada V2 ou V3.');
  }
  if (configuration.schemaVersion === CONFIGURATION_SCHEMA_VERSIONS.V3 && configuration.backupRoot !== null) {
    const external = normalizeBackupRootValue(configuration.backupRoot);
    if (validateExternal) return validateExternalBackupRoot(external, configuration.projectRoot, { proveWritable });
    return external;
  }
  const internal = resolveApplicationPaths(applicationRoot).backupRoot;
  if (prepareInternal) {
    try {
      await assertPhysicalPath(internal, { allowMissing: true });
      await mkdir(internal, { recursive: true });
      await proveDirectoryWritable(internal);
    } catch (cause) {
      fail('INTERNAL_BACKUP_ROOT_UNAVAILABLE', `A pasta interna de backups não pôde ser preparada: ${internal}.`, { backupRoot: internal, cause });
    }
  }
  return internal;
}
