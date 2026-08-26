import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { OUTPUT_MODES } from '../src/domain/index.js';
import {
  assertPhysicalPath,
  createHistoricalExecutionRecord,
  generateArtifactId,
  listHistoricalExecutionRecords,
  readHistoricalExecutionRecord,
  writeHistoricalExecutionRecord,
} from '../src/integrity/index.js';

const windowsTest = process.platform === 'win32' ? test : test.skip;

function makeRecord(executionId, artifactId, projectRoot) {
  return createHistoricalExecutionRecord({
    executionId,
    timestamp: '2026-08-26T00:00:00.000Z',
    outputMode: OUTPUT_MODES.PRESERVE_AND_CREATE_MINIFIED,
    projectRoot,
    artifacts: [{
      artifactId,
      sourcePath: join(projectRoot, 'app.js'),
      outputPath: join(projectRoot, 'app.min.js'),
      engine: 'esbuild',
      engineVersion: '0.28.2',
      profile: 'Padrao',
      outputMode: OUTPUT_MODES.PRESERVE_AND_CREATE_MINIFIED,
      timestamp: '2026-08-26T00:00:00.000Z',
      inputHash: 'a'.repeat(64),
      outputHash: 'b'.repeat(64),
      sourceSize: 100,
      outputSize: 50,
      backup: { available: false, compression: 'none', backupRoot: null, backupRelativePath: null, originalHash: null },
    }],
  });
}

test('listHistoricalExecutionRecords lê todos os registros após o refactor e readHistoricalExecutionRecord permanece íntegro', async () => {
  const root = await mkdtemp(join(tmpdir(), 'selfminifier-b3-p1-list-'));
  const projectRoot = join(root, 'projeto');
  const historyDirectory = join(root, 'Dados', 'Historico');
  try {
    const artifactIds = [];
    for (let i = 1; i <= 6; i += 1) {
      const artifactId = generateArtifactId();
      artifactIds.push(artifactId);
      await writeHistoricalExecutionRecord(historyDirectory, makeRecord(`exec-${i}`, artifactId, projectRoot));
    }
    const records = await listHistoricalExecutionRecords(historyDirectory);
    assert.equal(records.length, 6);
    assert.deepEqual(records.map((record) => record.executionId).sort(), ['exec-1', 'exec-2', 'exec-3', 'exec-4', 'exec-5', 'exec-6']);
    assert.deepEqual(records.flatMap((record) => record.artifacts.map((artifact) => artifact.artifactId)).sort(), [...artifactIds].sort());

    const single = await readHistoricalExecutionRecord(historyDirectory, 'exec-1');
    assert.equal(single.executionId, 'exec-1');
    assert.equal(single.artifacts[0].artifactId, artifactIds[0]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('reuso de prova não altera o resultado de um caminho físico seguro', async () => {
  const root = await mkdtemp(join(tmpdir(), 'selfminifier-b3-p1-safe-'));
  const directory = join(root, 'dir');
  await mkdir(directory);
  try {
    const withoutMemo = await assertPhysicalPath(directory);
    const memo = new Map();
    const withMemo = await assertPhysicalPath(directory, { memo });
    assert.equal(withMemo.exists, withoutMemo.exists);
    assert.equal(withMemo.canonicalPath, withoutMemo.canonicalPath);
    assert.equal(withMemo.physicalIdentity, withoutMemo.physicalIdentity);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

windowsTest('reuso de prova não converte caminho trocado por junction em caminho aceito', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'selfminifier-b3-p1-memo-'));
  const parent = join(root, 'pai');
  const child = join(parent, 'filho');
  await mkdir(child, { recursive: true });
  const memo = new Map();
  try {
    const first = await assertPhysicalPath(child, { memo });
    assert.equal(first.exists, true);

    const external = await mkdtemp(join(tmpdir(), 'selfminifier-b3-p1-ext-'));
    await rm(child, { recursive: true, force: true });
    try {
      await symlink(external, child, 'junction');
    } catch {
      t.skip('criação de junction indisponível');
      await rm(external, { recursive: true, force: true });
      return;
    }

    await assert.rejects(
      assertPhysicalPath(child, { memo }),
      (error) => ['LINK_NOT_ALLOWED', 'REPARSE_POINT_NOT_ALLOWED', 'PHYSICAL_PATH_ALIAS_NOT_ALLOWED'].includes(error.code),
    );
    await rm(external, { recursive: true, force: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

windowsTest('reuso de prova não aceita junction introduzida em um ancestral', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'selfminifier-b3-p1-ancestor-'));
  const parent = join(root, 'pai');
  const child = join(parent, 'filho');
  await mkdir(child, { recursive: true });
  const memo = new Map();
  try {
    await assertPhysicalPath(child, { memo });

    const external = await mkdtemp(join(tmpdir(), 'selfminifier-b3-p1-ext2-'));
    await rm(parent, { recursive: true, force: true });
    try {
      await symlink(external, parent, 'junction');
    } catch {
      t.skip('criação de junction indisponível');
      await rm(external, { recursive: true, force: true });
      return;
    }

    await assert.rejects(
      assertPhysicalPath(join(parent, 'nao-existe'), { memo, allowMissing: true }),
      (error) => ['LINK_NOT_ALLOWED', 'REPARSE_POINT_NOT_ALLOWED', 'PHYSICAL_PATH_ALIAS_NOT_ALLOWED'].includes(error.code),
    );
    await rm(external, { recursive: true, force: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

windowsTest('diretório histórico que é junction falha fechado em listHistoricalExecutionRecords', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'selfminifier-b3-p1-dirjunc-'));
  const external = await mkdtemp(join(tmpdir(), 'selfminifier-b3-p1-dirjunc-ext-'));
  const historyDirectory = join(root, 'Dados', 'Historico');
  await mkdir(join(root, 'Dados'), { recursive: true });
  try {
    try {
      await symlink(external, historyDirectory, 'junction');
    } catch {
      t.skip('criação de junction indisponível');
      return;
    }
    await assert.rejects(
      listHistoricalExecutionRecords(historyDirectory),
      (error) => ['LINK_NOT_ALLOWED', 'REPARSE_POINT_NOT_ALLOWED', 'PHYSICAL_PATH_ALIAS_NOT_ALLOWED', 'UNSAFE_HISTORY_DIRECTORY'].includes(error.code),
    );
  } finally {
    await rm(external, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});
