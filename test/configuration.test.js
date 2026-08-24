import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveEffectiveConfiguration, loadConfiguration, parseConfiguration } from '../src/configuration/index.js';
import { ConfigurationError } from '../src/configuration/errors.js';

const allowedEngines = new Set(['esbuild']);

const validIni = String.raw`[Configuracao]
Motor=esbuild
Perfil=Padrao
Incluir01=**/*.js
Incluir02=**/*.css
Excluir01=node_modules

[Origem.001]
Tipo=Diretorio
Caminho=C:\Dados\configuração\usuário
ExecutarPorPadrao=true
Recursivo=true
Modo=Todos
Incluir01=*.js
Excluir01=*execução.js

[Origem.002]
Tipo=Arquivo
Caminho=C:\Dados\execução.js
ExecutarPorPadrao=false
Modo=Arquivo
`;

function parse(text) {
  return parseConfiguration(text, { allowedEngines });
}

function expectCode(callback, code) {
  assert.throws(callback, (error) => error instanceof ConfigurationError && error.code === code);
}

test('aceita INI válido com múltiplas origens e texto pt-BR', () => {
  const configuration = parse(validIni);
  assert.equal(configuration.outputMode, 'BackupESobrescreverOriginais');
  assert.deepEqual(configuration.globalIncludes, ['**/*.js', '**/*.css']);
  assert.deepEqual(configuration.globalExcludes, ['node_modules']);
  assert.equal(configuration.sources.length, 2);
  assert.equal(configuration.sources[0].path, 'C:\\Dados\\configuração\\usuário');
  assert.deepEqual(configuration.sources[0].excludes, ['*execução.js']);
});

test('lê arquivo INI em UTF-8 com decodificação estrita', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'selfminifier-config-'));
  const filePath = join(directory, 'configuracao.ini');
  try {
    await writeFile(filePath, validIni, 'utf8');
    const configuration = await loadConfiguration(filePath, { allowedEngines });
    assert.equal(configuration.sources[0].path, 'C:\\Dados\\configuração\\usuário');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('aplica somente o modo de saída padrão documentado quando a chave está ausente', () => {
  const configuration = parse(validIni.replace('Incluir01=**/*.js', 'ModoSaida=BackupESobrescreverOriginais\nIncluir01=**/*.js').replace('ModoSaida=BackupESobrescreverOriginais\n', ''));
  assert.equal(configuration.outputMode, 'BackupESobrescreverOriginais');
});

test('rejeita modo de saída inválido', () => {
  expectCode(() => parse(validIni.replace('Motor=esbuild', 'ModoSaida=Outro\nMotor=esbuild')), 'INVALID_OUTPUT_MODE');
});

test('rejeita booleano, perfil e modo de origem inválidos', () => {
  expectCode(() => parse(validIni.replace('ExecutarPorPadrao=true', 'ExecutarPorPadrao=sim')), 'INVALID_BOOLEAN');
  expectCode(() => parse(validIni.replace('Perfil=Padrao', 'Perfil=Inexistente')), 'INVALID_PROFILE');
  expectCode(() => parse(validIni.replace('Modo=Todos', 'Modo=Inexistente')), 'INVALID_SOURCE_MODE');
});

test('normaliza listas numeradas em ordem determinística', () => {
  const configuration = parse(validIni.replace('Incluir01=**/*.js\nIncluir02=**/*.css', 'Incluir10=dez\nIncluir02=dois\nIncluir01=um'));
  assert.deepEqual(configuration.globalIncludes, ['um', 'dois', 'dez']);
});

test('rejeita sintaxe de lista não aprovada', () => {
  expectCode(() => parse(validIni.replace('Incluir01=**/*.js', 'Incluir=**/*.js;**/*.css')), 'UNSUPPORTED_LIST_SYNTAX');
});

test('rejeita chave duplicada antes da interpretação do INI', () => {
  expectCode(() => parse(validIni.replace('Motor=esbuild', 'Motor=esbuild\nMotor=esbuild')), 'DUPLICATE_KEY');
});

test('valida motor contra conjunto homologado injetado', () => {
  expectCode(() => parse(validIni.replace('Motor=esbuild', 'Motor=outro')), 'UNSUPPORTED_ENGINE');
  assert.doesNotThrow(() => parseConfiguration(validIni, { allowedEngines: new Set(['esbuild', 'outro']) }));
});

test('reconhece Personalizado mas bloqueia sem schema de opções aprovado', () => {
  expectCode(() => parse(validIni.replace('Perfil=Padrao', 'Perfil=Personalizado')), 'PROFILE_OPTIONS_PENDING');
});

test('deriva configuração efetiva sem mutar a persistente', () => {
  const persistent = parse(validIni);
  const snapshot = structuredClone(persistent);
  const effective = deriveEffectiveConfiguration(persistent, {
    outputMode: 'PreservarOriginaisECriarMinificados',
    globalIncludes: ['temporario/**/*.js'],
  }, { allowedEngines });

  assert.deepEqual(persistent, snapshot);
  assert.equal(effective.outputMode, 'PreservarOriginaisECriarMinificados');
  assert.deepEqual(effective.globalIncludes, ['temporario/**/*.js']);
});
