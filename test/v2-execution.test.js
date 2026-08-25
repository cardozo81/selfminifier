import test from 'node:test';
import assert from 'node:assert/strict';
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateV2Configuration } from '../src/configuration/index.js';
import { createExecutionPlan, executePlan, readExecutionJournal, writeExecutionJournal } from '../src/execution/index.js';
import { IntegrityError, readTechnicalState } from '../src/integrity/index.js';
import { createDefaultMinifierRegistry } from '../src/minifiers/index.js';
import { runBridgeRequest } from '../src/app/bridge.mjs';
import { resolveRuntimePaths } from '../src/runtime/paths.js';

const windowsTest = process.platform === 'win32' ? test : test.skip;

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function configurationText(projectRoot, {
  fileTypes = 'CSS+JavaScript',
  outputMode = 'PreservarOriginaisECriarMinificados',
  ignoredFolders = [],
  ignoredFiles = [],
} = {}) {
  const lines = [
    '[Configuracao]',
    'VersaoSchema=2',
    'Motor=esbuild',
    'Perfil=Padrao',
    `ModoSaida=${outputMode}`,
    `PastaRaiz=${projectRoot}`,
    `TiposArquivo=${fileTypes}`,
  ];
  ignoredFolders.forEach((folder, index) => lines.push(`IgnorarPasta${String(index + 1).padStart(2, '0')}=${folder}`));
  ignoredFiles.forEach((file, index) => lines.push(`IgnorarArquivo${String(index + 1).padStart(2, '0')}=${file}`));
  return `${lines.join('\n')}\n`;
}

async function bridgeFixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'selfminifier-v2-execution-'));
  const projectRoot = join(root, 'projeto');
  await mkdir(projectRoot, { recursive: true });
  await mkdir(join(root, 'Configuracao'), { recursive: true });
  await writeFile(join(root, 'Configuracao', 'configuracao.ini'), configurationText(projectRoot, options), 'utf8');
  return { root, projectRoot };
}

function minifier() {
  return createDefaultMinifierRegistry().get('esbuild');
}

async function directPlan(root, projectRoot, executionId) {
  const configuration = validateV2Configuration({
    engine: 'esbuild',
    profile: 'Padrao',
    outputMode: 'PreservarOriginaisECriarMinificados',
    projectRoot,
    fileTypes: ['javascript'],
    ignoredFolders: [],
    ignoredFiles: [],
  }, { allowedEngines: new Set(['esbuild']) });
  const adapter = minifier();
  const plan = await createExecutionPlan({
    configuration,
    minifier: adapter,
    runtimeRoot: root,
    executionId,
    timestamp: '2026-08-24T12:00:00.000Z',
  });
  return { plan, adapter };
}

windowsTest('V2 executa somente candidatos planejados e preserva .min preexistente sem falsa propriedade', async () => {
  const { root, projectRoot } = await bridgeFixture({
    ignoredFolders: ['vendor'],
    ignoredFiles: ['ignorado.js'],
  });
  const runtimePaths = resolveRuntimePaths(root);
  const app = join(projectRoot, 'app.js');
  const appMin = join(projectRoot, 'app.min.js');
  const css = join(projectRoot, 'site.css');
  const cssMin = join(projectRoot, 'site.min.css');
  const readonly = join(projectRoot, 'somente-leitura.js');
  try {
    await mkdir(join(projectRoot, 'vendor'), { recursive: true });
    await writeFile(app, 'const app = 1;\n', 'utf8');
    await writeFile(css, 'body { color: red; }\n', 'utf8');
    await writeFile(cssMin, '/* saída preexistente */\n', 'utf8');
    await writeFile(join(projectRoot, 'ignorado.js'), 'const ignorado = 1;\n', 'utf8');
    await writeFile(join(projectRoot, 'vendor', 'vendor.js'), 'const vendor = 1;\n', 'utf8');
    await writeFile(join(projectRoot, 'bundle.min.js'), 'const minificado = 1;\n', 'utf8');
    await writeFile(readonly, 'const readonly = 1;\n', 'utf8');
    await chmod(readonly, 0o444);

    const analyzed = await runBridgeRequest({ command: 'scan-analysis', executionId: 'v2-safe-001' }, { projectRoot: root });
    assert.equal(analyzed.ok, true);
    assert.deepEqual(analyzed.analysis.execution.items.map((item) => item.relativePath), ['app.js']);
    assert.equal(analyzed.analysis.execution.conflicts.length, 1);
    assert.equal(analyzed.analysis.execution.conflicts[0].action, 'skipped');
    assert.ok(analyzed.analysis.ignoredByReason.some((entry) => entry.reason === 'ALREADY_MINIFIED'));
    assert.ok(analyzed.analysis.ignoredByReason.some((entry) => entry.reason === 'IGNORED_FILE'));
    assert.ok(analyzed.analysis.ignoredByReason.some((entry) => entry.reason === 'IGNORED_FOLDER'));
    assert.ok(analyzed.analysis.ignoredByReason.some((entry) => entry.reason === 'READONLY_FILE'));

    const executed = await runBridgeRequest({
      command: 'execute',
      executionId: 'v2-safe-002',
      confirmed: true,
      confirmationFingerprint: analyzed.analysis.execution.confirmationFingerprint,
    }, { projectRoot: root });
    assert.equal(executed.ok, true);
    assert.equal(executed.result.status, 'completed');
    assert.deepEqual(executed.result.counts, {
      eligible: 2,
      planned: 1,
      createdSuccessfully: 1,
      skippedConflicts: 1,
      failed: 0,
    });
    assert.equal(await exists(appMin), true);
    assert.equal(await readFile(cssMin, 'utf8'), '/* saída preexistente */\n');

    const journal = await readExecutionJournal(runtimePaths.lastExecutionJournal);
    assert.equal(journal.items.length, 1);
    assert.equal(journal.items[0].sourcePath, app);
    assert.equal(journal.items[0].destinationPath, appMin);
    assert.equal(journal.items[0].operation, 'create-output');
    assert.equal(journal.items[0].status, 'confirmed');
    assert.equal(journal.items.some((item) => item.destinationPath === cssMin), false);
    const state = await readTechnicalState(runtimePaths.technicalState);
    assert.equal(state.records.length, 1);
    assert.equal(state.records[0].outputPath, appMin);
  } finally {
    await chmod(readonly, 0o666).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

windowsTest('V2 CSS-only e JavaScript-only não executam o tipo não selecionado', async () => {
  for (const scenario of [
    { fileTypes: 'CSS', planned: 'site.css', created: 'site.min.css', absent: 'app.min.js' },
    { fileTypes: 'JavaScript', planned: 'app.js', created: 'app.min.js', absent: 'site.min.css' },
  ]) {
    const { root, projectRoot } = await bridgeFixture({ fileTypes: scenario.fileTypes });
    try {
      await writeFile(join(projectRoot, 'app.js'), 'const app = 1;\n', 'utf8');
      await writeFile(join(projectRoot, 'site.css'), 'body { color: red; }\n', 'utf8');
      const analyzed = await runBridgeRequest({ command: 'scan-analysis' }, { projectRoot: root });
      assert.equal(analyzed.ok, true);
      assert.deepEqual(analyzed.analysis.execution.items.map((item) => item.relativePath), [scenario.planned]);
      const executed = await runBridgeRequest({
        command: 'execute',
        confirmed: true,
        confirmationFingerprint: analyzed.analysis.execution.confirmationFingerprint,
      }, { projectRoot: root });
      assert.equal(executed.ok, true);
      assert.equal(await exists(join(projectRoot, scenario.created)), true);
      assert.equal(await exists(join(projectRoot, scenario.absent)), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

windowsTest('V2 reutiliza backup, manifesto e operação de sobrescrita do executor existente', async () => {
  const { root, projectRoot } = await bridgeFixture({
    fileTypes: 'JavaScript',
    outputMode: 'BackupESobrescreverOriginais',
  });
  const source = join(projectRoot, 'app.js');
  const original = 'const app = 1;\n';
  const runtimePaths = resolveRuntimePaths(root);
  try {
    await writeFile(source, original, 'utf8');
    const analyzed = await runBridgeRequest({ command: 'analyze' }, { projectRoot: root });
    assert.equal(analyzed.ok, true);
    assert.equal(analyzed.analysis.configurationSchemaVersion, 2);
    assert.equal(analyzed.analysis.outputMode, 'BackupESobrescreverOriginais');
    const executed = await runBridgeRequest({
      command: 'execute',
      confirmed: true,
      confirmationFingerprint: analyzed.analysis.confirmationFingerprint,
    }, { projectRoot: root });
    assert.equal(executed.ok, true);
    assert.notEqual(await readFile(source, 'utf8'), original);
    assert.equal(await exists(join(projectRoot, 'app.min.js')), false);
    assert.equal(await exists(executed.result.manifestPath), true);
    const journal = await readExecutionJournal(runtimePaths.lastExecutionJournal);
    assert.equal(journal.items[0].operation, 'overwrite-original');
    assert.equal(journal.items[0].recovery.type, 'source-backup');
    assert.equal(await readFile(journal.items[0].recovery.path, 'utf8'), original);
    const manifest = JSON.parse(await readFile(executed.result.manifestPath, 'utf8'));
    assert.equal(Object.hasOwn(manifest, 'meminifyVersion'), true);
    assert.equal(Object.hasOwn(manifest, 'selfminifierVersion'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

windowsTest('V2 sem itens mutáveis reporta nenhuma alteração e preserva o journal anterior', async () => {
  const { root, projectRoot } = await bridgeFixture({ fileTypes: 'JavaScript' });
  const source = join(projectRoot, 'app.js');
  const destination = join(projectRoot, 'app.min.js');
  const runtimePaths = resolveRuntimePaths(root);
  try {
    await writeFile(source, 'const app = 1;\n', 'utf8');
    await writeFile(destination, 'const preexistente = true;\n', 'utf8');
    await chmod(destination, 0o444);
    const analyzed = await runBridgeRequest({ command: 'scan-analysis' }, { projectRoot: root });
    assert.equal(analyzed.ok, true);
    assert.equal(analyzed.analysis.execution.status, 'ready');
    assert.equal(analyzed.analysis.execution.items.length, 0);
    assert.equal(analyzed.analysis.execution.conflicts.length, 1);

    const executed = await runBridgeRequest({
      command: 'execute',
      confirmed: true,
      confirmationFingerprint: analyzed.analysis.execution.confirmationFingerprint,
    }, { projectRoot: root });
    assert.equal(executed.ok, true);
    assert.equal(executed.result.noFilesChanged, true);
    assert.equal(executed.result.journalRecorded, false);
    assert.equal(executed.result.counts.skippedConflicts, 1);
    assert.equal(await readFile(destination, 'utf8'), 'const preexistente = true;\n');
    assert.equal(await readExecutionJournal(runtimePaths.lastExecutionJournal), null);
  } finally {
    await chmod(destination, 0o666).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

windowsTest('V2 exige nova análise quando o conjunto elegível muda', async () => {
  const { root, projectRoot } = await bridgeFixture();
  try {
    await writeFile(join(projectRoot, 'app.js'), 'const app = 1;\n', 'utf8');
    const analyzed = await runBridgeRequest({ command: 'scan-analysis' }, { projectRoot: root });
    assert.equal(analyzed.ok, true);
    await writeFile(join(projectRoot, 'novo.js'), 'const novo = 1;\n', 'utf8');
    const executed = await runBridgeRequest({
      command: 'execute',
      confirmed: true,
      confirmationFingerprint: analyzed.analysis.execution.confirmationFingerprint,
    }, { projectRoot: root });
    assert.equal(executed.ok, false);
    assert.equal(executed.diagnostic.code, 'PLAN_CHANGED_AFTER_ANALYSIS');
    assert.equal(await exists(join(projectRoot, 'app.min.js')), false);
    assert.equal(await exists(join(projectRoot, 'novo.min.js')), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

windowsTest('V2 exige fingerprint e mantém override temporário somente na análise e execução atuais', async () => {
  const { root, projectRoot } = await bridgeFixture({
    fileTypes: 'JavaScript',
    outputMode: 'BackupESobrescreverOriginais',
  });
  const source = join(projectRoot, 'app.js');
  const destination = join(projectRoot, 'app.min.js');
  const configurationPath = join(root, 'Configuracao', 'configuracao.ini');
  const original = 'const app = 1;\n';
  const adjustments = { outputMode: 'PreservarOriginaisECriarMinificados' };
  try {
    await writeFile(source, original, 'utf8');
    const bypass = await runBridgeRequest({
      command: 'execute',
      confirmed: true,
      adjustments,
    }, { projectRoot: root });
    assert.equal(bypass.ok, false);
    assert.equal(bypass.diagnostic.code, 'PLAN_CHANGED_AFTER_ANALYSIS');
    assert.equal(await exists(destination), false);
    assert.equal(await readFile(source, 'utf8'), original);

    const analyzed = await runBridgeRequest({ command: 'scan-analysis', adjustments }, { projectRoot: root });
    assert.equal(analyzed.ok, true);
    assert.equal(analyzed.analysis.execution.outputMode, 'PreservarOriginaisECriarMinificados');
    const executed = await runBridgeRequest({
      command: 'execute',
      confirmed: true,
      adjustments,
      confirmationFingerprint: analyzed.analysis.execution.confirmationFingerprint,
    }, { projectRoot: root });
    assert.equal(executed.ok, true);
    assert.equal(await readFile(source, 'utf8'), original);
    assert.equal(await exists(destination), true);
    assert.match(await readFile(configurationPath, 'utf8'), /ModoSaida=BackupESobrescreverOriginais/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

windowsTest('falha da persistência inicial do journal bloqueia antes de mutar o projeto', async () => {
  const root = await mkdtemp(join(tmpdir(), 'selfminifier-v2-journal-failure-'));
  const projectRoot = join(root, 'projeto');
  const source = join(projectRoot, 'app.js');
  const destination = join(projectRoot, 'app.min.js');
  try {
    await mkdir(projectRoot, { recursive: true });
    await writeFile(source, 'const app = 1;\n', 'utf8');
    const created = await directPlan(root, projectRoot, 'v2-journal-failure');
    const persistenceFailure = new IntegrityError(
      'EXECUTION_JOURNAL_WRITE_FAILED',
      'falha sintética de persistência',
      { causeCode: 'EPERM', causeMessage: 'acesso negado', operation: 'rename-temporary-to-target' },
    );
    await assert.rejects(
      executePlan(created.plan, created.adapter, { confirmed: true }, {
        writeExecutionJournal: async () => { throw persistenceFailure; },
      }),
      (error) => error === persistenceFailure,
    );
    assert.equal(await readFile(source, 'utf8'), 'const app = 1;\n');
    assert.equal(await exists(destination), false);
    assert.equal(await exists(created.plan.runtimePaths.technicalState), false);
    assert.equal(await exists(created.plan.runtimePaths.lastExecutionJournal), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

windowsTest('falha sintética do journal após mutação propaga causa e executa rollback exato', async () => {
  const root = await mkdtemp(join(tmpdir(), 'selfminifier-v2-journal-rollback-'));
  const projectRoot = join(root, 'projeto');
  const source = join(projectRoot, 'app.js');
  const destination = join(projectRoot, 'app.min.js');
  try {
    await mkdir(projectRoot, { recursive: true });
    await writeFile(source, 'const app = 1;\n', 'utf8');
    const created = await directPlan(root, projectRoot, 'v2-journal-rollback');
    const persistenceFailure = new IntegrityError(
      'EXECUTION_JOURNAL_WRITE_FAILED',
      'falha sintética de persistência após mutação',
      {
        causeCode: 'EPERM',
        causeMessage: 'acesso negado',
        operation: 'rename-temporary-to-target',
        targetPath: created.plan.runtimePaths.lastExecutionJournal,
        temporaryPath: `${created.plan.runtimePaths.lastExecutionJournal}.teste.tmp`,
      },
    );
    let journalWrites = 0;
    await assert.rejects(
      executePlan(created.plan, created.adapter, { confirmed: true }, {
        writeExecutionJournal: async (...args) => {
          journalWrites += 1;
          if (journalWrites === 6) throw persistenceFailure;
          return writeExecutionJournal(...args);
        },
      }),
      (error) => {
        assert.equal(error.code, 'EXECUTION_JOURNAL_WRITE_FAILED');
        assert.equal(error.details.causeCode, 'EPERM');
        assert.equal(error.details.causeMessage, 'acesso negado');
        assert.equal(error.details.operation, 'rename-temporary-to-target');
        assert.equal(error.details.rollbackStatus, 'rolled-back');
        return true;
      },
    );
    assert.equal(await readFile(source, 'utf8'), 'const app = 1;\n');
    assert.equal(await exists(destination), false);
    assert.equal(await exists(created.plan.runtimePaths.technicalState), false);
    assert.equal((await readExecutionJournal(created.plan.runtimePaths.lastExecutionJournal)).status, 'rolled-back');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

windowsTest('V2 revalida somente leitura, confinamento e redirecionamento de diretório antes da escrita', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'selfminifier-v2-write-security-'));
  const projectRoot = join(root, 'projeto');
  const source = join(projectRoot, 'app.js');
  const externalRoot = await mkdtemp(join(tmpdir(), 'selfminifier-v2-external-'));
  try {
    await mkdir(projectRoot, { recursive: true });
    await writeFile(source, 'const app = 1;\n', 'utf8');

    const readonlyPlan = await directPlan(root, projectRoot, 'v2-readonly');
    await chmod(source, 0o444);
    await assert.rejects(
      executePlan(readonlyPlan.plan, readonlyPlan.adapter, { confirmed: true }),
      (error) => error.code === 'READONLY_SOURCE_AT_EXECUTION',
    );
    assert.equal(await exists(join(projectRoot, 'app.min.js')), false);
    await chmod(source, 0o666);

    const confined = await directPlan(root, projectRoot, 'v2-confined');
    const forged = structuredClone(confined.plan);
    forged.items[0].destinationPath = join(externalRoot, 'escape.min.js');
    await assert.rejects(
      executePlan(forged, confined.adapter, { confirmed: true }),
      (error) => error.code === 'V2_WRITE_OUTSIDE_PROJECT_ROOT',
    );
    assert.equal(await exists(join(externalRoot, 'escape.min.js')), false);

    const nested = join(projectRoot, 'nested');
    const externalNested = join(externalRoot, 'nested');
    await mkdir(nested, { recursive: true });
    await mkdir(externalNested, { recursive: true });
    await writeFile(join(nested, 'linked.js'), 'const linked = 1;\n', 'utf8');
    await writeFile(join(externalNested, 'linked.js'), 'const linked = 1;\n', 'utf8');
    const probe = join(root, 'junction-probe');
    try {
      await symlink(externalNested, probe, 'junction');
      await rm(probe, { force: true });
    } catch {
      t.skip('criação de junction indisponível');
      return;
    }
    const linkedPlan = await directPlan(root, projectRoot, 'v2-link');
    await assert.rejects(
      executePlan(linkedPlan.plan, linkedPlan.adapter, { confirmed: true }, {
        hooks: {
          beforeItem: async ({ item }) => {
            if (!item.sourcePath.endsWith('linked.js')) return;
            await rm(nested, { recursive: true, force: true });
            await symlink(externalNested, nested, 'junction');
          },
        },
      }),
      (error) => error.code === 'V2_WRITE_SECURITY_REVALIDATION_FAILED',
    );
    assert.equal(await exists(join(externalNested, 'linked.min.js')), false);
  } finally {
    await chmod(source, 0o666).catch(() => {});
    await rm(root, { recursive: true, force: true });
    await rm(externalRoot, { recursive: true, force: true });
  }
});
