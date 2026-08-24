import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { OUTPUT_MODES } from '../src/domain/index.js';
import {
  ExecutionError,
  calculateExecutionRisk,
  createExecutionPlan,
  executePlan,
  readExecutionJournal,
  recoverInterruptedExecution,
  writeExecutionJournal,
} from '../src/execution/index.js';
import { hashContentSha256, hashFileSha256, readTechnicalState } from '../src/integrity/index.js';
import { createDefaultMinifierRegistry } from '../src/minifiers/index.js';
import { resolveRuntimePaths } from '../src/runtime/paths.js';

async function exists(filePath) {
  try { await lstat(filePath); return true; } catch (cause) { if (cause?.code === 'ENOENT') return false; throw cause; }
}

async function fixture(names = ['app.js']) {
  const root = await mkdtemp(join(tmpdir(), 'selfminifier-execution-'));
  const sourceRoot = join(root, 'projeto');
  await mkdir(sourceRoot);
  const files = [];
  for (const name of names) {
    const filePath = join(sourceRoot, name);
    await writeFile(filePath, `function ${name.replace(/\W/g, '_')}(valor) { return valor + 1; }\n`, 'utf8');
    files.push(filePath);
  }
  return { root, sourceRoot, files, runtime: resolveRuntimePaths(root), backupRoot: join(sourceRoot, '_source_versions') };
}

function configuration(files, outputMode) {
  return {
    outputMode,
    engineId: 'esbuild',
    profile: 'Padrao',
    globalIncludes: [],
    globalExcludes: [],
    sources: files.map((filePath, index) => ({
      id: String(index + 1).padStart(3, '0'),
      type: 'Arquivo',
      path: filePath,
      executeByDefault: true,
      mode: 'Arquivo',
      includes: [],
      excludes: [],
    })),
  };
}

function adapter() {
  return createDefaultMinifierRegistry().get('esbuild');
}

async function planFor(paths, outputMode, options = {}) {
  const minifier = options.minifier ?? adapter();
  const plan = await createExecutionPlan({
    configuration: configuration(paths.files, outputMode),
    minifier,
    runtimeRoot: paths.root,
    backupRoot: paths.backupRoot,
    executionId: options.executionId ?? 'exec-001',
    timestamp: '2026-08-21T12:00:00.000Z',
  });
  return { plan, minifier };
}

test('pré-análise é completa, imutável e exige confirmações sem mutar arquivos', async () => {
  const paths = await fixture(['a.js', 'b.js']);
  try {
    const destinations = paths.files.map((filePath) => filePath.replace(/\.js$/, '.min.js'));
    await writeFile(destinations[0], 'const antigoA=1;');
    await writeFile(destinations[1], 'const antigoB=1;');
    const originals = await Promise.all([...paths.files, ...destinations].map((filePath) => readFile(filePath, 'utf8')));
    const { plan, minifier } = await planFor(paths, OUTPUT_MODES.PRESERVE_AND_CREATE_MINIFIED);
    assert.equal(plan.items.length, 2);
    assert.equal(plan.conflicts.length, 2);
    assert.equal(plan.requiredConfirmations.some((entry) => entry.type === 'execution'), true);
    assert.equal(Object.isFrozen(plan), true);
    assert.equal(Object.isFrozen(plan.items), true);
    assert.deepEqual(await Promise.all([...paths.files, ...destinations].map((filePath) => readFile(filePath, 'utf8'))), originals);
    await assert.rejects(executePlan(plan, minifier, { authorizeOverwriteConflicts: true }), (error) => error instanceof ExecutionError && error.code === 'EXECUTION_CONFIRMATION_REQUIRED');
    const denied = await executePlan(plan, minifier, { confirmed: true, authorizeOverwriteConflicts: false });
    assert.equal(denied.status, 'cancelled');
    assert.deepEqual(await Promise.all([...paths.files, ...destinations].map((filePath) => readFile(filePath, 'utf8'))), originals);
    const withoutRisk = structuredClone(plan);
    withoutRisk.executionRisk = null;
    await assert.rejects(executePlan(withoutRisk, minifier, { confirmed: true, authorizeOverwriteConflicts: true }), (error) => error.code === 'RISK_CALCULATION_REQUIRED');
    const forgedRisk = structuredClone(plan);
    forgedRisk.executionRisk.technicalLevel = 'Critico';
    forgedRisk.executionRisk.displayLevel = 'Crítico';
    await assert.rejects(executePlan(forgedRisk, minifier, { confirmed: true, authorizeOverwriteConflicts: true }), (error) => error.code === 'RISK_CALCULATION_REQUIRED');
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test('criação .min preserva a fonte, registra journal antes da mutação e atualiza estado', async () => {
  const paths = await fixture();
  try {
    const sourceBefore = await readFile(paths.files[0]);
    const destination = paths.files[0].replace(/\.js$/, '.min.js');
    const { plan, minifier } = await planFor(paths, OUTPUT_MODES.PRESERVE_AND_CREATE_MINIFIED);
    let writeAheadObserved = false;
    const result = await executePlan(plan, minifier, { confirmed: true }, { hooks: {
      beforeMutation: async ({ journalPath }) => {
        const journal = await readExecutionJournal(journalPath);
        writeAheadObserved = journal.status === 'running' && journal.items[0].status === 'mutation-intent';
      },
    } });
    assert.equal(result.status, 'completed');
    assert.equal(writeAheadObserved, true);
    assert.deepEqual(await readFile(paths.files[0]), sourceBefore);
    assert.equal(await exists(destination), true);
    assert.equal((await readExecutionJournal(paths.runtime.lastExecutionJournal)).status, 'completed');
    const state = await readTechnicalState(paths.runtime.technicalState);
    assert.equal(state.records.length, 1);
    assert.equal(state.records[0].outputPath, destination);
    assert.equal(state.records[0].minifiedHash, await hashFileSha256(destination));
    await rm(paths.runtime.technicalState);
    const next = await planFor(paths, OUTPUT_MODES.PRESERVE_AND_CREATE_MINIFIED, { executionId: 'exec-002' });
    await assert.rejects(executePlan(next.plan, next.minifier, { confirmed: true, authorizeOverwriteConflicts: true }), (error) => error.code === 'JOURNAL_STATE_CONTRADICTION');
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test('sobrescrita autorizada de .min preserva recuperação separada e mantém fonte idêntica', async () => {
  const paths = await fixture();
  try {
    const sourceBefore = await readFile(paths.files[0]);
    const destination = paths.files[0].replace(/\.js$/, '.min.js');
    const oldOutput = 'const saída_antiga = true;\n';
    await writeFile(destination, oldOutput, 'utf8');
    const { plan, minifier } = await planFor(paths, OUTPUT_MODES.PRESERVE_AND_CREATE_MINIFIED);
    await executePlan(plan, minifier, { confirmed: true, authorizeOverwriteConflicts: true });
    assert.deepEqual(await readFile(paths.files[0]), sourceBefore);
    assert.notEqual(await readFile(destination, 'utf8'), oldOutput);
    const journal = await readExecutionJournal(paths.runtime.lastExecutionJournal);
    assert.equal(journal.items[0].operation, 'replace-output');
    assert.equal(journal.items[0].recovery.type, 'preexisting-output');
    assert.equal(await readFile(journal.items[0].recovery.path, 'utf8'), oldOutput);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test('modo de sobrescrita exige backup válido, gera manifesto e mantém estado comprovado', async () => {
  const paths = await fixture();
  try {
    const original = await readFile(paths.files[0], 'utf8');
    const { plan, minifier } = await planFor(paths, OUTPUT_MODES.BACKUP_OVERWRITE);
    const result = await executePlan(plan, minifier, { confirmed: true, meminifyVersion: '0.1.0' });
    assert.notEqual(await readFile(paths.files[0], 'utf8'), original);
    const journal = await readExecutionJournal(paths.runtime.lastExecutionJournal);
    assert.equal(journal.items[0].operation, 'overwrite-original');
    assert.equal(journal.items[0].recovery.type, 'source-backup');
    assert.equal(await readFile(journal.items[0].recovery.path, 'utf8'), original);
    assert.equal(await exists(result.manifestPath), true);
    assert.equal((await readTechnicalState(paths.runtime.technicalState)).records[0].minifiedHash, await hashFileSha256(paths.files[0]));
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }

  const invalid = await fixture();
  try {
    const original = await readFile(invalid.files[0], 'utf8');
    const { plan, minifier } = await planFor(invalid, OUTPUT_MODES.BACKUP_OVERWRITE);
    let hashes = 0;
    await assert.rejects(executePlan(plan, minifier, { confirmed: true }, {
      backupDependencies: { hashFile: async (filePath) => (++hashes === 1 ? hashFileSha256(filePath) : '0'.repeat(64)) },
    }), (error) => error.code === 'BACKUP_HASH_MISMATCH');
    assert.equal(await readFile(invalid.files[0], 'utf8'), original);
    assert.equal((await readExecutionJournal(invalid.runtime.lastExecutionJournal)).status, 'rolled-back');
  } finally {
    await rm(invalid.root, { recursive: true, force: true });
  }
});

test('falhas parciais revertem somente mutações registradas nos dois modos', async () => {
  const created = await fixture(['a.js', 'b.js']);
  try {
    const sentinel = join(created.sourceRoot, 'nao-registrado.min.js');
    await writeFile(sentinel, 'não remover', 'utf8');
    const { plan, minifier } = await planFor(created, OUTPUT_MODES.PRESERVE_AND_CREATE_MINIFIED);
    await assert.rejects(executePlan(plan, minifier, { confirmed: true }, { hooks: { beforeItem: ({ index }) => { if (index === 1) throw new Error('falha injetada'); } } }));
    assert.equal(await exists(created.files[0].replace(/\.js$/, '.min.js')), false);
    assert.equal(await readFile(sentinel, 'utf8'), 'não remover');
    assert.equal(await exists(created.runtime.technicalState), false);
  } finally { await rm(created.root, { recursive: true, force: true }); }

  const replaced = await fixture(['a.js', 'b.js']);
  try {
    const destinations = replaced.files.map((filePath) => filePath.replace(/\.js$/, '.min.js'));
    await writeFile(destinations[0], 'const antigoA=1;');
    await writeFile(destinations[1], 'const antigoB=1;');
    const { plan, minifier } = await planFor(replaced, OUTPUT_MODES.PRESERVE_AND_CREATE_MINIFIED);
    await assert.rejects(executePlan(plan, minifier, { confirmed: true, authorizeOverwriteConflicts: true }, { hooks: { beforeItem: ({ index }) => { if (index === 1) throw new Error('falha injetada'); } } }));
    assert.equal(await readFile(destinations[0], 'utf8'), 'const antigoA=1;');
    assert.equal(await readFile(destinations[1], 'utf8'), 'const antigoB=1;');
  } finally { await rm(replaced.root, { recursive: true, force: true }); }

  const originals = await fixture(['a.js', 'b.js']);
  try {
    const before = await Promise.all(originals.files.map((filePath) => readFile(filePath, 'utf8')));
    const { plan, minifier } = await planFor(originals, OUTPUT_MODES.BACKUP_OVERWRITE);
    await assert.rejects(executePlan(plan, minifier, { confirmed: true }, { hooks: { beforeItem: ({ index }) => { if (index === 1) throw new Error('falha injetada'); } } }));
    assert.deepEqual(await Promise.all(originals.files.map((filePath) => readFile(filePath, 'utf8'))), before);
    assert.equal(await exists(originals.runtime.technicalState), false);
  } finally { await rm(originals.root, { recursive: true, force: true }); }
});

test('conflito tardio reverte criações anteriores sem tocar o arquivo externo', async () => {
  const paths = await fixture(['a.js', 'b.js']);
  try {
    const firstDestination = paths.files[0].replace(/\.js$/, '.min.js');
    const secondDestination = paths.files[1].replace(/\.js$/, '.min.js');
    const { plan, minifier } = await planFor(paths, OUTPUT_MODES.PRESERVE_AND_CREATE_MINIFIED);
    await assert.rejects(executePlan(plan, minifier, { confirmed: true }, { hooks: {
      beforeMutation: async ({ item }) => { if (item.destinationPath === secondDestination) await writeFile(secondDestination, 'externo tardio'); },
    } }), (error) => error.code === 'LATE_DESTINATION_CONFLICT');
    assert.equal(await exists(firstDestination), false);
    assert.equal(await readFile(secondDestination, 'utf8'), 'externo tardio');
    assert.equal((await readExecutionJournal(paths.runtime.lastExecutionJournal)).status, 'rolled-back');
  } finally { await rm(paths.root, { recursive: true, force: true }); }
});

test('mudança externa inesperada exige recuperação em vez de rollback destrutivo', async () => {
  const paths = await fixture();
  try {
    const destination = paths.files[0].replace(/\.js$/, '.min.js');
    const { plan, minifier } = await planFor(paths, OUTPUT_MODES.PRESERVE_AND_CREATE_MINIFIED);
    await assert.rejects(executePlan(plan, minifier, { confirmed: true }, { hooks: {
      afterMutation: async () => writeFile(destination, 'alteração externa'),
    } }), (error) => error.code === 'RECOVERY_REQUIRED');
    assert.equal(await readFile(destination, 'utf8'), 'alteração externa');
    assert.equal((await readExecutionJournal(paths.runtime.lastExecutionJournal)).status, 'recovery-required');
  } finally { await rm(paths.root, { recursive: true, force: true }); }
});

test('journal interrompido é recuperado deterministicamente e ambiguidade bloqueia nova execução', async () => {
  const paths = await fixture();
  try {
    const destination = paths.files[0].replace(/\.js$/, '.min.js');
    const output = 'const interrompido=1;';
    await writeFile(destination, output);
    const journal = {
      formatVersion: 1,
      executionId: 'interrompida-001',
      timestamp: '2026-08-21T12:00:00.000Z',
      outputMode: OUTPUT_MODES.PRESERVE_AND_CREATE_MINIFIED,
      executionRisk: calculateExecutionRisk({ outputMode: OUTPUT_MODES.PRESERVE_AND_CREATE_MINIFIED, profile: 'Padrao', conflictCount: 0 }),
      status: 'running',
      statePath: paths.runtime.technicalState,
      stateBefore: { existed: false, value: { formatVersion: 1, records: [] } },
      manifestPath: null,
      manifestStatus: 'not-applicable',
      manifestExpectedHash: null,
      items: [{
        id: 'item-001', sourcePath: paths.files[0], destinationPath: destination,
        operation: 'create-output', status: 'mutation-intent', sourceHash: await hashFileSha256(paths.files[0]),
        previousHash: null, expectedOutputHash: hashContentSha256(output), plannedRecoveryPath: null,
        recovery: null, stateRecorded: false,
      }],
    };
    await writeExecutionJournal(paths.runtime.lastExecutionJournal, journal);
    assert.equal((await recoverInterruptedExecution(paths.runtime.lastExecutionJournal)).status, 'rolled-back');
    assert.equal(await exists(destination), false);

    await writeFile(destination, 'conteúdo externo');
    journal.executionId = 'interrompida-002';
    journal.status = 'running';
    journal.items[0].status = 'mutation-intent';
    journal.items[0].expectedOutputHash = hashContentSha256('saída esperada diferente');
    await writeExecutionJournal(paths.runtime.lastExecutionJournal, journal);
    const { plan, minifier } = await planFor(paths, OUTPUT_MODES.PRESERVE_AND_CREATE_MINIFIED, { executionId: 'exec-nova' });
    await assert.rejects(executePlan(plan, minifier, { confirmed: true, authorizeOverwriteConflicts: true }), (error) => error.code === 'RECOVERY_REQUIRED');
    assert.equal(await readFile(destination, 'utf8'), 'conteúdo externo');
  } finally { await rm(paths.root, { recursive: true, force: true }); }
});
