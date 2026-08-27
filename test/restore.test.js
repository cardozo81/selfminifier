import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBridgeRequest } from '../src/app/bridge.mjs';
import { readTechnicalState } from '../src/integrity/state.js';
import { createBackupRestoreContext, createBackupRestorePlan, createLastMinRestorePlan, executeRestorePlan, listKnownBackups } from '../src/restore/index.js';

async function executionFixture(mode, names = ['entrada.js'], executionId = 'exec-restore') {
  const root = await mkdtemp(join(tmpdir(), 'selfminifier-restore-'));
  const sourceDirectory = join(root, 'fontes');
  await mkdir(join(root, 'Configuracao'), { recursive: true });
  await mkdir(sourceDirectory, { recursive: true });
  for (const name of names) await writeFile(join(sourceDirectory, name), `const ${name.replace(/\W/g, '_')} = 1;\n`, 'utf8');
  await writeFile(join(root, 'Configuracao', 'configuracao.ini'), `[Configuracao]\nVersaoSchema=2\nMotor=esbuild\nPerfil=Padrao\nModoSaida=${mode}\nPastaRaiz=${sourceDirectory}\nTiposArquivo=JavaScript\n`, 'utf8');
  const analysis = await runBridgeRequest({ command: 'analyze', executionId: `${executionId}-analysis` }, { projectRoot: root });
  assert.equal(analysis.ok, true, analysis.diagnostic?.message);
  const response = await runBridgeRequest({ command: 'execute', confirmed: true, confirmationFingerprint: analysis.analysis.confirmationFingerprint, executionId }, { projectRoot: root });
  assert.equal(response.ok, true, response.diagnostic?.message);
  return { root, sourceDirectory, executionId };
}

test('listagem leve não valida manifesto, estado, payload ou SHA; plano selecionado valida profundamente', async () => {
  const valid = await executionFixture('BackupESobrescreverOriginais');
  try {
    const listed = await listKnownBackups(valid.root);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].status, 'unverified');
    const manifestPath = join(valid.root, '_source_versions', valid.executionId, 'manifest.json');
    const originalManifest = await readFile(manifestPath, 'utf8');
    await writeFile(manifestPath, '{ inválido', 'utf8');
    assert.equal((await listKnownBackups(valid.root))[0].status, 'unverified');
    await writeFile(manifestPath, originalManifest, 'utf8');
    const statePath = join(valid.root, 'Dados', 'estado.json');
    const originalState = await readFile(statePath, 'utf8');
    await writeFile(statePath, '{ inválido', 'utf8');
    const manifest = JSON.parse(originalManifest);
    const backupPath = join(valid.root, '_source_versions', manifest.files[0].backupRelativePath);
    await writeFile(backupPath, 'adulterado', 'utf8');
    assert.equal((await listKnownBackups(valid.root))[0].status, 'unverified');
    await writeFile(statePath, originalState, 'utf8');
    await assert.rejects(createBackupRestorePlan({ projectRoot: valid.root, backupDirectory: join(valid.root, '_source_versions', valid.executionId) }), (error) => error.code === 'BACKUP_HASH_MISMATCH');
  } finally { await rm(valid.root, { recursive: true, force: true }); }
});

test('contexto histórico é reutilizável na operação sem nova leitura dos registros', async () => {
  const fixture = await executionFixture('BackupESobrescreverOriginais');
  try {
    const context = await createBackupRestoreContext(fixture.root);
    await rm(join(fixture.root, 'Dados', 'Historico', `${fixture.executionId}.json`));
    await rm(join(fixture.root, '_source_versions', fixture.executionId), { recursive: true, force: true });
    const listed = await listKnownBackups(fixture.root, { context });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].status, 'unverified');
    assert.equal(listed[0].directory, join(fixture.root, '_source_versions', fixture.executionId));
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('restaura fonte normal e mantém estado consistente', async () => {
  const fixture = await executionFixture('BackupESobrescreverOriginais');
  try {
    const source = join(fixture.sourceDirectory, 'entrada.js');
    const plan = await createBackupRestorePlan({ projectRoot: fixture.root, backupDirectory: join(fixture.root, '_source_versions', fixture.executionId) });
    assert.equal(plan.items[0].classification, 'unchanged-minified');
    const result = await executeRestorePlan(plan, { confirmed: true });
    assert.equal(result.status, 'completed');
    assert.equal(result.items[0].status, 'restored');
    assert.match(await readFile(source, 'utf8'), /const entrada_js = 1/);
    assert.equal((await readTechnicalState(join(fixture.root, 'Dados', 'estado.json'))).records.length, 0);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('fonte modificada exige confirmação; recusa preserva e confirmação restaura', async () => {
  const fixture = await executionFixture('BackupESobrescreverOriginais');
  try {
    const source = join(fixture.sourceDirectory, 'entrada.js');
    await writeFile(source, 'mudança atual', 'utf8');
    let plan = await createBackupRestorePlan({ projectRoot: fixture.root, backupDirectory: join(fixture.root, '_source_versions', fixture.executionId) });
    assert.equal(plan.items[0].classification, 'changed-after-minification');
    const refused = await executeRestorePlan(plan, { confirmed: true, confirmChanged: false });
    assert.equal(refused.items[0].status, 'skipped-by-user');
    assert.equal(await readFile(source, 'utf8'), 'mudança atual');
    plan = await createBackupRestorePlan({ projectRoot: fixture.root, backupDirectory: join(fixture.root, '_source_versions', fixture.executionId) });
    const restored = await executeRestorePlan(plan, { confirmed: true, confirmChanged: true });
    assert.equal(restored.items[0].status, 'restored');
    assert.match(await readFile(source, 'utf8'), /const entrada_js = 1/);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('seleção manual da pasta de backup funciona pelo bridge', async () => {
  const fixture = await executionFixture('BackupESobrescreverOriginais');
  try {
    const directory = join(fixture.root, '_source_versions', fixture.executionId);
    const planned = await runBridgeRequest({ command: 'plan-restore', kind: 'backup', backupDirectory: directory }, { projectRoot: fixture.root });
    assert.equal(planned.ok, true);
    const restored = await runBridgeRequest({ command: 'execute-restore', kind: 'backup', backupDirectory: directory, confirmed: true }, { projectRoot: fixture.root });
    assert.equal(restored.ok, true);
    assert.equal(restored.result.items[0].status, 'restored');
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('.min remove somente saída criada; saída preexistente permanece', async () => {
  const root = await mkdtemp(join(tmpdir(), 'selfminifier-restore-min-'));
  try {
    const sourceDirectory = join(root, 'fontes');
    await mkdir(join(root, 'Configuracao'), { recursive: true });
    await mkdir(sourceDirectory, { recursive: true });
    await writeFile(join(sourceDirectory, 'nova.js'), 'const nova = 1;\n', 'utf8');
    await writeFile(join(sourceDirectory, 'existente.js'), 'const existente = 2;\n', 'utf8');
    await writeFile(join(sourceDirectory, 'existente.min.js'), 'conteúdo anterior', 'utf8');
    await writeFile(join(root, 'Configuracao', 'configuracao.ini'), `[Configuracao]\nVersaoSchema=2\nMotor=esbuild\nPerfil=Padrao\nModoSaida=PreservarOriginaisECriarMinificados\nPastaRaiz=${sourceDirectory}\nTiposArquivo=JavaScript\n`, 'utf8');
    const analysis = await runBridgeRequest({ command: 'analyze', executionId: 'exec-min-analysis' }, { projectRoot: root });
    assert.equal(analysis.ok, true);
    const execution = await runBridgeRequest({ command: 'execute', confirmed: true, confirmationFingerprint: analysis.analysis.confirmationFingerprint, executionId: 'exec-min' }, { projectRoot: root });
    assert.equal(execution.ok, true);
    const plan = await createLastMinRestorePlan({ projectRoot: root });
    assert.equal(plan.items.length, 1);
    assert.equal(plan.items[0].destinationPath, join(sourceDirectory, 'nova.min.js'));
    assert.equal(plan.items.some((item) => item.destinationPath === join(sourceDirectory, 'existente.min.js')), false);
    const result = await executeRestorePlan(plan, { confirmed: true });
    assert.equal(result.items[0].status, 'deleted-min');
    await assert.rejects(readFile(join(sourceDirectory, 'nova.min.js')));
    assert.ok((await readFile(join(sourceDirectory, 'existente.min.js'), 'utf8')).length > 0);
    const state = await readTechnicalState(join(root, 'Dados', 'estado.json'));
    assert.equal(state.records.length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('.min ausente não é recriado e modificado exige confirmação', async () => {
  const absent = await executionFixture('PreservarOriginaisECriarMinificados', ['entrada.js'], 'exec-absent');
  try {
    const output = join(absent.sourceDirectory, 'entrada.min.js');
    await rm(output);
    const plan = await createLastMinRestorePlan({ projectRoot: absent.root });
    assert.equal(plan.items[0].classification, 'already-absent');
    const result = await executeRestorePlan(plan, { confirmed: true });
    assert.equal(result.items[0].status, 'already-absent');
    await assert.rejects(readFile(output));
  } finally { await rm(absent.root, { recursive: true, force: true }); }

  const modified = await executionFixture('PreservarOriginaisECriarMinificados', ['entrada.js'], 'exec-modified');
  try {
    const output = join(modified.sourceDirectory, 'entrada.min.js');
    await writeFile(output, 'alterado depois', 'utf8');
    let plan = await createLastMinRestorePlan({ projectRoot: modified.root });
    const refused = await executeRestorePlan(plan, { confirmed: true, confirmChanged: false });
    assert.equal(refused.items[0].status, 'skipped-by-user');
    assert.equal(await readFile(output, 'utf8'), 'alterado depois');
    plan = await createLastMinRestorePlan({ projectRoot: modified.root });
    const confirmed = await executeRestorePlan(plan, { confirmed: true, confirmChanged: true });
    assert.equal(confirmed.items[0].status, 'deleted-min');
    await assert.rejects(readFile(output));
  } finally { await rm(modified.root, { recursive: true, force: true }); }
});

test('falha parcial de restauração de fontes não declara sucesso e exige recuperação', async () => {
  const fixture = await executionFixture('BackupESobrescreverOriginais', ['um.js', 'dois.js'], 'exec-partial');
  try {
    const plan = await createBackupRestorePlan({ projectRoot: fixture.root, backupDirectory: join(fixture.root, '_source_versions', fixture.executionId) });
    await assert.rejects(executeRestorePlan(plan, { confirmed: true }, { afterItem: ({ index }) => { if (index === 0) throw new Error('falha injetada'); } }), (error) => error.code === 'RESTORE_RECOVERY_REQUIRED');
    const journal = JSON.parse(await readFile(join(fixture.root, 'Dados', 'Restauracao', 'restauracao-em-andamento.bkp'), 'utf8'));
    assert.equal(journal.status, 'recovery-required');
    assert.notEqual(journal.status, 'completed');
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('mudança externa ambígua durante restauração leva a recovery-required', async () => {
  const fixture = await executionFixture('BackupESobrescreverOriginais', ['um.js', 'dois.js'], 'exec-external-change');
  try {
    const plan = await createBackupRestorePlan({ projectRoot: fixture.root, backupDirectory: join(fixture.root, '_source_versions', fixture.executionId) });
    await assert.rejects(executeRestorePlan(plan, { confirmed: true }, { afterItem: async ({ index }) => { if (index === 0) await writeFile(plan.items[1].destinationPath, 'mudança externa ambígua', 'utf8'); } }), (error) => error.code === 'RESTORE_RECOVERY_REQUIRED');
    const journal = JSON.parse(await readFile(join(fixture.root, 'Dados', 'Restauracao', 'restauracao-em-andamento.bkp'), 'utf8'));
    assert.equal(journal.status, 'recovery-required');
    assert.equal(await readFile(plan.items[1].destinationPath, 'utf8'), 'mudança externa ambígua');
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('cancelamento é não destrutivo e implementação não usa exclusão por curinga', async () => {
  const fixture = await executionFixture('PreservarOriginaisECriarMinificados');
  try {
    const output = join(fixture.sourceDirectory, 'entrada.min.js');
    const before = await readFile(output, 'utf8');
    const plan = await createLastMinRestorePlan({ projectRoot: fixture.root });
    const result = await executeRestorePlan(plan, { confirmed: false });
    assert.equal(result.status, 'cancelled');
    assert.equal(await readFile(output, 'utf8'), before);
    const source = await readFile(new URL('../src/restore/index.js', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /\*\.min\.\*/);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});
