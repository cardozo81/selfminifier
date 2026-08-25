import { CONFIGURATION_SCHEMA_VERSIONS } from '../domain/index.js';
import { scanIni } from './parse.js';
import { identifyConfigurationSchema } from './schema.js';
import { readUtf8File, writeUtf8FileAtomic } from './utf8.js';
import { normalizeBackupRootValue, validateExternalBackupRoot } from './backup-root.js';
import { serializeV2Configuration, validateV2Configuration } from './v2.js';
import { ConfigurationError } from './errors.js';

const V3_SCHEMA_VERSION = CONFIGURATION_SCHEMA_VERSIONS.V3;
const V3_GENERAL_KEYS = new Set(['VersaoSchema', 'Motor', 'Perfil', 'ModoSaida', 'PastaRaiz', 'PastaBackups', 'TiposArquivo']);
const LIST_PATTERN = /^(IgnorarPasta|IgnorarArquivo)(\d+)$/;

function fail(code, message, details = {}) {
  throw new ConfigurationError(code, message, details);
}

function getUnique(entries, key) {
  return entries.find((entry) => entry.key === key)?.value;
}

function parseNumberedLists(entries) {
  const lists = { ignoredFolders: [], ignoredFiles: [] };
  const seen = { IgnorarPasta: new Set(), IgnorarArquivo: new Set() };
  for (const entry of entries) {
    const match = entry.key.match(LIST_PATTERN);
    if (!match) continue;
    const [, kind, rawNumber] = match;
    const number = Number(rawNumber);
    if (!Number.isSafeInteger(number) || number < 1) fail('INVALID_LIST_NUMBER', `O índice da chave '${entry.key}' deve ser positivo.`);
    if (seen[kind].has(number)) fail('DUPLICATE_LIST_NUMBER', `O índice ${number} foi repetido na lista '${kind}'.`);
    seen[kind].add(number);
    lists[kind === 'IgnorarPasta' ? 'ignoredFolders' : 'ignoredFiles'].push({ number, value: entry.value });
  }
  return {
    ignoredFolders: lists.ignoredFolders.sort((a, b) => a.number - b.number).map((entry) => entry.value),
    ignoredFiles: lists.ignoredFiles.sort((a, b) => a.number - b.number).map((entry) => entry.value),
  };
}

export function parseV3ConfigurationText(text) {
  const identified = identifyConfigurationSchema(text);
  if (identified.schemaVersion !== V3_SCHEMA_VERSION) fail('V3_CONFIGURATION_REQUIRED', 'A leitura V3 exige VersaoSchema=3.');
  const sections = scanIni(text);
  for (const section of sections.keys()) {
    if (section !== 'Configuracao') fail('UNKNOWN_SECTION', `A seção '${section}' não é permitida no schema V3.`);
  }
  const entries = sections.get('Configuracao');
  for (const entry of entries) {
    if (!V3_GENERAL_KEYS.has(entry.key) && !LIST_PATTERN.test(entry.key)) {
      fail('UNKNOWN_KEY', `A chave '${entry.key}' não é permitida na seção 'Configuracao' do schema V3.`, { key: entry.key, lineNumber: entry.lineNumber });
    }
  }
  const lists = parseNumberedLists(entries);
  return {
    engine: getUnique(entries, 'Motor'),
    profile: getUnique(entries, 'Perfil'),
    outputMode: getUnique(entries, 'ModoSaida'),
    projectRoot: getUnique(entries, 'PastaRaiz'),
    backupRoot: getUnique(entries, 'PastaBackups') ?? null,
    fileTypes: getUnique(entries, 'TiposArquivo'),
    ...lists,
  };
}

export async function validateV3Configuration(configuration, { allowedEngines, proveWritable = true } = {}) {
  if (!configuration || typeof configuration !== 'object') fail('INVALID_V3_CONFIGURATION', 'A configuração V3 deve ser um objeto.');
  const base = validateV2Configuration(configuration, { allowedEngines });
  const lexicalBackupRoot = normalizeBackupRootValue(configuration.backupRoot);
  const backupRoot = lexicalBackupRoot === null
    ? null
    : await validateExternalBackupRoot(lexicalBackupRoot, base.projectRoot, { proveWritable });
  return { ...base, schemaVersion: V3_SCHEMA_VERSION, backupRoot };
}

export async function parseV3Configuration(text, options = {}) {
  return validateV3Configuration(parseV3ConfigurationText(text), options);
}

export async function loadV3Configuration(filePath, options = {}) {
  return parseV3Configuration(await readUtf8File(filePath), options);
}

function emitV3Ini(configuration) {
  const baseText = serializeV2Configuration(configuration);
  const backupLine = `PastaBackups=${configuration.backupRoot ?? ''}`;
  return baseText
    .replace('VersaoSchema=2', `VersaoSchema=${V3_SCHEMA_VERSION}`)
    .replace(/^(PastaRaiz=.*)$/m, `$1\n${backupLine}`);
}

export function serializeV3Configuration(configuration) {
  if (!configuration || configuration.schemaVersion !== V3_SCHEMA_VERSION) fail('INVALID_V3_CONFIGURATION', 'A serialização V3 exige schemaVersion=3.');
  const base = validateV2Configuration(configuration, {});
  return emitV3Ini({ ...base, schemaVersion: V3_SCHEMA_VERSION, backupRoot: normalizeBackupRootValue(configuration.backupRoot) });
}

export async function writeV3Configuration(filePath, configuration, options = {}) {
  const normalized = await validateV3Configuration(configuration, options);
  const text = emitV3Ini(normalized);
  await writeUtf8FileAtomic(filePath, text, 'CONFIGURATION');
  return text;
}
