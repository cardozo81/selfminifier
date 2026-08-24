import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('UI explicita cancelamento, entrada inválida e recursos indisponíveis', async () => {
  const source = await readFile(new URL('../src/app/ui.ps1', import.meta.url), 'utf8');
  assert.match(source, /Opção inválida; nenhuma ação foi executada/);
  assert.match(source, /Execução cancelada; nenhum arquivo foi alterado/);
  assert.match(source, /Listar backups conhecidos e restaurar/);
  assert.match(source, /Restauração cancelada; nenhum arquivo foi alterado/);
  assert.match(source, /Nenhum relatório operacional disponível/);
  assert.match(source, /Nenhum log técnico disponível/);
  assert.match(source, /Invoke-SelfMinifierBridge/);
  assert.match(source, /StandardInput\.BaseStream/);
  assert.match(source, /Criar backup e sobrescrever os arquivos originais/);
  assert.match(source, /Preservar os arquivos originais e criar arquivos \.min/);
  assert.match(source, /Cancelar e voltar ao menu/);
  assert.match(source, /'1' \{ \[void\]\$script:TemporaryAdjustments\.Remove\('outputMode'\).*return \}/);
  assert.match(source, /'2' \{ \$script:TemporaryAdjustments\.outputMode = 'BackupESobrescreverOriginais'.*return \}/);
  assert.match(source, /'3' \{ \$script:TemporaryAdjustments\.outputMode = 'PreservarOriginaisECriarMinificados'.*return \}/);
  assert.doesNotMatch(source, /4\. Aplicar os ajustes desta execução/);
  assert.doesNotMatch(source, /risco da execução ainda não possui estimativa|EXECUTION_RISK_ALGORITHM_PENDING/);
  assert.match(source, /confirmationFingerprint = \$analysis\.confirmationFingerprint/);
  assert.match(source, /authorizeOverwriteConflicts = \$authorizeConflicts/);
  assert.doesNotMatch(source, /Modo temporário \(vazio mantém o persistente/);
  const bytes = await readFile(new URL('../src/app/ui.ps1', import.meta.url));
  assert.deepEqual([...bytes.subarray(0, 3)], [0xEF, 0xBB, 0xBF]);
});
