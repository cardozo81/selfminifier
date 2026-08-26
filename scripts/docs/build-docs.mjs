import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const manuals = Object.freeze([
  { name: 'Manual-Usuario', title: 'Manual do Usuário - SelfMinifier' },
  { name: 'Manual-Tecnico', title: 'Manual Técnico - SelfMinifier' },
]);

function escapeHtml(value) { return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'); }
function inline(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

export function renderMarkdown(markdown) {
  const lines = markdown.replace(/^\uFEFF/, '').split(/\r?\n/);
  const output = [];
  let paragraph = [];
  let list = null;
  let code = null;
  const flushParagraph = () => { if (paragraph.length) { output.push(`<p>${inline(paragraph.join(' '))}</p>`); paragraph = []; } };
  const flushList = () => { if (list) { output.push(`</${list}>`); list = null; } };
  for (const line of lines) {
    if (line.startsWith('```')) {
      flushParagraph(); flushList();
      if (code === null) { code = []; } else { output.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`); code = null; }
      continue;
    }
    if (code !== null) { code.push(line); continue; }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    const bullet = line.match(/^[-*]\s+(.+)$/);
    const ordered = line.match(/^\d+\.\s+(.+)$/);
    if (heading) { flushParagraph(); flushList(); output.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`); }
    else if (bullet || ordered) {
      flushParagraph(); const kind = ordered ? 'ol' : 'ul'; if (list !== kind) { flushList(); output.push(`<${kind}>`); list = kind; }
      output.push(`<li>${inline((bullet ?? ordered)[1])}</li>`);
    } else if (line.trim() === '') { flushParagraph(); flushList(); }
    else { paragraph.push(line.trim()); }
  }
  if (code !== null) throw new Error('Bloco de código Markdown não foi encerrado.');
  flushParagraph(); flushList();
  return output.join('\n');
}

export async function buildDocumentation({ projectRoot = defaultRoot } = {}) {
  const root = resolve(projectRoot);
  const stylesheet = await readFile(join(root, 'Documentacao', 'Assets', 'manual.css'), 'utf8');
  const outputs = [];
  for (const manual of manuals) {
    const sourcePath = join(root, 'Documentacao', 'Fonte', manual.name, 'README.md');
    const markdown = await readFile(sourcePath, 'utf8');
    const outputPath = join(root, 'Documentacao', 'Gerada', manual.name, 'index.html');
    const html = `<!doctype html>\n<html lang="pt-BR">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>${manual.title}</title>\n<style>\n${stylesheet}\n</style>\n</head>\n<body>\n${renderMarkdown(markdown)}\n</body>\n</html>\n`;
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, html, 'utf8');
    outputs.push(outputPath);
  }
  return outputs;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { const outputs = await buildDocumentation(); outputs.forEach((output) => console.log(`Documentação gerada: ${output}`)); }
  catch (error) { console.error(`Build de documentação bloqueado: ${error.message}`); process.exitCode = 1; }
}
