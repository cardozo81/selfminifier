import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBridgeRequest } from '../src/app/bridge.mjs';

function v2ConfigurationText(projectRoot, {
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

async function v2Fixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'selfminifier-config-ui-'));
  const projectRoot = join(root, 'projeto');
  await mkdir(projectRoot, { recursive: true });
  await mkdir(join(root, 'Configuracao'), { recursive: true });
  await writeFile(join(root, 'Configuracao', 'configuracao.ini'), v2ConfigurationText(projectRoot, options), 'utf8');
  return { root, projectRoot };
}

const windowsTest = process.platform === 'win32' ? test : test.skip;

windowsTest('summary expõe a configuração V2 normalizada para a visualização read-only', async () => {
  const { root, projectRoot } = await v2Fixture({
    fileTypes: 'JavaScript',
    outputMode: 'BackupESobrescreverOriginais',
    ignoredFolders: ['vendor'],
    ignoredFiles: ['src\\config.js'],
  });
  try {
    const summary = await runBridgeRequest({ command: 'summary' }, { projectRoot: root });
    assert.equal(summary.ok, true);
    assert.equal(summary.schema, 'v2');
    assert.equal(summary.configuration.schemaVersion, 2);
    assert.equal(summary.configuration.projectRoot, projectRoot);
    assert.equal(summary.configuration.engine, 'esbuild');
    assert.equal(summary.configuration.profile, 'Padrao');
    assert.equal(summary.configuration.outputMode, 'BackupESobrescreverOriginais');
    assert.deepEqual(summary.configuration.fileTypes, ['javascript']);
    assert.deepEqual(summary.configuration.ignoredFolders, ['vendor']);
    assert.deepEqual(summary.configuration.ignoredFiles, ['src\\config.js']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

windowsTest('summary com coleções vazias preserva listas vazias explícitas', async () => {
  const { root } = await v2Fixture();
  try {
    const summary = await runBridgeRequest({ command: 'summary' }, { projectRoot: root });
    assert.equal(summary.ok, true);
    assert.equal(summary.schema, 'v2');
    assert.deepEqual(summary.configuration.ignoredFolders, []);
    assert.deepEqual(summary.configuration.ignoredFiles, []);
    assert.deepEqual(summary.configuration.fileTypes, ['css', 'javascript']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('summary rejeita configuração antiga sem schema antes de expor configuração', async () => {
  const root = await mkdtemp(join(tmpdir(), 'selfminifier-config-ui-legacy-'));
  try {
    await mkdir(join(root, 'Configuracao'), { recursive: true });
    await writeFile(join(root, 'Configuracao', 'configuracao.ini'), [
      '[Configuracao]',
      'Motor=esbuild',
      'Perfil=Padrao',
      'ModoSaida=PreservarOriginaisECriarMinificados',
      'Incluir01=**/*.js',
      '',
      '[Origem.001]',
      'Tipo=Diretorio',
      `Caminho=${root}`,
      'ExecutarPorPadrao=true',
      'Recursivo=true',
      'Modo=Todos',
      '',
    ].join('\n'), 'utf8');

    const summary = await runBridgeRequest({ command: 'summary' }, { projectRoot: root });
    assert.equal(summary.ok, false);
    assert.equal(summary.configuration, null);
    assert.equal(summary.schema, undefined);
    assert.equal(summary.diagnostic.code, 'MISSING_SCHEMA_VERSION');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

windowsTest('summary para configuração V2 inválida preserva o diagnóstico existente', async () => {
  const root = await mkdtemp(join(tmpdir(), 'selfminifier-config-ui-invalid-'));
  const projectRoot = join(root, 'projeto');
  try {
    await mkdir(projectRoot, { recursive: true });
    await mkdir(join(root, 'Configuracao'), { recursive: true });
    await writeFile(join(root, 'Configuracao', 'configuracao.ini'), [
      '[Configuracao]',
      'VersaoSchema=2',
      'Motor=nao-homologado',
      'Perfil=Padrao',
      'ModoSaida=PreservarOriginaisECriarMinificados',
      `PastaRaiz=${projectRoot}`,
      'TiposArquivo=CSS+JavaScript',
      '',
    ].join('\n'), 'utf8');

    const summary = await runBridgeRequest({ command: 'summary' }, { projectRoot: root });
    assert.equal(summary.ok, false);
    assert.equal(summary.configuration, null);
    assert.equal(summary.diagnostic.code, 'UNSUPPORTED_ENGINE');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

windowsTest('create-configuration valida PastaRaiz explícita, usa o serializer oficial e recarrega como V2 válida', async () => {
  const root = await mkdtemp(join(tmpdir(), 'selfminifier-config-create-'));
  try {
    const configurationDirectory = join(root, 'Configuracao');
    await mkdir(configurationDirectory, { recursive: true });
    const example = await readFile(new URL('../Configuracao/configuracao.ini.example', import.meta.url), 'utf8');
    await writeFile(join(configurationDirectory, 'configuracao.ini.example'), example, 'utf8');

    const projectRoot = join(root, 'projeto');
    await mkdir(projectRoot, { recursive: true });

    const preview = await runBridgeRequest({ command: 'create-configuration', projectRoot }, { projectRoot: root });
    assert.equal(preview.ok, true);
    assert.equal(preview.preview, true);
    assert.equal(preview.configuration.schemaVersion, 2);
    assert.equal(preview.configuration.engine, 'esbuild');
    assert.equal(preview.configuration.profile, 'Padrao');
    assert.equal(preview.configuration.outputMode, 'BackupESobrescreverOriginais');
    assert.deepEqual(preview.configuration.fileTypes, ['css', 'javascript']);
    assert.deepEqual(preview.configuration.ignoredFolders, ['node_modules', '.git', 'vendor']);
    assert.deepEqual(preview.configuration.ignoredFiles, []);

    const created = await runBridgeRequest({ command: 'create-configuration', projectRoot, confirmed: true }, { projectRoot: root });
    assert.equal(created.ok, true);
    assert.equal(created.created, true);
    const summary = await runBridgeRequest({ command: 'summary' }, { projectRoot: root });
    assert.equal(summary.ok, true);
    assert.equal(summary.schema, 'v2');
    assert.equal(summary.configuration.schemaVersion, 2);
    assert.equal(summary.configuration.engine, 'esbuild');
    assert.equal(summary.configuration.projectRoot, projectRoot);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

windowsTest('create-configuration exige PastaRaiz explícito e rejeita diretório inexistente', async () => {
  const root = await mkdtemp(join(tmpdir(), 'selfminifier-config-create-invalid-'));
  try {
    await mkdir(join(root, 'Configuracao'), { recursive: true });
    const withoutRoot = await runBridgeRequest({ command: 'create-configuration', confirmed: true }, { projectRoot: root });
    assert.equal(withoutRoot.ok, false);
    assert.equal(withoutRoot.code, 'PROJECT_ROOT_REQUIRED');

    const missingDirectory = join(root, 'nao-existe');
    const invalid = await runBridgeRequest({ command: 'create-configuration', projectRoot: missingDirectory, confirmed: true }, { projectRoot: root });
    assert.equal(invalid.ok, false);
    assert.equal(invalid.diagnostic.code, 'PHYSICAL_PATH_ACCESS_FAILED');

    const stillMissing = await runBridgeRequest({ command: 'summary' }, { projectRoot: root });
    assert.equal(stillMissing.ok, false);
    assert.equal(stillMissing.code, 'CONFIGURATION_MISSING');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

windowsTest('create-configuration não sobrescreve configuração existente', async () => {
  const root = await mkdtemp(join(tmpdir(), 'selfminifier-config-create-exists-'));
  try {
    await mkdir(join(root, 'Configuracao'), { recursive: true });
    await writeFile(join(root, 'Configuracao', 'configuracao.ini'), '[Configuracao]\nVersaoSchema=2\n', 'utf8');
    const projectRoot = join(root, 'projeto');
    await mkdir(projectRoot, { recursive: true });
    const created = await runBridgeRequest({ command: 'create-configuration', projectRoot, confirmed: true }, { projectRoot: root });
    assert.equal(created.ok, false);
    assert.equal(created.code, 'CONFIGURATION_EXISTS');
    assert.equal(await readFile(join(root, 'Configuracao', 'configuracao.ini'), 'utf8'), '[Configuracao]\nVersaoSchema=2\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
