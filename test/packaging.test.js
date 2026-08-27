import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assemblePackage, assertSafeDistTarget, collectAllowedFiles, getPackageMetadata, validatePackagedTree } from '../scripts/release/package.mjs';

const execFileAsync = promisify(execFile);
const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

function createChildEnvironment(overrides = {}) {
  const env = { ...process.env, ...overrides };
  if (typeof env.PSModulePath === 'string') env.PSModulePath = env.PSModulePath.split(';').filter((entry) => !/\\\.cache\\codex-runtimes\\/i.test(entry)).join(';');
  return env;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'SelfMinifier 13C package '));
  for (const file of await collectAllowedFiles(projectRoot)) {
    const source = join(projectRoot, ...file.split('/'));
    const destination = join(root, ...file.split('/'));
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
  }
  return root;
}

function runProcess(file, args, { cwd, input = '', env = {}, shell = false } = {}) {
  return new Promise((resolveProcess, reject) => {
    const child = spawn(file, args, { cwd, windowsHide: true, env: createChildEnvironment(env), shell });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => resolveProcess({ code, stdout, stderr }));
    if (input) child.stdin.end(input);
  });
}

test('nomes de artefato derivam da versão e allowlist contém somente runtime necessário', async () => {
  const metadata = await getPackageMetadata(projectRoot);
  assert.equal(metadata.version, '0.2.1');
  assert.equal(metadata.packageName, 'SelfMinifier-0.2.1');
  assert.match(metadata.zipPath, /SelfMinifier-0\.2\.1\.zip$/);
  const files = await collectAllowedFiles(projectRoot);
  for (const required of ['Executar.cmd', 'Executar.ps1', 'LEIA-ME.txt', 'src/app/ui.ps1', 'resources/runtime-policy.json', 'Configuracao/configuracao.ini.example', 'Documentacao/Gerada/Manual-Usuario/index.html']) assert.ok(files.includes(required));
  assert.equal(files.some((file) => /^(?:test|Especificacoes|_ias|node_modules|Dados|_source_versions)\//.test(file)), false);
  assert.equal(files.includes('Configuracao/configuracao.ini'), false);
  const launcher = await readFile(join(projectRoot, 'Executar.cmd'), 'utf8');
  assert.match(launcher, /%~dp0Executar\.ps1/i);
  assert.match(launcher, /powershell\.exe -NoProfile -File/i);
  assert.doesNotMatch(launcher, /ExecutionPolicy\s+Bypass/i);
  assert.match(launcher, /if \/I "%PSPOLICY%"=="Restricted"/i);
  assert.match(launcher, /set "EXITCODE=1"[\s\S]*goto :failure/i);
  assert.match(launcher, /Manual-Usuario\\index\.html/i);
  assert.doesNotMatch(launcher, /[A-Za-z]:\\(?:Users|IA-PROJETOS)\\/i);
  assert.match(launcher, /chcp\s+65001/i);
  assert.doesNotMatch(launcher, /pol├¡tica|execu├º├úo|n├úo/i);
  const powershellBytes = await readFile(join(projectRoot, 'Executar.ps1'));
  assert.deepEqual([...powershellBytes.subarray(0, 3)], [0xEF, 0xBB, 0xBF]);
  const readme = await readFile(join(projectRoot, 'LEIA-ME.txt'), 'utf8');
  for (const guidance of ['Executar.cmd', 'configuracao.ini.example', 'Ajustar somente esta execução', 'Dados\\Relatorios']) assert.match(readme, new RegExp(guidance.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('montagem valida documentação e falha com obrigatório ausente ou proibido presente', async () => {
  const root = await fixture();
  try {
    const metadata = await assemblePackage(root);
    assert.equal((await validatePackagedTree({ projectRoot: root, packageRoot: metadata.packageRoot, version: metadata.version })).valid, true);
    await rm(join(metadata.packageRoot, 'Executar.ps1'));
    await assert.rejects(validatePackagedTree({ projectRoot: root, packageRoot: metadata.packageRoot, version: metadata.version }), /obrigatório ausente/);
    await copyFile(join(root, 'Executar.ps1'), join(metadata.packageRoot, 'Executar.ps1'));
    await mkdir(join(metadata.packageRoot, 'Configuracao'), { recursive: true });
    await writeFile(join(metadata.packageRoot, 'Configuracao', 'configuracao.ini'), 'pessoal=true', 'utf8');
    await assert.rejects(validatePackagedTree({ projectRoot: root, packageRoot: metadata.packageRoot, version: metadata.version }), /proibido|allowlist/);
    await rm(join(metadata.packageRoot, 'Configuracao', 'configuracao.ini'));
    await writeFile(join(metadata.packageRoot, 'LEIA-ME.txt'), 'C:\\Users\\pessoa\\segredo', 'utf8');
    await assert.rejects(validatePackagedTree({ projectRoot: root, packageRoot: metadata.packageRoot, version: metadata.version }), /Conteúdo local/);
    await copyFile(join(root, 'LEIA-ME.txt'), join(metadata.packageRoot, 'LEIA-ME.txt'));
    await writeFile(join(metadata.packageRoot, 'LEIA-ME.txt'), `configuração minificação execução usuário não restauração relatório ${String.fromCharCode(0xC3, 0xA7)}`, 'utf8');
    await assert.rejects(validatePackagedTree({ projectRoot: root, packageRoot: metadata.packageRoot, version: metadata.version }), /Mojibake confirmado/);
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test('pacote isolado resolve versão e inicia fora do repositório em caminho com espaços', async () => {
  const root = await fixture();
  const cwd = await mkdtemp(join(tmpdir(), 'SelfMinifier 13C cwd '));
  const failureRoot = await mkdtemp(join(tmpdir(), 'SelfMinifier 13C failure '));
  try {
    const metadata = await assemblePackage(root);
    assert.equal((await readFile(join(metadata.packageRoot, 'node_modules', 'esbuild', 'package.json'), 'utf8')).includes('0.28.2'), true);
    const cmdBytes = await readFile(join(metadata.packageRoot, 'Executar.cmd'));
    for (let index = 0; index < cmdBytes.length; index += 1) if (cmdBytes[index] === 0x0A) assert.equal(cmdBytes[index - 1], 0x0D);
    const npmLogPath = join(cwd, 'npm-invocations.log');
    await writeFile(join(cwd, 'npm.cmd'), `@echo off\r\necho %*>>"${npmLogPath}"\r\nif "%1"=="--version" echo 11.11.0\r\n`, 'utf8');
    const cmdPath = join(metadata.packageRoot, 'Executar.cmd');
    const powershell = 'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
    const policyResult = await execFileAsync(powershell, ['-NoProfile', '-NonInteractive', '-Command', 'Get-ExecutionPolicy'], { env: createChildEnvironment() });
    const hostPolicy = policyResult.stdout.trim();
    const cmdStartup = await runProcess(`"${cmdPath}"`, [], { cwd, input: '0\r\n', shell: true });
    if (/^Restricted$/i.test(hostPolicy)) {
      assert.equal(cmdStartup.code, 1, `${cmdStartup.stdout}\n${cmdStartup.stderr}`);
      assert.match(cmdStartup.stdout, /pol.tica de execu..o do Windows PowerShell n.o permite executar scripts locais/i);
    } else {
      assert.equal(cmdStartup.code, 0, `${cmdStartup.stdout}\n${cmdStartup.stderr}`);
      assert.equal((cmdStartup.stdout.match(/SELFMINIFIER v0\.2\.1\b/g) ?? []).length, 1, `${cmdStartup.stdout}\n${cmdStartup.stderr}`);
    }
    assert.doesNotMatch(cmdStartup.stdout, /tlocal|não é reconhecido como um comando/i);
    let npmInvocations = [];
    try { npmInvocations = (await readFile(npmLogPath, 'utf8')).split(/\r?\n/).filter(Boolean); } catch { /* host Restricted blocks before npm discovery */ }
    assert.deepEqual(npmInvocations, /^Restricted$/i.test(hostPolicy) ? [] : ['--version']);
    if (/^Restricted$/i.test(hostPolicy)) {
      const restricted = await runProcess(`"${cmdPath}"`, [], { cwd, input: '\r\n', shell: true });
      assert.equal(restricted.code, 1);
      assert.match(restricted.stdout, /política de execução do Windows PowerShell não permite executar scripts locais/i);
      assert.match(restricted.stdout, /Manual-Usuario\\index\.html/i);
      assert.doesNotMatch(restricted.stdout, /tlocal|não é reconhecido como um comando/i);
    }
    const request = await runProcess(process.execPath, [join(metadata.packageRoot, 'src', 'app', 'bridge.mjs'), '--bridge'], { cwd, input: '{"command":"version"}' });
    assert.equal(request.code, 0);
    assert.equal(JSON.parse(request.stdout).version, '0.2.1');
    if (/^Restricted$/i.test(hostPolicy)) return;
    const startup = await runProcess(powershell, ['-NoProfile', '-ExecutionPolicy', 'RemoteSigned', '-File', join(metadata.packageRoot, 'Executar.ps1')], { cwd, input: '0\r\n' });
    assert.equal(startup.code, 0);
    assert.equal((startup.stdout.match(/SELFMINIFIER v0\.2\.1\b/g) ?? []).length, 1);
    assert.match(startup.stdout, /CONFIGURAÇÃO NECESSÁRIA/);
    assert.match(startup.stdout, /Criar configuração inicial/);
    assert.doesNotMatch(startup.stdout, /1\. Minificar projeto/);
    const powershellMojibake = String.fromCharCode(0x00C3, 0x0192, 0x00C2, 0x00A0);
    assert.doesNotMatch(`${startup.stdout}${startup.stderr}`, new RegExp(powershellMojibake));
    const bridgePath = join(metadata.packageRoot, 'src', 'app', 'bridge.mjs');
    const requestBridge = async (request) => runProcess(process.execPath, [bridgePath, '--bridge'], { cwd, input: JSON.stringify(request) });
    const projectDirectory = join(cwd, 'projeto');
    await mkdir(projectDirectory, { recursive: true });
    const created = JSON.parse((await requestBridge({ command: 'create-configuration', projectRoot: projectDirectory, confirmed: true })).stdout);
    assert.equal(created.ok, true);
    assert.equal(created.configurationPath, join(metadata.packageRoot, 'Configuracao', 'configuracao.ini'));
    assert.equal(await (async () => { try { await readFile(join(metadata.packageRoot, 'src', 'app', 'Configuracao', 'configuracao.ini')); return true; } catch { return false; } })(), false);
    const summary = JSON.parse((await requestBridge({ command: 'summary' })).stdout);
    assert.equal(summary.ok, true);
    assert.equal(summary.configurationPath, join(metadata.packageRoot, 'Configuracao', 'configuracao.ini'));
    const restartedSummary = JSON.parse((await requestBridge({ command: 'summary' })).stdout);
    assert.equal(restartedSummary.ok, true);
    const persistentUi = await runProcess(powershell, ['-NoProfile', '-ExecutionPolicy', 'RemoteSigned', '-File', join(metadata.packageRoot, 'Executar.ps1')], { cwd, input: '2\r\n5\r\n1\r\n2\r\n1\r\n0\r\n0\r\n0\r\n' });
    assert.equal(persistentUi.code, 0);
    assert.match(persistentUi.stdout, /Preservar os arquivos originais e criar arquivos \.min/);
    assert.match(await readFile(join(metadata.packageRoot, 'Configuracao', 'configuracao.ini'), 'utf8'), /ModoSaida=PreservarOriginaisECriarMinificados/);
    const temporaryUi = await runProcess(powershell, ['-NoProfile', '-ExecutionPolicy', 'RemoteSigned', '-File', join(metadata.packageRoot, 'Executar.ps1')], { cwd, input: '1\r\n2\r\n2\r\n1\r\n0\r\n0\r\n0\r\n' });
    assert.equal(temporaryUi.code, 0);
    assert.match(temporaryUi.stdout, /Modo temporário: criar backup e sobrescrever os arquivos originais/);
    assert.match(temporaryUi.stdout, /Operação cancelada; nenhum arquivo foi alterado/);
    assert.match(temporaryUi.stdout, /Modo de saída: Criar backup e sobrescrever os arquivos originais/);
    assert.doesNotMatch(await readFile(join(metadata.packageRoot, 'Configuracao', 'configuracao.ini'), 'utf8'), /ModoSaida=BackupESobrescreverOriginais/);
    const analyzed = JSON.parse((await requestBridge({ command: 'analyze' })).stdout);
    assert.equal(analyzed.ok, true);
    assert.match(analyzed.artifacts.log.path, new RegExp(metadata.packageRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(analyzed.artifacts.log.path, /src[\\/]app[\\/]Dados/i);
    await copyFile(join(root, 'Executar.cmd'), join(failureRoot, 'Executar.cmd'));
    const failure = await runProcess('cmd.exe', ['/d', '/c', 'Executar.cmd'], { cwd: failureRoot, input: '\r\n' });
    assert.equal(failure.code, 1);
    assert.match(failure.stdout, /não foi possível iniciar|encerrado com erro/i);
    const esbuildBinary = join(metadata.packageRoot, 'node_modules', '@esbuild', 'win32-x64', 'esbuild.exe');
    await rename(esbuildBinary, `${esbuildBinary}.ausente`);
    const damagedRuntime = await runProcess(process.execPath, [join(metadata.packageRoot, 'src', 'bootstrap', 'cli.mjs'), '--bootstrap-only'], { cwd });
    assert.equal(damagedRuntime.code, 1);
    assert.match(`${damagedRuntime.stdout}${damagedRuntime.stderr}`, /runtime interno do esbuild empacotado.*ausente, corrompido ou incompatível/i);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(failureRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('ZIP contém raiz esperada e checksum SHA-256 corresponde', async () => {
  const root = await fixture();
  try {
    const metadata = await assemblePackage(root);
    const powershell = 'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
    await execFileAsync(powershell, ['-NoProfile', '-Command', `Compress-Archive -LiteralPath '${metadata.packageRoot.replaceAll("'", "''")}' -DestinationPath '${metadata.zipPath.replaceAll("'", "''")}' -Force`]);
    const listing = await execFileAsync(powershell, ['-NoProfile', '-Command', `Add-Type -AssemblyName System.IO.Compression.FileSystem; $z=[IO.Compression.ZipFile]::OpenRead('${metadata.zipPath.replaceAll("'", "''")}'); try { $z.Entries | ForEach-Object FullName } finally { $z.Dispose() }`]);
    const entries = listing.stdout.split(/\r?\n/).filter(Boolean).map((entry) => entry.replaceAll('\\', '/'));
    assert.ok(entries.includes(`${metadata.packageName}/Executar.cmd`));
    assert.ok(entries.includes(`${metadata.packageName}/LEIA-ME.txt`));
    assert.equal(entries.some((entry) => !entry.startsWith(`${metadata.packageName}/`)), false);
    const bytes = await readFile(metadata.zipPath);
    const hash = createHash('sha256').update(bytes).digest('hex');
    await writeFile(metadata.checksumPath, `${hash}  ${metadata.packageName}.zip\n`, 'utf8');
    assert.equal((await readFile(metadata.checksumPath, 'utf8')).trim().split(/\s+/)[0], hash);
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test('limpeza fora de dist ou com nome inesperado é rejeitada', async () => {
  assert.throws(() => assertSafeDistTarget(projectRoot, join(projectRoot, 'src'), 'SelfMinifier-0.2.1'));
  assert.throws(() => assertSafeDistTarget(projectRoot, join(projectRoot, 'dist', 'outro'), 'SelfMinifier-0.2.1'));
});

test('publicar.cmd prepara dependências somente com confirmação e mantém o launcher visível', async () => {
  const launcher = await readFile(join(projectRoot, 'publicar.cmd'), 'utf8');
  assert.doesNotMatch(launcher, /ExecutionPolicy\s+Bypass/i);
  assert.match(launcher, /powershell\.exe\s+-NoProfile\s+-File/i);
  assert.match(launcher, /pause/i);
  assert.match(launcher, /chcp\s+65001/i);
  assert.match(launcher, /política de execução/);
  assert.doesNotMatch(launcher, /pol├¡tica|execu├º├úo/);
  assert.match(await readFile(join(projectRoot, 'scripts', 'release', 'publicar.ps1'), 'utf8'), /npm ci/);
  assert.match(await readFile(join(projectRoot, 'scripts', 'release', 'publicar.ps1'), 'utf8'), /\(s\/N\)/);
});
