import { chmod, link, mkdir, mkdtemp, rm, symlink, writeFile, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { scan } from '../src/scanner/index.js';
import { validateV2Configuration } from '../src/configuration/v2.js';

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
function v2Config(projectRoot, overrides = {}) {
  return validateV2Configuration({
    engine: 'esbuild',
    profile: 'Padrao',
    projectRoot,
    fileTypes: ['css', 'javascript'],
    ignoredFolders: [],
    ignoredFiles: [],
    ...overrides,
  }, { allowedEngines: new Set(['esbuild']) });
}

const windowsTest = process.platform === 'win32' ? test : test.skip;

windowsTest('Scanner V2 usa uma raiz, recursão e seleção fechada de CSS/JavaScript', async () => withFixture(async ({ root, temporary }) => {
  await Promise.all([
    writeFile(join(root, 'bundle.min.JS'), 'const minified = 1;'),
    writeFile(join(root, 'sub', 'theme.MIN.css'), '.minified{}'),
  ]);

  const both = await scan(v2Config(root), { temporaryDirectory: temporary });
  assert.equal(both.errors.length, 0);
  assert.ok(both.eligible.some((item) => item.relativePath === 'sub/nested.js'));
  assert.ok(both.eligible.some((item) => item.relativePath === 'sub/nested.css'));
  assert.ok(both.eligible.every((item) => item.sourceId === 'project-root'));
  assert.equal(both.counts.cssFound, 3);
  assert.equal(both.counts.javascriptFound, 4);
  assert.equal(both.counts.alreadyMinified, 2);
  assert.ok(both.ignored.filter((item) => item.reason === 'ALREADY_MINIFIED').every((item) => /\.min\.(?:js|css)$/i.test(item.normalizedPath)));

  const css = await scan(v2Config(root, { fileTypes: ['css'] }), { temporaryDirectory: temporary });
  assert.ok(css.eligible.length > 0);
  assert.ok(css.eligible.every((item) => item.fileType === 'css'));
  assert.ok(css.ignored.some((item) => item.fileType === 'javascript' && item.reason === 'UNSELECTED_TYPE'));

  const javascript = await scan(v2Config(root, { fileTypes: ['javascript'] }), { temporaryDirectory: temporary });
  assert.ok(javascript.eligible.length > 0);
  assert.ok(javascript.eligible.every((item) => item.fileType === 'javascript'));
  assert.ok(javascript.ignored.some((item) => item.fileType === 'css' && item.reason === 'UNSELECTED_TYPE'));
  assert.deepEqual(both, await scan(v2Config(root), { temporaryDirectory: temporary }));
}));

windowsTest('Scanner V2 não percorre ignoredFolders e bloqueia ignoredFiles por identidade Windows', async () => withFixture(async ({ root, temporary }) => {
  const result = await scan(v2Config(root, {
    ignoredFolders: ['SUB'],
    ignoredFiles: ['APP.js'],
  }), { temporaryDirectory: temporary });

  assert.ok(result.ignored.some((item) => item.relativePath.toLowerCase() === 'sub' && item.reason === 'IGNORED_FOLDER'));
  assert.ok(result.ignored.some((item) => item.relativePath.toLowerCase() === 'app.js' && item.reason === 'IGNORED_FILE'));
  assert.ok(!result.discovered.some((item) => item.relativePath.toLowerCase() === 'sub/nested.js'));
  assert.ok(!result.eligible.some((item) => item.relativePath.toLowerCase() === 'app.js'));
  assert.ok(result.ignored.some((item) => item.reason === 'MANDATORY_TECHNICAL_EXCLUSION'));
}));

windowsTest('Scanner V2 mantém arquivo somente leitura intacto e o classifica', async (t) => withFixture(async ({ root, temporary }) => {
  const readonly = join(root, 'readonly.js');
  await writeFile(readonly, 'const readonlyFile = 1;');
  await chmod(readonly, 0o444);
  if ((await lstat(readonly)).mode & 0o222) { t.skip('filesystem does not expose readonly mode'); return; }

  const result = await scan(v2Config(root), { temporaryDirectory: temporary });
  assert.ok(result.ignored.some((item) => item.relativePath === 'readonly.js' && item.reason === 'READONLY_FILE'));
  assert.notEqual((await lstat(readonly)).mode & 0o222, 0o222);
  await chmod(readonly, 0o666);
}));

windowsTest('Scanner V2 rejeita traversal e exclusões inseguras antes da descoberta', async () => withFixture(async ({ root, temporary }) => {
  await assert.rejects(
    scan({ ...v2Config(root), projectRoot: `${root}\\..\\escape` }, { temporaryDirectory: temporary }),
    (error) => error.code === 'UNSAFE_PROJECT_ROOT' && error.details.modified === false,
  );
  await assert.rejects(
    scan({ ...v2Config(root), ignoredFiles: ['..\\app.js'] }, { temporaryDirectory: temporary }),
    (error) => error.code === 'UNSAFE_V2_EXCLUSION' && error.details.modified === false,
  );
}));

windowsTest('Scanner V2 bloqueia junction filha e junction usada como raiz', async (t) => {
  const project = await fixture();
  const external = await mkdtemp(join(tmpdir(), 'selfminifier-scanner-external-'));
  const linkedRoot = join(tmpdir(), `selfminifier-scanner-root-link-${process.pid}-${Date.now()}`);
  try {
    await writeFile(join(external, 'outside.js'), 'const outside = 1;');
    try {
      await symlink(external, join(project.root, 'external-link'), 'junction');
      await symlink(project.root, linkedRoot, 'junction');
    } catch {
      t.skip('criação de junction indisponível');
      return;
    }

    const childResult = await scan(v2Config(project.root), { temporaryDirectory: project.temporary });
    assert.ok(childResult.ignored.some((item) => item.relativePath === 'external-link' && item.reason === 'LINK_IGNORED'));
    assert.ok(!childResult.eligible.some((item) => item.relativePath.includes('external-link')));

    const rootResult = await scan(v2Config(linkedRoot), { temporaryDirectory: project.temporary });
    assert.equal(rootResult.eligible.length, 0);
    assert.ok(rootResult.errors.some((item) => item.reason === 'UNSAFE_PROJECT_ROOT_LINK' && item.modified === false));
  } finally {
    await rm(linkedRoot, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
    await rm(project.root, { recursive: true, force: true });
  }
});

windowsTest('ignoredFiles também bloqueia alias por hard link quando a identidade física é comprovada', async (t) => withFixture(async ({ root, temporary }) => {
  try {
    await link(join(root, 'app.js'), join(root, 'app-alias.js'));
  } catch {
    t.skip('criação de hard link indisponível');
    return;
  }
  const result = await scan(v2Config(root, { ignoredFiles: ['app.js'] }), { temporaryDirectory: temporary });
  assert.ok(result.ignored.some((item) => item.relativePath === 'app.js' && item.reason === 'IGNORED_FILE'));
  assert.ok(result.ignored.some((item) => item.relativePath === 'app-alias.js' && item.reason === 'IGNORED_FILE_ALIAS'));
  assert.ok(!result.eligible.some((item) => ['app.js', 'app-alias.js'].includes(item.relativePath)));

  await link(join(root, 'site.css'), join(root, 'site-copy.css'));
  const conservative = await scan(v2Config(root), { temporaryDirectory: temporary });
  assert.ok(conservative.ignored.some((item) => item.relativePath === 'site.css' && item.reason === 'HARD_LINK_IGNORED'));
  assert.ok(conservative.ignored.some((item) => item.relativePath === 'site-copy.css' && item.reason === 'HARD_LINK_IGNORED'));
}));
