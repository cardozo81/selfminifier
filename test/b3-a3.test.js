import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { gunzipSync, gzipSync } from 'node:zlib';
import { runBridgeRequest } from '../src/app/bridge.mjs';
import { OUTPUT_MODES } from '../src/domain/index.js';
import {
  hashContentSha256,
  readBackupManifest,
  readHistoricalExecutionRecord,
  validateBackupManifest,
} from '../src/integrity/index.js';
import { createBackupRestorePlan, executeRestorePlan } from '../src/restore/index.js';
import { resolveRuntimePaths } from '../src/runtime/paths.js';

function ini({ schemaVersion = 2, projectRoot, backupRoot, outputMode = OUTPUT_MODES.BACKUP_OVERWRITE } = {}) {
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

async function fixture({ schemaVersion = 2, backupRoot, outputMode = OUTPUT_MODES.BACKUP_OVERWRITE } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'selfminifier-b3-a3-'));
  const projectRoot = join(root, 'projeto');
  const externalA = join(root, 'backups-externos-a');
  await mkdir(projectRoot);
  await mkdir(externalA);
  await writeFile(join(projectRoot, 'entrada.js'), 'function somar(a, b) { return a + b; }\n', 'utf8');
  await mkdir(join(root, 'Configuracao'));
  await writeFile(join(root, 'Configuracao', 'configuracao.ini'), ini({ schemaVersion, projectRoot, backupRoot, outputMode }), 'utf8');
  return { root, projectRoot, externalA, source: join(projectRoot, 'entrada.js') };
}

async function analyzeAndExecute(root, executionId) {
  const analyzed = await runBridgeRequest({ command: 'analyze', executionId }, { projectRoot: root });
  assert.equal(analyzed.ok, true, analyzed.diagnostic?.message);
  const executed = await runBridgeRequest({
    command: 'execute',
    confirmed: true,
    confirmationFingerprint: analyzed.analysis.confirmationFingerprint,
    executionId,
  }, { projectRoot: root });
  assert.equal(executed.ok, true, executed.diagnostic?.message);
  return executed;
}

test('manifesto aceita somente v3 gzip e rejeita versões ou compressão inválidas', () => {
  const root = join(tmpdir(), 'selfminifier-b3-a3-manifesto');
  const originalPath = join(root, 'entrada.js');
  const entryV3 = {
    originId: 'origem-project-root',
    originalPath,
    backupRelativePath: 'exec-001/origem-project-root/entrada.js.gz',
    compression: 'gzip',
    engine: 'esbuild',
    engineVersion: null,
    profile: 'Padrao',
    executionRisk: null,
    originalSize: 40,
    originalSha256: 'a'.repeat(64),
    minifiedSize: 20,
    minifiedSha256: 'b'.repeat(64),
    status: 'minificado',
    minificationDate: null,
  };
  const header = { executionId: 'exec-001', timestamp: 'x', selfMinifierVersion: null, origins: [{ originId: 'origem-project-root', rootPath: root }] };
  validateBackupManifest({ ...header, formatVersion: 3, files: [entryV3] });

  assert.throws(() => validateBackupManifest({ formatVersion: 1 }), (error) => error.code === 'INVALID_MANIFEST');
  assert.throws(() => validateBackupManifest({ formatVersion: 2 }), (error) => error.code === 'INVALID_MANIFEST');
  assert.throws(() => validateBackupManifest({ formatVersion: 4 }), (error) => error.code === 'INVALID_MANIFEST');
  assert.throws(() => validateBackupManifest({ ...header, formatVersion: 3, files: [{ ...entryV3, compression: 'zip' }] }), (error) => error.code === 'INVALID_MANIFEST');
  assert.throws(() => validateBackupManifest({ ...header, formatVersion: 3, files: [{ ...entryV3, compression: undefined }] }), (error) => error.code === 'INVALID_MANIFEST');
});

test('sobrescrita V2 cria payload .gz com manifesto v3 e histórico gzip', async () => {
  const paths = await fixture();
  try {
    const original = await readFile(paths.source, 'utf8');
    const executionId = 'b3-a3-internal';
    const executed = await analyzeAndExecute(paths.root, executionId);
    assert.equal(executed.result.status, 'completed');

    const manifest = await readBackupManifest(executed.result.manifestPath);
    assert.equal(manifest.formatVersion, 3);
    assert.equal(manifest.files.length, 1);
    assert.equal(manifest.files[0].compression, 'gzip');
    assert.ok(manifest.files[0].backupRelativePath.endsWith('.gz'));

    const backupPath = join(paths.root, '_source_versions', manifest.files[0].backupRelativePath);
    assert.equal((await lstat(backupPath)).isFile(), true);
    assert.equal(manifest.files[0].originalSha256, hashContentSha256(original));
    assert.equal(gunzipSync(await readFile(backupPath)).toString('utf8'), original);

    const history = await readHistoricalExecutionRecord(resolveRuntimePaths(paths.root).historyDirectory, executionId);
    assert.equal(history.artifacts[0].backup.compression, 'gzip');
    assert.equal(history.artifacts[0].backup.originalHash, hashContentSha256(original));
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test('sobrescrita V3 cria .gz na raiz externa de backups', async () => {
  const paths = await fixture({ schemaVersion: 3, backupRoot: null });
  try {
    await runBridgeRequest({ command: 'update-backup-root', backupRoot: paths.externalA, confirmed: true }, { projectRoot: paths.root });
    const executionId = 'b3-a3-external';
    const executed = await analyzeAndExecute(paths.root, executionId);
    const manifest = await readBackupManifest(executed.result.manifestPath);
    assert.equal(manifest.formatVersion, 3);
    assert.ok(manifest.files[0].backupRelativePath.endsWith('.gz'));
    assert.equal((await lstat(join(paths.externalA, manifest.files[0].backupRelativePath))).isFile(), true);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test('restauração v3 gzip descompacta e restaura a fonte original', async () => {
  const paths = await fixture();
  try {
    const original = await readFile(paths.source, 'utf8');
    const executionId = 'b3-a3-restore';
    await analyzeAndExecute(paths.root, executionId);
    const directory = join(paths.root, '_source_versions', executionId);
    const plan = await createBackupRestorePlan({ projectRoot: paths.root, backupDirectory: directory });
    assert.equal(plan.items[0].backupCompression, 'gzip');
    const result = await executeRestorePlan(plan, { confirmed: true });
    assert.equal(result.items[0].status, 'restored');
    assert.equal(await readFile(paths.source, 'utf8'), original);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test('gzip corrompido, truncado, ausente ou com SHA divergente bloqueia a restauração', async () => {
  const paths = await fixture();
  try {
    const executionId = 'b3-a3-corrupt';
    const executed = await analyzeAndExecute(paths.root, executionId);
    const manifest = await readBackupManifest(executed.result.manifestPath);
    const backupPath = join(paths.root, '_source_versions', manifest.files[0].backupRelativePath);
    const directory = join(paths.root, '_source_versions', executionId);

    // Corrompido (não é gzip)
    await writeFile(backupPath, 'não é gzip', 'utf8');
    await assert.rejects(createBackupRestorePlan({ projectRoot: paths.root, backupDirectory: directory }), (error) => error.code === 'BACKUP_HASH_MISMATCH');

    // Truncado (metade dos bytes de um gzip válido)
    const validGzip = gzipSync('function somar(a, b) { return a + b; }\n');
    await writeFile(backupPath, validGzip.subarray(0, Math.floor(validGzip.length / 2)));
    await assert.rejects(createBackupRestorePlan({ projectRoot: paths.root, backupDirectory: directory }), (error) => error.code === 'BACKUP_HASH_MISMATCH');

    // SHA divergente (gzip válido de outro conteúdo)
    await writeFile(backupPath, gzipSync('conteúdo divergente\n'));
    await assert.rejects(createBackupRestorePlan({ projectRoot: paths.root, backupDirectory: directory }), (error) => error.code === 'BACKUP_HASH_MISMATCH');

    // Ausente
    await rm(backupPath);
    await assert.rejects(createBackupRestorePlan({ projectRoot: paths.root, backupDirectory: directory }), (error) => error.code === 'PHYSICAL_PATH_ACCESS_FAILED');
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});
