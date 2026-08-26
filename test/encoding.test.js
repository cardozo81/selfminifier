import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, validateTextContent } from '../scripts/quality/check-encoding.mjs';

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
