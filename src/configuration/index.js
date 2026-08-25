import { CONFIGURATION_SCHEMA_VERSIONS } from '../domain/index.js';
import { ConfigurationError } from './errors.js';
import { identifyConfigurationSchema } from './schema.js';
import { readUtf8File } from './utf8.js';
import { parseV2Configuration, validateV2Configuration } from './v2.js';
import { parseV3Configuration } from './v3.js';

export { ConfigurationError } from './errors.js';
export { parseV2Configuration, parseV2ConfigurationText, loadV2Configuration, serializeV2Configuration, writeV2Configuration, validateV2Configuration } from './v2.js';
export { loadV3Configuration, parseV3Configuration, parseV3ConfigurationText, serializeV3Configuration, validateV3Configuration, writeV3Configuration } from './v3.js';
export { normalizeBackupRootValue, resolveEffectiveBackupRoot, validateExternalBackupRoot } from './backup-root.js';
export { identifyConfigurationSchema } from './schema.js';

const ADJUSTABLE_FIELDS = new Set(['outputMode']);

export async function loadConfiguration(filePath, options = {}) {
  const text = await readUtf8File(filePath);
  const schema = identifyConfigurationSchema(text);
  const configuration = schema.schemaVersion === CONFIGURATION_SCHEMA_VERSIONS.V2
    ? parseV2Configuration(text, options)
    : await parseV3Configuration(text, options);
  return { schema, configuration };
}

export function deriveEffectiveConfiguration(persistentConfiguration, adjustments = {}, options = {}) {
  if (!persistentConfiguration || typeof persistentConfiguration !== 'object') {
    throw new ConfigurationError('INVALID_PERSISTENT_CONFIGURATION', 'A configuração persistente deve ser um objeto normalizado.');
  }
  if (![CONFIGURATION_SCHEMA_VERSIONS.V2, CONFIGURATION_SCHEMA_VERSIONS.V3].includes(persistentConfiguration.schemaVersion)) {
    throw new ConfigurationError('UNSUPPORTED_CONFIGURATION_SCHEMA', 'A configuração efetiva exige schemaVersion=2 ou schemaVersion=3.');
  }
  for (const key of Object.keys(adjustments)) {
    if (!ADJUSTABLE_FIELDS.has(key)) {
      throw new ConfigurationError('UNSUPPORTED_TEMPORARY_FIELD', `O ajuste temporário '${key}' não é permitido.`);
    }
  }

  const effective = structuredClone(persistentConfiguration);
  for (const key of ADJUSTABLE_FIELDS) {
    if (Object.hasOwn(adjustments, key)) effective[key] = structuredClone(adjustments[key]);
  }
  const base = validateV2Configuration(effective, options);
  if (persistentConfiguration.schemaVersion === CONFIGURATION_SCHEMA_VERSIONS.V2) return base;
  if (!Object.hasOwn(persistentConfiguration, 'backupRoot') || (persistentConfiguration.backupRoot !== null && typeof persistentConfiguration.backupRoot !== 'string')) {
    throw new ConfigurationError('INVALID_V3_CONFIGURATION', 'A configuração V3 normalizada exige backupRoot como caminho absoluto ou null.');
  }
  return { ...base, schemaVersion: CONFIGURATION_SCHEMA_VERSIONS.V3, backupRoot: persistentConfiguration.backupRoot };
}
