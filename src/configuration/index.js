import { validateV2Configuration } from './v2.js';
import { ConfigurationError } from './errors.js';

export { ConfigurationError } from './errors.js';
export { parseV2Configuration, parseV2ConfigurationText, loadV2Configuration, serializeV2Configuration, writeV2Configuration, validateV2Configuration } from './v2.js';
export { identifyConfigurationSchema } from './schema.js';

const ADJUSTABLE_FIELDS = new Set(['outputMode']);

export function deriveEffectiveConfiguration(persistentConfiguration, adjustments = {}, options = {}) {
  if (!persistentConfiguration || typeof persistentConfiguration !== 'object') {
    throw new ConfigurationError('INVALID_PERSISTENT_CONFIGURATION', 'A configuração persistente deve ser um objeto normalizado.');
  }
  if (persistentConfiguration.schemaVersion !== 2) {
    throw new ConfigurationError('UNSUPPORTED_CONFIGURATION_SCHEMA', 'A configuração efetiva exige schemaVersion=2.');
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
  return validateV2Configuration(effective, options);
}
