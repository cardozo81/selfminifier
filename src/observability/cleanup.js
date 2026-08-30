import { lstat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { assertPathHasNoLinks } from '../integrity/index.js';
import { inspectRegularFile, removeExactFile } from '../execution/filesystem.js';
import { isReadonlyFile } from '../scanner/filesystem.js';
import { listArtifacts } from './index.mjs';

const CANONICAL_LOG_NAME = /^tecnico-\d{8}-\d{6}(-\d{3})?\.log$/;
const CANONICAL_REPORT_NAME = /^execucao-\d{8}-\d{6}(-\d{3})?\.(txt|csv)$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

function categoryDirectory(projectRoot, kind) {
  return join(resolve(projectRoot), 'Dados', kind === 'logs' ? 'Logs' : 'Relatorios');
}

function isCanonicalName(kind, name) {
  return kind === 'logs' ? CANONICAL_LOG_NAME.test(name) : CANONICAL_REPORT_NAME.test(name);
}

function assertKind(kind) {
  if (kind !== 'logs' && kind !== 'reports') throw new Error('Tipo de artefato inválido.');
}

function assertProjectRoot(projectRoot) {
  if (typeof projectRoot !== 'string' || projectRoot.trim() === '') {
    const error = new Error('A limpeza exige uma pasta raiz explícita e válida.');
    error.code = 'PROJECT_ROOT_REQUIRED';
    throw error;
  }
}

export async function previewArtifactCleanup(projectRoot, kind) {
  assertProjectRoot(projectRoot);
  assertKind(kind);
  const directory = categoryDirectory(projectRoot, kind);
  await assertPathHasNoLinks(directory, { allowMissing: true });
  const names = (await listArtifacts(projectRoot, kind)).filter((name) => isCanonicalName(kind, name));
  const candidates = [];
  let totalBytes = 0;
  for (const name of names) {
    const filePath = join(directory, name);
    try {
      await assertPathHasNoLinks(filePath);
      const info = await inspectRegularFile(filePath);
      if (!info.exists) continue;
      candidates.push({ name, size: info.size, sha256: info.hash });
      totalBytes += info.size;
    } catch {
      // Entrada insegura ou inacessível não é candidata à exclusão.
    }
  }
  return Object.freeze({ status: 'preview', kind, candidateCount: candidates.length, totalBytes, candidates });
}

function normalizeSnapshot(kind, raw) {
  const list = Array.isArray(raw) ? raw : (raw == null ? [] : [raw]);
  return list.map((entry) => {
    const name = entry?.name;
    const sha256 = entry?.sha256;
    if (typeof name !== 'string' || basename(name) !== name || !isCanonicalName(kind, name)) {
      throw new Error('Nome de candidato inválido.');
    }
    if (typeof sha256 !== 'string' || !SHA256_HEX.test(sha256)) {
      throw new Error('Prova de candidato inválida.');
    }
    return { name, sha256 };
  });
}

export async function executeArtifactCleanup(projectRoot, kind, rawSnapshot) {
  assertProjectRoot(projectRoot);
  assertKind(kind);
  const candidates = normalizeSnapshot(kind, rawSnapshot);
  const directory = categoryDirectory(projectRoot, kind);
  const directoryProof = await assertPathHasNoLinks(directory, { allowMissing: true });
  const deleted = [];
  const skipped = [];
  const failed = [];
  for (const candidate of candidates) {
    const filePath = join(directory, candidate.name);
    if (!directoryProof.exists) {
      skipped.push({ name: candidate.name, reason: 'already-absent' });
      continue;
    }
    let proof;
    try {
      proof = await assertPathHasNoLinks(filePath, { allowMissing: true });
    } catch {
      skipped.push({ name: candidate.name, reason: 'unsafe' });
      continue;
    }
    if (!proof.exists) {
      skipped.push({ name: candidate.name, reason: 'already-absent' });
      continue;
    }
    let info;
    try {
      info = await inspectRegularFile(filePath);
    } catch {
      skipped.push({ name: candidate.name, reason: 'unsafe' });
      continue;
    }
    if (!info.exists) {
      skipped.push({ name: candidate.name, reason: 'already-absent' });
      continue;
    }
    if (info.hash !== candidate.sha256) {
      skipped.push({ name: candidate.name, reason: 'target-changed' });
      continue;
    }
    let readonly = false;
    try {
      readonly = await isReadonlyFile(filePath, await lstat(filePath));
    } catch {
      skipped.push({ name: candidate.name, reason: 'unsafe' });
      continue;
    }
    if (readonly) {
      skipped.push({ name: candidate.name, reason: 'readonly' });
      continue;
    }
    let removed;
    try {
      removed = await removeExactFile(filePath, candidate.sha256);
    } catch {
      failed.push({ name: candidate.name, reason: 'delete-failed' });
      continue;
    }
    if (removed) deleted.push(candidate.name);
    else skipped.push({ name: candidate.name, reason: 'target-changed' });
  }
  const status = skipped.length === 0 && failed.length === 0 ? 'completed' : 'partial';
  return Object.freeze({
    status,
    kind,
    deleted,
    skipped,
    failed,
    deletedCount: deleted.length,
    skippedCount: skipped.length,
    failedCount: failed.length,
  });
}
