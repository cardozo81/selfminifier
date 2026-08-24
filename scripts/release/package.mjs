import { copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePackageLock, validateProjectDependencies } from '../../src/runtime/dependencies.js';
import { loadRuntimePolicy, validateNodeRuntimeVersion } from '../../src/runtime/policy.js';
import { loadApplicationMetadata } from '../../src/runtime/version.js';
import { validateFile } from '../quality/check-encoding.mjs';

const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXED_FILES = Object.freeze([
  'Executar.cmd',
  'Executar.ps1',
  'package.json',
  'package-lock.json',
  'LEIA-ME.txt',
  'Configuracao/configuracao.ini.example',
  'Documentacao/Gerada/Manual-Usuario/index.html',
  'Documentacao/Gerada/Manual-Tecnico/index.html',
]);
const ALLOWED_TREES = Object.freeze([
  { path: 'src', extensions: new Set(['.js', '.mjs', '.ps1']) },
  { path: 'resources', extensions: new Set(['.json']) },
]);
const FORBIDDEN_PARTS = new Set(['.git', '.github', '_ias', 'Especificacoes', 'test', 'tests', 'fixtures', 'dist', 'Dados', '_source_versions']);
const TEXT_EXTENSIONS = new Set(['.cmd', '.css', '.html', '.ini', '.js', '.json', '.lock', '.mjs', '.ps1', '.txt']);
const REPRESENTATIVE_TERMS = Object.freeze(['configuração', 'minificação', 'execução', 'usuário', 'não', 'restauração', 'relatório']);
const LOCAL_MACHINE_CONTENT = /(?:[A-Za-z]:\\(?:Users|IA-PROJETOS)\\|OneDrive\\|(?:ghp_|github_pat_|sk-)[A-Za-z0-9_-]+)/i;
const SENSITIVE_ASSIGNMENT = /(?:password|token|secret)\s*=/i;
const execFileAsync = promisify(execFile);

function slash(value) { return value.split(sep).join('/'); }
function extension(name) { const index = name.lastIndexOf('.'); return index < 0 ? '' : name.slice(index).toLowerCase(); }
async function regularFile(path) { const stats = await lstat(path); if (!stats.isFile() || stats.isSymbolicLink()) throw new Error(`Arquivo não regular ou link proibido: ${path}.`); }

function normalizeCmdBytes(text) {
  return text.replace(/\r?\n/g, '\r\n');
}

async function copyReleaseFile(source, destination, relativePath) {
  await mkdir(dirname(destination), { recursive: true });
  if (extension(relativePath) === '.cmd') {
    await writeFile(destination, normalizeCmdBytes(await readFile(source, 'utf8')), { encoding: 'utf8' });
    return;
  }
  await copyFile(source, destination);
}

function validateCmdCrLfBytes(bytes, label) {
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] === 0x0A && (index === 0 || bytes[index - 1] !== 0x0D)) throw new Error(`${label} deve usar exclusivamente finais de linha CRLF.`);
  }
  if (!bytes.includes(0x0A)) throw new Error(`${label} não contém linhas validáveis.`);
}

async function runCleanNpmCi(stagingRoot) {
  const command = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : 'npm';
  const args = process.platform === 'win32'
    ? ['/d', '/s', '/c', 'npm.cmd ci --omit=dev --no-audit --no-fund']
    : ['ci', '--omit=dev', '--no-audit', '--no-fund'];
  try {
    await execFileAsync(command, args, { cwd: stagingRoot, windowsHide: true, timeout: 600000, maxBuffer: 4 * 1024 * 1024 });
  } catch (cause) {
    throw new Error(`A instalação limpa das dependências de runtime falhou: ${cause.stderr ?? cause.message}.`, { cause });
  }
}

export async function stageRuntimeDependencies(projectRoot, packageRoot, { install = runCleanNpmCi } = {}) {
  const stagingRoot = await mkdtemp(join(tmpdir(), 'SelfMinifier runtime dependencies '));
  try {
    await copyFile(join(projectRoot, 'package.json'), join(stagingRoot, 'package.json'));
    await copyFile(join(projectRoot, 'package-lock.json'), join(stagingRoot, 'package-lock.json'));
    await install(stagingRoot);
    const staged = await validateProjectDependencies({ projectRoot: stagingRoot });
    if (!staged.valid) throw new Error(`A instalação limpa não produziu dependências válidas: ${JSON.stringify(staged.diagnostics)}.`);
    await cp(join(stagingRoot, 'node_modules'), join(packageRoot, 'node_modules'), { recursive: true, force: false, errorOnExist: true });
  } finally {
    await rm(stagingRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function walk(directory, root = directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Link proibido no conteúdo do pacote: ${path}.`);
    if (entry.isDirectory()) files.push(...await walk(path, root));
    else if (entry.isFile()) files.push(slash(relative(root, path)));
  }
  return files.sort();
}

export async function getPackageMetadata(projectRoot = scriptRoot) {
  const { version } = await loadApplicationMetadata(projectRoot);
  const packageName = `SelfMinifier-${version}`;
  return Object.freeze({
    version,
    packageName,
    distRoot: resolve(projectRoot, 'dist'),
    packageRoot: resolve(projectRoot, 'dist', packageName),
    zipPath: resolve(projectRoot, 'dist', `${packageName}.zip`),
    checksumPath: resolve(projectRoot, 'dist', `${packageName}.zip.sha256`),
  });
}

export function assertSafeDistTarget(projectRoot, target, expectedName) {
  const distRoot = resolve(projectRoot, 'dist');
  const resolved = resolve(target);
  const expected = resolve(distRoot, expectedName);
  if (resolved !== expected || dirname(resolved) !== distRoot) throw new Error(`Destino de limpeza fora do escopo permitido: ${resolved}.`);
  return resolved;
}

export async function collectAllowedFiles(projectRoot = scriptRoot) {
  const files = [...FIXED_FILES];
  for (const tree of ALLOWED_TREES) {
    const root = join(projectRoot, tree.path);
    for (const file of await walk(root)) if (tree.extensions.has(extension(file))) files.push(`${tree.path}/${file}`);
  }
  for (const file of files) await regularFile(join(projectRoot, ...file.split('/')));
  return [...new Set(files)].sort();
}

function forbidden(relativePath) {
  const parts = relativePath.split('/');
  return parts.some((part) => FORBIDDEN_PARTS.has(part))
    || relativePath === 'Configuracao/configuracao.ini'
    || /(?:^|\/)configuracao\.ini$/i.test(relativePath)
    || /(?:^|\/).+\.(?:log|tmp)$/i.test(relativePath);
}

async function validatePackagedText(packageRoot, files) {
  const texts = [];
  for (const file of files) {
    if (!TEXT_EXTENSIONS.has(extension(file))) continue;
    const path = join(packageRoot, ...file.split('/'));
    await validateFile(path);
    const text = await readFile(path, 'utf8');
    if (LOCAL_MACHINE_CONTENT.test(text) || (!file.startsWith('node_modules/') && SENSITIVE_ASSIGNMENT.test(text))) throw new Error(`Conteúdo local ou credencial proibida no pacote: ${file}.`);
    texts.push(text);
  }
  const combined = texts.join('\n');
  for (const term of REPRESENTATIVE_TERMS) {
    if (!combined.includes(term)) throw new Error(`Termo pt-BR obrigatório ausente no pacote: ${term}.`);
  }
}

async function validatePackagedRuntimeDependencies(packageRoot) {
  const dependencyValidation = await validateProjectDependencies({ projectRoot: packageRoot });
  if (!dependencyValidation.valid) throw new Error(`Dependências de runtime ausentes ou inválidas no pacote: ${JSON.stringify(dependencyValidation.diagnostics)}.`);
  const actualFiles = await walk(join(packageRoot, 'node_modules'));
  if (actualFiles.length === 0) throw new Error('A árvore limpa de dependências de runtime está vazia.');
  const lockedRoots = Object.keys(dependencyValidation.lockJson.packages ?? {}).filter((key) => key.startsWith('node_modules/'));
  for (const file of actualFiles) {
    const packagedPath = `node_modules/${file}`;
    if (file === '.package-lock.json' || file.startsWith('.bin/')) continue;
    if (!lockedRoots.some((root) => packagedPath === root || packagedPath.startsWith(`${root}/`))) {
      throw new Error(`Arquivo de dependência fora do lockfile: ${packagedPath}.`);
    }
  }
  const validationSource = `import esbuild from 'esbuild'; const result = await esbuild.transform('const valor = 1;', { loader: 'js', minify: true }); if (esbuild.version !== ${JSON.stringify(dependencyValidation.packageJson.dependencies.esbuild)} || !result.code) process.exit(1);`;
  try {
    await execFileAsync(process.execPath, ['--input-type=module', '--eval', validationSource], { cwd: packageRoot, windowsHide: true, timeout: 30000 });
  } catch (cause) {
    throw new Error('O runtime empacotado do esbuild não foi validado.', { cause });
  }
  return { dependencyValidation, files: actualFiles };
}

export async function validatePackagedTree({ projectRoot = scriptRoot, packageRoot, version } = {}) {
  const metadata = await getPackageMetadata(projectRoot);
  if (version !== metadata.version || resolve(packageRoot) !== metadata.packageRoot) throw new Error('A versão ou raiz do pacote não corresponde ao package.json.');
  const expected = await collectAllowedFiles(projectRoot);
  const actual = await walk(packageRoot);
  for (const required of expected) if (!actual.includes(required)) throw new Error(`Arquivo obrigatório ausente no pacote: ${required}.`);
  for (const file of actual) {
    if (forbidden(file)) throw new Error(`Conteúdo proibido no pacote: ${file}.`);
    if (!expected.includes(file) && !file.startsWith('node_modules/')) throw new Error(`Conteúdo fora da allowlist no pacote: ${file}.`);
  }
  validateCmdCrLfBytes(await readFile(join(packageRoot, 'Executar.cmd')), 'Executar.cmd empacotado');
  await validatePackagedText(packageRoot, actual);
  const packagedLock = await validatePackageLock({ projectRoot: packageRoot });
  if (!packagedLock.valid) throw new Error(`Package/lock inválido no pacote: ${JSON.stringify(packagedLock.diagnostics)}.`);
  if (packagedLock.packageJson.version !== version || packagedLock.lockJson.packages?.['']?.version !== version) throw new Error('Versão divergente entre pacote, package.json e package-lock.json.');
  await validatePackagedRuntimeDependencies(packageRoot);
  return { valid: true, files: actual, metadata };
}

export async function assemblePackage(projectRoot = scriptRoot, options = {}) {
  const metadata = await getPackageMetadata(projectRoot);
  assertSafeDistTarget(projectRoot, metadata.packageRoot, metadata.packageName);
  assertSafeDistTarget(projectRoot, metadata.zipPath, `${metadata.packageName}.zip`);
  assertSafeDistTarget(projectRoot, metadata.checksumPath, `${metadata.packageName}.zip.sha256`);
  await mkdir(metadata.distRoot, { recursive: true });
  await rm(metadata.packageRoot, { recursive: true, force: true });
  await rm(metadata.zipPath, { force: true });
  await rm(metadata.checksumPath, { force: true });
  for (const file of await collectAllowedFiles(projectRoot)) {
    const source = join(projectRoot, ...file.split('/'));
    const destination = join(metadata.packageRoot, ...file.split('/'));
    await copyReleaseFile(source, destination, file);
  }
  await stageRuntimeDependencies(projectRoot, metadata.packageRoot, options);
  await validatePackagedTree({ projectRoot, packageRoot: metadata.packageRoot, version: metadata.version });
  return metadata;
}

export async function validatePackagingManifests(projectRoot = scriptRoot) {
  const metadata = await getPackageMetadata(projectRoot);
  const lock = await validatePackageLock({ projectRoot });
  if (!lock.valid) throw new Error(`package.json/package-lock.json inválidos ou divergentes: ${JSON.stringify(lock.diagnostics)}.`);
  if (lock.packageJson.version !== metadata.version || lock.lockJson.packages?.['']?.version !== metadata.version) throw new Error('Versão divergente entre package.json e package-lock.json.');
  const policy = await loadRuntimePolicy(join(projectRoot, 'resources', 'runtime-policy.json'));
  const runtime = validateNodeRuntimeVersion(process.version, policy);
  if (!runtime.valid) throw new Error(runtime.message);
  return { valid: true, metadata, runtime, packageJson: lock.packageJson, lockJson: lock.lockJson };
}

export async function validatePackagingEnvironment(projectRoot = scriptRoot) {
  const metadata = await getPackageMetadata(projectRoot);
  const dependencies = await validateProjectDependencies({ projectRoot });
  if (!dependencies.valid) throw new Error(`Dependências locais ou package/lock inválidos: ${JSON.stringify(dependencies.diagnostics)}.`);
  if (dependencies.packageJson.version !== metadata.version || dependencies.lockJson.packages?.['']?.version !== metadata.version) throw new Error('Versão divergente entre package.json e package-lock.json.');
  const policy = await loadRuntimePolicy(join(projectRoot, 'resources', 'runtime-policy.json'));
  const runtime = validateNodeRuntimeVersion(process.version, policy);
  if (!runtime.valid) throw new Error(runtime.message);
  return { valid: true, metadata, runtime };
}

async function main() {
  const command = process.argv[2];
  const projectRoot = process.argv[3] ? resolve(process.argv[3]) : scriptRoot;
  if (command === 'info') return getPackageMetadata(projectRoot);
  if (command === 'validate-manifests') return validatePackagingManifests(projectRoot);
  if (command === 'validate-dependencies') {
    const result = await validateProjectDependencies({ projectRoot });
    if (!result.valid) process.exitCode = 2;
    return { valid: result.valid, diagnostics: result.diagnostics ?? [] };
  }
  if (command === 'validate-project') return validatePackagingEnvironment(projectRoot);
  if (command === 'assemble') return assemblePackage(projectRoot);
  if (command === 'validate-package') {
    const metadata = await getPackageMetadata(projectRoot);
    return validatePackagedTree({ projectRoot, packageRoot: metadata.packageRoot, version: metadata.version });
  }
  throw new Error('Comando de empacotamento inválido.');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then((result) => console.log(JSON.stringify(result))).catch((error) => { console.error(`Empacotamento bloqueado: ${error.message}`); process.exitCode = 1; });
}
