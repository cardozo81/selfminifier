import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDocumentation } from '../scripts/docs/build-docs.mjs';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'selfminifier-docs-'));
  for (const manual of ['Manual-Usuario', 'Manual-Tecnico']) {
    await mkdir(join(root, 'Documentacao', 'Fonte', manual), { recursive: true });
    await writeFile(join(root, 'Documentacao', 'Fonte', manual, 'README.md'), `# ${manual}\n\nAção, acentuação e ç sobrevivem.\n\n- Item seguro\n`, 'utf8');
  }
  await mkdir(join(root, 'Documentacao', 'Assets'), { recursive: true });
  await writeFile(join(root, 'Documentacao', 'Assets', 'manual.css'), 'body { color: #123; }\n', 'utf8');
  return root;
}

test('build gera ambos os manuais com metadados UTF-8 e sem dependência externa', async () => {
  const root = await fixture();
  try {
    const outputs = await buildDocumentation({ projectRoot: root });
    assert.equal(outputs.length, 2);
    for (const output of outputs) {
      const html = await readFile(output, 'utf8');
      assert.match(html, /<meta charset="utf-8">/);
      assert.match(html, /<html lang="pt-BR">/);
      assert.match(html, /Ação, acentuação e ç sobrevivem/);
      assert.doesNotMatch(html, /https?:\/\//i);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('build falha quando uma fonte obrigatória está ausente', async () => {
  const root = await fixture();
  try {
    await rm(join(root, 'Documentacao', 'Fonte', 'Manual-Tecnico', 'README.md'));
    await assert.rejects(buildDocumentation({ projectRoot: root }), /ENOENT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('build representa ênfase **negrito** como strong e não deixa delimitadores visíveis', async () => {
  const root = await fixture();
  try {
    await writeFile(join(root, 'Documentacao', 'Fonte', 'Manual-Usuario', 'README.md'), '# Usuário\n\nTexto **negrito** com `código`.\n\n- **Item em negrito:** detalhe\n', 'utf8');
    await writeFile(join(root, 'Documentacao', 'Fonte', 'Manual-Tecnico', 'README.md'), '# Técnico\n\n**Destaque** sem delimitador.\n', 'utf8');
    const outputs = await buildDocumentation({ projectRoot: root });
    for (const output of outputs) {
      const html = await readFile(output, 'utf8');
      assert.match(html, /<strong>(negrito|Destaque)<\/strong>/);
      assert.doesNotMatch(html, /\*\*/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
