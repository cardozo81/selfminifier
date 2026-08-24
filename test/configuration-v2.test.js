import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assessLegacyConfiguration,
  identifyConfigurationSchema,
  loadV2Configuration,
  parseConfiguration,
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

function legacyIni({ globals = [], sources = [] } = {}) {
  const lines = ['[Configuracao]', 'Motor=esbuild', 'Perfil=Padrao'];
  globals.forEach((value, index) => lines.push(`Incluir${String(index + 1).padStart(2, '0')}=${value}`));
  sources.forEach((source, index) => {
    lines.push('');
    const id = String(index + 1).padStart(3, '0');
    lines.push(`[Origem.${id}]`, `Tipo=${source.type}`, `Caminho=${source.path}`, `ExecutarPorPadrao=${source.executeByDefault ?? true}`);
    if (source.type === 'Diretorio') {
      lines.push(`Recursivo=${source.recursive ?? true}`, `Modo=${source.mode ?? 'Todos'}`);
    } else {
      lines.push('Modo=Arquivo');
    }
  });
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

test('identificação de schema distingue legado, V2, versão inválida e misto', () => {
  assert.deepEqual(identifyConfigurationSchema(v2Ini()), { kind: 'v2', schemaVersion: 2 });
  const legacy = legacyIni({ sources: [{ type: 'Diretorio', path: 'C:\\Projetos\\exemplo' }] });
  assert.deepEqual(identifyConfigurationSchema(legacy), { kind: 'legacy', schemaVersion: 1 });
  expectCode(() => identifyConfigurationSchema(v2Ini({ VersaoSchema: '3' })), 'UNSUPPORTED_SCHEMA_VERSION');
  expectCode(() => identifyConfigurationSchema(v2Ini({ VersaoSchema: 'abc' })), 'INVALID_SCHEMA_VERSION');
  expectCode(() => identifyConfigurationSchema(v2Ini({ VersaoSchema: null })), 'MIXED_SCHEMA');
  const mixedLists = `[Configuracao]\nVersaoSchema=2\nMotor=esbuild\nPerfil=Padrao\nPastaRaiz=C:\\Projetos\\x\nIncluir01=**/*.js\n`;
  expectCode(() => identifyConfigurationSchema(mixedLists), 'MIXED_SCHEMA');
});

test('parser V2 exige VersaoSchema e rejeita seções de origem V1', () => {
  expectCode(() => v2(v2Ini({ VersaoSchema: null })), 'MISSING_SCHEMA_VERSION');
  expectCode(() => v2(v2Ini({ VersaoSchema: '3' })), 'UNSUPPORTED_SCHEMA_VERSION');
  const mixed = `[Configuracao]\nVersaoSchema=2\nMotor=esbuild\nPerfil=Padrao\nPastaRaiz=C:\\Projetos\\x\n\n[Origem.001]\nTipo=Diretorio\nCaminho=C:\\Projetos\\x\nExecutarPorPadrao=true\nRecursivo=true\nModo=Todos\n`;
  expectCode(() => v2(mixed), 'UNKNOWN_SECTION');
});

test('parser V1 continua rejeitando configuração V2 sem interpretação silenciosa', () => {
  expectCode(() => parseConfiguration(v2Ini(), { allowedEngines }), 'UNKNOWN_KEY');
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

test('legado simples de diretório único é diretamente conversível', () => {
  const legacy = parseConfiguration(legacyIni({ sources: [{ type: 'Diretorio', path: 'C:\\Projetos\\exemplo' }] }), { allowedEngines });
  const assessment = assessLegacyConfiguration(legacy);
  assert.equal(assessment.classification, 'directly-convertible');
  assert.equal(assessment.target.projectRoot, 'C:\\Projetos\\exemplo');
  assert.deepEqual(assessment.target.fileTypes, ['css', 'javascript']);
  assert.deepEqual(assessment.target.ignoredFolders, []);
});

test('legado com múltiplas origens é ambíguo', () => {
  const legacy = parseConfiguration(legacyIni({ sources: [
    { type: 'Diretorio', path: 'C:\\A' },
    { type: 'Diretorio', path: 'C:\\B' },
  ] }), { allowedEngines });
  const assessment = assessLegacyConfiguration(legacy);
  assert.equal(assessment.classification, 'ambiguous');
  assert.ok(assessment.reasons.some((entry) => entry.code === 'MULTIPLE_SOURCES'));
});

test('legado com origem de arquivo explícito não é convertido silenciosamente', () => {
  const legacy = parseConfiguration(legacyIni({ sources: [{ type: 'Arquivo', path: 'C:\\Projetos\\entrada.js' }] }), { allowedEngines });
  const assessment = assessLegacyConfiguration(legacy);
  assert.equal(assessment.classification, 'ambiguous');
  assert.equal(assessment.target, null);
  assert.ok(assessment.reasons.some((entry) => entry.code === 'EXPLICIT_FILE_SOURCE'));
});

test('legado com globs não é reinterpretado silenciosamente', () => {
  const legacy = parseConfiguration(legacyIni({ globals: ['**/*.js'], sources: [{ type: 'Diretorio', path: 'C:\\Projetos\\exemplo' }] }), { allowedEngines });
  const assessment = assessLegacyConfiguration(legacy);
  assert.equal(assessment.classification, 'requires-explicit-review');
  assert.equal(assessment.target, null);
  assert.ok(assessment.reasons.some((entry) => entry.code === 'GLOBS_REQUIRE_REVIEW'));
});
