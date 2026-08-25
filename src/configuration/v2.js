import path from 'node:path';
import {
  CONFIGURATION_SCHEMA_VERSIONS,
  DEFAULT_OUTPUT_MODE,
  OUTPUT_MODES,
  PROFILE_DEFINITIONS,
  PROFILES,
  V2_DEFAULT_FILE_TYPES,
  V2_FILE_TYPES_BY_VALUE,
} from '../domain/index.js';
import { ConfigurationError } from './errors.js';
import { scanIni } from './parse.js';
import { identifyConfigurationSchema } from './schema.js';
import { readUtf8File, writeUtf8FileAtomic } from './utf8.js';

const V2_SCHEMA_VERSION = CONFIGURATION_SCHEMA_VERSIONS.V2;
const FILE_TYPES_ORDER = Object.freeze(['css', 'javascript']);
const V2_GENERAL_KEYS = new Set(['VersaoSchema', 'Motor', 'Perfil', 'ModoSaida', 'PastaRaiz', 'TiposArquivo']);
const V2_LIST_PATTERN = /^(IgnorarPasta|IgnorarArquivo)(\d+)$/;
const GLOB_METACHARS = /[*?[\]{}!]/;
const DRIVE_PREFIX = /^[A-Za-z]:/;
const ENV_VAR_PATTERN = /%[^%]+%/;

function fail(code, message, details = {}) {
  throw new ConfigurationError(code, message, details);
}

function requireNonEmptyString(value, field) {
  if (typeof value !== 'string' || value === '') {
    fail('MISSING_REQUIRED_VALUE', `O campo '${field}' é obrigatório e deve ser texto não vazio.`, { field });
  }
}

function normalizeAllowedEngines(allowedEngines) {
  if (allowedEngines === undefined || allowedEngines === null) {
    fail('ENGINE_SET_REQUIRED', 'A validação V2 exige o conjunto de motores homologados como dependência explícita.');
  }
  const values = allowedEngines instanceof Set ? [...allowedEngines] : [...allowedEngines];
  if (values.length === 0) {
    fail('ENGINE_SET_EMPTY', 'O conjunto de motores homologados não pode estar vazio.');
  }
  return new Set(values);
}

function validateEngineValue(engine, allowedEngines) {
  requireNonEmptyString(engine, 'Motor');
  if (allowedEngines === undefined || allowedEngines === null) return engine;
  const homologated = normalizeAllowedEngines(allowedEngines);
  if (!homologated.has(engine)) {
    fail('UNSUPPORTED_ENGINE', `O motor '${engine}' não está no conjunto homologado fornecido.`, {
      engine,
      allowed: [...homologated],
    });
  }
  return engine;
}

function validateProfileValue(profile) {
  requireNonEmptyString(profile, 'Perfil');
  if (!Object.hasOwn(PROFILE_DEFINITIONS, profile)) {
    fail('INVALID_PROFILE', `O perfil '${profile}' não é permitido.`, {
      allowed: Object.values(PROFILES),
      value: profile,
    });
  }
  if (profile === PROFILES.PERSONALIZADO) {
    fail('PROFILE_OPTIONS_PENDING', 'O perfil Personalizado é reconhecido, mas suas opções ainda não foram especificadas; a execução foi bloqueada.', { profile });
  }
  return profile;
}

function validateOutputModeValue(outputMode) {
  const mode = outputMode === undefined ? DEFAULT_OUTPUT_MODE : outputMode;
  if (!Object.values(OUTPUT_MODES).includes(mode)) {
    fail('INVALID_OUTPUT_MODE', `O modo de saída '${mode}' não é permitido.`, {
      allowed: Object.values(OUTPUT_MODES),
      value: mode,
    });
  }
  return mode;
}

function splitPathSegments(value) {
  return value.split(/[\\/]+/).filter((segment) => segment.length > 0);
}

function validateNoGlobSyntax(value, field) {
  if (GLOB_METACHARS.test(value)) {
    fail('GLOB_NOT_ALLOWED', `O campo '${field}' não aceita padrões glob ou curingas.`, { field, value });
  }
}

function validateNoParentTraversal(value, field) {
  if (splitPathSegments(value).some((segment) => segment === '..')) {
    fail('PARENT_TRAVERSAL_NOT_ALLOWED', `O campo '${field}' não pode conter '..'.`, { field, value });
  }
}

function normalizeProjectRoot(value) {
  requireNonEmptyString(value, 'PastaRaiz');
  if (ENV_VAR_PATTERN.test(value)) {
    fail('ENV_EXPANSION_NOT_ALLOWED', "O campo 'PastaRaiz' não aceita variáveis de ambiente.", { value });
  }
  validateNoGlobSyntax(value, 'PastaRaiz');
  validateNoParentTraversal(value, 'PastaRaiz');
  const parsed = path.win32.parse(value);
  if (!path.win32.isAbsolute(value) || parsed.root === '\\' || parsed.root === '/' || parsed.root === '') {
    fail('ABSOLUTE_PATH_REQUIRED', "O campo 'PastaRaiz' deve ser um caminho Windows absoluto com unidade ou UNC.", { value });
  }
  return path.win32.normalize(value);
}

function normalizeIgnoredPath(value, field) {
  requireNonEmptyString(value, field);
  validateNoGlobSyntax(value, field);
  validateNoParentTraversal(value, field);
  if (path.win32.isAbsolute(value) || DRIVE_PREFIX.test(value)) {
    fail('RELATIVE_PATH_REQUIRED', `O campo '${field}' deve ser um caminho relativo à raiz do projeto.`, { field, value });
  }
  return path.win32.normalize(value);
}

function caseInsensitiveIdentity(value) {
  return value.toLowerCase();
}

function normalizeIgnoredEntries(values, field, duplicateCode) {
  if (!Array.isArray(values)) {
    fail('INVALID_LISTS', `A lista '${field}' deve ser um vetor normalizado.`);
  }
  const entries = [];
  const seen = new Set();
  for (const value of values) {
    requireNonEmptyString(value, field);
    const candidate = normalizeIgnoredPath(value, field);
    const key = caseInsensitiveIdentity(candidate);
    if (seen.has(key)) {
      fail(duplicateCode, `A entrada '${value}' em '${field}' é duplicada logicamente após normalização.`, { field, value });
    }
    seen.add(key);
    entries.push(candidate);
  }
  return entries;
}

function normalizeFileTypesValue(value) {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      fail('INVALID_FILE_TYPES', 'A seleção de tipos não pode ser vazia.', { value });
    }
    const unique = [...new Set(value.map((type) => String(type)))];
    for (const type of unique) {
      if (!FILE_TYPES_ORDER.includes(type)) {
        fail('INVALID_FILE_TYPES', `O tipo '${type}' não é permitido. Use somente css e javascript.`, { type });
      }
    }
    return unique.sort((a, b) => FILE_TYPES_ORDER.indexOf(a) - FILE_TYPES_ORDER.indexOf(b));
  }
  const raw = value === undefined || value === '' ? V2_DEFAULT_FILE_TYPES : value;
  const mapped = V2_FILE_TYPES_BY_VALUE[raw];
  if (!mapped) {
    fail('INVALID_FILE_TYPES', `O valor '${raw}' de 'TiposArquivo' não é permitido. Use CSS, JavaScript ou CSS+JavaScript.`, {
      value: raw,
      allowed: Object.keys(V2_FILE_TYPES_BY_VALUE),
    });
  }
  return [...mapped];
}

function fileTypesValueFromList(list) {
  const canonical = list.slice().sort((a, b) => FILE_TYPES_ORDER.indexOf(a) - FILE_TYPES_ORDER.indexOf(b));
  const entry = Object.entries(V2_FILE_TYPES_BY_VALUE).find(([, types]) => (
    types.length === canonical.length && types.every((type) => canonical.includes(type))
  ));
  if (!entry) {
    fail('INVALID_FILE_TYPES', 'A lista de tipos não corresponde a um valor fechado.', { list });
  }
  return entry[0];
}

function validateKnownKeys(generalEntries) {
  for (const entry of generalEntries) {
    if (!V2_GENERAL_KEYS.has(entry.key) && !V2_LIST_PATTERN.test(entry.key)) {
      fail('UNKNOWN_KEY', `A chave '${entry.key}' não é permitida na seção 'Configuracao' do schema V2.`, {
        section: 'Configuracao',
        key: entry.key,
        lineNumber: entry.lineNumber,
      });
    }
  }
}

function ensureNoUnknownSections(sections) {
  for (const sectionName of sections.keys()) {
    if (sectionName !== 'Configuracao') {
      fail('UNKNOWN_SECTION', `A seção '${sectionName}' não é permitida no schema V2.`, { section: sectionName });
    }
  }
}

function getUnique(entries, key) {
  return entries.find((entry) => entry.key === key)?.value;
}

function parseNumberedLists(generalEntries, sectionName) {
  const lists = { folders: [], files: [] };
  const seenNumbers = { IgnorarPasta: new Set(), IgnorarArquivo: new Set() };
  for (const entry of generalEntries) {
    const match = entry.key.match(V2_LIST_PATTERN);
    if (!match) continue;
    const [, kind, numberText] = match;
    const number = Number(numberText);
    if (!Number.isSafeInteger(number) || number < 1) {
      fail('INVALID_LIST_NUMBER', `O índice da chave '${entry.key}' deve ser um número positivo.`, {
        section: sectionName,
        key: entry.key,
        lineNumber: entry.lineNumber,
      });
    }
    if (seenNumbers[kind].has(number)) {
      fail('DUPLICATE_LIST_NUMBER', `O índice ${number} foi repetido na lista '${kind}' da seção '${sectionName}'.`, {
        section: sectionName,
        number,
        lineNumber: entry.lineNumber,
      });
    }
    seenNumbers[kind].add(number);
    const target = kind === 'IgnorarPasta' ? 'folders' : 'files';
    lists[target].push({ number, value: entry.value });
  }
  return {
    folders: lists.folders.sort((left, right) => left.number - right.number).map((entry) => entry.value),
    files: lists.files.sort((left, right) => left.number - right.number).map((entry) => entry.value),
  };
}

export function parseV2ConfigurationText(text) {
  if (typeof text !== 'string') {
    fail('INVALID_TEXT', 'O conteúdo da configuração deve ser texto.');
  }
  const sections = scanIni(text);
  ensureNoUnknownSections(sections);
  const generalEntries = sections.get('Configuracao');
  if (!generalEntries) {
    fail('MISSING_CONFIGURATION_SECTION', "A seção '[Configuracao]' é obrigatória.");
  }
  validateKnownKeys(generalEntries);

  const rawVersion = getUnique(generalEntries, 'VersaoSchema');
  if (rawVersion === undefined || rawVersion === '') {
    fail('MISSING_SCHEMA_VERSION', "A chave 'VersaoSchema' é obrigatória no schema V2.");
  }
  if (!/^\d+$/.test(rawVersion)) {
    fail('INVALID_SCHEMA_VERSION', `O valor '${rawVersion}' de 'VersaoSchema' não é um número inteiro válido.`, { value: rawVersion });
  }
  if (Number(rawVersion) !== V2_SCHEMA_VERSION) {
    fail('UNSUPPORTED_SCHEMA_VERSION', `A versão de schema '${rawVersion}' não é suportada.`, {
      version: Number(rawVersion),
      supported: [V2_SCHEMA_VERSION],
    });
  }

  const lists = parseNumberedLists(generalEntries, 'Configuracao');
  return {
    engine: getUnique(generalEntries, 'Motor'),
    profile: getUnique(generalEntries, 'Perfil'),
    outputMode: getUnique(generalEntries, 'ModoSaida'),
    projectRoot: getUnique(generalEntries, 'PastaRaiz'),
    fileTypes: getUnique(generalEntries, 'TiposArquivo'),
    ignoredFolders: lists.folders,
    ignoredFiles: lists.files,
  };
}

export function validateV2Configuration(configuration, { allowedEngines } = {}) {
  if (!configuration || typeof configuration !== 'object') {
    fail('INVALID_V2_CONFIGURATION', 'A configuração V2 deve ser um objeto.');
  }
  return {
    schemaVersion: V2_SCHEMA_VERSION,
    engine: validateEngineValue(configuration.engine, allowedEngines),
    profile: validateProfileValue(configuration.profile),
    outputMode: validateOutputModeValue(configuration.outputMode),
    projectRoot: normalizeProjectRoot(configuration.projectRoot),
    fileTypes: normalizeFileTypesValue(configuration.fileTypes),
    ignoredFolders: normalizeIgnoredEntries(configuration.ignoredFolders ?? [], 'IgnorarPasta', 'DUPLICATE_IGNORED_FOLDER'),
    ignoredFiles: normalizeIgnoredEntries(configuration.ignoredFiles ?? [], 'IgnorarArquivo', 'DUPLICATE_IGNORED_FILE'),
  };
}

export function parseV2Configuration(text, options = {}) {
  identifyConfigurationSchema(text);
  return validateV2Configuration(parseV2ConfigurationText(text), options);
}

export async function loadV2Configuration(filePath, options = {}) {
  return parseV2Configuration(await readUtf8File(filePath), options);
}

function padNumber(number) {
  return String(number).padStart(2, '0');
}

function emitV2Ini(configuration) {
  const lines = ['[Configuracao]'];
  lines.push(`VersaoSchema=${V2_SCHEMA_VERSION}`);
  lines.push(`Motor=${configuration.engine}`);
  lines.push(`Perfil=${configuration.profile}`);
  lines.push(`ModoSaida=${configuration.outputMode}`);
  lines.push(`PastaRaiz=${configuration.projectRoot}`);
  lines.push(`TiposArquivo=${fileTypesValueFromList(configuration.fileTypes)}`);
  configuration.ignoredFolders.forEach((folder, index) => lines.push(`IgnorarPasta${padNumber(index + 1)}=${folder}`));
  configuration.ignoredFiles.forEach((file, index) => lines.push(`IgnorarArquivo${padNumber(index + 1)}=${file}`));
  return `${lines.join('\n')}\n`;
}

export function serializeV2Configuration(configuration) {
  const normalized = validateV2Configuration(configuration, {});
  return emitV2Ini(normalized);
}

export async function writeV2Configuration(filePath, configuration) {
  const text = serializeV2Configuration(configuration);
  await writeUtf8FileAtomic(filePath, text, 'CONFIGURATION');
  return text;
}
