import { chmod, mkdir, mkdtemp, rm, symlink, writeFile, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { scan } from '../src/scanner/index.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'selfminifier-scanner-'));
  const temporary = join(root, 'SelfMinifierTemp');
  await mkdir(join(root, 'sub'), { recursive: true });
  await mkdir(join(root, 'node_modules'), { recursive: true });
  await mkdir(join(root, '.git'), { recursive: true });
  await mkdir(join(root, '_source_versions'), { recursive: true });
  await mkdir(temporary, { recursive: true });
  await Promise.all([
    writeFile(join(root, 'app.js'), 'const app = 1;'),
    writeFile(join(root, 'site.css'), 'body { color: red; }'),
    writeFile(join(root, 'notes.txt'), 'ignored'),
    writeFile(join(root, 'a1.js'), 'const a1 = 1;'),
    writeFile(join(root, 'sub', 'nested.js'), 'const nested = 1;'),
    writeFile(join(root, 'sub', 'nested.css'), '.nested { color: blue; }'),
    writeFile(join(root, 'node_modules', 'blocked.js'), 'const blocked = 1;'),
    writeFile(join(root, '.git', 'hidden.js'), 'const hidden = 1;'),
    writeFile(join(root, '_source_versions', 'old.js'), 'const old = 1;'),
    writeFile(join(temporary, 'temp.js'), 'const temp = 1;'),
  ]);
  return { root, temporary };
}

function config(source, overrides = {}) {
  return { globalIncludes: [], globalExcludes: [], sources: [{ id: 'src', path: source, type: 'Diretorio', recursive: true, mode: 'Todos', includes: [], excludes: [], ...overrides }] };
}

async function withFixture(fn) {
  const paths = await fixture();
  try { await fn(paths); } finally { await rm(paths.root, { recursive: true, force: true }); }
}

test('scanner honors recursion and explicit file sources', async () => withFixture(async ({ root, temporary }) => {
  const shallow = await scan(config(root, { recursive: false }), { temporaryDirectory: temporary });
  assert.ok(shallow.eligible.some((item) => item.normalizedPath.endsWith('app.js')));
  assert.ok(!shallow.eligible.some((item) => item.normalizedPath.endsWith('nested.js')));
  const explicit = await scan(config(join(root, 'app.js'), { type: 'Arquivo', recursive: false, mode: 'Arquivo' }), { temporaryDirectory: temporary });
  assert.equal(explicit.eligible.length, 1);
  assert.equal(explicit.eligible[0].fileType, 'javascript');
}));

test('Todos, Selecionados, includes and excludes are deterministic', async () => withFixture(async ({ root, temporary }) => {
  const all = await scan(config(root), { temporaryDirectory: temporary });
  assert.ok(all.eligible.some((item) => item.normalizedPath.endsWith('nested.js')));
  const selected = await scan(config(root, { mode: 'Selecionados', includes: ['**/*.js'] }), { temporaryDirectory: temporary });
  assert.ok(selected.eligible.every((item) => item.fileType === 'javascript'));
  const patterns = await scan({ globalIncludes: ['a?.js'], globalExcludes: ['a1.js'], sources: [{ id: 'src', path: root, type: 'Diretorio', recursive: true, mode: 'Todos', includes: [], excludes: [] }] }, { temporaryDirectory: temporary });
  assert.ok(patterns.ignored.some((item) => item.reason === 'EXCLUDED_BY_PATTERN'));
  const globstar = await scan(config(root, { mode: 'Selecionados', includes: ['**/*.js'] }), { temporaryDirectory: temporary });
  assert.ok(globstar.eligible.some((item) => item.normalizedPath.endsWith('nested.js')));
  assert.deepEqual(globstar.eligible, (await scan(config(root, { mode: 'Selecionados', includes: ['**/*.js'] }), { temporaryDirectory: temporary })).eligible);
}));

test('technical exclusions, file types and duplicate origins are explicit', async () => withFixture(async ({ root, temporary }) => {
  const result = await scan({ globalIncludes: ['**/*'], globalExcludes: [], sources: [
    { id: 'one', path: root, type: 'Diretorio', recursive: true, mode: 'Todos', includes: [], excludes: [] },
    { id: 'two', path: join(root, 'sub'), type: 'Diretorio', recursive: true, mode: 'Todos', includes: [], excludes: [] },
  ] }, { temporaryDirectory: temporary });
  assert.ok(result.ignored.some((item) => item.reason === 'MANDATORY_TECHNICAL_EXCLUSION'));
  assert.ok(result.ignored.some((item) => item.reason === 'UNSUPPORTED_EXTENSION'));
  assert.ok(result.ignored.some((item) => item.reason === 'DUPLICATE_PHYSICAL_FILE'));
  assert.equal(new Set(result.eligible.map((item) => item.normalizedPath.toLowerCase())).size, result.eligible.length);
}));

test('missing and readonly files produce diagnostics', async (t) => withFixture(async ({ root, temporary }) => {
  const missing = await scan(config(join(root, 'missing')), { temporaryDirectory: temporary });
  assert.equal(missing.errors[0].reason, 'SOURCE_MISSING_OR_INACCESSIBLE');
  const readonly = join(root, 'readonly.js');
  await writeFile(readonly, 'const readonlyFile = 1;');
  await chmod(readonly, 0o444);
  if ((await lstat(readonly)).mode & 0o222) { t.skip('filesystem does not expose readonly mode'); return; }
  const result = await scan(config(root, { recursive: false }), { temporaryDirectory: temporary });
  assert.ok(result.ignored.some((item) => item.normalizedPath.endsWith('readonly.js') && item.reason === 'READONLY_FILE'));
  await chmod(readonly, 0o666);
}));

test('symlinks are reported and never traversed', async (t) => withFixture(async ({ root, temporary }) => {
  const link = join(root, 'linked');
  try { await symlink(join(root, 'sub'), link, 'junction'); } catch { t.skip('symlink/junction creation unavailable'); return; }
  const result = await scan(config(root), { temporaryDirectory: temporary });
  assert.ok(result.ignored.some((item) => item.normalizedPath.endsWith('linked') && item.reason === 'LINK_IGNORED'));
  assert.ok(!result.eligible.some((item) => item.normalizedPath.includes('linked')));
}));
