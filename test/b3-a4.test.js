import assert from 'node:assert/strict';
import { copyFile, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';
import { runBridgeRequest } from '../src/app/bridge.mjs';
import { OUTPUT_MODES } from '../src/domain/index.js';
import { createExecutionPlan, executePlan, readExecutionJournal } from '../src/execution/index.js';
import {
  SELFMINIFIER_TAG_NAME,
  createSelfMinifierTag,
  hashContentSha256,
  hashFileSha256,
  insertSelfMinifierTag,
  inspectSelfMinifierTags,
  readBackupManifest,
  readHistoricalExecutionRecord,
  readTechnicalState,
  writeTechnicalState,
} from '../src/integrity/index.js';
import { createDefaultMinifierRegistry } from '../src/minifiers/index.js';
import { createBackupRestorePlan, executeRestorePlan } from '../src/restore/index.js';
import { resolveRuntimePaths } from '../src/runtime/paths.js';
import { buildAnalysis } from '../src/scanner/index.js';

const ARTIFACT_A = '7F31A2C82A884E91B04F22D7';
const ARTIFACT_B = '111111111111111111111111';
const UNKNOWN_ARTIFACT = 'EEEEEEEEEEEEEEEEEEEEEEEE';

async function fixture(files = { 'app.js': 'function somar(a, b) { return a + b; }\n' }) {
  const root = await mkdtemp(join(tmpdir(), 'selfminifier-b3-a4-'));
  const projectRoot = join(root, 'projeto');
  await mkdir(projectRoot);
  for (const [name, content] of Object.entries(files)) await writeFile(join(projectRoot, name), content, 'utf8');
  return {
    root,
    projectRoot,
    backupRoot: join(root, '_source_versions'),
    runtime: resolveRuntimePaths(root),
  };
}

function configuration(paths, outputMode, fileTypes = ['javascript']) {
  return {
    schemaVersion: 2,
    outputMode,
    engine: 'esbuild',
    profile: 'Padrao',
    projectRoot: paths.projectRoot,
    fileTypes,
    ignoredFolders: [],
    ignoredFiles: [],
  };
}

async function planFor(paths, outputMode, executionId, fileTypes = ['javascript']) {
  const minifier = createDefaultMinifierRegistry().get('esbuild');
  const plan = await createExecutionPlan({
    configuration: configuration(paths, outputMode, fileTypes),
    minifier,
    runtimeRoot: paths.root,
    backupRoot: paths.backupRoot,
    executionId,
    timestamp: '2026-08-25T12:00:00.000Z',
    selfMinifierVersion: '0.2.0',
  });
  return { plan, minifier };
}

function artifactGenerator(...artifactIds) {
  let index = 0;
  return () => artifactIds[index++];
}

test('módulo usa sintaxe fechada, posiciona Tag com segurança e não acumula marcadores', () => {
  assert.equal(SELFMINIFIER_TAG_NAME, 'SelfMinifier-Tag');
  assert.equal(createSelfMinifierTag(ARTIFACT_A), '/*! SelfMinifier-Tag: 7F31A2C82A884E91B04F22D7 */');

  const normalJs = insertSelfMinifierTag('const x=1;\n', 'javascript', ARTIFACT_A);
  assert.equal(inspectSelfMinifierTags(normalJs, 'javascript').exact.length, 1);

  const shebang = insertSelfMinifierTag('#!/usr/bin/env node\nconsole.log(1);\n', 'javascript', ARTIFACT_A);
  assert.deepEqual(shebang.split('\n').slice(0, 2), ['#!/usr/bin/env node', createSelfMinifierTag(ARTIFACT_A)]);

  const charset = insertSelfMinifierTag('@charset "UTF-8";body{color:red}', 'css', ARTIFACT_A);
  assert.deepEqual(charset.split('\n').slice(0, 2), ['@charset "UTF-8";', createSelfMinifierTag(ARTIFACT_A)]);

  const licensed = insertSelfMinifierTag('/*! licença do usuário */\nconst x=1;', 'javascript', ARTIFACT_A);
  assert.match(licensed, /\/\*! licença do usuário \*\//);
  assert.equal(inspectSelfMinifierTags('const texto="/*! SelfMinifier-Tag: 7F31A2C82A884E91B04F22D7 */";', 'javascript').exact.length, 0);
  assert.equal(inspectSelfMinifierTags('/*! SelfMinifier-Tag : inválida */', 'css').invalid.length, 1);
  assert.throws(
    () => insertSelfMinifierTag(normalJs, 'javascript', ARTIFACT_A),
    (error) => error.code === 'SELFMINIFIER_TAG_ACCUMULATION_BLOCKED',
  );
});

test('saída .min vincula Tag ao artifactId e persiste o hash dos bytes completos em todos os registros aplicáveis', async () => {
  const paths = await fixture({ 'app.js': '/*! licença preservada */\nfunction somar(a, b) { return a + b; }\n' });
  try {
    const sourcePath = join(paths.projectRoot, 'app.js');
    const sourceBefore = await readFile(sourcePath);
    const { plan, minifier } = await planFor(paths, OUTPUT_MODES.PRESERVE_AND_CREATE_MINIFIED, 'b3-a4-min');
    const result = await executePlan(plan, minifier, { confirmed: true, selfMinifierVersion: '0.2.0' }, {
      generateArtifactId: artifactGenerator(ARTIFACT_A),
    });
    const outputPath = join(paths.projectRoot, 'app.min.js');
    const output = await readFile(outputPath, 'utf8');
    const outputHash = hashContentSha256(output);
    const inspected = inspectSelfMinifierTags(output, 'javascript');
    const history = await readHistoricalExecutionRecord(paths.runtime.historyDirectory, plan.executionId);
    const state = await readTechnicalState(paths.runtime.technicalState);
    const journal = await readExecutionJournal(paths.runtime.lastExecutionJournal);

    assert.equal(result.status, 'completed');
    assert.deepEqual(await readFile(sourcePath), sourceBefore);
    assert.equal(inspectSelfMinifierTags(await readFile(sourcePath, 'utf8'), 'javascript').exact.length, 0);
    assert.equal(inspected.exact.length, 1);
    assert.equal(inspected.exact[0].artifactId, ARTIFACT_A);
    assert.match(output, /\/\*! licença preservada \*\//);
    assert.equal(await hashFileSha256(outputPath), outputHash);
    assert.equal(journal.items[0].artifactId, ARTIFACT_A);
    assert.equal(journal.items[0].expectedOutputHash, outputHash);
    assert.equal(state.records[0].artifactId, ARTIFACT_A);
    assert.equal(state.records[0].minifiedHash, outputHash);
    assert.equal(history.artifacts[0].artifactId, ARTIFACT_A);
    assert.equal(history.artifacts[0].outputHash, outputHash);
    assert.equal(result.manifestPath, null);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test('execução real preserva shebang e @charset antes da única Tag', async () => {
  const paths = await fixture({
    'cli.js': '#!/usr/bin/env node\nconsole.log( 1 );\n',
    'style.css': '@charset "UTF-8";\nbody { color: red; }\n',
  });
  try {
    const { plan, minifier } = await planFor(paths, OUTPUT_MODES.PRESERVE_AND_CREATE_MINIFIED, 'b3-a4-placement', ['javascript', 'css']);
    await executePlan(plan, minifier, { confirmed: true }, {
      generateArtifactId: artifactGenerator(ARTIFACT_A, ARTIFACT_B),
    });
    const history = await readHistoricalExecutionRecord(paths.runtime.historyDirectory, plan.executionId);
    const jsArtifact = history.artifacts.find((artifact) => basename(artifact.sourcePath) === 'cli.js');
    const cssArtifact = history.artifacts.find((artifact) => basename(artifact.sourcePath) === 'style.css');
    const jsOutput = await readFile(jsArtifact.outputPath, 'utf8');
    const cssOutput = await readFile(cssArtifact.outputPath, 'utf8');

    assert.equal(jsOutput.split(/\r?\n/)[0], '#!/usr/bin/env node');
    assert.equal(jsOutput.split(/\r?\n/)[1], createSelfMinifierTag(jsArtifact.artifactId));
    assert.equal(inspectSelfMinifierTags(jsOutput, 'javascript').exact.length, 1);
    assert.equal(cssOutput.split(/\r?\n/)[0], '@charset "UTF-8";');
    assert.equal(cssOutput.split(/\r?\n/)[1], createSelfMinifierTag(cssArtifact.artifactId));
    assert.equal(inspectSelfMinifierTags(cssOutput, 'css').exact.length, 1);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test('proveniência por Tag reconhece rename e cópia e bloqueia conteúdo alterado, Tag desconhecida, múltipla ou inválida', async () => {
  const paths = await fixture();
  try {
    const first = await planFor(paths, OUTPUT_MODES.PRESERVE_AND_CREATE_MINIFIED, 'b3-a4-provenance');
    await executePlan(first.plan, first.minifier, { confirmed: true }, {
      generateArtifactId: artifactGenerator(ARTIFACT_A),
    });
    const taggedOutput = join(paths.projectRoot, 'app.min.js');
    const renamed = join(paths.projectRoot, 'renamed.js');
    await rename(taggedOutput, renamed);
    await copyFile(renamed, join(paths.projectRoot, 'copied.js'));
    await copyFile(renamed, join(paths.projectRoot, 'changed.js'));
    await writeFile(join(paths.projectRoot, 'changed.js'), `${await readFile(renamed, 'utf8')}\nconst alterado=true;\n`, 'utf8');
    await writeFile(join(paths.projectRoot, 'unknown.js'), `${createSelfMinifierTag(UNKNOWN_ARTIFACT)}\nconst desconhecido=true;\n`, 'utf8');
    await writeFile(join(paths.projectRoot, 'multiple.js'), `${createSelfMinifierTag(ARTIFACT_A)}\n${createSelfMinifierTag(UNKNOWN_ARTIFACT)}\nconst multiplo=true;\n`, 'utf8');
    await writeFile(join(paths.projectRoot, 'invalid.js'), '/*! SelfMinifier-Tag : 7F31A2C82A884E91B04F22D7 */\nconst invalido=true;\n', 'utf8');
    await writeFile(join(paths.projectRoot, 'license.js'), '/*! license */\nconst legal=true;\n', 'utf8');
    await writeFile(join(paths.projectRoot, 'vendor.min.js'), `${createSelfMinifierTag(UNKNOWN_ARTIFACT)}\nconst vendor=true;\n`, 'utf8');

    const second = await planFor(paths, OUTPUT_MODES.PRESERVE_AND_CREATE_MINIFIED, 'b3-a4-classification');
    const byName = new Map(second.plan.ignored.map((item) => [basename(item.normalizedPath), item]));
    assert.equal(byName.get('renamed.js').reason, 'ALREADY_MINIFIED_BY_SELFMINIFIER');
    assert.equal(byName.get('copied.js').reason, 'ALREADY_MINIFIED_BY_SELFMINIFIER');
    assert.equal(byName.get('changed.js').reason, 'SELFMINIFIER_TAG_CONTENT_CHANGED');
    assert.equal(byName.get('unknown.js').reason, 'SELFMINIFIER_TAG_UNKNOWN');
    assert.equal(byName.get('multiple.js').reason, 'SELFMINIFIER_TAG_MULTIPLE');
    assert.equal(byName.get('invalid.js').reason, 'SELFMINIFIER_TAG_INVALID');
    assert.equal(byName.get('vendor.min.js').reason, 'ALREADY_MINIFIED');
    assert.equal(byName.get('changed.js').status, 'blocked');
    assert.equal(byName.get('unknown.js').status, 'blocked');
    assert.equal(second.plan.items.some((item) => basename(item.sourcePath) === 'license.js'), true);
    assert.equal(second.plan.items.some((item) => basename(item.sourcePath) === 'vendor.min.js'), false);
    assert.equal(second.plan.analysisResult.counts.eligible, second.plan.items.length);

    const analysis = buildAnalysis(second.plan.analysisResult);
    const reasons = new Map(analysis.ignoredByReason.map((item) => [item.reason, item.label]));
    assert.equal(reasons.get('ALREADY_MINIFIED_BY_SELFMINIFIER'), 'Já minificado pelo SelfMinifier');
    assert.equal(reasons.has('SELFMINIFIER_TAG_CONTENT_CHANGED'), true);
    assert.equal(reasons.has('SELFMINIFIER_TAG_UNKNOWN'), true);
    assert.equal(reasons.has('SELFMINIFIER_TAG_MULTIPLE'), true);
    assert.equal(reasons.has('SELFMINIFIER_TAG_INVALID'), true);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test('sobrescrita mantém backup original, hashes coerentes, restaura sem Tag e preserva reconhecimento legado sem Tag', async () => {
  const paths = await fixture();
  try {
    const sourcePath = join(paths.projectRoot, 'app.js');
    const original = await readFile(sourcePath);
    const { plan, minifier } = await planFor(paths, OUTPUT_MODES.BACKUP_OVERWRITE, 'b3-a4-overwrite');
    const result = await executePlan(plan, minifier, { confirmed: true, selfMinifierVersion: '0.2.0' }, {
      generateArtifactId: artifactGenerator(ARTIFACT_A),
    });
    const tagged = await readFile(sourcePath, 'utf8');
    const finalHash = hashContentSha256(tagged);
    const stateBeforeRestore = await readTechnicalState(paths.runtime.technicalState);
    const journal = await readExecutionJournal(paths.runtime.lastExecutionJournal);
    const history = await readHistoricalExecutionRecord(paths.runtime.historyDirectory, plan.executionId);
    const manifest = await readBackupManifest(result.manifestPath);
    const backupPath = join(paths.backupRoot, manifest.files[0].backupRelativePath);

    assert.equal(inspectSelfMinifierTags(tagged, 'javascript').exact[0].artifactId, ARTIFACT_A);
    assert.equal(journal.items[0].expectedOutputHash, finalHash);
    assert.equal(stateBeforeRestore.records[0].minifiedHash, finalHash);
    assert.equal(history.artifacts[0].outputHash, finalHash);
    assert.equal(manifest.files[0].minifiedSha256, finalHash);
    assert.equal(manifest.files[0].artifactId, ARTIFACT_A);
    assert.deepEqual(gunzipSync(await readFile(backupPath)), original);
    assert.equal(inspectSelfMinifierTags(gunzipSync(await readFile(backupPath)).toString('utf8'), 'javascript').exact.length, 0);

    const restorePlan = await createBackupRestorePlan({
      projectRoot: paths.root,
      backupDirectory: join(paths.backupRoot, plan.executionId),
    });
    await executeRestorePlan(restorePlan, { confirmed: true });
    assert.deepEqual(await readFile(sourcePath), original);
    assert.equal(inspectSelfMinifierTags(await readFile(sourcePath, 'utf8'), 'javascript').exact.length, 0);

    const legacyRecord = structuredClone(stateBeforeRestore.records[0]);
    delete legacyRecord.executionId;
    delete legacyRecord.artifactId;
    legacyRecord.sourceHash = hashContentSha256(original);
    legacyRecord.minifiedHash = hashContentSha256(original);
    legacyRecord.sourceSize = original.length;
    legacyRecord.minifiedSize = original.length;
    await writeTechnicalState({ formatVersion: 1, records: [legacyRecord] }, paths.runtime.technicalState);
    const legacy = await planFor(paths, OUTPUT_MODES.BACKUP_OVERWRITE, 'b3-a4-legacy-untagged');
    assert.equal(legacy.plan.ignored.some((item) => item.reason === 'ALREADY_MINIFIED_UNCHANGED'), true);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test('V3 mantém fingerprint estável entre análise e execução com artifactId alocado somente na execução', async () => {
  const paths = await fixture();
  try {
    await mkdir(join(paths.root, 'Configuracao'));
    await writeFile(join(paths.root, 'Configuracao', 'configuracao.ini'), [
      '[Configuracao]',
      'VersaoSchema=3',
      'Motor=esbuild',
      'Perfil=Padrao',
      `ModoSaida=${OUTPUT_MODES.PRESERVE_AND_CREATE_MINIFIED}`,
      `PastaRaiz=${paths.projectRoot}`,
      'PastaBackups=',
      'TiposArquivo=JavaScript',
      '',
    ].join('\n'), 'utf8');

    const executionId = 'b3-a4-fingerprint-v3';
    const analyzed = await runBridgeRequest({ command: 'analyze', executionId }, { projectRoot: paths.root });
    assert.equal(analyzed.ok, true, analyzed.diagnostic?.message);
    const executed = await runBridgeRequest({
      command: 'execute',
      executionId,
      confirmed: true,
      confirmationFingerprint: analyzed.analysis.confirmationFingerprint,
    }, { projectRoot: paths.root });
    assert.equal(executed.ok, true, executed.diagnostic?.message);
    assert.equal(executed.result.status, 'completed');
    assert.equal(inspectSelfMinifierTags(await readFile(join(paths.projectRoot, 'app.min.js'), 'utf8'), 'javascript').exact.length, 1);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});
