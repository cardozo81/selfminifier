import { basename, extname, win32 } from 'node:path';
import { collectProjectEntries, normalizeAbsolutePath } from './filesystem.js';
import { ScannerError } from './errors.js';
import { resolveRuntimePaths } from '../runtime/paths.js';

const SUPPORTED_FILE_TYPES = Object.freeze({
  '.js': 'javascript',
  '.css': 'css',
});
const V2_FILE_TYPES = new Set(['css', 'javascript']);
const MINIFIED_NAME = /\.min\.(?:js|css)$/i;
const GLOB_METACHARS = /[*?[\]{}!]/;

function sortItems(items) {
  return items.sort((left, right) => (
    left.normalizedPath.localeCompare(right.normalizedPath) || String(left.sourceId).localeCompare(String(right.sourceId)) || String(left.reason ?? '').localeCompare(String(right.reason ?? ''))
  ));
}

function createResult() {
  return { discovered: [], eligible: [], ignored: [], warnings: [], errors: [] };
}

function finalizeResult(result) {
  sortItems(result.discovered);
  sortItems(result.eligible);
  sortItems(result.ignored);
  result.errors.sort((left, right) => left.normalizedPath.localeCompare(right.normalizedPath));
  const ignoredByReason = {};
  for (const item of result.ignored) ignoredByReason[item.reason] = (ignoredByReason[item.reason] ?? 0) + 1;
  result.counts = {
    cssFound: result.discovered.filter((item) => item.fileType === 'css').length,
    javascriptFound: result.discovered.filter((item) => item.fileType === 'javascript').length,
    ignored: result.ignored.length,
    alreadyMinified: result.ignored.filter((item) => item.reason === 'ALREADY_MINIFIED').length,
    eligible: result.eligible.length,
    ignoredByReason,
  };
  return result;
}

function baseItem(event, fileType) {
  return {
    normalizedPath: event.normalizedPath ?? normalizeAbsolutePath(event.path),
    relativePath: event.relativePath ?? '',
    sourceId: event.sourceId,
    fileType,
  };
}

function ignoredItem(event, fileType, reason, extra = {}) {
  return {
    ...baseItem(event, fileType),
    status: 'ignored',
    reason,
    ...extra,
  };
}


function scannerFailure(code, message, details = {}) {
  throw new ScannerError(code, message, { ...details, operation: 'discovery', modified: false });
}

function relativeIdentity(value) {
  return win32.normalize(value).replaceAll('\\', '/').toLowerCase();
}

function validateRelativeEntries(values, field) {
  if (!Array.isArray(values)) scannerFailure('INVALID_V2_CONFIGURATION', `O campo '${field}' deve ser uma lista normalizada.`, { field });
  const identities = new Set();
  for (const value of values) {
    if (typeof value !== 'string' || value === '' || win32.isAbsolute(value) || /^[A-Za-z]:/.test(value) || GLOB_METACHARS.test(value) || value.split(/[\\/]+/).includes('..')) {
      scannerFailure('UNSAFE_V2_EXCLUSION', `A entrada '${value}' em '${field}' não é um caminho relativo seguro.`, { field, value });
    }
    const identity = relativeIdentity(value);
    if (identities.has(identity)) scannerFailure('DUPLICATE_V2_EXCLUSION', `A entrada '${value}' em '${field}' é duplicada após normalização.`, { field, value });
    identities.add(identity);
  }
  return identities;
}

function validateV2ScannerConfiguration(configuration) {
  if (!configuration || typeof configuration !== 'object' || configuration.schemaVersion !== 2) {
    scannerFailure('INVALID_V2_CONFIGURATION', 'O Scanner V2 exige uma configuração normalizada com schemaVersion=2.');
  }
  const projectRoot = configuration.projectRoot;
  const parsedRoot = typeof projectRoot === 'string' ? win32.parse(projectRoot).root : '';
  if (
    typeof projectRoot !== 'string'
    || projectRoot === ''
    || !win32.isAbsolute(projectRoot)
    || parsedRoot === '\\'
    || parsedRoot === '/'
    || parsedRoot === ''
    || projectRoot.split(/[\\/]+/).includes('..')
    || GLOB_METACHARS.test(projectRoot)
    || /%[^%]+%/.test(projectRoot)
  ) {
    scannerFailure('UNSAFE_PROJECT_ROOT', 'A raiz do projeto deve ser um caminho Windows absoluto com unidade ou UNC, sem traversal, curingas ou variáveis.', { projectRoot });
  }
  if (!Array.isArray(configuration.fileTypes) || configuration.fileTypes.length === 0 || new Set(configuration.fileTypes).size !== configuration.fileTypes.length || configuration.fileTypes.some((type) => !V2_FILE_TYPES.has(type))) {
    scannerFailure('INVALID_V2_FILE_TYPES', 'O Scanner V2 aceita somente a seleção normalizada de CSS e/ou JavaScript.', { fileTypes: configuration.fileTypes });
  }
  return {
    fileTypes: new Set(configuration.fileTypes),
    ignoredFolders: validateRelativeEntries(configuration.ignoredFolders, 'ignoredFolders'),
    ignoredFiles: validateRelativeEntries(configuration.ignoredFiles, 'ignoredFiles'),
  };
}

function recordError(result, event) {
  result.errors.push({
    normalizedPath: event.path,
    canonicalPath: event.canonicalPath,
    sourceId: event.sourceId,
    status: 'error',
    reason: event.reason,
    message: event.error?.message ?? 'A segurança ou acessibilidade do caminho não pôde ser comprovada.',
    operation: 'discovery',
    modified: false,
  });
}

export async function scanV2(configuration, options = {}) {
  const normalized = validateV2ScannerConfiguration(configuration);
  const temporaryDirectory = options.temporaryDirectory ?? resolveRuntimePaths(options.runtimeRoot).temporaryDirectory;
  const result = createResult();
  const events = await collectProjectEntries(configuration.projectRoot, configuration.ignoredFolders, { temporaryDirectory });
  const ignoredPhysicalIdentities = new Set(events
    .filter((event) => event.kind === 'file' && normalized.ignoredFiles.has(relativeIdentity(event.relativePath)))
    .map((event) => event.identity));
  const seenIdentities = new Map();

  for (const event of events) {
    if (event.kind === 'source-error' || event.kind === 'error') {
      recordError(result, event);
      continue;
    }
    if (event.kind === 'unsafe-path') {
      const reason = event.reason === 'CANONICAL_PATH_OUTSIDE_ROOT' ? 'UNSAFE_OUTSIDE_ROOT' : 'BLOCKED_FILESYSTEM_INDIRECTION';
      const item = ignoredItem(event, event.fileType, reason, { canonicalPath: event.canonicalPath, securityReason: event.reason });
      result.discovered.push(item);
      result.ignored.push(item);
      if (event.reason === 'CANONICAL_PATH_UNAVAILABLE') recordError(result, event);
      continue;
    }
    if (event.kind === 'link') {
      const item = ignoredItem(event, event.fileType, 'LINK_IGNORED', { target: event.target });
      result.discovered.push(item);
      result.ignored.push(item);
      continue;
    }
    if (event.kind === 'technical-exclusion') {
      const item = ignoredItem(event, event.fileType, event.reason);
      result.discovered.push(item);
      result.ignored.push(item);
      continue;
    }
    if (event.kind === 'ignored-folder') {
      const item = ignoredItem(event, 'directory', 'IGNORED_FOLDER');
      result.discovered.push(item);
      result.ignored.push(item);
      continue;
    }
    if (event.kind === 'unsupported-entry') {
      const item = ignoredItem(event, event.fileType, 'UNSUPPORTED_FILESYSTEM_ENTRY');
      result.discovered.push(item);
      result.ignored.push(item);
      continue;
    }
    if (event.kind !== 'file') continue;

    const extension = extname(event.normalizedPath).toLowerCase();
    const fileType = SUPPORTED_FILE_TYPES[extension];
    const discovered = baseItem(event, fileType ?? 'unknown');
    result.discovered.push(discovered);
    const relativePathIdentity = relativeIdentity(event.relativePath);

    if (!event.identityProven) {
      result.ignored.push(ignoredItem(event, fileType ?? 'unknown', 'UNPROVEN_FILE_IDENTITY'));
      recordError(result, { ...event, reason: 'UNPROVEN_FILE_IDENTITY', error: new Error('O arquivo possui múltiplos vínculos, mas sua identidade física não pôde ser provada.') });
      continue;
    }
    if (normalized.ignoredFiles.has(relativePathIdentity)) {
      result.ignored.push(ignoredItem(event, fileType ?? 'unknown', 'IGNORED_FILE'));
      continue;
    }
    if (ignoredPhysicalIdentities.has(event.identity)) {
      result.ignored.push(ignoredItem(event, fileType ?? 'unknown', 'IGNORED_FILE_ALIAS'));
      continue;
    }
    if (event.linkCount > 1) {
      result.ignored.push(ignoredItem(event, fileType ?? 'unknown', 'HARD_LINK_IGNORED'));
      continue;
    }
    if (MINIFIED_NAME.test(basename(event.normalizedPath))) {
      result.ignored.push(ignoredItem(event, fileType ?? 'unknown', 'ALREADY_MINIFIED'));
      continue;
    }
    if (!fileType) {
      result.ignored.push(ignoredItem(event, 'unknown', 'UNSUPPORTED_EXTENSION'));
      continue;
    }
    if (!normalized.fileTypes.has(fileType)) {
      result.ignored.push(ignoredItem(event, fileType, 'UNSELECTED_TYPE'));
      continue;
    }
    if (event.readonly) {
      result.ignored.push(ignoredItem(event, fileType, 'READONLY_FILE'));
      continue;
    }
    if (seenIdentities.has(event.identity)) {
      result.ignored.push(ignoredItem(event, fileType, 'DUPLICATE_PHYSICAL_FILE', { firstRelativePath: seenIdentities.get(event.identity) }));
      continue;
    }
    seenIdentities.set(event.identity, event.relativePath);
    result.eligible.push({ ...discovered, status: 'eligible' });
  }
  return finalizeResult(result);
}

export async function scan(configuration, options = {}) {
  return scanV2(configuration, options);
}

export { ScannerError } from './errors.js';
export { buildAnalysis, buildCandidateList, paginate, DEFAULT_PAGE_SIZE, FILE_TYPE_ORDER, REASON_LABELS } from './analysis.js';
