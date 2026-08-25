import { ConfigurationError } from './errors.js';

const SECTION_PATTERN = /^\[([^\]]+)\]$/;
const KEY_PATTERN = /^([A-Za-z][A-Za-z0-9]*)=(.*)$/;

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
