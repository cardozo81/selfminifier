import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBridgeRequest } from '../src/app/bridge.mjs';
import { measureStorageDirectory, summarizeStorageUsage } from '../src/observability/storage.js';

const windowsTest = process.platform === 'win32' ? test : test.skip;

function ini({ schemaVersion = 2, projectRoot, backupRoot, outputMode = 'BackupESobrescreverOriginais' } = {}) {
  const lines = [
    '[Configuracao]',
    `VersaoSchema=${schemaVersion}`,
    'Motor=esbuild',
    'Perfil=Padrao',
    `ModoSaida=${outputMode}`,
    `PastaRaiz=${projectRoot}`,
  ];
  if (schemaVersion === 3 && backupRoot !== undefined) lines.push(`PastaBackups=${backupRoot ?? ''}`);
  lines.push('TiposArquivo=JavaScript');
  return `${lines.join('\n')}\n`;
}

async function snapshot(directory) {
  return (await readdir(directory, { recursive: true })).sort();
}

test('raiz ausente resulta em zero e completa', async () => {
  const missing = join(tmpdir(), `selfminifier-storage-ausente-${process.pid}-${Date.now()}`);
  const result = await measureStorageDirectory(missing);
  assert.equal(result.status, 'absent');
  assert.equal(result.bytes, 0);
  assert.equal(result.complete, true);
});

test('mede bytes exatos de arquivos regulares em árvore', async () => {
  const root = await mkdtemp(join(tmpdir(), 'selfminifier-storage-'));
  try {
    await writeFile(join(root, 'a.txt'), 'x'.repeat(3), 'utf8');
    await mkdir(join(root, 'sub'));
    await writeFile(join(root, 'sub', 'b.txt'), 'y'.repeat(5), 'utf8');
    const result = await measureStorageDirectory(root);
    assert.equal(result.status, 'present');
    assert.equal(result.bytes, 8);
    assert.equal(result.complete, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

windowsTest('não percorre junction', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'selfminifier-storage-link-'));
  const external = await mkdtemp(join(tmpdir(), 'selfminifier-storage-external-'));
  try {
    await writeFile(join(external, 'fora.txt'), 'x'.repeat(100), 'utf8');
    await writeFile(join(root, 'dentro.txt'), 'y'.repeat(7), 'utf8');
    try {
      await symlink(external, join(root, 'link-externo'), 'junction');
    } catch {
      t.skip('criação de junction indisponível');
      return;
    }
    const result = await measureStorageDirectory(root);
    assert.equal(result.status, 'present');
    assert.equal(result.bytes, 7);
    assert.equal(result.complete, true);
  } finally {
    await rm(join(root, 'link-externo'), { recursive: true, force: true }).catch(() => {});
    await rm(external, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('total é a soma das quatro categorias contabilizadas', () => {
  const categories = [
    { key: 'backups', label: 'Backups', status: 'present', bytes: 10, complete: true },
    { key: 'history', label: 'Histórico', status: 'present', bytes: 20, complete: true },
    { key: 'reports', label: 'Relatórios', status: 'present', bytes: 30, complete: true },
    { key: 'logs', label: 'Logs técnicos', status: 'present', bytes: 40, complete: true },
  ];
  const summary = summarizeStorageUsage(categories);
  assert.equal(summary.totalContabilizado, 100);
  assert.equal(summary.complete, true);
});

test('total fica incompleto quando qualquer categoria é parcial ou indisponível', () => {
  const summary = summarizeStorageUsage([
    { status: 'present', bytes: 10, complete: true },
    { status: 'partial', bytes: 5, complete: false },
    { status: 'present', bytes: 20, complete: true },
    { status: 'present', bytes: 30, complete: true },
  ]);
  assert.equal(summary.totalContabilizado, 65);
  assert.equal(summary.complete, false);
});

test('categoria raiz indisponível nunca é reportada como completa', async () => {
  const root = await mkdtemp(join(tmpdir(), 'selfminifier-storage-indisp-'));
  try {
    await mkdir(join(root, 'Dados'), { recursive: true });
    await writeFile(join(root, 'Dados', 'Historico'), 'não é diretório', 'utf8');
    const result = await measureStorageDirectory(join(root, 'Dados', 'Historico'));
    assert.equal(result.status, 'unavailable');
    assert.equal(result.bytes, 0);
    assert.equal(result.complete, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('bridge storage-usage exclui estado técnico, recuperação e temporários e não escreve', async () => {
  const root = await mkdtemp(join(tmpdir(), 'selfminifier-storage-bridge-'));
  try {
    const projectRoot = join(root, 'projeto');
    await mkdir(projectRoot);
    await mkdir(join(root, 'Configuracao'));
    await writeFile(join(root, 'Configuracao', 'configuracao.ini'), ini({ projectRoot }), 'utf8');

    await mkdir(join(root, 'Dados', 'Historico'), { recursive: true });
    await mkdir(join(root, 'Dados', 'Relatorios'), { recursive: true });
    await mkdir(join(root, 'Dados', 'Logs'), { recursive: true });
    await mkdir(join(root, 'Dados', 'Restauracao'), { recursive: true });
    await mkdir(join(root, 'Dados', 'Temporarios'), { recursive: true });

    await writeFile(join(root, 'Dados', 'Historico', 'exec-1.json'), 'a'.repeat(11), 'utf8');
    await writeFile(join(root, 'Dados', 'Relatorios', 'execucao-1.txt'), 'b'.repeat(13), 'utf8');
    await writeFile(join(root, 'Dados', 'Relatorios', 'execucao-1.csv'), 'c'.repeat(17), 'utf8');
    await writeFile(join(root, 'Dados', 'Logs', 'tecnico-1.log'), 'd'.repeat(19), 'utf8');
    await writeFile(join(root, 'Dados', 'estado.json'), 'e'.repeat(23), 'utf8');
    await writeFile(join(root, 'Dados', 'Restauracao', 'ultima-execucao.bkp'), 'f'.repeat(29), 'utf8');
    await writeFile(join(root, 'Dados', 'Temporarios', 'tmp.txt'), 'g'.repeat(31), 'utf8');

    const before = await snapshot(root);
    const response = await runBridgeRequest({ command: 'storage-usage' }, { projectRoot: root });
    const after = await snapshot(root);

    assert.equal(response.ok, true);
    assert.equal(response.totalContabilizado, 11 + 13 + 17 + 19);
    assert.equal(response.complete, true);
    const byKey = Object.fromEntries(response.categories.map((category) => [category.key, category]));
    assert.equal(byKey.history.bytes, 11);
    assert.equal(byKey.reports.bytes, 13 + 17);
    assert.equal(byKey.logs.bytes, 19);
    assert.equal(byKey.backups.status, 'absent');
    assert.equal(byKey.backups.bytes, 0);
    assert.deepEqual(after, before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('bridge mede raiz externa de backups com segurança em modo read-only', async () => {
  const root = await mkdtemp(join(tmpdir(), 'selfminifier-storage-externo-'));
  try {
    const projectRoot = join(root, 'projeto');
    const backupRoot = join(root, 'backups-externos');
    await mkdir(projectRoot);
    await mkdir(join(backupRoot, 'exec-1', 'origem-001'), { recursive: true });
    await writeFile(join(backupRoot, 'exec-1', 'origem-001', 'arquivo.js.gz'), 'h'.repeat(37), 'utf8');
    await writeFile(join(backupRoot, 'exec-1', 'manifest.json'), 'i'.repeat(41), 'utf8');
    await mkdir(join(root, 'Configuracao'));
    await writeFile(join(root, 'Configuracao', 'configuracao.ini'), ini({ schemaVersion: 3, projectRoot, backupRoot }), 'utf8');

    const response = await runBridgeRequest({ command: 'storage-usage' }, { projectRoot: root });
    assert.equal(response.ok, true);
    const backups = response.categories.find((category) => category.key === 'backups');
    assert.equal(backups.status, 'present');
    assert.equal(backups.mode, 'external');
    assert.equal(backups.bytes, 37 + 41);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
