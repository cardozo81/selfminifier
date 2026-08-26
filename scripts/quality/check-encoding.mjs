import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import { TextDecoder } from 'node:util';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const IGNORED_DIRECTORIES = new Set(['.git', 'node_modules', 'dist', 'Dados', '_source_versions']);
const TEXT_EXTENSIONS = new Set([
  '.cmd',
  '.css',
  '.editorconfig',
  '.gitattributes',
  '.gitignore',
  '.html',
  '.ini',
  '.js',
  '.json',
  '.lock',
  '.mjs',
  '.md',
  '.ps1',
  '.txt',
  '.yaml',
  '.yml',
]);
const SPECIAL_TEXT_FILES = new Set(['.editorconfig', '.gitattributes', '.gitignore']);
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });
const MOJIBAKE_PATTERNS = Object.freeze([
  '\u00c3\u0192',
  '\u00c3\u201a',
  '\u00c3\u00a9',
  '\u00c3\u00a3',
  '\u00c3\u00a7',
  '\u00c3\u00a1',
  '\u00c3\u00b3',
  '\u00c3\u00ba',
  '\u00c3\u00ad',
  '\u00ef\u00bf\u00bd',
  '\u00e2\u20ac',
  '\u00e2\u20ac\u2122',
  '\u00e2\u20ac\u0153',
  '\u00e2\u20ac\u009d',
  '\ufffd',
]);
const MOJIBAKE_REGEXES = Object.freeze([
  /\u00C2[^\u0000-\u007F]/,
]);

function isTextCandidate(name) {
  return SPECIAL_TEXT_FILES.has(name) || TEXT_EXTENSIONS.has(extname(name).toLowerCase());
}

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(fullPath));
    else if (entry.isFile() && isTextCandidate(entry.name)) files.push(fullPath);
  }
  return files;
}

export function validateTextContent(text, filePath = '<memória>') {
  for (const pattern of MOJIBAKE_PATTERNS) {
    if (text.includes(pattern)) {
      throw new Error(`Mojibake confirmado em ${filePath}: sequência '${pattern}'.`);
    }
  }
  for (const regex of MOJIBAKE_REGEXES) {
    if (regex.test(text)) {
      throw new Error(`Mojibake confirmado em ${filePath}: 'Â' seguido de caractere não ASCII.`);
    }
  }
}

function validateCmdCrlf(bytes, filePath) {
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] === 0x0A && (index === 0 || bytes[index - 1] !== 0x0D)) {
      throw new Error(`Fim de linha sem CRLF em ${filePath}: LF isolado no byte ${index}.`);
    }
  }
}

export async function validateFile(filePath) {
  const bytes = await readFile(filePath);
  if (extname(filePath).toLowerCase() === '.cmd') {
    validateCmdCrlf(bytes, filePath);
  }
  let text;
  try {
    text = UTF8_DECODER.decode(bytes);
  } catch (error) {
    throw new Error(`UTF-8 inválido em ${filePath}.`, { cause: error });
  }
  validateTextContent(text, filePath);
}

export async function run(root = ROOT) {
  const files = await walk(root);
  const failures = [];
  for (const filePath of files) {
    try {
      await validateFile(filePath);
    } catch (error) {
      failures.push(error.message);
    }
  }
  if (failures.length > 0) {
    throw new Error(failures.join('\n'));
  }
  return files.map((filePath) => relative(root, filePath));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().then((files) => {
    console.log(`Validação de UTF-8 concluída: ${files.length} arquivos textuais.`);
  }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
