import { V2_DEFAULT_FILE_TYPES, V2_FILE_TYPES_BY_VALUE } from '../domain/index.js';
import { ConfigurationError } from './errors.js';

function reason(code, message) {
  return { code, message };
}

export function assessLegacyConfiguration(configuration) {
  if (!configuration || typeof configuration !== 'object' || !Array.isArray(configuration.sources)) {
    throw new ConfigurationError('INVALID_LEGACY_CONFIGURATION', 'A configuração legada deve ser um objeto normalizado com a lista de origens.');
  }

  const sources = configuration.sources;
  if (sources.length === 0) {
    return {
      classification: 'ambiguous',
      reasons: [reason('NO_SOURCES', 'A configuração legada não possui origens para converter em uma raiz única.')],
      target: null,
    };
  }

  const reasons = [];
  const fileSources = sources.filter((source) => source.type === 'Arquivo');
  const directorySources = sources.filter((source) => source.type === 'Diretorio');

  if (fileSources.length > 0) {
    reasons.push(reason('EXPLICIT_FILE_SOURCE', 'A configuração contém origens de arquivo explícito, sem equivalente direto no modelo de raiz única.'));
  }
  if (sources.length > 1) {
    reasons.push(reason('MULTIPLE_SOURCES', 'A configuração contém múltiplas origens; a escolha de uma raiz única exigiria decisão explícita.'));
  }

  if (sources.length === 1 && directorySources.length === 1) {
    const [source] = sources;
    if (source.recursive !== true) {
      reasons.push(reason('NON_RECURSIVE_SOURCE', 'A origem não é recursiva, mas o modelo-alvo é recursivo.'));
    }
    if (source.mode !== 'Todos') {
      reasons.push(reason('SOURCE_MODE_REQUIRES_REVIEW', 'O modo da origem não corresponde à seleção implícita de tipos do modelo-alvo.'));
    }
    if (source.executeByDefault === false) {
      reasons.push(reason('INACTIVE_SOURCE', 'A origem está marcada como não executada por padrão, sem equivalente direto no modelo-alvo.'));
    }
    const globCount = (configuration.globalIncludes ?? []).length
      + (configuration.globalExcludes ?? []).length
      + (source.includes ?? []).length
      + (source.excludes ?? []).length;
    if (globCount > 0) {
      reasons.push(reason('GLOBS_REQUIRE_REVIEW', 'A configuração usa padrões glob que não podem ser convertidos de forma unívoca em tipos, pastas ou arquivos ignorados.'));
    }
  }

  if (reasons.length === 0) {
    const [source] = sources;
    return {
      classification: 'directly-convertible',
      reasons: [],
      target: {
        schemaVersion: 2,
        engine: configuration.engineId,
        profile: configuration.profile,
        outputMode: configuration.outputMode,
        projectRoot: source.path,
        fileTypes: [...V2_FILE_TYPES_BY_VALUE[V2_DEFAULT_FILE_TYPES]],
        ignoredFolders: [],
        ignoredFiles: [],
      },
    };
  }

  const ambiguous = sources.length > 1 || fileSources.length > 0;
  return {
    classification: ambiguous ? 'ambiguous' : 'requires-explicit-review',
    reasons,
    target: null,
  };
}
