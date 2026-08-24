import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { validateProjectDependencies } from './dependencies.js';
import { loadRuntimePolicy, validateNodeRuntimeVersion } from './policy.js';

const execFileAsync = promisify(execFile);

export async function defaultCommandRunner(command, args = [], options = {}) {
  try {
    const isWindowsCommandScript = process.platform === 'win32' && /\.cmd$/i.test(command);
    const executable = isWindowsCommandScript ? (process.env.ComSpec ?? 'cmd.exe') : command;
    const executableArgs = isWindowsCommandScript
      ? ['/d', '/c', [command, ...args].map((argument) => String(argument)).join(' ')]
      : args;
    const result = await execFileAsync(executable, executableArgs, { cwd: options.cwd, windowsHide: true, timeout: options.timeout ?? 120000, maxBuffer: 1024 * 1024 });
    return { code: 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  } catch (error) {
    return { code: typeof error.code === 'number' ? error.code : 1, stdout: error.stdout ?? '', stderr: error.stderr ?? error.message ?? '' };
  }
}

function parseNpmVersion(version) {
  return /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(String(version).trim());
}

async function validatePackagedRuntimeCapabilities({ projectRoot, dependencies, runtime, commandRunner }) {
  const expectedEsbuildVersion = dependencies.packageJson?.dependencies?.esbuild;
  if (!expectedEsbuildVersion) return { valid: true };
  const probeSource = `import * as esbuild from 'esbuild'; const result = await esbuild.transform('const valor = 1;', { loader: 'js', minify: true }); if (esbuild.version !== ${JSON.stringify(expectedEsbuildVersion)} || !result.code) process.exit(2);`;
  const probe = await commandRunner(runtime.nodeCommand, ['--input-type=module', '--eval', probeSource], { cwd: projectRoot, timeout: 30000 });
  if (probe.code !== 0) {
    return {
      valid: false,
      code: 'PACKAGED_RUNTIME_INVALID',
      message: 'O runtime interno do esbuild empacotado está ausente, corrompido ou incompatível. Reextraia uma distribuição íntegra do SelfMinifier.',
      probe,
    };
  }
  return { valid: true };
}

async function discoverNode(commandRunner) {
  const where = await commandRunner('where.exe', ['node.exe']);
  const candidates = where.code === 0 ? where.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) : [];
  if (process.platform === 'win32') {
    if (process.env.ProgramFiles) candidates.push(join(process.env.ProgramFiles, 'nodejs', 'node.exe'));
    if (process.env.LOCALAPPDATA) candidates.push(join(process.env.LOCALAPPDATA, 'Programs', 'nodejs', 'node.exe'));
  }
  candidates.push('node.exe');
  for (const nodeCommand of [...new Set(candidates)]) {
    const result = await commandRunner(nodeCommand, ['--version']);
    if (result.code === 0) return { command: nodeCommand, versionOutput: result.stdout.trim() };
  }
  return null;
}

async function validateNodeAndNpm(commandRunner, policy) {
  const node = await discoverNode(commandRunner);
  if (!node) return { valid: false, code: 'NODE_NOT_FOUND', message: 'Node.js não foi encontrado no PATH após a redescoberta.' };
  let runtime;
  try { runtime = validateNodeRuntimeVersion(node.versionOutput, policy); } catch (error) {
    return { valid: false, code: error.code, message: error.message, nodeCommand: node.command };
  }
  if (!runtime.valid) return { valid: false, code: runtime.code, message: runtime.message, nodeCommand: node.command, version: runtime.version };
  const npmCandidates = ['npm.cmd'];
  let npm = null;
  for (const npmCommand of [...new Set(npmCandidates)]) {
    const result = await commandRunner(npmCommand, ['--version']);
    if (result.code === 0 && parseNpmVersion(result.stdout)) { npm = { command: npmCommand, version: result.stdout.trim() }; break; }
  }
  if (!npm) return { valid: false, code: 'NPM_INVALID', message: 'npm.cmd não foi encontrado ou sua versão não pôde ser validada.', nodeCommand: node.command, version: runtime.version };
  return { valid: true, nodeCommand: node.command, version: runtime.version, preferred: runtime.preferred, channel: runtime.channel, message: runtime.message, npmCommand: npm.command, npmVersion: npm.version };
}

export async function bootstrapEnvironment({
  projectRoot = process.cwd(),
  policy,
  policyPath,
  commandRunner = defaultCommandRunner,
  authorizeNodeInstall = async () => false,
} = {}) {
  const runtimePolicy = policy ?? await loadRuntimePolicy(policyPath ?? join(projectRoot, 'resources', 'runtime-policy.json'));
  let runtime = await validateNodeAndNpm(commandRunner, runtimePolicy);
  if (!runtime.valid) {
    const winget = await commandRunner('winget.exe', ['--version']);
    if (winget.code !== 0 || !(await authorizeNodeInstall({ policy: runtimePolicy, reason: runtime }))) {
      return { ok: false, code: runtime.code, message: `${runtime.message} Instalação automática não autorizada ou indisponível. Instale manualmente Node.js ${runtimePolicy.approvedAutomaticInstallVersion} (LTS) e tente novamente.`, runtime };
    }
    const install = await commandRunner('winget.exe', ['install', '--id', runtimePolicy.wingetPackage, '--version', runtimePolicy.approvedAutomaticInstallVersion, '--exact', '--accept-source-agreements', '--accept-package-agreements'], { timeout: 600000 });
    if (install.code !== 0) return { ok: false, code: 'NODE_INSTALL_FAILED', message: 'A instalação autorizada do Node.js falhou; o resultado não foi aceito pelo bootstrap.', install };
    runtime = await validateNodeAndNpm(commandRunner, runtimePolicy);
    if (!runtime.valid) return { ok: false, code: runtime.code, message: `O Node.js instalado não passou na validação: ${runtime.message}`, runtime };
  }
  let dependencies = await validateProjectDependencies({ projectRoot });
  if (!dependencies.valid) {
    return {
      ok: false,
      code: 'DEPENDENCY_VALIDATION_FAILED',
      message: 'As dependências internas do pacote estão ausentes ou inconsistentes. Reextraia uma distribuição íntegra do SelfMinifier; a inicialização normal não instala dependências automaticamente.',
      runtime,
      dependencies,
    };
  }
  const packagedRuntime = await validatePackagedRuntimeCapabilities({ projectRoot, dependencies, runtime, commandRunner });
  if (!packagedRuntime.valid) return { ok: false, ...packagedRuntime, runtime, dependencies };
  return { ok: true, runtime, dependencies, installed: false, message: runtime.message };
}
