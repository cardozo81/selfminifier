import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBridgeRequest } from '../src/app/bridge.mjs';
import { readTechnicalState } from '../src/integrity/state.js';
import { createLastMinRestorePlan, executeRestorePlan } from '../src/restore/index.js';

const windowsTest = process.platform === 'win32' ? test : test.skip;

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function createV2Execution(names, { preexisting = [] } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'selfminifier-v2-restore-'));
  const projectRoot = join(root, 'projeto');
  await mkdir(projectRoot, { recursive: true });
  await mkdir(join(root, 'Configuracao'), { recursive: true });
  await writeFile(join(root, 'Configuracao', 'configuracao.ini'), [
    '[Configuracao]',
    'VersaoSchema=2',
    'Motor=esbuild',
    'Perfil=Padrao',
    'ModoSaida=PreservarOriginaisECriarMinificados',
    `PastaRaiz=${projectRoot}`,
    'TiposArquivo=JavaScript',
    '',
  ].join('\n'), 'utf8');
  for (const [index, name] of names.entries()) {
    await writeFile(join(projectRoot, name), `const valor${index} = ${index + 1};\n`, 'utf8');
  }
  for (const name of preexisting) {
    await writeFile(join(projectRoot, name.replace(/\.js$/i, '.min.js')), `preexistente:${name}\n`, 'utf8');
  }
  const analysis = await runBridgeRequest({ command: 'scan-analysis' }, { projectRoot: root });
  assert.equal(analysis.ok, true, analysis.diagnostic?.message);
  const execution = await runBridgeRequest({
    command: 'execute',
    confirmed: true,
    confirmationFingerprint: analysis.analysis.execution.confirmationFingerprint,
  }, { projectRoot: root });
  assert.equal(execution.ok, true, execution.diagnostic?.message);
  return { root, projectRoot, analysis, execution };
}

windowsTest('restauração V2 em lote remove 52 saídas criadas e preserva as fontes', async () => {
  const names = Array.from({ length: 52 }, (_, index) => `arquivo-${String(index + 1).padStart(3, '0')}.js`);
  const fixture = await createV2Execution(names);
  try {
    const sourcesBefore = await Promise.all(names.map((name) => readFile(join(fixture.projectRoot, name), 'utf8')));
    assert.equal((await readTechnicalState(join(fixture.root, 'Dados', 'estado.json'))).records.length, 52);
    const plan = await createLastMinRestorePlan({ projectRoot: fixture.root });
    assert.equal(plan.items.length, 52);
    const result = await executeRestorePlan(plan, { confirmed: true });
    assert.equal(result.status, 'completed');
    assert.equal(result.items.filter((item) => item.status === 'deleted-min').length, 52);
    for (const [index, name] of names.entries()) {
      assert.equal(await exists(join(fixture.projectRoot, name.replace(/\.js$/i, '.min.js'))), false);
      assert.equal(await readFile(join(fixture.projectRoot, name), 'utf8'), sourcesBefore[index]);
    }
    assert.equal((await readTechnicalState(join(fixture.root, 'Dados', 'estado.json'))).records.length, 0);
    const executionJournal = JSON.parse(await readFile(join(fixture.root, 'Dados', 'Restauracao', 'ultima-execucao.bkp'), 'utf8'));
    assert.equal(executionJournal.items.length, 52);
    assert.equal(executionJournal.items.every((item) => item.manualRestoreStatus === 'deleted-min'), true);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

windowsTest('restauração V2 remove uma saída criada e mantém a fonte intacta', async () => {
  const fixture = await createV2Execution(['source.js']);
  const source = join(fixture.projectRoot, 'source.js');
  const output = join(fixture.projectRoot, 'source.min.js');
  try {
    const sourceBefore = await readFile(source, 'utf8');
    assert.equal(await exists(output), true);
    const plan = await createLastMinRestorePlan({ projectRoot: fixture.root });
    assert.equal(plan.items.length, 1);
    assert.equal(plan.items[0].classification, 'eligible-delete');
    const result = await executeRestorePlan(plan, { confirmed: true });
    assert.equal(result.status, 'completed');
    assert.equal(result.items[0].status, 'deleted-min');
    assert.equal(await exists(output), false);
    assert.equal(await readFile(source, 'utf8'), sourceBefore);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

windowsTest('restauração V2 preserva .min preexistente não registrado como criado', async () => {
  const fixture = await createV2Execution(['nova.js', 'existente.js'], { preexisting: ['existente.js'] });
  const newOutput = join(fixture.projectRoot, 'nova.min.js');
  const preexistingOutput = join(fixture.projectRoot, 'existente.min.js');
  try {
    assert.equal(await readFile(preexistingOutput, 'utf8'), 'preexistente:existente.js\n');
    const plan = await createLastMinRestorePlan({ projectRoot: fixture.root });
    assert.equal(plan.items.length, 1);
    assert.equal(plan.items[0].destinationPath, newOutput);
    assert.equal(plan.items.some((item) => item.destinationPath === preexistingOutput), false);
    const result = await executeRestorePlan(plan, { confirmed: true });
    assert.equal(result.status, 'completed');
    assert.equal(await exists(newOutput), false);
    assert.equal(await readFile(preexistingOutput, 'utf8'), 'preexistente:existente.js\n');
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

windowsTest('restauração V2 não exclui saída criada que divergiu sem confirmação específica', async () => {
  const fixture = await createV2Execution(['alterada.js']);
  const output = join(fixture.projectRoot, 'alterada.min.js');
  try {
    await writeFile(output, 'alteração externa\n', 'utf8');
    const plan = await createLastMinRestorePlan({ projectRoot: fixture.root });
    assert.equal(plan.items[0].classification, 'changed-after-creation');
    assert.equal(plan.items[0].requiresChangedConfirmation, true);
    const result = await executeRestorePlan(plan, { confirmed: true, confirmChanged: false });
    assert.equal(result.status, 'completed-with-skips');
    assert.equal(result.items[0].status, 'skipped-by-user');
    assert.equal(await readFile(output, 'utf8'), 'alteração externa\n');
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

windowsTest('rollback V2 recompõe saídas e registra causa e estados coerentes', async () => {
  const fixture = await createV2Execution(['um.js', 'dois.js']);
  const outputs = [
    join(fixture.projectRoot, 'um.min.js'),
    join(fixture.projectRoot, 'dois.min.js'),
  ];
  try {
    const before = await Promise.all(outputs.map((output) => readFile(output, 'utf8')));
    const plan = await createLastMinRestorePlan({ projectRoot: fixture.root });
    await assert.rejects(
      executeRestorePlan(plan, { confirmed: true }, {
        afterItem: ({ index }) => {
          if (index === 0) throw new Error('falha temporária reproduzida');
        },
      }),
      (error) => (
        error.code === 'RESTORE_FAILED_ROLLED_BACK'
        && error.details.causeMessage === 'falha temporária reproduzida'
        && error.details.failedItem.id === 'item-001'
      ),
    );
    assert.deepEqual(await Promise.all(outputs.map((output) => readFile(output, 'utf8'))), before);
    const journal = JSON.parse(await readFile(join(fixture.root, 'Dados', 'Restauracao', 'restauracao-em-andamento.bkp'), 'utf8'));
    assert.equal(journal.status, 'rolled-back');
    assert.equal(journal.items[0].status, 'rolled-back');
    assert.equal(journal.items[1].status, 'planned');
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
