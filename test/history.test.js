import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { OUTPUT_MODES } from '../src/domain/index.js';
import { createExecutionPlan, executePlan, readExecutionJournal } from '../src/execution/index.js';
import {
  IntegrityError,
  createHistoricalIndex,
  createHistoricalExecutionRecord,
  findHistoricalArtifact,
  generateArtifactId,
  hashFileSha256,
  listHistoricalExecutionRecords,
  readBackupManifest,
  readHistoricalExecutionRecord,
  readTechnicalState,
  resolveHistoricalExecutionPath,
  writeHistoricalExecutionRecord,
} from '../src/integrity/index.js';
import { createDefaultMinifierRegistry } from '../src/minifiers/index.js';
import { resolveRuntimePaths } from '../src/runtime/paths.js';

async function exists(filePath) {
  try { await lstat(filePath); return true; } catch (cause) { if (cause?.code === 'ENOENT') return false; throw cause; }
}

async function fixture(names = ['app.js']) {
  const root = await mkdtemp(join(tmpdir(), 'selfminifier-history-'));
  const projectRoot = join(root, 'projeto');
  await mkdir(projectRoot);
  const files = [];
  for (const name of names) {
    const filePath = join(projectRoot, name);
    await writeFile(filePath, `function ${name.replace(/\W/g, '_')}(valor) { return valor + 1; }\n`, 'utf8');
    files.push(filePath);
  }
  return { root, projectRoot, files, runtime: resolveRuntimePaths(root), backupRoot: join(projectRoot, '_source_versions') };
}

async function planFor(paths, outputMode, executionId) {
  const minifier = createDefaultMinifierRegistry().get('esbuild');
  const plan = await createExecutionPlan({
    configuration: {
      schemaVersion: 2,
      outputMode,
      engine: 'esbuild',
      profile: 'Padrao',
      projectRoot: paths.projectRoot,
      fileTypes: ['javascript'],
      ignoredFolders: [],
      ignoredFiles: [],
    },
    minifier,
    runtimeRoot: paths.root,
    backupRoot: paths.backupRoot,
    executionId,
    timestamp: '2026-08-25T12:00:00.000Z',
    meminifyVersion: '0.2.0',
  });
  return { plan, minifier };
}

function record(root, executionId, artifactId) {
  return createHistoricalExecutionRecord({
    executionId,
    meminifyVersion: '0.2.0',
    timestamp: '2026-08-25T12:00:00.000Z',
    outputMode: OUTPUT_MODES.PRESERVE_AND_CREATE_MINIFIED,
    projectRoot: root,
    artifacts: [{
      artifactId,
      sourcePath: join(root, 'app.js'),
      outputPath: join(root, 'app.min.js'),
      inputHash: 'a'.repeat(64),
      outputHash: 'b'.repeat(64),
      sourceSize: 10,
      outputSize: 5,
      engine: 'esbuild',
      engineVersion: '0.28.2',
      profile: 'Padrao',
      outputMode: OUTPUT_MODES.PRESERVE_AND_CREATE_MINIFIED,
      timestamp: '2026-08-25T12:00:00.000Z',
      backup: { available: false, backupRoot: null, backupRelativePath: null, originalHash: null, compression: 'none' },
    }],
  });
}

test('artifactId usa 96 bits aleatórios, hexadecimal maiúsculo e nenhuma informação de caminho', () => {
  const deterministicBytes = () => Buffer.from('7f31a2c82a884e91b04f22d7', 'hex');
  assert.equal(generateArtifactId(deterministicBytes), '7F31A2C82A884E91B04F22D7');
  assert.equal(generateArtifactId(deterministicBytes), generateArtifactId(deterministicBytes));
  assert.equal(generateArtifactId.length, 0);
});

test('store histórico cria registros imutáveis, lista deterministicamente e localiza artifactId', async () => {
  const root = await mkdtemp(join(tmpdir(), 'selfminifier-history-store-'));
  const historyDirectory = join(root, 'Dados', 'Historico');
  try {
    const second = record(root, 'exec-002', '222222222222222222222222');
    const first = record(root, 'exec-001', '111111111111111111111111');
    await writeHistoricalExecutionRecord(historyDirectory, second);
    await writeHistoricalExecutionRecord(historyDirectory, first);
    assert.deepEqual((await listHistoricalExecutionRecords(historyDirectory)).map((item) => item.executionId), ['exec-001', 'exec-002']);
    assert.deepEqual(await readHistoricalExecutionRecord(historyDirectory, 'exec-001'), first);
    assert.equal((await findHistoricalArtifact(historyDirectory, first.artifacts[0].artifactId)).execution.executionId, 'exec-001');
    await assert.rejects(writeHistoricalExecutionRecord(historyDirectory, first), (error) => error.code === 'HISTORY_RECORD_COLLISION');
    assert.deepEqual(await readHistoricalExecutionRecord(historyDirectory, 'exec-001'), first);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('histórico malformado e executionId inseguro falham fechado sem escape de caminho', async () => {
  const root = await mkdtemp(join(tmpdir(), 'selfminifier-history-invalid-'));
  const historyDirectory = join(root, 'Dados', 'Historico');
  try {
    assert.throws(() => resolveHistoricalExecutionPath(historyDirectory, '../escape'), (error) => error.code === 'INVALID_HISTORY_EXECUTION_ID');
    await mkdir(historyDirectory, { recursive: true });
    await writeFile(join(historyDirectory, 'malformado.json'), '{ inválido', 'utf8');
    await assert.rejects(listHistoricalExecutionRecords(historyDirectory), (error) => error.code === 'HISTORY_RECORD_INVALID_JSON');
    assert.equal(await exists(join(root, 'Dados', 'escape.json')), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('sobrescrita concluída persiste hashes, backup físico e artifactId em histórico, estado, journal e manifesto', async () => {
  const paths = await fixture(['a.js', 'b.js']);
  try {
    const originals = await Promise.all(paths.files.map((filePath) => readFile(filePath)));
    const { plan, minifier } = await planFor(paths, OUTPUT_MODES.BACKUP_OVERWRITE, 'history-overwrite');
    const result = await executePlan(plan, minifier, { confirmed: true, meminifyVersion: '0.2.0' });
    const history = await readHistoricalExecutionRecord(paths.runtime.historyDirectory, plan.executionId);
    assert.equal(result.historyPath, join(paths.runtime.historyDirectory, `${plan.executionId}.json`));
    assert.equal(history.formatVersion, 1);
    assert.equal(history.executionId, plan.executionId);
    assert.equal(history.meminifyVersion, '0.2.0');
    assert.equal(history.outputMode, OUTPUT_MODES.BACKUP_OVERWRITE);
    assert.equal(history.projectRoot, paths.projectRoot);
    assert.equal(history.artifacts.length, 2);
    assert.equal(new Set(history.artifacts.map((artifact) => artifact.artifactId)).size, 2);
    for (let index = 0; index < history.artifacts.length; index += 1) {
      const artifact = history.artifacts[index];
      assert.match(artifact.artifactId, /^[A-F0-9]{24}$/);
      assert.equal(artifact.inputHash, plan.items[index].sourceHash);
      assert.equal(artifact.outputHash, await hashFileSha256(artifact.outputPath));
      assert.equal(artifact.sourceSize, originals[index].length);
      assert.equal(artifact.outputSize, (await lstat(artifact.outputPath)).size);
      assert.deepEqual(artifact.backup, {
        available: true,
        backupRoot: paths.backupRoot,
        backupRelativePath: `${plan.executionId}/origem-project-root/${paths.files[index].split(/[\\/]/).at(-1)}.gz`,
        originalHash: plan.items[index].sourceHash,
        compression: 'gzip',
      });
    }
    const state = await readTechnicalState(paths.runtime.technicalState);
    const journal = await readExecutionJournal(paths.runtime.lastExecutionJournal);
    const manifest = await readBackupManifest(result.manifestPath);
    assert.equal(journal.historyStatus, 'written');
    assert.equal(journal.historyPath, result.historyPath);
    assert.deepEqual(state.records.map((item) => item.artifactId).sort(), history.artifacts.map((item) => item.artifactId).sort());
    assert.deepEqual(journal.items.map((item) => item.artifactId).sort(), history.artifacts.map((item) => item.artifactId).sort());
    assert.deepEqual(manifest.files.map((item) => item.artifactId).sort(), history.artifacts.map((item) => item.artifactId).sort());
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test('modo .min persiste proveniência sem inventar payload de backup', async () => {
  const paths = await fixture();
  try {
    const original = await readFile(paths.files[0]);
    const { plan, minifier } = await planFor(paths, OUTPUT_MODES.PRESERVE_AND_CREATE_MINIFIED, 'history-min');
    await executePlan(plan, minifier, { confirmed: true });
    const history = await readHistoricalExecutionRecord(paths.runtime.historyDirectory, plan.executionId);
    assert.deepEqual(await readFile(paths.files[0]), original);
    assert.equal(history.artifacts.length, 1);
    assert.deepEqual(history.artifacts[0].backup, {
      available: false,
      backupRoot: null,
      backupRelativePath: null,
      originalHash: null,
      compression: 'none',
    });
    assert.equal(history.artifacts[0].inputHash, plan.items[0].sourceHash);
    assert.equal(history.artifacts[0].outputHash, await hashFileSha256(plan.items[0].destinationPath));
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test('execução posterior cria outro registro e não sobrescreve o histórico anterior', async () => {
  const paths = await fixture(['a.js']);
  try {
    const first = await planFor(paths, OUTPUT_MODES.PRESERVE_AND_CREATE_MINIFIED, 'history-first');
    await executePlan(first.plan, first.minifier, { confirmed: true });
    const firstPath = resolveHistoricalExecutionPath(paths.runtime.historyDirectory, first.plan.executionId);
    const firstBytes = await readFile(firstPath);

    const secondSource = join(paths.projectRoot, 'b.js');
    await writeFile(secondSource, 'const b = 2;\n', 'utf8');
    const second = await planFor(paths, OUTPUT_MODES.PRESERVE_AND_CREATE_MINIFIED, 'history-second');
    await executePlan(second.plan, second.minifier, { confirmed: true });

    assert.deepEqual(await readFile(firstPath), firstBytes);
    assert.deepEqual((await listHistoricalExecutionRecords(paths.runtime.historyDirectory)).map((item) => item.executionId), ['history-first', 'history-second']);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test('falha injetada na persistência histórica reverte a execução e não afirma conclusão', async () => {
  const paths = await fixture();
  try {
    const { plan, minifier } = await planFor(paths, OUTPUT_MODES.PRESERVE_AND_CREATE_MINIFIED, 'history-write-failure');
    await assert.rejects(
      executePlan(plan, minifier, { confirmed: true }, {
        writeHistoricalExecutionRecord: async () => {
          throw new IntegrityError('HISTORY_RECORD_WRITE_FAILED', 'falha histórica sintética');
        },
      }),
      (error) => error.code === 'HISTORY_RECORD_WRITE_FAILED' && error.details.rollbackStatus === 'rolled-back',
    );
    assert.equal(await exists(plan.items[0].destinationPath), false);
    assert.equal(await exists(resolveHistoricalExecutionPath(paths.runtime.historyDirectory, plan.executionId)), false);
    assert.equal((await readExecutionJournal(paths.runtime.lastExecutionJournal)).status, 'rolled-back');
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test('falha ao confirmar o journal depois da gravação histórica remove o registro pelo hash exato e reverte arquivos', async () => {
  const paths = await fixture();
  try {
    const { writeExecutionJournal } = await import('../src/execution/journal.js');
    const { plan, minifier } = await planFor(paths, OUTPUT_MODES.PRESERVE_AND_CREATE_MINIFIED, 'history-journal-failure');
    let failureInjected = false;
    await assert.rejects(
      executePlan(plan, minifier, { confirmed: true }, {
        writeExecutionJournal: async (journalPath, journal) => {
          if (!failureInjected && journal.status === 'running' && journal.historyStatus === 'written') {
            failureInjected = true;
            throw new IntegrityError('EXECUTION_JOURNAL_WRITE_FAILED', 'falha sintética depois do histórico');
          }
          return writeExecutionJournal(journalPath, journal);
        },
      }),
      (error) => error.code === 'EXECUTION_JOURNAL_WRITE_FAILED' && error.details.rollbackStatus === 'rolled-back',
    );
    assert.equal(failureInjected, true);
    assert.equal(await exists(plan.items[0].destinationPath), false);
    assert.equal(await exists(resolveHistoricalExecutionPath(paths.runtime.historyDirectory, plan.executionId)), false);
    const journal = await readExecutionJournal(paths.runtime.lastExecutionJournal);
    assert.equal(journal.status, 'rolled-back');
    assert.equal(journal.historyStatus, 'rolled-back');
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test('writer histórico rejeita artifactId já pertencente a outra execução', async () => {
  const root = await mkdtemp(join(tmpdir(), 'selfminifier-history-id-collision-'));
  const historyDirectory = join(root, 'Dados', 'Historico');
  try {
    const artifactId = 'ABCDEF0123456789ABCDEF01';
    await writeHistoricalExecutionRecord(historyDirectory, record(root, 'collision-first', artifactId));
    await assert.rejects(
      writeHistoricalExecutionRecord(historyDirectory, record(root, 'collision-second', artifactId)),
      (error) => error.code === 'HISTORY_ARTIFACT_ID_COLLISION',
    );
    assert.equal(await exists(resolveHistoricalExecutionPath(historyDirectory, 'collision-second')), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('execução multi-artefato reutiliza o HistoryIndex e limita enumerações completas a três', async () => {
  const paths = await fixture(['a.js', 'b.js', 'c.js', 'd.js']);
  try {
    const { plan, minifier } = await planFor(paths, OUTPUT_MODES.PRESERVE_AND_CREATE_MINIFIED, 'history-index-count');
    let indexBuilds = 0;
    const result = await executePlan(plan, minifier, { confirmed: true }, {
      createHistoricalIndex: async (historyDirectory) => {
        indexBuilds += 1;
        return createHistoricalIndex(historyDirectory);
      },
    });
    assert.equal(result.status, 'completed');
    assert.equal(result.items.length, 4);
    assert.equal(indexBuilds, 3);
    assert.equal((await readHistoricalExecutionRecord(paths.runtime.historyDirectory, plan.executionId)).artifacts.length, 4);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test('colisão externa de artifactId depois do snapshot bloqueia a persistência e aciona rollback', async () => {
  const paths = await fixture();
  const artifactId = 'ABCDEF0123456789ABCDEF99';
  try {
    const { plan, minifier } = await planFor(paths, OUTPUT_MODES.PRESERVE_AND_CREATE_MINIFIED, 'history-index-late-collision');
    let indexBuilds = 0;
    await assert.rejects(
      executePlan(plan, minifier, { confirmed: true }, {
        generateArtifactId: () => artifactId,
        createHistoricalIndex: async (historyDirectory) => {
          indexBuilds += 1;
          if (indexBuilds === 2) {
            await writeHistoricalExecutionRecord(historyDirectory, record(paths.projectRoot, 'external-collision', artifactId));
          }
          return createHistoricalIndex(historyDirectory);
        },
      }),
      (error) => error.code === 'HISTORY_ARTIFACT_ID_COLLISION' && error.details.rollbackStatus === 'rolled-back',
    );
    assert.equal(await exists(plan.items[0].destinationPath), false);
    assert.equal(await exists(resolveHistoricalExecutionPath(paths.runtime.historyDirectory, plan.executionId)), false);
    assert.equal((await readExecutionJournal(paths.runtime.lastExecutionJournal)).status, 'rolled-back');
    assert.equal((await findHistoricalArtifact(paths.runtime.historyDirectory, artifactId)).execution.executionId, 'external-collision');
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test('mudança de bytes em registro histórico após o snapshot falha fechado por fingerprint', async () => {
  const root = await mkdtemp(join(tmpdir(), 'selfminifier-history-index-fingerprint-'));
  const historyDirectory = join(root, 'Dados', 'Historico');
  try {
    const first = record(root, 'fingerprint-first', '111111111111111111111199');
    await writeHistoricalExecutionRecord(historyDirectory, first);
    const historyIndex = await createHistoricalIndex(historyDirectory);
    const firstPath = resolveHistoricalExecutionPath(historyDirectory, first.executionId);
    await writeFile(firstPath, `${await readFile(firstPath, 'utf8')} `, 'utf8');
    await assert.rejects(
      writeHistoricalExecutionRecord(
        historyDirectory,
        record(root, 'fingerprint-second', '222222222222222222222299'),
        { historyIndex },
      ),
      (error) => error.code === 'HISTORY_IMMUTABILITY_VIOLATION',
    );
    assert.equal(await exists(resolveHistoricalExecutionPath(historyDirectory, 'fingerprint-second')), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('colisão externa após o link exclusivo é detectada e o journal remove somente o registro da tentativa', async () => {
  const paths = await fixture();
  const artifactId = 'ABCDEF0123456789ABCDEF98';
  const externalExecutionId = 'external-after-link';
  try {
    const { plan, minifier } = await planFor(paths, OUTPUT_MODES.PRESERVE_AND_CREATE_MINIFIED, 'history-index-post-collision');
    let indexBuilds = 0;
    await assert.rejects(
      executePlan(plan, minifier, { confirmed: true }, {
        generateArtifactId: () => artifactId,
        createHistoricalIndex: async (historyDirectory) => {
          indexBuilds += 1;
          if (indexBuilds === 3) {
            const external = record(paths.projectRoot, externalExecutionId, artifactId);
            await writeFile(
              resolveHistoricalExecutionPath(historyDirectory, externalExecutionId),
              `${JSON.stringify(external, null, 2)}\n`,
              'utf8',
            );
          }
          return createHistoricalIndex(historyDirectory);
        },
      }),
      (error) => error.code === 'DUPLICATE_HISTORICAL_ARTIFACT_ID' && error.details.rollbackStatus === 'rolled-back',
    );
    assert.equal(await exists(plan.items[0].destinationPath), false);
    assert.equal(await exists(resolveHistoricalExecutionPath(paths.runtime.historyDirectory, plan.executionId)), false);
    assert.equal(await exists(resolveHistoricalExecutionPath(paths.runtime.historyDirectory, externalExecutionId)), true);
    assert.equal((await readExecutionJournal(paths.runtime.lastExecutionJournal)).status, 'rolled-back');
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test('journal formatVersion 1 sem artifactId nem ligação histórica continua válido', async () => {
  const paths = await fixture();
  try {
    const { validateExecutionJournal } = await import('../src/execution/journal.js');
    const { plan, minifier } = await planFor(paths, OUTPUT_MODES.PRESERVE_AND_CREATE_MINIFIED, 'legacy-journal');
    await executePlan(plan, minifier, { confirmed: true });
    const legacy = structuredClone(await readExecutionJournal(paths.runtime.lastExecutionJournal));
    delete legacy.historyPath;
    delete legacy.historyStatus;
    delete legacy.historyExpectedHash;
    for (const item of legacy.items) delete item.artifactId;
    assert.equal(validateExecutionJournal(legacy), legacy);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});
