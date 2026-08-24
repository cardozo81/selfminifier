import ini from 'ini';
import { ConfigurationError } from './errors.js';

const SECTION_PATTERN = /^\[([^\]]+)\]$/;
const KEY_PATTERN = /^([A-Za-z][A-Za-z0-9]*)=(.*)$/;
const ORIGIN_SECTION_PATTERN = /^Origem\.(\d+)$/;
const NUMBERED_LIST_PATTERN = /^(Incluir|Excluir)(\d+)$/;
const GLOBAL_KEYS = new Set(['ModoSaida', 'Motor', 'Perfil', 'Incluir', 'Excluir']);
const ORIGIN_KEYS = new Set(['Tipo', 'Caminho', 'ExecutarPorPadrao', 'Recursivo', 'Modo', 'Incluir', 'Excluir']);

function fail(code, message, details = {}) {
  throw new ConfigurationError(code, message, details);
}

export function scanIni(text) {
  const sections = new Map();
  let currentSection = null;

  text.split(/\r?\n/).forEach((rawLine, index) => {
    const lineNumber = index + 1;
    const line = rawLine.trim();
    if (line === '' || line.startsWith(';') || line.startsWith('#')) return;

    const sectionMatch = line.match(SECTION_PATTERN);
    if (sectionMatch) {
      currentSection = sectionMatch[1];
      if (sections.has(currentSection)) {
        fail('DUPLICATE_SECTION', `A seção '${currentSection}' foi repetida na linha ${lineNumber}.`, { lineNumber });
      }
      sections.set(currentSection, []);
      return;
    }

    if (currentSection === null) {
      fail('KEY_OUTSIDE_SECTION', `A chave da linha ${lineNumber} está fora de uma seção.`, { lineNumber });
    }

    const keyMatch = line.match(KEY_PATTERN);
    if (!keyMatch) {
      fail('INVALID_INI_LINE', `A linha ${lineNumber} não possui a estrutura chave=valor aprovada.`, { lineNumber });
    }

    const [, key, rawValue] = keyMatch;
    const entries = sections.get(currentSection);
    if (entries.some((entry) => entry.key === key)) {
      fail('DUPLICATE_KEY', `A chave '${key}' foi repetida na seção '${currentSection}'.`, {
        lineNumber,
        section: currentSection,
        key,
      });
    }
    entries.push({ key, value: rawValue.trim(), lineNumber });
  });

  return sections;
}

function rejectUnsupportedListKey(sectionName, key, value, lineNumber) {
  if (key === 'Incluir' || key === 'Excluir') {
    fail(
      'UNSUPPORTED_LIST_SYNTAX',
      `A chave '${key}' na seção '${sectionName}' deve ser numerada; arrays ou chaves repetidas não são aceitos.`,
      { section: sectionName, key, value, lineNumber },
    );
  }
}

function normalizeNumberedLists(sectionName, entries) {
  const lists = { includes: [], excludes: [] };
  const seenNumbers = { Incluir: new Set(), Excluir: new Set() };

  for (const entry of entries) {
    rejectUnsupportedListKey(sectionName, entry.key, entry.value, entry.lineNumber);
    const match = entry.key.match(NUMBERED_LIST_PATTERN);
    if (!match) continue;

    if (entry.value.includes(';')) {
      fail(
        'UNSUPPORTED_LIST_SYNTAX',
        `A chave '${entry.key}' não aceita lista separada por ponto e vírgula. Use uma chave numerada por item.`,
        { section: sectionName, key: entry.key, lineNumber: entry.lineNumber },
      );
    }

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
    lists[kind === 'Incluir' ? 'includes' : 'excludes'].push({ number, value: entry.value });
  }

  lists.includes.sort((left, right) => left.number - right.number);
  lists.excludes.sort((left, right) => left.number - right.number);
  return {
    includes: lists.includes.map((entry) => entry.value),
    excludes: lists.excludes.map((entry) => entry.value),
  };
}

function getUnique(entries, key, sectionName) {
  return entries.find((entry) => entry.key === key)?.value;
}

function requireValue(entries, key, sectionName) {
  const value = getUnique(entries, key, sectionName);
  if (value === undefined || value === '') {
    fail('MISSING_REQUIRED_VALUE', `A chave '${key}' é obrigatória na seção '${sectionName}'.`, { section: sectionName, key });
  }
  return value;
}

function parseBoolean(value, sectionName, key) {
  if (value !== 'true' && value !== 'false') {
    fail('INVALID_BOOLEAN', `O valor '${value}' para '${key}' na seção '${sectionName}' deve ser true ou false.`, {
      section: sectionName,
      key,
      value,
    });
  }
  return value === 'true';
}

function validateKnownKeys(sectionName, entries, allowedKeys) {
  for (const entry of entries) {
    if (!allowedKeys.has(entry.key) && !NUMBERED_LIST_PATTERN.test(entry.key)) {
      fail('UNKNOWN_KEY', `A chave '${entry.key}' não é permitida na seção '${sectionName}'.`, {
        section: sectionName,
        key: entry.key,
        lineNumber: entry.lineNumber,
      });
    }
  }
}

function parseOrigin(sectionName, entries) {
  validateKnownKeys(sectionName, entries, ORIGIN_KEYS);
  const type = requireValue(entries, 'Tipo', sectionName);
  const sourcePath = requireValue(entries, 'Caminho', sectionName);
  const executeByDefault = parseBoolean(requireValue(entries, 'ExecutarPorPadrao', sectionName), sectionName, 'ExecutarPorPadrao');
  const mode = requireValue(entries, 'Modo', sectionName);
  const lists = normalizeNumberedLists(sectionName, entries);

  if (type !== 'Diretorio' && type !== 'Arquivo') {
    fail('INVALID_SOURCE_TYPE', `O tipo '${type}' na seção '${sectionName}' não é permitido. Use Diretorio ou Arquivo.`, { section: sectionName, type });
  }
  if (!['Todos', 'Selecionados', 'Arquivo'].includes(mode)) {
    fail('INVALID_SOURCE_MODE', `O modo '${mode}' na seção '${sectionName}' não é permitido.`, { section: sectionName, mode });
  }
  if (type === 'Arquivo' && mode !== 'Arquivo') {
    fail('SOURCE_MODE_MISMATCH', `Uma origem do tipo Arquivo deve usar Modo=Arquivo na seção '${sectionName}'.`, { section: sectionName });
  }
  if (type === 'Diretorio' && mode === 'Arquivo') {
    fail('SOURCE_MODE_MISMATCH', `Uma origem do tipo Diretorio não pode usar Modo=Arquivo na seção '${sectionName}'.`, { section: sectionName });
  }

  const recursiveValue = getUnique(entries, 'Recursivo', sectionName);
  const recursive = type === 'Diretorio'
    ? parseBoolean(recursiveValue ?? '', sectionName, 'Recursivo')
    : undefined;

  return {
    id: sectionName.replace('Origem.', ''),
    type,
    path: sourcePath,
    executeByDefault,
    ...(recursive === undefined ? {} : { recursive }),
    mode,
    includes: lists.includes,
    excludes: lists.excludes,
  };
}

export function parseConfigurationText(text) {
  if (typeof text !== 'string') {
    fail('INVALID_TEXT', 'O conteúdo da configuração deve ser texto.');
  }

  const sections = scanIni(text);
  ini.parse(text);
  let generalEntries = sections.get('Configuracao');
  if (!generalEntries) {
    fail('MISSING_CONFIGURATION_SECTION', "A seção '[Configuracao]' é obrigatória.");
  }

  validateKnownKeys('Configuracao', generalEntries, GLOBAL_KEYS);
  const lists = normalizeNumberedLists('Configuracao', generalEntries);
  const sources = [];
  const originIds = new Set();

  for (const [sectionName, entries] of sections) {
    if (sectionName === 'Configuracao') continue;
    const match = sectionName.match(ORIGIN_SECTION_PATTERN);
    if (!match) {
      fail('UNKNOWN_SECTION', `A seção '${sectionName}' não é permitida.`, { section: sectionName });
    }
    const idNumber = Number(match[1]);
    if (!Number.isSafeInteger(idNumber) || idNumber < 1 || originIds.has(idNumber)) {
      fail('INVALID_ORIGIN_ID', `O identificador da seção '${sectionName}' não é válido.`, { section: sectionName });
    }
    originIds.add(idNumber);
    sources.push(parseOrigin(sectionName, entries));
  }

  sources.sort((left, right) => Number(left.id) - Number(right.id));
  return {
    outputMode: getUnique(generalEntries, 'ModoSaida', 'Configuracao'),
    engineId: getUnique(generalEntries, 'Motor', 'Configuracao'),
    profile: getUnique(generalEntries, 'Perfil', 'Configuracao'),
    globalIncludes: lists.includes,
    globalExcludes: lists.excludes,
    sources,
  };
}

export function parseWithIniLibrary(text) {
  scanIni(text);
  return ini.parse(text);
}
