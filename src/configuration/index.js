import { parseConfigurationText } from './parse.js';
import { readUtf8File } from './utf8.js';
import { validateConfiguration } from './validate.js';
import { ConfigurationError } from './errors.js';

export { ConfigurationError } from './errors.js';
export { parseWithIniLibrary } from './parse.js';
export { validateConfiguration } from './validate.js';
export { parseV2Configuration, parseV2ConfigurationText, loadV2Configuration, serializeV2Configuration, writeV2Configuration, validateV2Configuration } from './v2.js';
export { identifyConfigurationSchema } from './schema.js';
export { assessLegacyConfiguration } from './legacy.js';

export function parseConfiguration(text, options = {}) {
  const parsed = parseConfigurationText(text);
  return validateConfiguration(parsed, options);
}

export async function loadConfiguration(filePath, options = {}) {
  return parseConfiguration(await readUtf8File(filePath), options);
}

const ADJUSTABLE_FIELDS = new Set([
  'outputMode',
  'engineId',
  'profile',
  'globalIncludes',
  'globalExcludes',
  'sources',
]);

export function deriveEffectiveConfiguration(persistentConfiguration, adjustments = {}, options = {}) {
  if (!persistentConfiguration || typeof persistentConfiguration !== 'object') {
    throw new ConfigurationError('INVALID_PERSISTENT_CONFIGURATION', 'A configuração persistente deve ser um objeto normalizado.');
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
  return validateConfiguration(effective, options);
}
