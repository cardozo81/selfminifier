import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runBridgeRequest } from '../src/app/bridge.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const uiPath = new URL('../src/app/ui.ps1', import.meta.url);
const harnessPath = join(repoRoot, 'test', 'b3-ux-harness.ps1');
const windowsTest = process.platform === 'win32' ? test : test.skip;

function runScenario(scenario, state = '') {
  const args = ['-NoProfile', '-File', harnessPath, '-Scenario', scenario];
  if (state) args.push('-State', state);
  const output = execFileSync('powershell.exe', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    env: process.env,
    windowsHide: true,
  });
  return JSON.parse(output.trim());
}

function outputText(result) {
  return result.output.join('\n');
}

test('menu principal permanece estável e item 3 concentra restauração e histórico', async () => {
  const source = await readFile(uiPath, 'utf8');
  for (const label of [
    '1. Minificar projeto',
    '2. Configurações',
    '3. Backups e restauração',
    '4. Relatórios',
    '5. Logs técnicos',
    '0. Sair',
  ]) assert.ok(source.includes(label), label);
  assert.match(source, /'3' \{ Show-RestoreMenu \}/);
  assert.match(source, /BACKUPS, RESTAURAÇÃO E HISTÓRICO/);
  assert.match(source, /RESTAURAÇÃO NORMAL:/);
  assert.match(source, /RECUPERAÇÃO HISTÓRICA:/);
  assert.match(source, /4\. Pesquisar SelfMinifier-Tag/);
  assert.match(source, /5\. Consultar histórico por arquivo ou caminho/);
  assert.doesNotMatch(source, /Write-Host 'search-history-by-tag/);
  assert.doesNotMatch(source, /Write-Host 'recover-historical-original/);
});

windowsTest('submenu é alcançável e retorna sem disparar operação', () => {
  const result = runScenario('submenu');
  const output = outputText(result);
  assert.match(output, /Listar backups conhecidos e restaurar normalmente/);
  assert.match(output, /Pesquisar SelfMinifier-Tag/);
  assert.match(output, /Consultar histórico por arquivo ou caminho/);
  assert.deepEqual(result.calls, []);
});

windowsTest('pesquisa por Tag apresenta resultado, ausência e conflito de forma controlada', () => {
  const found = runScenario('tag-success');
  const foundText = outputText(found);
  assert.match(foundText, /Histórico autoritativo encontrado/);
  assert.match(foundText, /DADO HISTÓRICO PERSISTIDO/);
  assert.match(foundText, /ESTADO VERIFICADO AGORA/);
  assert.match(foundText, /\/\*! SelfMinifier-Tag: 7F31A2C82A884E91B04F22D7 \*\//);
  assert.match(foundText, /Versão do SelfMinifier: 0\.2\.0/);
  assert.match(foundText, /Detalhes técnicos:/);
  assert.ok(found.calls.some((call) => call.startsWith('search-history-by-tag|')));
  assert.ok(found.calls.some((call) => call.startsWith('inspect-historical-artifact|7F31')));

  const missingText = outputText(runScenario('tag-not-found'));
  assert.match(missingText, /Nenhum histórico autoritativo do SelfMinifier/);
  assert.match(missingText, /não significa que um arquivo esteja corrompido/);

  const conflictText = outputText(runScenario('tag-conflict'));
  assert.match(conflictText, /registros históricos conflitantes/);
  assert.match(conflictText, /bloqueada para preservar a integridade/);
  assert.match(conflictText, /nenhum registro foi escolhido automaticamente/);
});

windowsTest('histórico por caminho mostra múltiplos artefatos em ordem determinística e permite seleção', () => {
  const result = runScenario('path-multiple');
  const output = outputText(result);
  assert.match(output, /ordem mais recente primeiro: 2/);
  assert.match(output, /artefato histórico independente/);
  assert.ok(output.indexOf('222222222222222222222222') < output.indexOf('111111111111111111111111'));
  assert.ok(result.calls.some((call) => call.startsWith('inspect-historical-artifact|111111111111111111111111')));
});

windowsTest('todos os estados de integridade atual têm rótulos humanos distintos e detalhes factuais', () => {
  const labels = new Map([
    ['MATCH', 'Corresponde ao histórico'],
    ['CONTENT_CHANGED', 'Conteúdo alterado'],
    ['TAG_MISMATCH', 'Tag diferente da histórica'],
    ['TAG_MISSING', 'Tag histórica ausente'],
    ['TAG_INVALID', 'Tag inválida'],
    ['FILE_UNAVAILABLE', 'Arquivo atual indisponível'],
    ['NOT_INSPECTED', 'Ainda não inspecionado'],
  ]);
  const details = new Map([
    ['MATCH', 'corresponde exatamente ao artefato histórico'],
    ['CONTENT_CHANGED', 'não corresponde ao hash histórico'],
    ['TAG_MISMATCH', 'contém outra SelfMinifier-Tag'],
    ['TAG_MISSING', 'não contém a SelfMinifier-Tag histórica esperada'],
    ['TAG_INVALID', 'marcador reservado inválido ou inconsistente'],
    ['FILE_UNAVAILABLE', 'artefato histórico existe, mas o arquivo atual não está disponível'],
    ['NOT_INSPECTED', 'ainda não foi verificada'],
  ]);
  const captured = new Set();
  for (const [state, label] of labels) {
    const output = outputText(runScenario('integrity', state));
    assert.match(output, new RegExp(label));
    assert.match(output, new RegExp(details.get(state)));
    if (state === 'CONTENT_CHANGED') {
      assert.match(output, /não determina sua causa/);
      assert.doesNotMatch(output, /malicioso|ataque/i);
    }
    captured.add(output.match(/Integridade atual: ([^\n]+)/)?.[1]);
  }
  assert.equal(captured.size, labels.size);
});

windowsTest('todos os estados de backup têm rótulos humanos distintos e somente AVAILABLE habilita recuperação', () => {
  const labels = new Map([
    ['AVAILABLE', 'Disponível'],
    ['NOT_AVAILABLE', 'Não disponível'],
    ['ROOT_UNAVAILABLE', 'Local do backup indisponível'],
    ['PAYLOAD_MISSING', 'Conteúdo do backup ausente'],
    ['MANIFEST_MISSING_OR_INVALID', 'Metadados do backup inválidos'],
    ['HASH_MISMATCH', 'Integridade do backup divergente'],
    ['UNSUPPORTED_FORMAT', 'Formato não suportado'],
    ['NOT_INSPECTED', 'Ainda não inspecionado'],
  ]);
  const details = new Map([
    ['AVAILABLE', 'disponível e validável'],
    ['NOT_AVAILABLE', 'não possui backup histórico'],
    ['ROOT_UNAVAILABLE', 'local histórico do backup não está acessível'],
    ['PAYLOAD_MISSING', 'conteúdo de backup esperado não foi encontrado'],
    ['MANIFEST_MISSING_OR_INVALID', 'metadados de recuperação estão ausentes ou inválidos'],
    ['HASH_MISMATCH', 'não corresponde à prova de integridade histórica'],
    ['UNSUPPORTED_FORMAT', 'formato desse backup histórico não é suportado'],
    ['NOT_INSPECTED', 'ainda não foi verificada'],
  ]);
  const captured = new Set();
  for (const [state, label] of labels) {
    const output = outputText(runScenario('backup-state', state));
    assert.match(output, new RegExp(label));
    assert.match(output, new RegExp(details.get(state)));
    assert.equal(output.includes('RECOVERY_OPTION_VISIBLE'), state === 'AVAILABLE');
    captured.add(output.match(/Backup histórico: ([^\n]+)/)?.[1]);
  }
  assert.equal(captured.size, labels.size);
});

windowsTest('.min sem backup continua inspecionável e não oferece recuperação falsa', () => {
  const result = runScenario('min-no-backup');
  const output = outputText(result);
  assert.match(output, /artefato \.min permanece pesquisável e inspecionável/);
  assert.match(output, /não criou backup histórico da origem/);
  assert.match(output, /arquivo-fonte atual não substitui esse backup/);
  assert.doesNotMatch(output, /2\. Recuperar original histórico/);
  assert.ok(!result.calls.some((call) => call.startsWith('recover-historical-original|')));
});

windowsTest('exportação histórica exige destino explícito, confirmação numérica e relata destino separado', () => {
  const success = runScenario('export-success');
  const output = outputText(success);
  assert.match(output, /caminho completo e explícito do novo arquivo/);
  assert.match(output, /NÃO executa a restauração normal/);
  assert.match(output, /1\. Exportar o original histórico/);
  assert.match(output, /Original histórico exportado com sucesso/);
  assert.match(output, /Destino exato: C:\\Exportado\\original\.js/);
  assert.match(output, /arquivos atuais de origem e saída não foram modificados/);
  assert.ok(success.calls.some((call) => call.includes('recover-historical-original|7F31A2C82A884E91B04F22D7|C:\\Exportado\\original.js')));

  const cancelled = runScenario('export-cancel');
  assert.match(outputText(cancelled), /Exportação histórica cancelada; nenhum arquivo foi criado/);
  assert.ok(!cancelled.calls.some((call) => call.startsWith('recover-historical-original|')));
});

windowsTest('destino existente é bloqueado sem oferecer sobrescrita', () => {
  const result = runScenario('export-existing');
  const output = outputText(result);
  assert.match(output, /arquivo de destino já existe e não será sobrescrito/);
  assert.match(output, /Escolha outro destino/);
  assert.doesNotMatch(output, /sobrescrever mesmo assim/i);
});

windowsTest('restauração normal permanece alcançável e usa a transação existente', () => {
  const result = runScenario('normal-restore');
  assert.ok(result.calls.some((call) => call.startsWith('plan-restore|')));
  assert.ok(result.calls.some((call) => call.startsWith('execute-restore|')));
  assert.match(outputText(result), /Restauração: concluída/);
});

windowsTest('seleção de backup usa [Bn] e chega ao plano de restauração existente', () => {
  const selected = runScenario('backup-select');
  const output = outputText(selected);
  assert.match(output, /SELFMINIFIER/);
  assert.match(output, /BACKUPS CONHECIDOS/);
  assert.match(output, /\[B1\]/);
  assert.match(output, /\[B2\]/);
  assert.match(output, /Digite o ID do backup a restaurar/);
  assert.equal(selected.lastBackupDirectory, 'C:\\Backups\\exec-aaa');
  assert.ok(selected.calls.some((call) => call.startsWith('plan-restore|')));
  assert.ok(selected.calls.some((call) => call.startsWith('execute-restore|')));

  assert.equal(runScenario('backup-select-case').lastBackupDirectory, 'C:\\Backups\\exec-bbb');
  assert.equal(runScenario('backup-select-whitespace').lastBackupDirectory, 'C:\\Backups\\exec-aaa');
});

windowsTest('seleção de backup rejeita cancelamento e IDs inválidos sem plano de restauração', () => {
  const scenarios = ['backup-cancel', 'backup-invalid-bare', 'backup-invalid-b0', 'backup-invalid-malformed', 'backup-invalid-outofrange'];
  for (const scenario of scenarios) {
    const result = runScenario(scenario);
    assert.ok(!result.calls.some((call) => call.startsWith('plan-restore|')), scenario);
    assert.equal(result.lastBackupDirectory, null, scenario);
    const output = outputText(result);
    if (scenario === 'backup-cancel') {
      assert.match(output, /Seleção cancelada; nenhum arquivo foi alterado/);
    } else {
      assert.match(output, /ID inválido|ID fora da lista/);
    }
  }
});

test('Configuração V2/V3 e apresentação de proveniência A4 permanecem conectadas sem redesenho', async () => {
  const source = await readFile(uiPath, 'utf8');
  assert.match(source, /function Show-ConfigurationMenu/);
  assert.match(source, /function Invoke-EditBackupRoot/);
  assert.match(source, /command = 'update-backup-root'/);
  assert.match(source, /command = 'scan-analysis'/);
  assert.match(source, /alreadyMinified/);
  const analysis = await readFile(new URL('../src/scanner/analysis.js', import.meta.url), 'utf8');
  assert.match(analysis, /ALREADY_MINIFIED_BY_SELFMINIFIER: 'Já minificado pelo SelfMinifier'/);
  assert.match(analysis, /SELFMINIFIER_TAG_CONTENT_CHANGED: 'Conteúdo alterado após a SelfMinifier-Tag'/);
  assert.match(analysis, /SELFMINIFIER_TAG_UNKNOWN: 'SelfMinifier-Tag desconhecida'/);
  assert.match(analysis, /SELFMINIFIER_TAG_MULTIPLE: 'Múltiplas SelfMinifier-Tags'/);
  assert.match(analysis, /SELFMINIFIER_TAG_INVALID: 'SelfMinifier-Tag inválida'/);
});

test('bridge registra sucesso ou bloqueio histórico no logger existente sem alterar contrato', async () => {
  const bridgeSource = await readFile(new URL('../src/app/bridge.mjs', import.meta.url), 'utf8');
  assert.match(bridgeSource, /writeTechnicalLog/);
  assert.match(bridgeSource, /status: 'completed'/);
  assert.match(bridgeSource, /status: 'blocked'/);
  assert.doesNotMatch(bridgeSource, /fileContent|sourceBytes|payloadBytes/);

  const root = await mkdtemp(join(tmpdir(), 'selfminifier-b3-ux-log-'));
  try {
    const response = await runBridgeRequest({
      command: 'search-history-by-tag',
      tag: 'EEEEEEEEEEEEEEEEEEEEEEEE',
    }, { projectRoot: root });
    assert.deepEqual(Object.keys(response).sort(), ['diagnostic', 'ok']);
    assert.equal(response.ok, false);
    assert.equal(response.diagnostic.code, 'TAG_NOT_FOUND');

    const logDirectory = join(root, 'Dados', 'Logs');
    const names = await readdir(logDirectory);
    assert.equal(names.length, 1);
    const content = await readFile(join(logDirectory, names[0]), 'utf8');
    assert.match(content, /"command":"search-history-by-tag"/);
    assert.match(content, /"status":"blocked"/);
    assert.match(content, /"code":"TAG_NOT_FOUND"/);
    assert.match(content, /TAG_NOT_FOUND/);
    assert.doesNotMatch(content, /function somar|conteúdo do arquivo/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});