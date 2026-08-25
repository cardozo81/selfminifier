import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBridgeRequest } from '../src/app/bridge.mjs';

const windowsTest = process.platform === 'win32' ? test : test.skip;

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
  const root = await mkdtemp(join(tmpdir(), 'selfminifier-config-edit-'));
  const projectRoot = join(root, 'projeto');
  await mkdir(projectRoot, { recursive: true });
  await mkdir(join(root, 'Configuracao'), { recursive: true });
  const configurationPath = join(root, 'Configuracao', 'configuracao.ini');
  await writeFile(configurationPath, v2ConfigurationText(projectRoot, options), 'utf8');
  return { root, projectRoot, configurationPath };
}

windowsTest('update-configuration-v2 edita projectRoot e preserva campos não relacionados', async () => {
  const { root, projectRoot, configurationPath } = await v2Fixture({
    outputMode: 'PreservarOriginaisECriarMinificados',
    ignoredFolders: ['vendor'],
    ignoredFiles: ['src\\config.js'],
  });
  const newRoot = join(root, 'projeto-novo');
  try {
    const response = await runBridgeRequest({
      command: 'update-configuration-v2',
      projectRoot: newRoot,
      confirmed: true,
    }, { projectRoot: root });

    assert.equal(response.ok, true);
    assert.deepEqual(response.updated, ['projectRoot']);
    assert.equal(response.configuration.schemaVersion, 2);
    assert.equal(response.configuration.projectRoot, newRoot);
    assert.equal(response.configuration.engine, 'esbuild');
    assert.equal(response.configuration.profile, 'Padrao');
    assert.equal(response.configuration.outputMode, 'PreservarOriginaisECriarMinificados');
    assert.deepEqual(response.configuration.fileTypes, ['css', 'javascript']);
    assert.deepEqual(response.configuration.ignoredFolders, ['vendor']);
    assert.deepEqual(response.configuration.ignoredFiles, ['src\\config.js']);

    const text = await readFile(configurationPath, 'utf8');
    assert.match(text, new RegExp(`PastaRaiz=${newRoot.replace(/\\/g, '\\\\')}`));
    assert.match(text, /TiposArquivo=CSS\+JavaScript/);
    assert.match(text, /IgnorarPasta01=vendor/);
    assert.match(text, /IgnorarArquivo01=src\\config\.js/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

windowsTest('update-configuration-v2 aceita somente o conjunto fechado de TiposArquivo', async () => {
  for (const scenario of [
    { value: 'CSS', expected: ['css'] },
    { value: 'JavaScript', expected: ['javascript'] },
    { value: 'CSS+JavaScript', expected: ['css', 'javascript'] },
  ]) {
    const { root, projectRoot, configurationPath } = await v2Fixture({
      outputMode: 'BackupESobrescreverOriginais',
      ignoredFolders: ['vendor'],
    });
    try {
      const response = await runBridgeRequest({
        command: 'update-configuration-v2',
        fileTypes: scenario.value,
        confirmed: true,
      }, { projectRoot: root });

      assert.equal(response.ok, true);
      assert.deepEqual(response.updated, ['fileTypes']);
      assert.deepEqual(response.configuration.fileTypes, scenario.expected);
      assert.equal(response.configuration.projectRoot, projectRoot);
      assert.equal(response.configuration.engine, 'esbuild');
      assert.equal(response.configuration.outputMode, 'BackupESobrescreverOriginais');
      assert.deepEqual(response.configuration.ignoredFolders, ['vendor']);
      assert.deepEqual(response.configuration.ignoredFiles, []);

      const text = await readFile(configurationPath, 'utf8');
      assert.ok(text.includes(`TiposArquivo=${scenario.value}`));
      assert.match(text, /IgnorarPasta01=vendor/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

windowsTest('update-configuration-v2 exige confirmação e não muta ao cancelar', async () => {
  const { root, projectRoot, configurationPath } = await v2Fixture();
  const before = await readFile(configurationPath, 'utf8');
  try {
    const response = await runBridgeRequest({
      command: 'update-configuration-v2',
      projectRoot: join(root, 'outro'),
      confirmed: false,
    }, { projectRoot: root });

    assert.equal(response.ok, false);
    assert.equal(response.code, 'CONFIRMATION_REQUIRED');
    assert.equal(await readFile(configurationPath, 'utf8'), before);
    const summary = await runBridgeRequest({ command: 'summary' }, { projectRoot: root });
    assert.equal(summary.configuration.projectRoot, projectRoot);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

windowsTest('update-configuration-v2 rejeita raiz inválida sem mutar a configuração', async () => {
  const cases = [
    { value: '', code: 'MISSING_REQUIRED_VALUE' },
    { value: 'pasta\\relativa', code: 'ABSOLUTE_PATH_REQUIRED' },
    { value: 'C:\\projeto\\..\\escape', code: 'PARENT_TRAVERSAL_NOT_ALLOWED' },
    { value: 'C:\\projeto\\*', code: 'GLOB_NOT_ALLOWED' },
    { value: '%USERPROFILE%\\site', code: 'ENV_EXPANSION_NOT_ALLOWED' },
  ];
  for (const entry of cases) {
    const { root, configurationPath } = await v2Fixture();
    const before = await readFile(configurationPath, 'utf8');
    try {
      const response = await runBridgeRequest({
        command: 'update-configuration-v2',
        projectRoot: entry.value,
        confirmed: true,
      }, { projectRoot: root });

      assert.equal(response.ok, false, `esperava rejeição para: ${JSON.stringify(entry.value)}`);
      assert.equal(response.diagnostic.code, entry.code);
      assert.equal(await readFile(configurationPath, 'utf8'), before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('update-configuration-v2 bloqueia configuração antiga sem schema e não muta', async () => {
  const root = await mkdtemp(join(tmpdir(), 'selfminifier-config-edit-legacy-'));
  const configurationPath = join(root, 'Configuracao', 'configuracao.ini');
  try {
    await mkdir(join(root, 'Configuracao'), { recursive: true });
    await writeFile(configurationPath, [
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
    const before = await readFile(configurationPath, 'utf8');

    const response = await runBridgeRequest({
      command: 'update-configuration-v2',
      projectRoot: join(root, 'outro'),
      confirmed: true,
    }, { projectRoot: root });

    assert.equal(response.ok, false);
    assert.equal(response.diagnostic.code, 'MISSING_SCHEMA_VERSION');
    assert.equal(await readFile(configurationPath, 'utf8'), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

windowsTest('update-configuration-v2 bloqueia configuração V2 inválida', async () => {
  const root = await mkdtemp(join(tmpdir(), 'selfminifier-config-edit-invalid-'));
  const projectRoot = join(root, 'projeto');
  const configurationPath = join(root, 'Configuracao', 'configuracao.ini');
  try {
    await mkdir(projectRoot, { recursive: true });
    await mkdir(join(root, 'Configuracao'), { recursive: true });
    await writeFile(configurationPath, [
      '[Configuracao]',
      'VersaoSchema=2',
      'Motor=nao-homologado',
      'Perfil=Padrao',
      'ModoSaida=PreservarOriginaisECriarMinificados',
      `PastaRaiz=${projectRoot}`,
      'TiposArquivo=CSS+JavaScript',
      '',
    ].join('\n'), 'utf8');

    const response = await runBridgeRequest({
      command: 'update-configuration-v2',
      projectRoot: join(root, 'outro'),
      confirmed: true,
    }, { projectRoot: root });

    assert.equal(response.ok, false);
    assert.equal(response.diagnostic.code, 'UNSUPPORTED_ENGINE');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

windowsTest('update-configuration-v2 edita ignoredFolders e preserva campos não relacionados', async () => {
  const { root, projectRoot, configurationPath } = await v2Fixture({
    outputMode: 'BackupESobrescreverOriginais',
    ignoredFolders: ['vendor'],
    ignoredFiles: ['src\\config.js'],
  });
  try {
    const response = await runBridgeRequest({
      command: 'update-configuration-v2',
      ignoredFolders: ['vendor', 'build\\cache'],
      confirmed: true,
    }, { projectRoot: root });

    assert.equal(response.ok, true);
    assert.deepEqual(response.updated, ['ignoredFolders']);
    assert.deepEqual(response.configuration.ignoredFolders, ['vendor', 'build\\cache']);
    assert.deepEqual(response.configuration.ignoredFiles, ['src\\config.js']);
    assert.equal(response.configuration.projectRoot, projectRoot);
    assert.equal(response.configuration.engine, 'esbuild');
    assert.equal(response.configuration.profile, 'Padrao');
    assert.equal(response.configuration.outputMode, 'BackupESobrescreverOriginais');
    assert.equal(response.configuration.schemaVersion, 2);

    const text = await readFile(configurationPath, 'utf8');
    assert.ok(text.includes('IgnorarPasta01=vendor'));
    assert.ok(text.includes('IgnorarPasta02=build\\cache'));
    assert.ok(text.includes('IgnorarArquivo01=src\\config.js'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

windowsTest('update-configuration-v2 edita ignoredFiles e preserva pastas', async () => {
  const { root, configurationPath } = await v2Fixture({
    ignoredFolders: ['vendor'],
    ignoredFiles: ['src\\config.js'],
  });
  try {
    const response = await runBridgeRequest({
      command: 'update-configuration-v2',
      ignoredFiles: ['src\\config.js', 'src\\outro.js'],
      confirmed: true,
    }, { projectRoot: root });

    assert.equal(response.ok, true);
    assert.deepEqual(response.updated, ['ignoredFiles']);
    assert.deepEqual(response.configuration.ignoredFiles, ['src\\config.js', 'src\\outro.js']);
    assert.deepEqual(response.configuration.ignoredFolders, ['vendor']);
    const text = await readFile(configurationPath, 'utf8');
    assert.ok(text.includes('IgnorarPasta01=vendor'));
    assert.ok(text.includes('IgnorarArquivo01=src\\config.js'));
    assert.ok(text.includes('IgnorarArquivo02=src\\outro.js'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

windowsTest('update-configuration-v2 aceita lista vazia para remover exclusões', async () => {
  const { root, configurationPath } = await v2Fixture({
    ignoredFolders: ['vendor', 'build'],
    ignoredFiles: ['src\\config.js'],
  });
  try {
    const response = await runBridgeRequest({
      command: 'update-configuration-v2',
      ignoredFolders: [],
      confirmed: true,
    }, { projectRoot: root });

    assert.equal(response.ok, true);
    assert.deepEqual(response.updated, ['ignoredFolders']);
    assert.deepEqual(response.configuration.ignoredFolders, []);
    assert.deepEqual(response.configuration.ignoredFiles, ['src\\config.js']);
    const text = await readFile(configurationPath, 'utf8');
    assert.ok(!text.includes('IgnorarPasta'));
    assert.ok(text.includes('IgnorarArquivo01=src\\config.js'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

windowsTest('update-configuration-v2 ignora campos arbitrários fora do whitelist', async () => {
  const { root } = await v2Fixture({
    outputMode: 'PreservarOriginaisECriarMinificados',
    ignoredFolders: [],
  });
  try {
    const response = await runBridgeRequest({
      command: 'update-configuration-v2',
      ignoredFolders: ['vendor'],
      engine: 'nao-homologado',
      outputMode: 'BackupESobrescreverOriginais',
      schemaVersion: 99,
      confirmed: true,
    }, { projectRoot: root });

    assert.equal(response.ok, true);
    assert.deepEqual(response.configuration.ignoredFolders, ['vendor']);
    assert.equal(response.configuration.engine, 'esbuild');
    assert.equal(response.configuration.profile, 'Padrao');
    assert.equal(response.configuration.outputMode, 'PreservarOriginaisECriarMinificados');
    assert.equal(response.configuration.schemaVersion, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

windowsTest('update-configuration-v2 rejeita caminho de exclusão inválido sem mutar', async () => {
  const cases = [
    { value: '', code: 'MISSING_REQUIRED_VALUE' },
    { value: '..\\escape', code: 'PARENT_TRAVERSAL_NOT_ALLOWED' },
    { value: 'C:\\absoluto', code: 'RELATIVE_PATH_REQUIRED' },
    { value: 'vendor\\*', code: 'GLOB_NOT_ALLOWED' },
  ];
  for (const entry of cases) {
    const { root, configurationPath } = await v2Fixture({ ignoredFolders: ['vendor'] });
    const before = await readFile(configurationPath, 'utf8');
    try {
      const response = await runBridgeRequest({
        command: 'update-configuration-v2',
        ignoredFolders: ['vendor', entry.value],
        confirmed: true,
      }, { projectRoot: root });

      assert.equal(response.ok, false, `esperava rejeição para: ${JSON.stringify(entry.value)}`);
      assert.equal(response.diagnostic.code, entry.code);
      assert.equal(await readFile(configurationPath, 'utf8'), before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

windowsTest('update-configuration-v2 rejeita duplicata lógica conforme regras V2', async () => {
  const folderFixture = await v2Fixture({ ignoredFolders: ['vendor'] });
  try {
    const response = await runBridgeRequest({
      command: 'update-configuration-v2',
      ignoredFolders: ['vendor', 'Vendor'],
      confirmed: true,
    }, { projectRoot: folderFixture.root });
    assert.equal(response.ok, false);
    assert.equal(response.diagnostic.code, 'DUPLICATE_IGNORED_FOLDER');
  } finally {
    await rm(folderFixture.root, { recursive: true, force: true });
  }

  const fileFixture = await v2Fixture({ ignoredFiles: ['src\\config.js'] });
  try {
    const response = await runBridgeRequest({
      command: 'update-configuration-v2',
      ignoredFiles: ['src\\config.js', 'src\\CONFIG.js'],
      confirmed: true,
    }, { projectRoot: fileFixture.root });
    assert.equal(response.ok, false);
    assert.equal(response.diagnostic.code, 'DUPLICATE_IGNORED_FILE');
  } finally {
    await rm(fileFixture.root, { recursive: true, force: true });
  }
});

windowsTest('update-configuration-v2 edita profile e preserva campos não relacionados', async () => {
  const { root, projectRoot, configurationPath } = await v2Fixture({
    ignoredFolders: ['vendor'],
    ignoredFiles: ['src\\config.js'],
  });
  try {
    const response = await runBridgeRequest({
      command: 'update-configuration-v2',
      profile: 'Maximo',
      confirmed: true,
    }, { projectRoot: root });

    assert.equal(response.ok, true);
    assert.deepEqual(response.updated, ['profile']);
    assert.equal(response.configuration.profile, 'Maximo');
    assert.equal(response.configuration.projectRoot, projectRoot);
    assert.equal(response.configuration.engine, 'esbuild');
    assert.equal(response.configuration.outputMode, 'PreservarOriginaisECriarMinificados');
    assert.deepEqual(response.configuration.fileTypes, ['css', 'javascript']);
    assert.deepEqual(response.configuration.ignoredFolders, ['vendor']);
    assert.deepEqual(response.configuration.ignoredFiles, ['src\\config.js']);
    assert.equal(response.configuration.schemaVersion, 2);

    const text = await readFile(configurationPath, 'utf8');
    assert.ok(text.includes('Perfil=Maximo'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

windowsTest('update-configuration-v2 aceita perfis suportados e rejeita Personalizado', async () => {
  for (const value of ['Conservador', 'Padrao', 'Maximo']) {
    const { root } = await v2Fixture();
    try {
      const response = await runBridgeRequest({
        command: 'update-configuration-v2',
        profile: value,
        confirmed: true,
      }, { projectRoot: root });
      assert.equal(response.ok, true);
      assert.equal(response.configuration.profile, value);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  const { root, configurationPath } = await v2Fixture();
  const before = await readFile(configurationPath, 'utf8');
  try {
    const response = await runBridgeRequest({
      command: 'update-configuration-v2',
      profile: 'Personalizado',
      confirmed: true,
    }, { projectRoot: root });
    assert.equal(response.ok, false);
    assert.equal(response.diagnostic.code, 'PROFILE_OPTIONS_PENDING');
    assert.equal(await readFile(configurationPath, 'utf8'), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
