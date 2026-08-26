import { win32 } from 'node:path';

export const DEFAULT_PAGE_SIZE = 10;

export const FILE_TYPE_ORDER = Object.freeze(['css', 'javascript']);

export const REASON_LABELS = Object.freeze({
  IGNORED_FOLDER: 'Pastas ignoradas',
  IGNORED_FILE: 'Arquivos ignorados',
  IGNORED_FILE_ALIAS: 'Alias de arquivo ignorado',
  UNSELECTED_TYPE: 'Tipo não selecionado',
  READONLY_FILE: 'Somente leitura',
  LINK_IGNORED: 'Link ou ponto de redirecionamento bloqueado',
  BLOCKED_FILESYSTEM_INDIRECTION: 'Indireção de arquivo bloqueada',
  UNSAFE_OUTSIDE_ROOT: 'Fora da raiz do projeto',
  MANDATORY_TECHNICAL_EXCLUSION: 'Exclusão técnica',
  HARD_LINK_IGNORED: 'Hard link',
  DUPLICATE_PHYSICAL_FILE: 'Arquivo físico duplicado',
  UNPROVEN_FILE_IDENTITY: 'Identidade não comprovada',
  UNSUPPORTED_EXTENSION: 'Extensão não suportada',
  UNSUPPORTED_FILESYSTEM_ENTRY: 'Entrada não suportada',
  ALREADY_MINIFIED: 'Já minificado',
  ALREADY_MINIFIED_BY_SELFMINIFIER: 'Já minificado pelo SelfMinifier',
  SELFMINIFIER_TAG_CONTENT_CHANGED: 'Conteúdo alterado após a SelfMinifier-Tag',
  SELFMINIFIER_TAG_UNKNOWN: 'SelfMinifier-Tag desconhecida',
  SELFMINIFIER_TAG_MULTIPLE: 'Múltiplas SelfMinifier-Tags',
  SELFMINIFIER_TAG_INVALID: 'SelfMinifier-Tag inválida',
  EXCLUDED_BY_PATTERN: 'Excluído por padrão',
  NO_SELECTION_PATTERN: 'Sem padrão de seleção',
  NOT_INCLUDED_BY_PATTERN: 'Não incluído por padrão',
});

const REASON_ORDER = Object.freeze([
  'IGNORED_FOLDER',
  'IGNORED_FILE',
  'IGNORED_FILE_ALIAS',
  'UNSELECTED_TYPE',
  'READONLY_FILE',
  'LINK_IGNORED',
  'BLOCKED_FILESYSTEM_INDIRECTION',
  'UNSAFE_OUTSIDE_ROOT',
  'MANDATORY_TECHNICAL_EXCLUSION',
  'HARD_LINK_IGNORED',
  'DUPLICATE_PHYSICAL_FILE',
  'UNPROVEN_FILE_IDENTITY',
  'UNSUPPORTED_EXTENSION',
  'UNSUPPORTED_FILESYSTEM_ENTRY',
  'ALREADY_MINIFIED',
  'ALREADY_MINIFIED_BY_SELFMINIFIER',
  'SELFMINIFIER_TAG_CONTENT_CHANGED',
  'SELFMINIFIER_TAG_UNKNOWN',
  'SELFMINIFIER_TAG_MULTIPLE',
  'SELFMINIFIER_TAG_INVALID',
  'EXCLUDED_BY_PATTERN',
  'NO_SELECTION_PATTERN',
  'NOT_INCLUDED_BY_PATTERN',
]);

function comparableRelative(value) {
  const normalized = win32.normalize(String(value ?? '')).replaceAll('\\', '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function sortCandidates(items) {
  return [...items].sort((left, right) => {
    const leftKey = comparableRelative(left.relativePath);
    const rightKey = comparableRelative(right.relativePath);
    if (leftKey < rightKey) return -1;
    if (leftKey > rightKey) return 1;
    return String(left.sourceId ?? '').localeCompare(String(right.sourceId ?? ''));
  });
}

function toCandidate(item) {
  return {
    relativePath: item.relativePath ?? '',
    fileType: item.fileType,
    sourceId: item.sourceId,
  };
}

function buildCandidates(eligible) {
  const byType = { css: [], javascript: [] };
  for (const item of eligible ?? []) {
    if (item.fileType === 'css') byType.css.push(item);
    else if (item.fileType === 'javascript') byType.javascript.push(item);
  }
  return {
    css: sortCandidates(byType.css).map(toCandidate),
    javascript: sortCandidates(byType.javascript).map(toCandidate),
  };
}

function buildReasonBreakdown(ignored) {
  const countsByReason = new Map();
  for (const item of ignored ?? []) {
    const reason = item.reason ?? 'UNCLASSIFIED';
    countsByReason.set(reason, (countsByReason.get(reason) ?? 0) + 1);
  }
  return [...countsByReason.entries()]
    .map(([reason, count]) => ({ reason, label: REASON_LABELS[reason] ?? reason, count }))
    .sort((left, right) => {
      const leftIndex = REASON_ORDER.indexOf(left.reason);
      const rightIndex = REASON_ORDER.indexOf(right.reason);
      const leftOrder = leftIndex === -1 ? REASON_ORDER.length : leftIndex;
      const rightOrder = rightIndex === -1 ? REASON_ORDER.length : rightIndex;
      if (leftOrder !== rightOrder) return leftOrder - rightOrder;
      return left.reason.localeCompare(right.reason);
    });
}

export function buildAnalysis(scannerResult, { projectRoot = null, fileTypes = [], ignoredFolders = [], ignoredFiles = [] } = {}) {
  const eligible = scannerResult?.eligible ?? [];
  const ignored = scannerResult?.ignored ?? [];
  return {
    projectRoot,
    fileTypes: [...fileTypes],
    exclusions: { folders: ignoredFolders.length, files: ignoredFiles.length },
    counts: {
      cssFound: scannerResult?.counts?.cssFound ?? 0,
      javascriptFound: scannerResult?.counts?.javascriptFound ?? 0,
      ignored: scannerResult?.counts?.ignored ?? ignored.length,
      alreadyMinified: scannerResult?.counts?.alreadyMinified ?? 0,
      eligible: scannerResult?.counts?.eligible ?? eligible.length,
      candidateBytes: scannerResult?.counts?.candidateBytes ?? 0,
    },
    ignoredByReason: buildReasonBreakdown(ignored),
    candidates: buildCandidates(eligible),
    errors: scannerResult?.errors ?? [],
    warnings: scannerResult?.warnings ?? [],
  };
}

export function buildCandidateList(candidates) {
  return [...(candidates?.css ?? []), ...(candidates?.javascript ?? [])];
}

export function paginate(items, page, pageSize = DEFAULT_PAGE_SIZE) {
  const totalItems = items.length;
  const safePageSize = Math.max(1, Math.floor(Number(pageSize) || DEFAULT_PAGE_SIZE));
  const totalPages = totalItems === 0 ? 1 : Math.ceil(totalItems / safePageSize);
  const safePage = Math.min(Math.max(1, Math.floor(Number(page) || 1)), totalPages);
  const start = (safePage - 1) * safePageSize;
  return {
    items: items.slice(start, start + safePageSize),
    page: safePage,
    pageSize: safePageSize,
    totalItems,
    totalPages,
  };
}
