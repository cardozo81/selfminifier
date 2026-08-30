import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBridgeRequest } from '../src/app/bridge.mjs';

const windowsTest = process.platform === 'win32' ? test : test.skip;

const LOG_NAME = 'tecnico-20260829-133000.log';
const LOG_NAME_2 = 'tecnico-20260829-134500.log';
const TXT_NAME = 'execucao-20260829-133000.txt';
const CSV_NAME = 'execucao-20260829-133000.csv';

async function tempRoot() {
  return mkdtemp(join(tmpdir(), 'selfminifier-d2-'));
}

async function exists(filePath) {
  try { await lstat(filePath); return true; } catch { return false; }
}

function preview(root, kind) {
  return runBridgeRequest({ command: 'cleanup-artifacts', kind, confirmed: false }, { projectRoot: root });
}

function execute(root, kind, candidates) {
  return runBridgeRequest({ command: 'cleanup-artifacts', kind, confirmed: true, candidates }, { projectRoot: root });
}

test('preview não deleta e relata candidatos canônicos', async () => {
  const root = await tempRoot();
  try {
    const dir = join(root, 'Dados', 'Logs');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, LOG_NAME), 'conteúdo', 'utf8');
    await writeFile(join(dir, 'manual.log'), 'estrangeiro', 'utf8');
    const response = await preview(root, 'logs');
    assert.equal(response.ok, true);
    assert.equal(response.status, 'preview');
    assert.equal(response.candidateCount, 1);
    assert.ok(response.totalBytes > 0);
    assert.equal(response.candidates.length, 1);
    assert.equal(response.candidates[0].name, LOG_NAME);
    assert.equal(await exists(join(dir, LOG_NAME)), true);
    assert.equal(await exists(join(dir, 'manual.log')), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('omissão de projectRoot falha fechado sem descobrir ou mutar a raiz real', async () => {
  const preview = await runBridgeRequest({ command: 'cleanup-artifacts', kind: 'logs', confirmed: false });
  assert.equal(preview.ok, false);
  assert.equal(preview.diagnostic.code, 'PROJECT_ROOT_REQUIRED');
  const execution = await runBridgeRequest({ command: 'cleanup-artifacts', kind: 'logs', confirmed: true, candidates: [] });
  assert.equal(execution.ok, false);
  assert.equal(execution.diagnostic.code, 'PROJECT_ROOT_REQUIRED');
});

test('confirmação remove logs canônicos e preserva arquivo estrangeiro', async () => {
  const root = await tempRoot();
  try {
    const dir = join(root, 'Dados', 'Logs');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, LOG_NAME), 'conteúdo', 'utf8');
    await writeFile(join(dir, 'manual.log'), 'estrangeiro', 'utf8');
    const response = await preview(root, 'logs');
    const result = await execute(root, 'logs', response.candidates);
    assert.equal(result.ok, true);
    assert.equal(result.status, 'completed');
    assert.deepEqual(result.deleted, [LOG_NAME]);
    assert.equal(result.deletedCount, 1);
    assert.equal(result.skippedCount, 0);
    assert.equal(await exists(join(dir, LOG_NAME)), false);
    assert.equal(await exists(join(dir, 'manual.log')), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('limpeza de relatórios remove txt e csv canônicos e preserva estrangeiro', async () => {
  const root = await tempRoot();
  try {
    const dir = join(root, 'Dados', 'Relatorios');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, TXT_NAME), 'a', 'utf8');
    await writeFile(join(dir, CSV_NAME), 'b', 'utf8');
    await writeFile(join(dir, 'manual.txt'), 'c', 'utf8');
    const response = await preview(root, 'reports');
    assert.equal(response.candidateCount, 2);
    const result = await execute(root, 'reports', response.candidates);
    assert.equal(result.status, 'completed');
    assert.equal(result.deletedCount, 2);
    assert.equal(await exists(join(dir, TXT_NAME)), false);
    assert.equal(await exists(join(dir, CSV_NAME)), false);
    assert.equal(await exists(join(dir, 'manual.txt')), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('arquivo criado após a prévia permanece intacto', async () => {
  const root = await tempRoot();
  try {
    const dir = join(root, 'Dados', 'Logs');
    await mkdir(dir, { recursive: true });
    const response = await preview(root, 'logs');
    assert.equal(response.candidateCount, 0);
    await writeFile(join(dir, LOG_NAME), 'novo', 'utf8');
    const result = await execute(root, 'logs', response.candidates);
    assert.equal(result.ok, true);
    assert.equal(result.deletedCount, 0);
    assert.equal(await exists(join(dir, LOG_NAME)), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('arquivo alterado após a prévia não é removido', async () => {
  const root = await tempRoot();
  try {
    const dir = join(root, 'Dados', 'Logs');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, LOG_NAME), 'original', 'utf8');
    const response = await preview(root, 'logs');
    await writeFile(join(dir, LOG_NAME), 'alterado', 'utf8');
    const result = await execute(root, 'logs', response.candidates);
    assert.equal(result.ok, true);
    assert.equal(result.status, 'partial');
    assert.equal(result.skippedCount, 1);
    assert.equal(result.skipped[0].reason, 'target-changed');
    assert.equal(await readFile(join(dir, LOG_NAME), 'utf8'), 'alterado');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('arquivo desaparecido após a prévia é no-op factual', async () => {
  const root = await tempRoot();
  try {
    const dir = join(root, 'Dados', 'Logs');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, LOG_NAME), 'x', 'utf8');
    const response = await preview(root, 'logs');
    await rm(join(dir, LOG_NAME));
    const result = await execute(root, 'logs', response.candidates);
    assert.equal(result.ok, true);
    assert.equal(result.deletedCount, 0);
    assert.equal(result.skippedCount, 1);
    assert.equal(result.skipped[0].reason, 'already-absent');
  } finally { await rm(root, { recursive: true, force: true }); }
});

windowsTest('somente leitura é pulado e falha parcial não relata sucesso total', async (t) => {
  const root = await tempRoot();
  const readonlyFile = join(root, 'Dados', 'Logs', LOG_NAME_2);
  let madeReadonly = false;
  try {
    const dir = join(root, 'Dados', 'Logs');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, LOG_NAME), 'removível', 'utf8');
    await writeFile(readonlyFile, 'protegido', 'utf8');
    await chmod(readonlyFile, 0o444);
    if ((await lstat(readonlyFile)).mode & 0o222) { t.skip('filesystem does not expose readonly mode'); return; }
    madeReadonly = true;
    const response = await preview(root, 'logs');
    assert.equal(response.candidateCount, 2);
    const result = await execute(root, 'logs', response.candidates);
    assert.equal(result.status, 'partial');
    assert.equal(result.deletedCount, 1);
    assert.deepEqual(result.deleted, [LOG_NAME]);
    assert.equal(result.skippedCount, 1);
    assert.equal(result.skipped[0].name, LOG_NAME_2);
    assert.equal(result.skipped[0].reason, 'readonly');
    assert.equal(await exists(join(dir, LOG_NAME)), false);
    assert.equal(await exists(readonlyFile), true);
  } finally {
    if (madeReadonly) await chmod(readonlyFile, 0o666).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

windowsTest('candidato que virou junction é pulado como inseguro', async (t) => {
  const root = await tempRoot();
  const external = await mkdtemp(join(tmpdir(), 'selfminifier-d2-ext-'));
  try {
    const dir = join(root, 'Dados', 'Logs');
    await mkdir(dir, { recursive: true });
    const file = join(dir, LOG_NAME);
    await writeFile(file, 'x', 'utf8');
    await writeFile(join(external, 'alvo.log'), 'fora', 'utf8');
    const response = await preview(root, 'logs');
    assert.equal(response.candidateCount, 1);
    await rm(file);
    try {
      await symlink(external, file, 'junction');
    } catch {
      t.skip('criação de junction indisponível');
      return;
    }
    const result = await execute(root, 'logs', response.candidates);
    assert.equal(result.ok, true);
    assert.equal(result.status, 'partial');
    assert.equal(result.skippedCount, 1);
    assert.equal(result.skipped[0].reason, 'unsafe');
    assert.equal(await exists(join(external, 'alvo.log')), true);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
});

test('nomes inseguros de candidato são rejeitados (fail-closed)', async () => {
  const root = await tempRoot();
  try {
    const sha = 'a'.repeat(64);
    const traversal = await runBridgeRequest({ command: 'cleanup-artifacts', kind: 'logs', confirmed: true, candidates: [{ name: '..\\segredo.log', sha256: sha }] }, { projectRoot: root });
    assert.equal(traversal.ok, false);
    const badHash = await runBridgeRequest({ command: 'cleanup-artifacts', kind: 'logs', confirmed: true, candidates: [{ name: LOG_NAME, sha256: 'not-a-hash' }] }, { projectRoot: root });
    assert.equal(badHash.ok, false);
    const foreign = await runBridgeRequest({ command: 'cleanup-artifacts', kind: 'logs', confirmed: true, candidates: [{ name: 'manual.log', sha256: sha }] }, { projectRoot: root });
    assert.equal(foreign.ok, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('limpeza não altera backups nem histórico', async () => {
  const root = await tempRoot();
  try {
    await mkdir(join(root, 'Dados', 'Logs'), { recursive: true });
    await mkdir(join(root, '_source_versions'), { recursive: true });
    await mkdir(join(root, 'Dados', 'Historico'), { recursive: true });
    await writeFile(join(root, 'Dados', 'Logs', LOG_NAME), 'x', 'utf8');
    await writeFile(join(root, '_source_versions', 'backup.gz'), 'b', 'utf8');
    await writeFile(join(root, 'Dados', 'Historico', 'record.json'), 'h', 'utf8');
    const response = await preview(root, 'logs');
    const result = await execute(root, 'logs', response.candidates);
    assert.equal(result.status, 'completed');
    assert.equal(await exists(join(root, 'Dados', 'Logs', LOG_NAME)), false);
    assert.equal(await exists(join(root, '_source_versions', 'backup.gz')), true);
    assert.equal(await exists(join(root, 'Dados', 'Historico', 'record.json')), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
