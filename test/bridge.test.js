import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBridgeRequest } from '../src/app/bridge.mjs';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'selfminifier-bridge-'));
  const projectRoot = join(root, 'projeto');
  const source = join(projectRoot, 'entrada.js');
  await mkdir(projectRoot, { recursive: true });
  await writeFile(source, 'const valor = 1;\n', 'utf8');
  await mkdir(join(root, 'Configuracao'), { recursive: true });
  await writeFile(join(root, 'Configuracao', 'configuracao.ini'), `[Configuracao]\nVersaoSchema=2\nMotor=esbuild\nPerfil=Padrao\nModoSaida=PreservarOriginaisECriarMinificados\nPastaRaiz=${projectRoot}\nTiposArquivo=JavaScript\n`, 'utf8');
  return { root, source };
}

test('bridge retorna análise estruturada e risco determinístico', async () => {
  const { root } = await fixture();
  try {
    const response = await runBridgeRequest({ command: 'analyze' }, { projectRoot: root });
    assert.equal(response.ok, true);
    assert.equal(response.analysis.status, 'ready');
    assert.equal(response.analysis.counts.eligible, 1);
    assert.equal(response.analysis.executionRisk.technicalLevel, 'Moderado');
    assert.equal(response.analysis.executionRisk.status, 'determined');
    assert.equal(response.analysis.scope.fileCount, 1);
    assert.match(response.analysis.confirmationFingerprint, /^[a-f0-9]{64}$/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('bridge propaga erro de configuração sem fallback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'selfminifier-bridge-invalid-'));
  try {
    const projectRoot = join(root, 'projeto');
    await mkdir(projectRoot, { recursive: true });
    await mkdir(join(root, 'Configuracao'), { recursive: true });
    await writeFile(join(root, 'Configuracao', 'configuracao.ini'), `[Configuracao]\nVersaoSchema=2\nMotor=nao-homologado\nPerfil=Padrao\nModoSaida=PreservarOriginaisECriarMinificados\nPastaRaiz=${projectRoot}\nTiposArquivo=JavaScript\n`, 'utf8');
    const response = await runBridgeRequest({ command: 'analyze' }, { projectRoot: root });
    assert.equal(response.ok, false);
    assert.equal(response.diagnostic.code, 'UNSUPPORTED_ENGINE');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('execução sem confirmação não modifica e ajuste temporário não persiste', async () => {
  const { root, source } = await fixture();
  try {
    const before = await readFile(source, 'utf8');
    const response = await runBridgeRequest({ command: 'execute', confirmed: false, adjustments: { outputMode: 'BackupESobrescreverOriginais' }, riskAssessment: { authorized: true, status: 'substituto-proibido' } }, { projectRoot: root });
    assert.equal(response.ok, false);
    assert.equal(response.diagnostic.code, 'EXECUTION_CONFIRMATION_REQUIRED');
    assert.equal(await readFile(source, 'utf8'), before);
    const summary = await runBridgeRequest({ command: 'summary' }, { projectRoot: root });
    assert.equal(summary.configuration.outputMode, 'PreservarOriginaisECriarMinificados');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('bridge ignora autorização substituta e mantém o risco calculado', async () => {
  const { root } = await fixture();
  try {
    const response = await runBridgeRequest({ command: 'analyze', riskAssessment: { authorized: true, status: 'unavailable' } }, { projectRoot: root });
    assert.equal(response.ok, true);
    assert.equal(response.analysis.executionRisk.technicalLevel, 'Moderado');
    assert.equal('riskAssessment' in response.analysis, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('execução bloqueia quando escopo ou conflitos mudam depois da análise confirmada', async () => {
  const { root, source } = await fixture();
  const destination = source.replace(/\.js$/i, '.min.js');
  try {
    const analyzed = await runBridgeRequest({ command: 'analyze' }, { projectRoot: root });
    assert.equal(analyzed.ok, true);
    await writeFile(destination, 'const preexistente = true;\n', 'utf8');
    const response = await runBridgeRequest({
      command: 'execute',
      confirmed: true,
      confirmationFingerprint: analyzed.analysis.confirmationFingerprint,
    }, { projectRoot: root });
    assert.equal(response.ok, false);
    assert.equal(response.diagnostic.code, 'PLAN_CHANGED_AFTER_ANALYSIS');
    assert.equal(await readFile(destination, 'utf8'), 'const preexistente = true;\n');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('alteração persistente do modo exige confirmação e grava somente o enum aprovado', async () => {
  const { root } = await fixture();
  const configurationPath = join(root, 'Configuracao', 'configuracao.ini');
  try {
    const before = await readFile(configurationPath, 'utf8');
    const declined = await runBridgeRequest({ command: 'update-output-mode', outputMode: 'PreservarOriginaisECriarMinificados', confirmed: false }, { projectRoot: root });
    assert.equal(declined.ok, false);
    assert.equal(await readFile(configurationPath, 'utf8'), before);
    const invalid = await runBridgeRequest({ command: 'update-output-mode', outputMode: 'Outro', confirmed: true }, { projectRoot: root });
    assert.equal(invalid.ok, false);
    assert.equal(await readFile(configurationPath, 'utf8'), before);
    const saved = await runBridgeRequest({ command: 'update-output-mode', outputMode: 'BackupESobrescreverOriginais', confirmed: true }, { projectRoot: root });
    assert.equal(saved.ok, true);
    assert.equal(saved.configuration.schemaVersion, 2);
    assert.equal(saved.configuration.outputMode, 'BackupESobrescreverOriginais');
    const persisted = await readFile(configurationPath, 'utf8');
    assert.match(persisted, /^\[Configuracao\]\nVersaoSchema=2\n/);
    assert.match(persisted, /ModoSaida=BackupESobrescreverOriginais/);
    assert.match(persisted, /TiposArquivo=JavaScript/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
