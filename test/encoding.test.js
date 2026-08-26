import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, validateFile, validateTextContent } from '../scripts/quality/check-encoding.mjs';

test('aceita UTF-8 válido com palavras portuguesas', () => {
  assert.doesNotThrow(() => validateTextContent('NÃO configuração usuário execução', 'memória'));
});

test('detecta sequência conhecida de mojibake sem rejeitar Ã isolado válido', () => {
  assert.doesNotThrow(() => validateTextContent('NÃO', 'válido'));
  assert.throws(() => validateTextContent('\u00c3\u0192Configura\u00e7\u00e3o', 'corrompido'), /Mojibake confirmado/);
});

async function withTempDir(callback) {
  const root = await mkdtemp(join(tmpdir(), 'SelfMinifier encoding '));
  try { return await callback(root); } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}

test('validação escaneia fonte ativa e ignora payloads históricos/runtime', async () => {
  await withTempDir(async (root) => {
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, '_source_versions', 'exec-x', 'assets', 'js'), { recursive: true });
    await mkdir(join(root, 'Dados'), { recursive: true });
    const mojibake = String.fromCharCode(0xC3, 0xA7); // mojibake conhecido montado em runtime
    const aCircunflexo = String.fromCharCode(0xC2); // A maiúsculo circunflexo legítimo
    await writeFile(join(root, 'src', 'ativo.js'), 'const ok = "NÃO configuração";\n', 'utf8');
    await writeFile(join(root, '_source_versions', 'exec-x', 'assets', 'js', 'historico.js'), `const a = "${mojibake}";\nconst b = "SEM${aCircunflexo}NTICOS";\n`, 'utf8');
    await writeFile(join(root, 'Dados', 'estado.json'), `{"nome":"SEM${aCircunflexo}NTICOS","rotulo":"${mojibake}"}`, 'utf8');
    const files = await run(root);
    assert.equal(files.includes(join('src', 'ativo.js')), true);
    assert.equal(files.some((file) => file.includes('_source_versions')), false);
    assert.equal(files.some((file) => file.includes('Dados')), false);
  });
});

test('validação falha fechada para mojibake conhecido em fonte ativa', async () => {
  await withTempDir(async (root) => {
    await mkdir(join(root, 'src'), { recursive: true });
    const mojibake = String.fromCharCode(0xC3, 0xA7); // mojibake conhecido montado em runtime
    await writeFile(join(root, 'src', 'corrompido.js'), `const texto = "${mojibake}";\n`, 'utf8');
    await assert.rejects(run(root), /Mojibake confirmado/);
  });
});

test('validação aceita arquivo ativo UTF-8 normal', async () => {
  await withTempDir(async (root) => {
    await writeFile(join(root, 'ativo.txt'), 'NÃO configuração usuário execução restauração relatório\n', 'utf8');
    const files = await run(root);
    assert.equal(files.includes('ativo.txt'), true);
  });
});

test('aceita A-circunflexo legítimo em palavras portuguesas', () => {
  const aCircunflexo = String.fromCharCode(0xC2);
  assert.doesNotThrow(() => validateTextContent(`SEM${aCircunflexo}NTICOS DIN${aCircunflexo}MICOS PAR${aCircunflexo}METROS`, 'legítimo'));
});

test('rejeita A-circunflexo seguido de caractere não ASCII (mojibake CP1252)', () => {
  const mojibake = String.fromCharCode(0xC2, 0xA9); // A-circunflexo + símbolo de copyright montados em runtime
  assert.throws(() => validateTextContent(`${mojibake} rodapé`, 'corrompido'), /Mojibake confirmado/);
});

test('validação aceita .cmd com CRLF físico', async () => {
  await withTempDir(async (root) => {
    await writeFile(join(root, 'Executar.cmd'), '@echo off\r\necho ok\r\n', 'utf8');
    const files = await run(root);
    assert.equal(files.includes('Executar.cmd'), true);
  });
});

test('validação rejeita .cmd com LF apenas', async () => {
  await withTempDir(async (root) => {
    await writeFile(join(root, 'Executar.cmd'), '@echo off\necho ok\n', 'utf8');
    await assert.rejects(run(root), /Fim de linha sem CRLF/);
  });
});

test('validação rejeita .cmd com finais de linha mistos', async () => {
  await withTempDir(async (root) => {
    await writeFile(join(root, 'Executar.cmd'), '@echo off\r\necho ok\n', 'utf8');
    await assert.rejects(run(root), /Fim de linha sem CRLF/);
  });
});

test('validação não aplica regra CRLF a arquivos que não são .cmd', async () => {
  await withTempDir(async (root) => {
    await writeFile(join(root, 'script.ps1'), 'Write-Host "oi"\n', 'utf8');
    await writeFile(join(root, 'app.js'), 'const x = 1;\n', 'utf8');
    const files = await run(root);
    assert.equal(files.includes('script.ps1'), true);
    assert.equal(files.includes('app.js'), true);
  });
});

test('arquivos .cmd reais do repositório passam no gate CRLF', async () => {
  await validateFile('Executar.cmd');
  await validateFile('publicar.cmd');
});
