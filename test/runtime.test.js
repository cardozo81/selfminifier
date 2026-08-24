import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { validateProjectDependencies } from '../src/runtime/dependencies.js';
import { bootstrapEnvironment } from '../src/runtime/environment.js';
import { loadRuntimePolicy, parseNodeVersion, validateNodeRuntimeVersion, validateRuntimePolicy, RuntimePolicyError } from '../src/runtime/policy.js';

const execFileAsync = promisify(execFile);

const policy = {
  formatVersion: 2,
  minimumMajor: 24,
  supportedMajorLines: [24, 25],
  preferredMajor: 24,
  preferredChannel: 'LTS',
  approvedAutomaticInstallVersion: '24.19.0',
  wingetPackage: 'OpenJS.NodeJS.LTS',
};

async function projectFixture({ dependency = true, dependencyEngine } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'selfminifier-runtime-'));
  const packageJson = { name: 'fixture', private: true, dependencies: { fixturedep: '1.2.3' } };
  const lockJson = {
    name: 'fixture', lockfileVersion: 3, requires: true,
    packages: { '': { dependencies: { fixturedep: '1.2.3' } }, 'node_modules/fixturedep': { version: '1.2.3' } },
  };
  await writeFile(join(root, 'package.json'), JSON.stringify(packageJson));
  await writeFile(join(root, 'package-lock.json'), JSON.stringify(lockJson));
  if (dependency) {
    await mkdir(join(root, 'node_modules', 'fixturedep'), { recursive: true });
    await writeFile(join(root, 'node_modules', 'fixturedep', 'package.json'), JSON.stringify({ name: 'fixturedep', version: '1.2.3', ...(dependencyEngine ? { engines: { node: dependencyEngine } } : {}) }));
  }
  return root;
}

function runtimeRunner({ version = 'v24.1.0', npmVersion = '10.0.0', winget = true } = {}) {
  const calls = [];
  const runner = async (command, args) => {
    calls.push([command, args]);
    if (command === 'where.exe') return { code: 0, stdout: 'C:\\nodejs\\node.exe\r\n', stderr: '' };
    if (command === 'C:\\nodejs\\node.exe' && args[0] === '--version') return { code: 0, stdout: `${version}\n`, stderr: '' };
    if (String(command).toLowerCase().endsWith('npm.cmd') && args[0] === '--version') return { code: 0, stdout: `${npmVersion}\n`, stderr: '' };
    if (command === 'winget.exe' && args[0] === '--version') return { code: winget ? 0 : 1, stdout: winget ? 'v1.0.0' : '', stderr: '' };
    if (command === 'winget.exe' && args[0] === 'install') return { code: 0, stdout: 'instalado', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  return { runner, calls };
}

test('política runtime aceita Node 24 e 25.8.2 e rejeita majors não suportadas ou versões malformadas', async () => {
  const loaded = await loadRuntimePolicy(join(process.cwd(), 'resources', 'runtime-policy.json'));
  assert.equal(loaded.minimumMajor, 24);
  assert.deepEqual(loaded.supportedMajorLines, [24, 25]);
  assert.equal(loaded.preferredMajor, 24);
  assert.equal(loaded.preferredChannel, 'LTS');
  assert.equal(loaded.approvedAutomaticInstallVersion, '24.19.0');
  assert.equal(validateNodeRuntimeVersion('v24.19.0', policy).valid, true);
  assert.equal(validateNodeRuntimeVersion('v25.8.2', policy).valid, true);
  assert.equal(validateNodeRuntimeVersion('v25.8.2', policy).preferred, false);
  assert.equal(validateNodeRuntimeVersion('v23.11.1', policy).valid, false);
  assert.equal(validateNodeRuntimeVersion('26.0.0', policy).valid, false);
  assert.equal(validateNodeRuntimeVersion('27.0.0', policy).valid, false);
  assert.throws(() => parseNodeVersion('v24'), (error) => error instanceof RuntimePolicyError && error.code === 'MALFORMED_NODE_VERSION');
  assert.throws(() => validateRuntimePolicy({ ...policy, preferredMajor: 26 }), (error) => error.code === 'INVALID_RUNTIME_POLICY');
  assert.throws(() => validateRuntimePolicy({ ...policy, supportedMajorLines: [24, 24] }), (error) => error.code === 'INVALID_RUNTIME_POLICY');
});

test('Node 25 compatível não aciona instalação automática da linha 24', async () => {
  const root = await projectFixture();
  try {
    const mock = runtimeRunner({ version: 'v25.8.2', winget: true });
    const result = await bootstrapEnvironment({ projectRoot: root, policy, commandRunner: mock.runner, authorizeNodeInstall: async () => { throw new Error('não deveria instalar Node 24'); } });
    assert.equal(result.ok, true);
    assert.equal(result.runtime.preferred, false);
    assert.match(result.message, /compatível/);
    assert.equal(mock.calls.some(([command]) => command === 'winget.exe'), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('dependências válidas são reconhecidas e inconsistência/ausência é reportada', async () => {
  const validRoot = await projectFixture();
  try { assert.equal((await validateProjectDependencies({ projectRoot: validRoot })).valid, true); } finally { await rm(validRoot, { recursive: true, force: true }); }
  const missingRoot = await projectFixture({ dependency: false });
  try {
    const result = await validateProjectDependencies({ projectRoot: missingRoot });
    assert.equal(result.valid, false);
    assert.equal(result.diagnostics[0].code, 'DEPENDENCY_MISSING');
    await writeFile(join(missingRoot, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies: {} } } }));
    const mismatch = await validateProjectDependencies({ projectRoot: missingRoot });
    assert.equal(mismatch.diagnostics[0].code, 'PACKAGE_LOCK_MISMATCH');
  } finally { await rm(missingRoot, { recursive: true, force: true }); }
});

test('bootstrap não executa npm ci quando ambiente e dependências já são válidos', async () => {
  const root = await projectFixture();
  try {
    const mock = runtimeRunner();
    const result = await bootstrapEnvironment({ projectRoot: root, policy, commandRunner: mock.runner, authorizeNodeInstall: async () => { throw new Error('não deveria instalar'); } });
    assert.equal(result.ok, true);
    assert.equal(result.installed, false);
    assert.equal(mock.calls.some(([, args]) => args[0] === 'ci'), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('bootstrap bloqueia dependência ausente sem executar npm ci ou install', async () => {
  const root = await projectFixture({ dependency: false });
  try {
    const mock = runtimeRunner();
    const result = await bootstrapEnvironment({ projectRoot: root, policy, commandRunner: mock.runner });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'DEPENDENCY_VALIDATION_FAILED');
    assert.match(result.message, /não instala dependências automaticamente/);
    assert.equal(mock.calls.some(([, args]) => ['ci', 'install'].includes(args[0])), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Node não homologado falha fechado e instalação autorizada valida versão real depois do winget', async () => {
  const root = await projectFixture();
  try {
    const rejected = runtimeRunner({ version: 'v26.0.0', winget: false });
    const blocked = await bootstrapEnvironment({ projectRoot: root, policy, commandRunner: rejected.runner, authorizeNodeInstall: async () => true });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.code, 'NODE_MAJOR_NOT_SUPPORTED');

    const install = runtimeRunner({ version: 'v26.0.0', winget: true });
    let nodeCalls = 0;
    const installRunner = async (command, args, options) => {
      if (command === 'C:\\nodejs\\node.exe' && args[0] === '--version') {
        nodeCalls += 1;
        return { code: 0, stdout: `${nodeCalls === 1 ? 'v26.0.0' : 'v24.19.0'}\n`, stderr: '' };
      }
      return install.runner(command, args, options);
    };
    const accepted = await bootstrapEnvironment({ projectRoot: root, policy, commandRunner: installRunner, authorizeNodeInstall: async () => true });
    assert.equal(accepted.ok, true);
    assert.equal(install.calls.some(([command, args]) => command === 'winget.exe' && args.includes('24.19.0')), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Executar.ps1 passa pelo parser PowerShell sem alterar política de execução', async (t) => {
  if (process.platform !== 'win32') { t.skip('validação PowerShell é específica do Windows'); return; }
  const scriptPath = join(process.cwd(), 'Executar.ps1');
  const escapedPath = scriptPath.replaceAll("'", "''");
  const command = `$tokens=$null; $errors=$null; [System.Management.Automation.Language.Parser]::ParseFile('${escapedPath}', [ref]$tokens, [ref]$errors); if ($errors.Count -gt 0) { exit 1 }`;
  await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true });
  const text = await readFile(scriptPath, 'utf8');
  assert.equal(/Set-ExecutionPolicy/i.test(text), false);
});

test('direct dependency engine validation accepts Node 25 when declared and blocks conflicts', async () => {
  const acceptedRoot = await projectFixture({ dependencyEngine: '^20.17.0 || >=22.9.0' });
  try {
    assert.equal((await validateProjectDependencies({ projectRoot: acceptedRoot, runtimeVersion: 'v25.8.2' })).valid, true);
  } finally { await rm(acceptedRoot, { recursive: true, force: true }); }
  const blockedRoot = await projectFixture({ dependencyEngine: '^24.0.0' });
  try {
    const result = await validateProjectDependencies({ projectRoot: blockedRoot, runtimeVersion: 'v25.8.2' });
    assert.equal(result.valid, false);
    assert.equal(result.diagnostics[0].code, 'DEPENDENCY_NODE_ENGINE_UNSUPPORTED');
  } finally { await rm(blockedRoot, { recursive: true, force: true }); }
});

test('ini 6.0.0 é a dependência direta exata e declara compatibilidade com Node 25', async () => {
  const manifest = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8'));
  const installed = JSON.parse(await readFile(join(process.cwd(), 'node_modules', 'ini', 'package.json'), 'utf8'));
  assert.equal(manifest.dependencies.ini, '6.0.0');
  assert.equal(installed.version, '6.0.0');
  assert.match(installed.engines.node, /\^20\.17\.0/);
  assert.match(installed.engines.node, />=22\.9\.0/);
});
