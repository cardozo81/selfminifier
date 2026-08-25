export const OUTPUT_MODES = Object.freeze({
  BACKUP_OVERWRITE: 'BackupESobrescreverOriginais',
  PRESERVE_AND_CREATE_MINIFIED: 'PreservarOriginaisECriarMinificados',
});

export const DEFAULT_OUTPUT_MODE = OUTPUT_MODES.BACKUP_OVERWRITE;

export const PROFILES = Object.freeze({
  CONSERVADOR: 'Conservador',
  PADRAO: 'Padrao',
  MAXIMO: 'Maximo',
  PERSONALIZADO: 'Personalizado',
});

export const PROFILE_DEFINITIONS = Object.freeze({
  [PROFILES.CONSERVADOR]: Object.freeze({ risk: 'muito baixo' }),
  [PROFILES.PADRAO]: Object.freeze({ risk: 'baixo' }),
  [PROFILES.MAXIMO]: Object.freeze({ risk: 'moderado' }),
  [PROFILES.PERSONALIZADO]: Object.freeze({ risk: 'depende das opções selecionadas' }),
});

export const CONFIGURATION_SCHEMA_VERSIONS = Object.freeze({
  V2: 2,
  V3: 3,
});

export const V2_FILE_TYPE_VALUES = Object.freeze({
  CSS: 'CSS',
  JAVASCRIPT: 'JavaScript',
  CSS_AND_JAVASCRIPT: 'CSS+JavaScript',
});

export const V2_DEFAULT_FILE_TYPES = V2_FILE_TYPE_VALUES.CSS_AND_JAVASCRIPT;

export const V2_FILE_TYPES_BY_VALUE = Object.freeze({
  [V2_FILE_TYPE_VALUES.CSS]: Object.freeze(['css']),
  [V2_FILE_TYPE_VALUES.JAVASCRIPT]: Object.freeze(['javascript']),
  [V2_FILE_TYPE_VALUES.CSS_AND_JAVASCRIPT]: Object.freeze(['css', 'javascript']),
});
