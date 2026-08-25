import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBridgeRequest } from '../src/app/bridge.mjs';
import { listArtifacts, readArtifact, writeOperationalReports, writeTechnicalLog } from '../src/observability/index.mjs';

function plan(root, ignored = []) {
  return {
    executionId: 'exec-teste', status: 'ready', outputMode: 'PreservarOriginaisECriarMinificados', profile: 'Padrao',
    engine: { id: 'esbuild', version: '0.28.2' }, backupRoot: null, runtimePaths: { technicalState: join(root, 'Dados', 'estado.json') },
    items: [{ id: 'item-001', sourcePath: 'C:\\projetos, "amostra"\\entrada.js', destinationPath: join(root, 'saida.min.js'), fileType: 'javascript', sourceSize: 100 }],
    ignored, diagnostics: { errors: [], blockers: [] },
  };
}

test('cria log técnico UTF-8, relatório TXT e CSV escapado', async () => {
  const root = await mkdtemp(join(tmpdir(), 'selfminifier-observability-'));
  try {
    const output = join(root, 'saida.min.js');
    await mkdir(join(root, 'Dados'), { recursive: true });
    await writeFile(output, 'const x=1;', 'utf8');
    const operational = await writeOperationalReports({ projectRoot: root, plan: plan(root, [{ normalizedPath: 'C:\\dados\\ação, teste.css', fileType: 'css', reason: 'READONLY_FILE' }]), result: { items: [{ id: 'item-001', status: 'confirmed' }] }, resultStatus: 'sucesso', timestamp: new Date(2026, 7, 21, 10, 20, 30) });
    const log = await writeTechnicalLog({ projectRoot: root, executionId: 'exec-teste', phases: [{ name: 'análise', durationMs: 4 }], result: { status: 'sucesso' }, runtime: { node: 'v24' }, timestamp: new Date(2026, 7, 21, 10, 20, 30) });
    const txt = await readFile(operational.txtPath, 'utf8');
    const csv = await readFile(operational.csvPath, 'utf8');
    const logText = await readFile(log.path, 'utf8');
    assert.match(txt, /Relatório operacional/);
    assert.match(txt, /ignorado/);
    assert.match(txt, /READONLY_FILE/);
    assert.match(csv, /"C:\\dados\\ação, teste\.css"/);
    assert.match(csv, /caminho,tipo,status,motivo/);
    assert.match(logText, /runtime=/);
    assert.match(logText, /phase=/);
    assert.equal(Buffer.from(txt).toString('utf8'), txt);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('execução bem-sucedida gera relatório integrado sem alterar dados do plano', async () => {
  const root = await mkdtemp(join(tmpdir(), 'selfminifier-report-execution-'));
  try {
    const projectRoot = join(root, 'projeto');
    const source = join(projectRoot, 'entrada.js');
    await mkdir(projectRoot, { recursive: true });
    await mkdir(join(root, 'Configuracao'), { recursive: true });
    await writeFile(source, 'const valor = 1;\n', 'utf8');
    await writeFile(join(root, 'Configuracao', 'configuracao.ini'), `[Configuracao]\nVersaoSchema=2\nMotor=esbuild\nPerfil=Padrao\nModoSaida=PreservarOriginaisECriarMinificados\nPastaRaiz=${projectRoot}\nTiposArquivo=JavaScript\n`, 'utf8');
    const analysis = await runBridgeRequest({ command: 'analyze', executionId: 'exec-report-analysis' }, { projectRoot: root });
    assert.equal(analysis.ok, true);
    const response = await runBridgeRequest({ command: 'execute', confirmed: true, confirmationFingerprint: analysis.analysis.confirmationFingerprint, executionId: 'exec-report' }, { projectRoot: root });
    assert.equal(response.ok, true);
    assert.equal(response.result.status, 'completed');
    assert.ok(response.artifacts.reports.txtPath);
    assert.ok(response.artifacts.log.path);
    const names = await listArtifacts(root, 'reports');
    assert.equal(names.length, 4);
    const listed = await runBridgeRequest({ command: 'list-artifacts', kind: 'logs' }, { projectRoot: root });
    assert.equal(listed.ok, true);
    assert.equal(listed.names.length, 2);
    let reportName;
    for (const name of names.filter((candidate) => candidate.endsWith('.txt'))) {
      if ((await readFile(join(root, 'Dados', 'Relatorios', name), 'utf8')).includes('ID da execução: exec-report\n')) { reportName = name; break; }
    }
    assert.ok(reportName);
    const viewed = await runBridgeRequest({ command: 'read-artifact', kind: 'reports', name: reportName }, { projectRoot: root });
    assert.match(viewed.content, /Status: sucesso|Status: completed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('relatório representa falha, rollback e recovery-required sem declarar sucesso', async () => {
  const root = await mkdtemp(join(tmpdir(), 'selfminifier-report-status-'));
  try {
    for (const status of ['falha/rollback', 'recovery-required']) {
      const result = await writeOperationalReports({ projectRoot: root, plan: plan(root), resultStatus: status });
      const text = await readFile(result.txtPath, 'utf8');
      assert.match(text, new RegExp(`Status: ${status.replace('/', '\\/')}`));
      assert.doesNotMatch(text, /Status: sucesso/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('listagem e leitura são read-only e diretórios ausentes são criados apenas na escrita', async () => {
  const root = await mkdtemp(join(tmpdir(), 'selfminifier-report-readonly-'));
  try {
    assert.deepEqual(await listArtifacts(root, 'reports'), []);
    assert.deepEqual(await listArtifacts(root, 'logs'), []);
    await assert.rejects(readArtifact(root, 'reports', '..\\segredo.txt'));
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});
