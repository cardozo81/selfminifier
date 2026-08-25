import { CONFIGURATION_SCHEMA_VERSIONS } from '../domain/index.js';
import { scanIni } from './parse.js';
import { ConfigurationError } from './errors.js';

const ORIGIN_SECTION_PATTERN = /^Origem\.(\d+)$/;
const V1_LIST_PATTERN = /^(Incluir|Excluir)(\d*)$/;
const V2_LIST_PATTERN = /^(IgnorarPasta|IgnorarArquivo)(\d+)$/;
const V2_SINGLE_KEYS = new Set(['PastaRaiz', 'TiposArquivo']);

function fail(code, message, details = {}) {
  throw new ConfigurationError(code, message, details);
}

export function identifyConfigurationSchema(text) {
  if (typeof text !== 'string') {
    fail('INVALID_TEXT', 'O conteúdo da configuração deve ser texto.');
  }
  const sections = scanIni(text);
  const generalEntries = sections.get('Configuracao');
  if (!generalEntries) {
    fail('MISSING_CONFIGURATION_SECTION', "A seção '[Configuracao]' é obrigatória.");
  }

  const keys = new Set(generalEntries.map((entry) => entry.key));
  const hasVersaoSchema = keys.has('VersaoSchema');
  const hasOriginSections = [...sections.keys()].some((name) => ORIGIN_SECTION_PATTERN.test(name));
  const hasV1Lists = [...keys].some((key) => V1_LIST_PATTERN.test(key));
  const hasV1Structure = hasOriginSections || hasV1Lists;
  const hasV2Structure = [...keys].some((key) => V2_SINGLE_KEYS.has(key) || V2_LIST_PATTERN.test(key));

  if (!hasVersaoSchema) {
    if (hasV1Structure && hasV2Structure) {
      fail('MIXED_SCHEMA', 'A configuração mistura estruturas V1 e V2 sem declarar um schema suportado.', { hasV1Structure, hasV2Structure });
    }
    fail('MISSING_SCHEMA_VERSION', "A configuração não declara 'VersaoSchema=2'. Somente o schema V2 é suportado.", {
      requiredVersion: CONFIGURATION_SCHEMA_VERSIONS.V2,
      hasV1Structure,
      hasV2Structure,
    });
  }

  const versionEntry = generalEntries.find((entry) => entry.key === 'VersaoSchema');
  const rawVersion = versionEntry.value;
  if (!/^\d+$/.test(rawVersion)) {
    fail('INVALID_SCHEMA_VERSION', `O valor '${rawVersion}' de 'VersaoSchema' não é um número inteiro válido.`, { value: rawVersion });
  }
  const version = Number(rawVersion);
  if (version !== CONFIGURATION_SCHEMA_VERSIONS.V2) {
    fail('UNSUPPORTED_SCHEMA_VERSION', `A versão de schema '${version}' não é suportada.`, {
      version,
      supported: [CONFIGURATION_SCHEMA_VERSIONS.V2],
    });
  }
  if (hasV1Structure) {
    fail('MIXED_SCHEMA', 'A configuração declara VersaoSchema=2 mas contém estruturas do schema V1.', { hasV1Structure });
  }
  return { kind: 'v2', schemaVersion: CONFIGURATION_SCHEMA_VERSIONS.V2 };
}
