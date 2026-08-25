import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  deriveEffectiveConfiguration,
  identifyConfigurationSchema,
  loadV2Configuration,
  parseV2Configuration,
  serializeV2Configuration,
  writeV2Configuration,
} from '../src/configuration/index.js';
import { ConfigurationError } from '../src/configuration/errors.js';

const allowedEngines = new Set(['esbuild']);

function v2(text) {
  return parseV2Configuration(text, { allowedEngines });
}

function expectCode(callback, code) {
  assert.throws(callback, (error) => error instanceof ConfigurationError && error.code === code);
}

function v2Ini(overrides = {}) {
  const defaults = {
    VersaoSchema: '2',
    Motor: 'esbuild',
    Perfil: 'Padrao',
    ModoSaida: 'BackupESobrescreverOriginais',
    PastaRaiz: 'C:\\Projetos\\MeuSite',
    TiposArquivo: 'CSS+JavaScript',
    IgnorarPasta01: 'vendor',
    IgnorarPasta02: 'assets\\gerado',
    IgnorarArquivo01: 'src\\config.js',
  };
  const merged = { ...defaults, ...overrides };
  const lines = ['[Configuracao]'];
  const order = ['VersaoSchema', 'Motor', 'Perfil', 'ModoSaida', 'PastaRaiz', 'TiposArquivo'];
  for (const key of order) {
    if (merged[key] !== undefined && merged[key] !== null) lines.push(`${key}=${merged[key]}`);
  }
  const folders = Object.keys(merged).filter((key) => /^IgnorarPasta\d+$/.test(key)).sort().map((key) => `${key}=${merged[key]}`);
  const files = Object.keys(merged).filter((key) => /^IgnorarArquivo\d+$/.test(key)).sort().map((key) => `${key}=${merged[key]}`);
  lines.push(...folders, ...files);
  return `${lines.join('\n')}\n`;
}


test('V2 válida produz representação normalizada', () => {
  const config = v2(v2Ini());
  assert.equal(config.schemaVersion, 2);
  assert.equal(config.engine, 'esbuild');
  assert.equal(config.profile, 'Padrao');
  assert.equal(config.outputMode, 'BackupESobrescreverOriginais');
  assert.equal(config.projectRoot, 'C:\\Projetos\\MeuSite');
  assert.deepEqual(config.fileTypes, ['css', 'javascript']);
  assert.deepEqual(config.ignoredFolders, ['vendor', 'assets\\gerado']);
  assert.deepEqual(config.ignoredFiles, ['src\\config.js']);
});

test('cada valor fechado de TiposArquivo é aceito', () => {
  assert.deepEqual(v2(v2Ini({ TiposArquivo: 'CSS' })).fileTypes, ['css']);
  assert.deepEqual(v2(v2Ini({ TiposArquivo: 'JavaScript' })).fileTypes, ['javascript']);
  assert.deepEqual(v2(v2Ini({ TiposArquivo: 'CSS+JavaScript' })).fileTypes, ['css', 'javascript']);
});

test('TiposArquivo ausente assume CSS+JavaScript', () => {
  assert.deepEqual(v2(v2Ini({ TiposArquivo: null })).fileTypes, ['css', 'javascript']);
});

test('TiposArquivo inválido falha fechado', () => {
  expectCode(() => v2(v2Ini({ TiposArquivo: 'HTML' })), 'INVALID_FILE_TYPES');
  expectCode(() => v2(v2Ini({ TiposArquivo: 'JavaScript+CSS' })), 'INVALID_FILE_TYPES');
});

test('identificação aceita somente V2 explícita e rejeita ausência, versão não suportada e mistura', () => {
  assert.deepEqual(identifyConfigurationSchema(v2Ini()), { kind: 'v2', schemaVersion: 2 });
  expectCode(() => identifyConfigurationSchema('[Configuracao]\nMotor=esbuild\nPerfil=Padrao\n'), 'MISSING_SCHEMA_VERSION');
  expectCode(() => identifyConfigurationSchema(v2Ini({ VersaoSchema: '3' })), 'UNSUPPORTED_SCHEMA_VERSION');
  expectCode(() => identifyConfigurationSchema(v2Ini({ VersaoSchema: 'abc' })), 'INVALID_SCHEMA_VERSION');
  expectCode(() => identifyConfigurationSchema(v2Ini({ VersaoSchema: null })), 'MISSING_SCHEMA_VERSION');
  const mixedLists = `[Configuracao]\nVersaoSchema=2\nMotor=esbuild\nPerfil=Padrao\nPastaRaiz=C:\\Projetos\\x\nIncluir01=**/*.js\n`;
  expectCode(() => identifyConfigurationSchema(mixedLists), 'MIXED_SCHEMA');
  const oldOrigin = `[Configuracao]\nMotor=esbuild\nPerfil=Padrao\n\n[Origem.001]\nTipo=Diretorio\nCaminho=C:\\Projetos\\x\n`;
  expectCode(() => identifyConfigurationSchema(oldOrigin), 'MISSING_SCHEMA_VERSION');
  const mixedWithoutVersion = `[Configuracao]\nMotor=esbuild\nPastaRaiz=C:\\Projetos\\x\nIncluir01=**/*.js\n`;
  expectCode(() => identifyConfigurationSchema(mixedWithoutVersion), 'MIXED_SCHEMA');
});
test('parser V2 exige VersaoSchema=2 e rejeita estruturas V1', () => {
  expectCode(() => v2(v2Ini({ VersaoSchema: null })), 'MISSING_SCHEMA_VERSION');
  expectCode(() => v2(v2Ini({ VersaoSchema: '3' })), 'UNSUPPORTED_SCHEMA_VERSION');
  const mixed = `[Configuracao]\nVersaoSchema=2\nMotor=esbuild\nPerfil=Padrao\nPastaRaiz=C:\\Projetos\\x\n\n[Origem.001]\nTipo=Diretorio\nCaminho=C:\\Projetos\\x\nExecutarPorPadrao=true\nRecursivo=true\nModo=Todos\n`;
  expectCode(() => v2(mixed), 'MIXED_SCHEMA');
});
test('raiz absoluta Windows é aceita e normaliza separadores', () => {
  assert.equal(v2(v2Ini({ PastaRaiz: 'C:/Projetos/MeuSite' })).projectRoot, 'C:\\Projetos\\MeuSite');
});

test('raiz relativa, sem unidade ou com traversal falha fechado', () => {
  expectCode(() => v2(v2Ini({ PastaRaiz: 'Projetos\\MeuSite' })), 'ABSOLUTE_PATH_REQUIRED');
  expectCode(() => v2(v2Ini({ PastaRaiz: '\\Projetos' })), 'ABSOLUTE_PATH_REQUIRED');
  expectCode(() => v2(v2Ini({ PastaRaiz: 'C:\\Projetos\\..\\Outro' })), 'PARENT_TRAVERSAL_NOT_ALLOWED');
  expectCode(() => v2(v2Ini({ PastaRaiz: 'C:\\Projetos\\*' })), 'GLOB_NOT_ALLOWED');
  expectCode(() => v2(v2Ini({ PastaRaiz: '%USERPROFILE%\\site' })), 'ENV_EXPANSION_NOT_ALLOWED');
});

test('exclusões exigem caminho relativo e confinado', () => {
  expectCode(() => v2(v2Ini({ IgnorarPasta01: '..\\vendor' })), 'PARENT_TRAVERSAL_NOT_ALLOWED');
  expectCode(() => v2(v2Ini({ IgnorarPasta01: 'C:\\vendor' })), 'RELATIVE_PATH_REQUIRED');
  expectCode(() => v2(v2Ini({ IgnorarArquivo01: 'C:config.js' })), 'RELATIVE_PATH_REQUIRED');
  expectCode(() => v2(v2Ini({ IgnorarArquivo01: '\\\\servidor\\compartilhamento\\x.js' })), 'RELATIVE_PATH_REQUIRED');
  expectCode(() => v2(v2Ini({ IgnorarPasta01: 'vendor\\*' })), 'GLOB_NOT_ALLOWED');
});

test('duplicatas lógicas sob semântica Windows são rejeitadas', () => {
  expectCode(() => v2(v2Ini({ IgnorarPasta01: 'Vendor', IgnorarPasta02: 'vendor' })), 'DUPLICATE_IGNORED_FOLDER');
  expectCode(() => v2(v2Ini({ IgnorarArquivo01: 'src\\Config.js', IgnorarArquivo02: 'src\\config.js' })), 'DUPLICATE_IGNORED_FILE');
});

test('serialize → parse faz round-trip determinístico', () => {
  const config = v2(v2Ini());
  const serialized = serializeV2Configuration(config);
  assert.deepEqual(parseV2Configuration(serialized, { allowedEngines }), config);
  assert.match(serialized, /^\[Configuracao\]\nVersaoSchema=2\n/);
});

test('persistência V2 grava e lê UTF-8 sem tocar a configuração real', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'selfminifier-v2-'));
  try {
    const filePath = join(directory, 'configuracao.ini');
    const config = v2(v2Ini({ IgnorarArquivo01: 'src\\configuração\\usuário.js' }));
    await writeV2Configuration(filePath, config);
    const text = await readFile(filePath, 'utf8');
    assert.match(text, /configuração/);
    assert.match(text, /usuário/);
    assert.deepEqual(await loadV2Configuration(filePath, { allowedEngines }), config);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});


test('ajuste temporário V2 altera somente outputMode e revalida sem mutar a persistente', () => {
  const persistent = v2(v2Ini());
  const effective = deriveEffectiveConfiguration(persistent, {
    outputMode: 'PreservarOriginaisECriarMinificados',
  }, { allowedEngines });
  assert.equal(effective.outputMode, 'PreservarOriginaisECriarMinificados');
  assert.equal(persistent.outputMode, 'BackupESobrescreverOriginais');
  assert.equal(effective.schemaVersion, 2);
  assert.throws(
    () => deriveEffectiveConfiguration(persistent, { projectRoot: 'C:\\Outro' }, { allowedEngines }),
    (error) => error.code === 'UNSUPPORTED_TEMPORARY_FIELD',
  );
});
