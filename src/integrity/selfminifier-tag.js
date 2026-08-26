import { IntegrityError } from './errors.js';
import { ARTIFACT_ID_PATTERN, findHistoricalArtifact } from './history.js';

export const SELFMINIFIER_TAG_NAME = 'SelfMinifier-Tag';
export const NO_SELFMINIFIER_TAG = 'NO_SELFMINIFIER_TAG';

const EXACT_TAG_PATTERN = /^\/\*! SelfMinifier-Tag: ([A-F0-9]{24}) \*\/$/;
const RESERVED_TAG_ATTEMPT = /^!?\s*SelfMinifier-Tag(?:\s|:|$)/i;

function blockComments(content, fileType) {
  const comments = [];
  let index = 0;
  let quote = null;

  while (index < content.length) {
    const character = content[index];
    const next = content[index + 1];

    if (quote !== null) {
      if (character === '\\') {
        index += 2;
        continue;
      }
      if (character === quote) quote = null;
      index += 1;
      continue;
    }

    if (character === '"' || character === "'" || (fileType === 'javascript' && character === '`')) {
      quote = character;
      index += 1;
      continue;
    }

    if (fileType === 'javascript' && character === '/' && next === '/') {
      const start = index;
      index += 2;
      while (index < content.length && content[index] !== '\n' && content[index] !== '\r') index += 1;
      comments.push({ start, end: index, text: content.slice(start, index), kind: 'line' });
      continue;
    }

    if (character === '/' && next === '*') {
      const start = index;
      const end = content.indexOf('*/', index + 2);
      if (end === -1) {
        comments.push({ start, end: content.length, text: content.slice(start), kind: 'unterminated-block' });
        break;
      }
      comments.push({ start, end: end + 2, text: content.slice(start, end + 2) });
      index = end + 2;
      continue;
    }

    index += 1;
  }

  return comments;
}

function markerAttempt(comment) {
  const body = comment.kind === 'line'
    ? comment.text.slice(2).trim()
    : comment.text.slice(2, comment.kind === 'unterminated-block' ? undefined : -2).trim();
  return RESERVED_TAG_ATTEMPT.test(body);
}

export function createSelfMinifierTag(artifactId) {
  if (!ARTIFACT_ID_PATTERN.test(artifactId)) {
    throw new IntegrityError('INVALID_ARTIFACT_ID', 'O artifactId da SelfMinifier-Tag é inválido.');
  }
  return `/*! ${SELFMINIFIER_TAG_NAME}: ${artifactId} */`;
}

export function inspectSelfMinifierTags(content, fileType) {
  if (typeof content !== 'string' || !['javascript', 'css'].includes(fileType)) {
    throw new IntegrityError('INVALID_SELFMINIFIER_TAG_INPUT', 'A inspeção da SelfMinifier-Tag exige conteúdo textual CSS ou JavaScript.');
  }
  const exact = [];
  const invalid = [];
  for (const comment of blockComments(content, fileType)) {
    const match = EXACT_TAG_PATTERN.exec(comment.text);
    if (match) exact.push({ ...comment, artifactId: match[1] });
    else if (markerAttempt(comment)) invalid.push(comment);
  }
  return { exact, invalid };
}

export async function classifySelfMinifierTag({ content, fileType, currentHash, historyDirectory }) {
  const inspected = inspectSelfMinifierTags(content, fileType);
  if (inspected.exact.length > 1) {
    return { reason: 'SELFMINIFIER_TAG_MULTIPLE', artifactId: null, historicalOutputHash: null };
  }
  if (inspected.invalid.length > 0) {
    return { reason: 'SELFMINIFIER_TAG_INVALID', artifactId: inspected.exact[0]?.artifactId ?? null, historicalOutputHash: null };
  }
  if (inspected.exact.length === 0) {
    return { reason: NO_SELFMINIFIER_TAG, artifactId: null, historicalOutputHash: null };
  }

  const artifactId = inspected.exact[0].artifactId;
  const historical = await findHistoricalArtifact(historyDirectory, artifactId);
  if (!historical) {
    return { reason: 'SELFMINIFIER_TAG_UNKNOWN', artifactId, historicalOutputHash: null };
  }
  if (historical.artifact.outputHash !== currentHash) {
    return {
      reason: 'SELFMINIFIER_TAG_CONTENT_CHANGED',
      artifactId,
      historicalOutputHash: historical.artifact.outputHash,
      historicalExecutionId: historical.execution.executionId,
    };
  }
  return {
    reason: 'ALREADY_MINIFIED_BY_SELFMINIFIER',
    artifactId,
    historicalOutputHash: historical.artifact.outputHash,
    historicalExecutionId: historical.execution.executionId,
  };
}

function splitBom(content) {
  return content.startsWith('\uFEFF') ? { prefix: '\uFEFF', body: content.slice(1) } : { prefix: '', body: content };
}

export function insertSelfMinifierTag(content, fileType, artifactId) {
  const inspected = inspectSelfMinifierTags(content, fileType);
  if (inspected.exact.length > 0 || inspected.invalid.length > 0) {
    throw new IntegrityError('SELFMINIFIER_TAG_ACCUMULATION_BLOCKED', 'A saída já contém uma SelfMinifier-Tag ou uma tentativa inválida no namespace reservado.');
  }

  const marker = createSelfMinifierTag(artifactId);
  const { prefix, body } = splitBom(content);

  if (fileType === 'javascript') {
    const shebang = /^(#![^\r\n]*)(\r\n|\n|\r)?/.exec(body);
    if (shebang) {
      const separator = shebang[2] ?? '\n';
      return `${prefix}${shebang[1]}${separator}${marker}\n${body.slice(shebang[0].length)}`;
    }
    return `${prefix}${marker}\n${body}`;
  }

  const charset = /^@charset[ \t]+"[^"\r\n]+";/i.exec(body);
  if (charset) return `${prefix}${charset[0]}\n${marker}\n${body.slice(charset[0].length)}`;
  return `${prefix}${marker}\n${body}`;
}
