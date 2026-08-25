import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, normalize } from 'node:path';
import test from 'node:test';
import {
  identifyConfigurationSchema,
  loadConfiguration,
  normalizeBackupRootValue,
  resolveEffectiveBackupRoot,
  serializeV3Configuration,
  validateExternalBackupRoot,
} from '../src/configuration/index.js';
import { runBridgeRequest } from '../src/app/bridge.mjs';
import { OUTPUT_MODES } from '../src/domain/index.js';
import { createExecutionPlan, executePlan } from '../src/execution/index.js';
import { proveDirectoryWritable, readHistoricalExecutionRecord } from '../src/integrity/index.js';
import { createDefaultMinifierRegistry } from '../src/minifiers/index.js';
import { createBackupRestorePlan, listKnownBackups } from '../src/restore/index.js';
import { resolveRuntimePaths } from '../src/runtime/paths.js';

const allowedEngines = new Set(['esbuild']);

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
  const root = await mkdtemp(join(tmpdir(), 'selfminifier-b3-a2-'));
  const projectRoot = join(root, 'projeto');
  const externalA = join(root, 'backups-externos-a');
  const externalB = join(root, 'backups-externos-b');
  await mkdir(projectRoot);
  await mkdir(externalA);
  await mkdir(externalB);
  await writeFile(join(projectRoot, 'entrada.js'), 'function somar(a, b) { return a + b; }\n', 'utf8');
  await mkdir(join(root, 'Configuracao'));
  await writeFile(
    join(root, 'Configuracao', 'configuracao.ini'),
    ini({ schemaVersion, projectRoot, backupRoot, outputMode }),
    'utf8',
  );
  return { root, projectRoot, externalA, externalB, source: join(projectRoot, 'entrada.js') };
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

test('contrato aceita V2/V3, mantém V1 rejeitada e bloqueia V2 com PastaBackups', async () => {
  const paths = await fixture();
  try {
    const configurationPath = join(paths.root, 'Configuracao', 'configuracao.ini');
    const loadedV2 = await loadConfiguration(configurationPath, { allowedEngines });
    assert.equal(loadedV2.schema.kind, 'v2');
    assert.equal(loadedV2.configuration.schemaVersion, 2);

    await writeFile(configurationPath, ini({ schemaVersion: 3, projectRoot: paths.projectRoot }), 'utf8');
    const loadedV3 = await loadConfiguration(configurationPath, { allowedEngines });
    assert.equal(loadedV3.schema.kind, 'v3');
    assert.equal(loadedV3.configuration.backupRoot, null);

    assert.throws(
      () => identifyConfigurationSchema('[Configuracao]\nMotor=esbuild\nPerfil=Padrao\nIncluir01=*.js\n'),
      (error) => error.code === 'MISSING_SCHEMA_VERSION',
    );
    assert.throws(
      () => identifyConfigurationSchema(`${ini({ schemaVersion: 2, projectRoot: paths.projectRoot }).trim()}\nPastaBackups=${paths.externalA}\n`),
      (error) => error.code === 'MIXED_SCHEMA',
    );
  } finally { await rm(paths.root, { recursive: true, force: true }); }
});

test('V3 normaliza PastaBackups, serializa deterministicamente e resolve sem fallback espalhado', async () => {
  const paths = await fixture({ schemaVersion: 3, backupRoot: null });
  try {
    const configurationPath = join(paths.root, 'Configuracao', 'configuracao.ini');
    const internal = await loadConfiguration(configurationPath, { allowedEngines });
    assert.equal(internal.configuration.backupRoot, null);
    assert.equal(await resolveEffectiveBackupRoot(internal.configuration, paths.root), join(paths.root, '_source_versions'));

    await writeFile(configurationPath, ini({
      schemaVersion: 3,
      projectRoot: paths.projectRoot,
      backupRoot: paths.externalA.replaceAll('\\', '/'),
    }), 'utf8');
    const external = await loadConfiguration(configurationPath, { allowedEngines });
    assert.equal(external.configuration.backupRoot, normalize(paths.externalA));
    assert.equal(await resolveEffectiveBackupRoot(external.configuration, paths.root), normalize(paths.externalA));
    assert.equal(serializeV3Configuration(external.configuration), serializeV3Configuration(external.configuration));
    assert.match(serializeV3Configuration(external.configuration), /VersaoSchema=3[\s\S]*PastaBackups=/);
  } finally { await rm(paths.root, { recursive: true, force: true }); }
});

test('edição dedicada migra V2→V3, preserva campos e limpar mantém V3', async () => {
  const paths = await fixture();
  const configurationPath = join(paths.root, 'Configuracao', 'configuracao.ini');
  try {
    const before = (await runBridgeRequest({ command: 'summary' }, { projectRoot: paths.root })).configuration;
    const cancelled = await runBridgeRequest({ command: 'update-backup-root', backupRoot: paths.externalA, confirmed: false }, { projectRoot: paths.root });
    assert.equal(cancelled.ok, false);
    assert.equal((await loadConfiguration(configurationPath, { allowedEngines })).configuration.schemaVersion, 2);

    const migrated = await runBridgeRequest({ command: 'update-backup-root', backupRoot: paths.externalA, confirmed: true }, { projectRoot: paths.root });
    assert.equal(migrated.ok, true, migrated.diagnostic?.message);
    assert.equal(migrated.migratedFromV2, true);
    assert.equal(migrated.configuration.schemaVersion, 3);
    assert.equal(migrated.configuration.backupRoot, normalize(paths.externalA));
    for (const field of ['engine', 'profile', 'outputMode', 'projectRoot', 'fileTypes', 'ignoredFolders', 'ignoredFiles']) {
      assert.deepEqual(migrated.configuration[field], before[field]);
    }

    const modeChanged = await runBridgeRequest({
      command: 'update-output-mode',
      outputMode: OUTPUT_MODES.PRESERVE_AND_CREATE_MINIFIED,
      confirmed: true,
    }, { projectRoot: paths.root });
    assert.equal(modeChanged.configuration.schemaVersion, 3);
    assert.equal(modeChanged.configuration.backupRoot, normalize(paths.externalA));

    const cleared = await runBridgeRequest({ command: 'update-backup-root', backupRoot: null, confirmed: true }, { projectRoot: paths.root });
    assert.equal(cleared.ok, true);
    assert.equal(cleared.configuration.schemaVersion, 3);
    assert.equal(cleared.configuration.backupRoot, null);
  } finally { await rm(paths.root, { recursive: true, force: true }); }
});

test('validação lexical bloqueia relativo, traversal, glob e expansão de ambiente', () => {
  assert.throws(() => normalizeBackupRootValue('backups'), (error) => error.code === 'ABSOLUTE_BACKUP_PATH_REQUIRED');
  assert.throws(() => normalizeBackupRootValue('C:\\dados\\..\\backups'), (error) => error.code === 'PARENT_TRAVERSAL_NOT_ALLOWED');
  assert.throws(() => normalizeBackupRootValue('C:\\dados\\*'), (error) => error.code === 'GLOB_NOT_ALLOWED');
  assert.throws(() => normalizeBackupRootValue('%TEMP%\\backups'), (error) => error.code === 'ENV_EXPANSION_NOT_ALLOWED');
  assert.throws(() => normalizeBackupRootValue('$env:TEMP\\backups'), (error) => error.code === 'ENV_EXPANSION_NOT_ALLOWED');
});

test('validação física bloqueia ausente, arquivo, junction/reparse e sobreposição bidirecional', async () => {
  const paths = await fixture();
  try {
    const fileRoot = join(paths.root, 'nao-diretorio');
    await writeFile(fileRoot, 'x');
    await assert.rejects(validateExternalBackupRoot(join(paths.root, 'ausente'), paths.projectRoot), (error) => error.code === 'UNSAFE_EXTERNAL_BACKUP_ROOT');
    await assert.rejects(validateExternalBackupRoot(fileRoot, paths.projectRoot), (error) => error.code === 'UNSAFE_EXTERNAL_BACKUP_ROOT');
    await assert.rejects(validateExternalBackupRoot(paths.projectRoot, paths.projectRoot), (error) => error.code === 'BACKUP_PROJECT_ROOT_OVERLAP');

    const descendant = join(paths.projectRoot, 'backups');
    await mkdir(descendant);
    await assert.rejects(validateExternalBackupRoot(descendant, paths.projectRoot), (error) => error.code === 'BACKUP_PROJECT_ROOT_OVERLAP');

    const parent = join(paths.root, 'pai');
    const nestedProject = join(parent, 'projeto');
    await mkdir(nestedProject, { recursive: true });
    await assert.rejects(validateExternalBackupRoot(parent, nestedProject), (error) => error.code === 'BACKUP_PROJECT_ROOT_OVERLAP');

    const junction = join(paths.root, 'junction-backups');
    await symlink(paths.externalA, junction, 'junction');
    await assert.rejects(validateExternalBackupRoot(junction, paths.projectRoot), (error) => (
      error.code === 'UNSAFE_EXTERNAL_BACKUP_ROOT'
      && ['LINK_NOT_ALLOWED', 'REPARSE_POINT_NOT_ALLOWED'].includes(error.details.cause.code)
    ));
  } finally { await rm(paths.root, { recursive: true, force: true }); }
});

test('prova exclusiva de escrita falha fechado e não deixa arquivo residual', async () => {
  const paths = await fixture();
  try {
    await assert.rejects(
      proveDirectoryWritable(paths.externalA, {
        openFile: async () => {
          const error = new Error('acesso negado sintético');
          error.code = 'EACCES';
          throw error;
        },
      }),
      (error) => error.code === 'BACKUP_ROOT_NOT_WRITABLE',
    );
    assert.deepEqual(await readdir(paths.externalA), []);
  } finally { await rm(paths.root, { recursive: true, force: true }); }
});

test('sobrescrita V3 usa layout externo e histórico persiste a raiz real com compressão gzip', async () => {
  const paths = await fixture({ schemaVersion: 3, backupRoot: null });
  try {
    const migrated = await runBridgeRequest({ command: 'update-backup-root', backupRoot: paths.externalA, confirmed: true }, { projectRoot: paths.root });
    assert.equal(migrated.ok, true, migrated.diagnostic?.message);
    const executionId = 'b3-a2-external';
    const executed = await analyzeAndExecute(paths.root, executionId);
    assert.equal(await lstat(join(paths.externalA, executionId, 'manifest.json')).then((stats) => stats.isFile()), true);
    const history = await readHistoricalExecutionRecord(resolveRuntimePaths(paths.root).historyDirectory, executionId);
    assert.equal(history.artifacts[0].backup.backupRoot, normalize(paths.externalA));
    assert.equal(history.artifacts[0].backup.compression, 'gzip');
    assert.equal(history.formatVersion, 1);
    assert.equal(executed.result.status, 'completed');
  } finally { await rm(paths.root, { recursive: true, force: true }); }
});

test('mudança da configuração não muda a raiz histórica usada por descoberta/restauração', async () => {
  const paths = await fixture({ schemaVersion: 3, backupRoot: null });
  try {
    await runBridgeRequest({ command: 'update-backup-root', backupRoot: paths.externalA, confirmed: true }, { projectRoot: paths.root });
    const executionId = 'b3-a2-history-root';
    await analyzeAndExecute(paths.root, executionId);
    await runBridgeRequest({ command: 'update-backup-root', backupRoot: paths.externalB, confirmed: true }, { projectRoot: paths.root });

    const item = (await listKnownBackups(paths.root)).find((candidate) => candidate.executionId === executionId);
    assert.equal(item.status, 'valid');
    assert.equal(item.directory, join(paths.externalA, executionId));
    const plan = await createBackupRestorePlan({ projectRoot: paths.root, backupDirectory: item.directory });
    assert.equal(plan.backupRoot, normalize(paths.externalA));
    assert.equal(plan.backupAuthority, 'history');
  } finally { await rm(paths.root, { recursive: true, force: true }); }
});

test('raiz histórica externa indisponível permanece visível e bloqueia sem fallback', async () => {
  const paths = await fixture({ schemaVersion: 3, backupRoot: null });
  try {
    await runBridgeRequest({ command: 'update-backup-root', backupRoot: paths.externalA, confirmed: true }, { projectRoot: paths.root });
    const executionId = 'b3-a2-unavailable';
    await analyzeAndExecute(paths.root, executionId);
    await rm(paths.externalA, { recursive: true, force: true });

    const item = (await listKnownBackups(paths.root)).find((candidate) => candidate.executionId === executionId);
    assert.equal(item.status, 'unavailable');
    assert.equal(item.expectedPath, join(paths.externalA, executionId));
    await assert.rejects(
      createBackupRestorePlan({ projectRoot: paths.root, backupDirectory: join(paths.externalA, executionId) }),
      (error) => error.code === 'HISTORICAL_BACKUP_ROOT_UNAVAILABLE',
    );
    await assert.rejects(lstat(join(paths.root, '_source_versions', executionId)));
  } finally { await rm(paths.root, { recursive: true, force: true }); }
});

test('backup interno V2 legado permanece descobrível e restaurável', async () => {
  const paths = await fixture();
  try {
    const executionId = 'b3-a2-legacy-internal';
    await analyzeAndExecute(paths.root, executionId);
    const item = (await listKnownBackups(paths.root)).find((candidate) => candidate.executionId === executionId);
    assert.equal(item.status, 'valid');
    assert.equal(item.directory, join(paths.root, '_source_versions', executionId));
    const plan = await createBackupRestorePlan({ projectRoot: paths.root, backupDirectory: item.directory });
    assert.equal(plan.backupRoot, join(paths.root, '_source_versions'));
  } finally { await rm(paths.root, { recursive: true, force: true }); }
});

test('V3 não altera comportamento .min nem ALREADY_MINIFIED_UNCHANGED', async () => {
  const minPaths = await fixture({ schemaVersion: 3, backupRoot: null, outputMode: OUTPUT_MODES.PRESERVE_AND_CREATE_MINIFIED });
  try {
    await runBridgeRequest({ command: 'update-backup-root', backupRoot: minPaths.externalA, confirmed: true }, { projectRoot: minPaths.root });
    await analyzeAndExecute(minPaths.root, 'b3-a2-min');
    assert.equal(await readFile(minPaths.source, 'utf8'), 'function somar(a, b) { return a + b; }\n');
    assert.equal(await lstat(minPaths.source.replace(/\.js$/, '.min.js')).then((stats) => stats.isFile()), true);
    assert.deepEqual(await readdir(minPaths.externalA), []);
  } finally { await rm(minPaths.root, { recursive: true, force: true }); }

  const overwrite = await fixture({ schemaVersion: 3, backupRoot: null });
  try {
    await runBridgeRequest({ command: 'update-backup-root', backupRoot: overwrite.externalA, confirmed: true }, { projectRoot: overwrite.root });
    await analyzeAndExecute(overwrite.root, 'b3-a2-first');
    const second = await runBridgeRequest({ command: 'analyze', executionId: 'b3-a2-second' }, { projectRoot: overwrite.root });
    assert.equal(second.ok, true);
    assert.equal(second.analysis.ignored.some((item) => item.reason === 'ALREADY_MINIFIED_UNCHANGED'), true);
  } finally { await rm(overwrite.root, { recursive: true, force: true }); }
});

test('rollback transacional continua restaurando a fonte com payload externo', async () => {
  const paths = await fixture({ schemaVersion: 3, backupRoot: null });
  try {
    const configuration = {
      schemaVersion: 3,
      engine: 'esbuild',
      profile: 'Padrao',
      outputMode: OUTPUT_MODES.BACKUP_OVERWRITE,
      projectRoot: paths.projectRoot,
      backupRoot: paths.externalA,
      fileTypes: ['javascript'],
      ignoredFolders: [],
      ignoredFiles: [],
    };
    const minifier = createDefaultMinifierRegistry().get('esbuild');
    const before = await readFile(paths.source);
    const plan = await createExecutionPlan({
      configuration,
      minifier,
      runtimeRoot: paths.root,
      backupRoot: paths.externalA,
      executionId: 'b3-a2-rollback',
      timestamp: '2026-08-25T12:00:00.000Z',
      meminifyVersion: '0.2.0',
    });
    await assert.rejects(
      executePlan(plan, minifier, { confirmed: true, meminifyVersion: '0.2.0' }, {
        hooks: { afterMutation: async () => { throw new Error('falha sintética depois da mutação'); } },
      }),
      (error) => error.details?.rollbackStatus === 'rolled-back',
    );
    assert.deepEqual(await readFile(paths.source), before);
    assert.equal(await lstat(join(paths.externalA, 'b3-a2-rollback')).then((stats) => stats.isDirectory()), true);
  } finally { await rm(paths.root, { recursive: true, force: true }); }
});
