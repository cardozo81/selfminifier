import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';
import { runBridgeRequest } from '../src/app/bridge.mjs';
import { OUTPUT_MODES } from '../src/domain/index.js';
import { createExecutionPlan, executePlan } from '../src/execution/index.js';
import {
  BACKUP_AVAILABILITY_STATES,
  CURRENT_INTEGRITY_STATES,
  inspectHistoricalArtifact,
  inspectHistoricalBackup,
  recoverHistoricalOriginal,
  searchHistoryByPath,
  searchHistoryByTag,
} from '../src/history/index.js';
import {
  createHistoricalExecutionRecord,
  createSelfMinifierTag,
  hashContentSha256,
  hashFileSha256,
  inspectSelfMinifierTags,
  readBackupManifest,
  readHistoricalExecutionRecord,
  writeHistoricalExecutionRecord,
} from '../src/integrity/index.js';
import { createDefaultMinifierRegistry } from '../src/minifiers/index.js';
import { createBackupRestorePlan, executeRestorePlan } from '../src/restore/index.js';
import { resolveRuntimePaths } from '../src/runtime/paths.js';

const ARTIFACT_A = '7F31A2C82A884E91B04F22D7';
const ARTIFACT_B = '111111111111111111111111';
const ARTIFACT_C = '222222222222222222222222';
const UNKNOWN = 'EEEEEEEEEEEEEEEEEEEEEEEE';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'selfminifier-b3-a5-'));
  const projectRoot = join(root, 'projeto');
  const sourcePath = join(projectRoot, 'app.js');
  await mkdir(projectRoot);
  await writeFile(sourcePath, 'function somar(a, b) { return a + b; }\n', 'utf8');
  return {
    root,
    projectRoot,
    sourcePath,
    backupRoot: join(root, '_source_versions'),
    runtime: resolveRuntimePaths(root),
  };
}

function artifactGenerator(artifactId) {
  return () => artifactId;
}

async function executeFixture(paths, {
  executionId = 'b3-a5-exec',
  artifactId = ARTIFACT_A,
  outputMode = OUTPUT_MODES.BACKUP_OVERWRITE,
  backupRoot = paths.backupRoot,
  timestamp = '2026-08-25T12:00:00.000Z',
} = {}) {
  const minifier = createDefaultMinifierRegistry().get('esbuild');
  const plan = await createExecutionPlan({
    configuration: {
      schemaVersion: 3,
      outputMode,
      engine: 'esbuild',
      profile: 'Padrao',
      projectRoot: paths.projectRoot,
      backupRoot: null,
      fileTypes: ['javascript'],
      ignoredFolders: [],
      ignoredFiles: [],
    },
    minifier,
    runtimeRoot: paths.root,
    backupRoot,
    executionId,
    timestamp,
    meminifyVersion: '0.2.0',
  });
  const result = await executePlan(plan, minifier, { confirmed: true, meminifyVersion: '0.2.0' }, {
    generateArtifactId: artifactGenerator(artifactId),
  });
  const history = await readHistoricalExecutionRecord(paths.runtime.historyDirectory, executionId);
  return { plan, result, history, artifact: history.artifacts[0] };
}

function manualRecord(paths, executionId, artifactId, timestamp, sourcePath = paths.sourcePath) {
  const outputPath = join(paths.projectRoot, 'app.min.js');
  return createHistoricalExecutionRecord({
    executionId,
    meminifyVersion: '0.2.0',
    timestamp,
    outputMode: OUTPUT_MODES.PRESERVE_AND_CREATE_MINIFIED,
    projectRoot: paths.projectRoot,
    artifacts: [{
      artifactId,
      sourcePath,
      outputPath,
      inputHash: 'a'.repeat(64),
      outputHash: 'b'.repeat(64),
      sourceSize: 10,
      outputSize: 5,
      engine: 'esbuild',
      engineVersion: '0.28.2',
      profile: 'Padrao',
      outputMode: OUTPUT_MODES.PRESERVE_AND_CREATE_MINIFIED,
      timestamp,
      backup: {
        available: false,
        backupRoot: null,
        backupRelativePath: null,
        originalHash: null,
        compression: 'none',
      },
    }],
  });
}

async function convertExecutionToLegacyV1(paths, executionId) {
  const historyPath = join(paths.runtime.historyDirectory, `${executionId}.json`);
  const history = JSON.parse(await readFile(historyPath, 'utf8'));
  const manifestPath = join(paths.backupRoot, executionId, 'manifest.json');
  const manifest = await readBackupManifest(manifestPath);
  for (let index = 0; index < manifest.files.length; index += 1) {
    const entry = manifest.files[index];
    const gzipPath = join(paths.backupRoot, entry.backupRelativePath);
    const rawRelativePath = entry.backupRelativePath.replace(/\.gz$/, '');
    const rawPath = join(paths.backupRoot, rawRelativePath);
    await writeFile(rawPath, gunzipSync(await readFile(gzipPath)));
    await rm(gzipPath);
    entry.backupRelativePath = rawRelativePath;
    delete entry.compression;
    history.artifacts[index].backup.backupRelativePath = rawRelativePath;
    history.artifacts[index].backup.compression = 'none';
  }
  manifest.formatVersion = 1;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await writeFile(historyPath, `${JSON.stringify(history, null, 2)}\n`, 'utf8');
}

test('pesquisa por Tag retorna o fato histórico, aceita marcador exato e não depende do caminho atual', async () => {
  const paths = await fixture();
  try {
    const original = await readFile(paths.sourcePath);
    const executed = await executeFixture(paths);
    const renamed = join(paths.projectRoot, 'renomeado.js');
    const copied = join(paths.projectRoot, 'copiado.js');
    await rename(paths.sourcePath, renamed);
    await copyFile(renamed, copied);

    const byId = await searchHistoryByTag({ projectRoot: paths.root, tag: ARTIFACT_A });
    const byMarker = await searchHistoryByTag({
      projectRoot: paths.root,
      tag: createSelfMinifierTag(ARTIFACT_A),
    });
    assert.equal(byId.artifactId, ARTIFACT_A);
    assert.equal(byId.executionId, executed.plan.executionId);
    assert.equal(byId.outputHash, executed.artifact.outputHash);
    assert.deepEqual(byMarker, byId);

    const renamedInspection = await inspectHistoricalArtifact({
      projectRoot: paths.root,
      tag: ARTIFACT_A,
      currentPath: renamed,
    });
    const copiedInspection = await inspectHistoricalArtifact({
      projectRoot: paths.root,
      tag: ARTIFACT_A,
      currentPath: copied,
    });
    assert.equal(renamedInspection.observations.currentIntegrity.state, CURRENT_INTEGRITY_STATES.MATCH);
    assert.equal(copiedInspection.observations.currentIntegrity.state, CURRENT_INTEGRITY_STATES.MATCH);

    await rm(renamed);
    const missingInspection = await inspectHistoricalArtifact({
      projectRoot: paths.root,
      tag: ARTIFACT_A,
      currentPath: renamed,
    });
    assert.equal(missingInspection.historical.inputHash, hashContentSha256(original));
    assert.equal(missingInspection.observations.currentIntegrity.state, CURRENT_INTEGRITY_STATES.FILE_UNAVAILABLE);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test('Tag desconhecida e conflito autoritativo falham sem escolher registro', async () => {
  const paths = await fixture();
  try {
    await writeHistoricalExecutionRecord(
      paths.runtime.historyDirectory,
      manualRecord(paths, 'exec-001', ARTIFACT_A, '2026-08-25T10:00:00.000Z'),
    );
    await assert.rejects(
      searchHistoryByTag({ projectRoot: paths.root, tag: UNKNOWN }),
      (error) => error.code === 'TAG_NOT_FOUND',
    );

    const conflicting = manualRecord(paths, 'exec-002', ARTIFACT_A, '2026-08-25T11:00:00.000Z');
    await writeFile(
      join(paths.runtime.historyDirectory, 'exec-002.json'),
      `${JSON.stringify(conflicting, null, 2)}\n`,
      'utf8',
    );
    await assert.rejects(
      searchHistoryByTag({ projectRoot: paths.root, tag: ARTIFACT_A }),
      (error) => error.code === 'HISTORY_ARTIFACT_ID_CONFLICT',
    );
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test('histórico por caminho retorna todas as execuções em ordem determinística sem fabricar continuidade', async () => {
  const paths = await fixture();
  try {
    await writeHistoricalExecutionRecord(
      paths.runtime.historyDirectory,
      manualRecord(paths, 'exec-old', ARTIFACT_A, '2026-08-25T10:00:00.000Z'),
    );
    await writeHistoricalExecutionRecord(
      paths.runtime.historyDirectory,
      manualRecord(paths, 'exec-new', ARTIFACT_B, '2026-08-25T12:00:00.000Z'),
    );
    const newest = await searchHistoryByPath({ projectRoot: paths.root, filePath: paths.sourcePath });
    const oldest = await searchHistoryByPath({
      projectRoot: paths.root,
      filePath: paths.sourcePath,
      order: 'oldest-first',
    });
    assert.deepEqual(newest.records.map((item) => item.artifactId), [ARTIFACT_B, ARTIFACT_A]);
    assert.deepEqual(oldest.records.map((item) => item.artifactId), [ARTIFACT_A, ARTIFACT_B]);
    assert.deepEqual(newest.records.map((item) => item.matchedFields), [['sourcePath'], ['sourcePath']]);
    assert.equal(Object.hasOwn(newest.records[0], 'revision'), false);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test('integridade atual distingue MATCH, CONTENT_CHANGED, TAG_MISMATCH, TAG_MISSING e TAG_INVALID', async () => {
  const paths = await fixture();
  try {
    await executeFixture(paths);
    const matching = await inspectHistoricalArtifact({
      projectRoot: paths.root,
      tag: ARTIFACT_A,
      currentPath: paths.sourcePath,
    });
    assert.equal(matching.observations.currentIntegrity.state, CURRENT_INTEGRITY_STATES.MATCH);

    const tagged = await readFile(paths.sourcePath, 'utf8');
    await writeFile(paths.sourcePath, `${tagged}\nconst alterado=true;\n`, 'utf8');
    const changed = await inspectHistoricalArtifact({
      projectRoot: paths.root,
      tag: ARTIFACT_A,
      currentPath: paths.sourcePath,
    });
    assert.equal(changed.observations.currentIntegrity.state, CURRENT_INTEGRITY_STATES.CONTENT_CHANGED);

    await writeFile(paths.sourcePath, `${createSelfMinifierTag(ARTIFACT_B)}\nconst x=1;\n`, 'utf8');
    const mismatch = await inspectHistoricalArtifact({
      projectRoot: paths.root,
      tag: ARTIFACT_A,
      currentPath: paths.sourcePath,
    });
    assert.equal(mismatch.observations.currentIntegrity.state, CURRENT_INTEGRITY_STATES.TAG_MISMATCH);

    await writeFile(paths.sourcePath, 'const x=1;\n', 'utf8');
    const missing = await inspectHistoricalArtifact({
      projectRoot: paths.root,
      tag: ARTIFACT_A,
      currentPath: paths.sourcePath,
    });
    assert.equal(missing.observations.currentIntegrity.state, CURRENT_INTEGRITY_STATES.TAG_MISSING);

    await writeFile(paths.sourcePath, '/*! SelfMinifier-Tag : inválida */\nconst x=1;\n', 'utf8');
    const invalid = await inspectHistoricalArtifact({
      projectRoot: paths.root,
      tag: ARTIFACT_A,
      currentPath: paths.sourcePath,
    });
    assert.equal(invalid.observations.currentIntegrity.state, CURRENT_INTEGRITY_STATES.TAG_INVALID);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test('backup v2 gzip usa raiz histórica, exporta bytes exatos e não modifica origem/saída atual', async () => {
  const paths = await fixture();
  try {
    const original = await readFile(paths.sourcePath);
    const executed = await executeFixture(paths);
    const currentAfterExecution = await readFile(paths.sourcePath);
    const exportDirectory = join(paths.root, 'exportacao');
    const destination = join(exportDirectory, 'app-original.js');
    await mkdir(exportDirectory);

    await mkdir(join(paths.root, 'Configuracao'));
    await writeFile(join(paths.root, 'Configuracao', 'configuracao.ini'), [
      '[Configuracao]',
      'VersaoSchema=3',
      'Motor=esbuild',
      'Perfil=Padrao',
      `ModoSaida=${OUTPUT_MODES.BACKUP_OVERWRITE}`,
      `PastaRaiz=${paths.projectRoot}`,
      `PastaBackups=${join(paths.root, 'outra-raiz')}`,
      'TiposArquivo=JavaScript',
      '',
    ].join('\n'), 'utf8');

    const availability = await inspectHistoricalBackup({
      projectRoot: paths.root,
      historical: await searchHistoryByTag({ projectRoot: paths.root, tag: ARTIFACT_A }),
    });
    assert.equal(availability.state, BACKUP_AVAILABILITY_STATES.AVAILABLE);
    assert.equal(availability.compression, 'gzip');
    assert.equal(availability.backupRoot, paths.backupRoot);

    const recovered = await recoverHistoricalOriginal({
      projectRoot: paths.root,
      tag: ARTIFACT_A,
      destinationPath: destination,
    });
    assert.equal(recovered.status, 'EXPORTED');
    assert.deepEqual(await readFile(destination), original);
    assert.equal(await hashFileSha256(destination), executed.artifact.inputHash);
    assert.deepEqual(await readFile(paths.sourcePath), currentAfterExecution);
    assert.equal(inspectSelfMinifierTags(await readFile(destination, 'utf8'), 'javascript').exact.length, 0);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test('backup legado v1 raw permanece disponível e exportável', async () => {
  const paths = await fixture();
  try {
    const original = await readFile(paths.sourcePath);
    await executeFixture(paths, { executionId: 'b3-a5-v1' });
    await convertExecutionToLegacyV1(paths, 'b3-a5-v1');
    const historical = await searchHistoryByTag({ projectRoot: paths.root, tag: ARTIFACT_A });
    const availability = await inspectHistoricalBackup({ projectRoot: paths.root, historical });
    assert.equal(availability.state, BACKUP_AVAILABILITY_STATES.AVAILABLE);
    assert.equal(availability.manifestFormatVersion, 1);
    assert.equal(availability.compression, 'none');

    const exportDirectory = join(paths.root, 'exportacao');
    await mkdir(exportDirectory);
    const destination = join(exportDirectory, 'origem-v1.js');
    await recoverHistoricalOriginal({ projectRoot: paths.root, tag: ARTIFACT_A, destinationPath: destination });
    assert.deepEqual(await readFile(destination), original);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test('ausência e corrupção do backup histórico produzem estados distintos e bloqueiam exportação', async (t) => {
  await t.test('raiz indisponível', async () => {
    const paths = await fixture();
    try {
      await executeFixture(paths);
      await rename(paths.backupRoot, `${paths.backupRoot}-movida`);
      const historical = await searchHistoryByTag({ projectRoot: paths.root, tag: ARTIFACT_A });
      assert.equal(
        (await inspectHistoricalBackup({ projectRoot: paths.root, historical })).state,
        BACKUP_AVAILABILITY_STATES.ROOT_UNAVAILABLE,
      );
      await assert.rejects(
        recoverHistoricalOriginal({
          projectRoot: paths.root,
          tag: ARTIFACT_A,
          destinationPath: join(paths.root, 'export.js'),
        }),
        (error) => error.code === 'ROOT_UNAVAILABLE',
      );
    } finally {
      await rm(paths.root, { recursive: true, force: true });
    }
  });

  await t.test('manifesto ausente', async () => {
    const paths = await fixture();
    try {
      await executeFixture(paths);
      await rm(join(paths.backupRoot, 'b3-a5-exec', 'manifest.json'));
      const historical = await searchHistoryByTag({ projectRoot: paths.root, tag: ARTIFACT_A });
      assert.equal(
        (await inspectHistoricalBackup({ projectRoot: paths.root, historical })).state,
        BACKUP_AVAILABILITY_STATES.MANIFEST_MISSING_OR_INVALID,
      );
    } finally {
      await rm(paths.root, { recursive: true, force: true });
    }
  });

  await t.test('payload ausente', async () => {
    const paths = await fixture();
    try {
      const executed = await executeFixture(paths);
      await rm(join(paths.backupRoot, executed.artifact.backup.backupRelativePath));
      const historical = await searchHistoryByTag({ projectRoot: paths.root, tag: ARTIFACT_A });
      assert.equal(
        (await inspectHistoricalBackup({ projectRoot: paths.root, historical })).state,
        BACKUP_AVAILABILITY_STATES.PAYLOAD_MISSING,
      );
    } finally {
      await rm(paths.root, { recursive: true, force: true });
    }
  });

  for (const variant of ['corrompido', 'truncado']) {
    await t.test(`gzip ${variant}`, async () => {
      const paths = await fixture();
      try {
        const executed = await executeFixture(paths);
        const payload = join(paths.backupRoot, executed.artifact.backup.backupRelativePath);
        if (variant === 'corrompido') await writeFile(payload, 'não é gzip', 'utf8');
        else {
          const valid = await readFile(payload);
          await writeFile(payload, valid.subarray(0, Math.max(1, Math.floor(valid.length / 2))));
        }
        const historical = await searchHistoryByTag({ projectRoot: paths.root, tag: ARTIFACT_A });
        assert.equal(
          (await inspectHistoricalBackup({ projectRoot: paths.root, historical })).state,
          BACKUP_AVAILABILITY_STATES.HASH_MISMATCH,
        );
        await assert.rejects(
          recoverHistoricalOriginal({
            projectRoot: paths.root,
            tag: ARTIFACT_A,
            destinationPath: join(paths.root, 'export.js'),
          }),
          (error) => error.code === 'HASH_MISMATCH',
        );
      } finally {
        await rm(paths.root, { recursive: true, force: true });
      }
    });
  }

  await t.test('raw corrompido e hashes históricos contraditórios', async () => {
    const paths = await fixture();
    try {
      await executeFixture(paths, { executionId: 'b3-a5-v1-corrupt' });
      await convertExecutionToLegacyV1(paths, 'b3-a5-v1-corrupt');
      let historical = await searchHistoryByTag({ projectRoot: paths.root, tag: ARTIFACT_A });
      await writeFile(join(paths.backupRoot, historical.backup.backupRelativePath), 'conteúdo divergente\n', 'utf8');
      assert.equal(
        (await inspectHistoricalBackup({ projectRoot: paths.root, historical })).state,
        BACKUP_AVAILABILITY_STATES.HASH_MISMATCH,
      );

      const historyPath = join(paths.runtime.historyDirectory, 'b3-a5-v1-corrupt.json');
      const record = JSON.parse(await readFile(historyPath, 'utf8'));
      record.artifacts[0].backup.originalHash = 'c'.repeat(64);
      await writeFile(historyPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
      historical = await searchHistoryByTag({ projectRoot: paths.root, tag: ARTIFACT_A });
      const contradiction = await inspectHistoricalBackup({ projectRoot: paths.root, historical });
      assert.equal(contradiction.state, BACKUP_AVAILABILITY_STATES.HASH_MISMATCH);
      assert.equal(contradiction.diagnostic.code, 'HISTORICAL_HASH_CONFLICT');
    } finally {
      await rm(paths.root, { recursive: true, force: true });
    }
  });
});

test('modo .min permanece pesquisável e não oferece recuperação sem backup histórico', async () => {
  const paths = await fixture();
  try {
    const executed = await executeFixture(paths, {
      outputMode: OUTPUT_MODES.PRESERVE_AND_CREATE_MINIFIED,
    });
    const historical = await searchHistoryByTag({ projectRoot: paths.root, tag: ARTIFACT_A });
    assert.equal(historical.outputPath, executed.artifact.outputPath);
    assert.equal(historical.backup.available, false);
    const availability = await inspectHistoricalBackup({ projectRoot: paths.root, historical });
    assert.equal(availability.state, BACKUP_AVAILABILITY_STATES.NOT_AVAILABLE);
    assert.equal(availability.recoverable, false);
    await assert.rejects(
      recoverHistoricalOriginal({
        projectRoot: paths.root,
        tag: ARTIFACT_A,
        destinationPath: join(paths.root, 'export.js'),
      }),
      (error) => error.code === 'HISTORICAL_BACKUP_UNAVAILABLE',
    );
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test('exportação é exclusiva, rejeita destino inseguro e nunca substitui origem ou saída histórica', async () => {
  const paths = await fixture();
  try {
    await executeFixture(paths);
    const exportDirectory = join(paths.root, 'exportacao');
    await mkdir(exportDirectory);
    const existing = join(exportDirectory, 'existente.js');
    await writeFile(existing, 'trabalho atual\n', 'utf8');

    await assert.rejects(
      recoverHistoricalOriginal({ projectRoot: paths.root, tag: ARTIFACT_A, destinationPath: existing }),
      (error) => error.code === 'EXPORT_TARGET_EXISTS',
    );
    assert.equal(await readFile(existing, 'utf8'), 'trabalho atual\n');

    const traversal = `${exportDirectory}${sep}..${sep}fora.js`;
    await assert.rejects(
      recoverHistoricalOriginal({ projectRoot: paths.root, tag: ARTIFACT_A, destinationPath: traversal }),
      (error) => error.code === 'UNSAFE_EXPORT_DESTINATION',
    );
    await assert.rejects(
      recoverHistoricalOriginal({ projectRoot: paths.root, tag: ARTIFACT_A, destinationPath: paths.sourcePath }),
      (error) => error.code === 'HISTORICAL_EXPORT_TARGET_FORBIDDEN',
    );
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test('bridge expõe contratos determinísticos e restauração normal permanece independente', async () => {
  const paths = await fixture();
  try {
    const original = await readFile(paths.sourcePath);
    const executed = await executeFixture(paths);

    const searched = await runBridgeRequest({
      command: 'search-history-by-tag',
      tag: ARTIFACT_A,
    }, { projectRoot: paths.root });
    assert.equal(searched.ok, true);
    assert.equal(searched.result.artifactId, ARTIFACT_A);

    const byPath = await runBridgeRequest({
      command: 'search-history-by-path',
      path: paths.sourcePath,
    }, { projectRoot: paths.root });
    assert.equal(byPath.ok, true);
    assert.equal(byPath.result.order, 'newest-first');

    const inspected = await runBridgeRequest({
      command: 'inspect-historical-artifact',
      artifactId: ARTIFACT_A,
      currentPath: paths.sourcePath,
    }, { projectRoot: paths.root });
    assert.equal(inspected.ok, true);
    assert.equal(inspected.result.observations.currentIntegrity.state, CURRENT_INTEGRITY_STATES.MATCH);

    const exportDirectory = join(paths.root, 'exportacao');
    await mkdir(exportDirectory);
    const exported = await runBridgeRequest({
      command: 'recover-historical-original',
      tag: ARTIFACT_A,
      destinationPath: join(exportDirectory, 'bridge.js'),
    }, { projectRoot: paths.root });
    assert.equal(exported.ok, true);
    assert.equal(exported.result.status, 'EXPORTED');

    const restorePlan = await createBackupRestorePlan({
      projectRoot: paths.root,
      backupDirectory: join(paths.backupRoot, executed.plan.executionId),
    });
    const restored = await executeRestorePlan(restorePlan, { confirmed: true });
    assert.equal(restored.items[0].status, 'restored');
    assert.deepEqual(await readFile(paths.sourcePath), original);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test('A4 mantém Tag igual a artifactId e outputHash dos bytes completos', async () => {
  const paths = await fixture();
  try {
    const executed = await executeFixture(paths);
    const bytes = await readFile(executed.artifact.outputPath);
    const tags = inspectSelfMinifierTags(bytes.toString('utf8'), 'javascript');
    assert.equal(tags.exact[0].artifactId, executed.artifact.artifactId);
    assert.equal(hashContentSha256(bytes), executed.artifact.outputHash);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});
