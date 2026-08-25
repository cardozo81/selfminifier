import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAnalysis, buildCandidateList, paginate, DEFAULT_PAGE_SIZE } from '../src/scanner/index.js';
import { scan } from '../src/scanner/index.js';
import { validateV2Configuration } from '../src/configuration/v2.js';
import { runBridgeRequest } from '../src/app/bridge.mjs';

function scannerResult({ eligible = [], ignored = [], counts = {}, errors = [], warnings = [] } = {}) {
  return { discovered: [], eligible, ignored, warnings, errors, counts };
}

test('buildAnalysis expõe contagens do resultado do scanner sem reclassificar', () => {
  const result = scannerResult({
    eligible: [
      { relativePath: 'assets/a.css', fileType: 'css', sourceId: 'project-root' },
      { relativePath: 'src/app.js', fileType: 'javascript', sourceId: 'project-root' },
    ],
    ignored: [
      { relativePath: 'bundle.min.js', fileType: 'javascript', sourceId: 'project-root', reason: 'ALREADY_MINIFIED' },
      { relativePath: 'readonly.js', fileType: 'javascript', sourceId: 'project-root', reason: 'READONLY_FILE' },
    ],
    counts: { cssFound: 1, javascriptFound: 3, ignored: 2, alreadyMinified: 1, eligible: 2 },
  });

  const analysis = buildAnalysis(result, {
    projectRoot: 'C:\\Projetos\\MeuSite',
    fileTypes: ['css', 'javascript'],
    ignoredFolders: ['vendor', 'gerado'],
    ignoredFiles: ['src\\config.js'],
  });

  assert.equal(analysis.counts.cssFound, 1);
  assert.equal(analysis.counts.javascriptFound, 3);
  assert.equal(analysis.counts.ignored, 2);
  assert.equal(analysis.counts.alreadyMinified, 1);
  assert.equal(analysis.counts.eligible, 2);
  assert.deepEqual(analysis.exclusions, { folders: 2, files: 1 });
  assert.deepEqual(analysis.candidates.css.map((item) => item.relativePath), ['assets/a.css']);
  assert.deepEqual(analysis.candidates.javascript.map((item) => item.relativePath), ['src/app.js']);
});

test('candidatos são agrupados e ordenados deterministicamente', () => {
  const result = scannerResult({
    eligible: [
      { relativePath: 'src/utils.js', fileType: 'javascript', sourceId: 'project-root' },
      { relativePath: 'assets/home.css', fileType: 'css', sourceId: 'project-root' },
      { relativePath: 'src/app.js', fileType: 'javascript', sourceId: 'project-root' },
      { relativePath: 'assets/site.css', fileType: 'css', sourceId: 'project-root' },
    ],
    counts: { cssFound: 2, javascriptFound: 2, ignored: 0, alreadyMinified: 0, eligible: 4 },
  });

  const analysis = buildAnalysis(result, { projectRoot: 'C:\\Projetos\\MeuSite', fileTypes: ['css', 'javascript'] });
  assert.deepEqual(analysis.candidates.css.map((item) => item.relativePath), ['assets/home.css', 'assets/site.css']);
  assert.deepEqual(analysis.candidates.javascript.map((item) => item.relativePath), ['src/app.js', 'src/utils.js']);
  assert.deepEqual(buildCandidateList(analysis.candidates).map((item) => item.relativePath), [
    'assets/home.css', 'assets/site.css', 'src/app.js', 'src/utils.js',
  ]);
});

test('buildReasonBreakdown preserva razões distintas em ordem determinística', () => {
  const result = scannerResult({
    ignored: [
      { reason: 'ALREADY_MINIFIED' },
      { reason: 'READONLY_FILE' },
      { reason: 'IGNORED_FOLDER' },
      { reason: 'IGNORED_FILE' },
      { reason: 'ALREADY_MINIFIED' },
    ],
    counts: { cssFound: 0, javascriptFound: 0, ignored: 5, alreadyMinified: 2, eligible: 0 },
  });

  const analysis = buildAnalysis(result, {});
  assert.deepEqual(analysis.ignoredByReason, [
    { reason: 'IGNORED_FOLDER', label: 'Pastas ignoradas', count: 1 },
    { reason: 'IGNORED_FILE', label: 'Arquivos ignorados', count: 1 },
    { reason: 'READONLY_FILE', label: 'Somente leitura', count: 1 },
    { reason: 'ALREADY_MINIFIED', label: 'Já minificado', count: 2 },
  ]);
});

test('paginate limita a saída, calcula páginas e estabiliza página fora do intervalo', () => {
  const items = Array.from({ length: 25 }, (_, index) => `arquivo-${index}`);
  const first = paginate(items, 1, DEFAULT_PAGE_SIZE);
  assert.equal(first.page, 1);
  assert.equal(first.pageSize, 10);
  assert.equal(first.totalItems, 25);
  assert.equal(first.totalPages, 3);
  assert.equal(first.items.length, 10);
  assert.equal(first.items[0], 'arquivo-0');

  const last = paginate(items, 3, DEFAULT_PAGE_SIZE);
  assert.equal(last.items.length, 5);
  assert.equal(last.items[0], 'arquivo-20');

  const beyond = paginate(items, 99, DEFAULT_PAGE_SIZE);
  assert.equal(beyond.page, 3);
  assert.equal(beyond.items.length, 5);

  const before = paginate(items, 0, DEFAULT_PAGE_SIZE);
  assert.equal(before.page, 1);

  const empty = paginate([], 1, DEFAULT_PAGE_SIZE);
  assert.equal(empty.totalItems, 0);
  assert.equal(empty.totalPages, 1);
  assert.equal(empty.items.length, 0);
});

const windowsTest = process.platform === 'win32' ? test : test.skip;

windowsTest('análise consome o resultado do scanner V2 sem segunda varredura', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'selfminifier-analysis-'));
  try {
    await writeFile(join(root, 'app.js'), 'const app = 1;');
    await writeFile(join(root, 'site.css'), 'body {}');
    await writeFile(join(root, 'bundle.min.js'), 'const min = 1;');
    await writeFile(join(root, 'notes.txt'), 'ignorado');
    await mkdir(join(root, 'vendor'), { recursive: true });
    await writeFile(join(root, 'vendor', 'vendored.js'), 'const vendor = 1;');
    const readonlyPath = join(root, 'readonly.js');
    await writeFile(readonlyPath, 'const ro = 1;');
    await chmod(readonlyPath, 0o444);
    if ((await lstat(readonlyPath)).mode & 0o222) { t.skip('filesystem does not expose readonly mode'); return; }

    const configuration = validateV2Configuration({
      engine: 'esbuild',
      profile: 'Padrao',
      projectRoot: root,
      fileTypes: ['css', 'javascript'],
      ignoredFolders: ['vendor'],
      ignoredFiles: ['app.js'],
    }, { allowedEngines: new Set(['esbuild']) });

    const result = await scan(configuration, { runtimeRoot: root });
    const analysis = buildAnalysis(result, {
      projectRoot: configuration.projectRoot,
      fileTypes: configuration.fileTypes,
      ignoredFolders: configuration.ignoredFolders,
      ignoredFiles: configuration.ignoredFiles,
    });

    assert.equal(analysis.counts.cssFound, 1);
    assert.equal(analysis.counts.javascriptFound, 3);
    assert.equal(analysis.counts.eligible, 1);
    assert.equal(analysis.counts.alreadyMinified, 1);
    assert.equal(analysis.exclusions.folders, 1);
    assert.equal(analysis.exclusions.files, 1);

    assert.deepEqual(analysis.candidates.css.map((item) => item.relativePath), ['site.css']);
    assert.deepEqual(analysis.candidates.javascript, []);
    assert.ok(analysis.ignoredByReason.some((entry) => entry.reason === 'ALREADY_MINIFIED' && entry.count === 1));
    assert.ok(analysis.ignoredByReason.some((entry) => entry.reason === 'IGNORED_FILE' && entry.count === 1));
    assert.ok(analysis.ignoredByReason.some((entry) => entry.reason === 'IGNORED_FOLDER' && entry.count === 1));
    assert.ok(analysis.ignoredByReason.some((entry) => entry.reason === 'READONLY_FILE' && entry.count === 1));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

windowsTest('bridge scan-analysis retorna contagens e candidatos confiáveis', async () => {
  const root = await mkdtemp(join(tmpdir(), 'selfminifier-analysis-bridge-'));
  const project = join(root, 'site');
  try {
    await mkdir(project, { recursive: true });
    await mkdir(join(root, 'Configuracao'), { recursive: true });
    await writeFile(join(project, 'app.js'), 'const app = 1;');
    await writeFile(join(project, 'site.css'), 'body {}');
    await writeFile(join(project, 'bundle.min.js'), 'const min = 1;');
    await writeFile(join(project, 'ignored.js'), 'const ignored = 1;');
    await writeFile(join(root, 'Configuracao', 'configuracao.ini'), [
      '[Configuracao]',
      'VersaoSchema=2',
      'Motor=esbuild',
      'Perfil=Padrao',
      'ModoSaida=PreservarOriginaisECriarMinificados',
      `PastaRaiz=${project}`,
      'TiposArquivo=CSS+JavaScript',
      'IgnorarArquivo01=ignored.js',
      '',
    ].join('\n'), 'utf8');

    const response = await runBridgeRequest({ command: 'scan-analysis' }, { projectRoot: root });
    assert.equal(response.ok, true);
    assert.equal(response.schema, 'v2');
    assert.equal(response.analysis.projectRoot, project);
    assert.equal(response.analysis.counts.cssFound, 1);
    assert.equal(response.analysis.counts.javascriptFound, 3);
    assert.equal(response.analysis.counts.eligible, 2);
    assert.equal(response.analysis.counts.alreadyMinified, 1);
    assert.equal(response.analysis.counts.ignored, 2);
    assert.deepEqual(response.analysis.candidates.css.map((item) => item.relativePath), ['site.css']);
    assert.deepEqual(response.analysis.candidates.javascript.map((item) => item.relativePath), ['app.js']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

windowsTest('bridge scan-analysis exige configuração V2', async () => {
  const root = await mkdtemp(join(tmpdir(), 'selfminifier-analysis-legacy-'));
  try {
    await mkdir(join(root, 'Configuracao'), { recursive: true });
    await writeFile(join(root, 'Configuracao', 'configuracao.ini'), [
      '[Configuracao]',
      'Motor=esbuild',
      'Perfil=Padrao',
      'ModoSaida=PreservarOriginaisECriarMinificados',
      'Incluir01=**/*.js',
      '',
      '[Origem.001]',
      'Tipo=Diretorio',
      `Caminho=${root}`,
      'ExecutarPorPadrao=true',
      'Recursivo=true',
      'Modo=Todos',
      '',
    ].join('\n'), 'utf8');

    const response = await runBridgeRequest({ command: 'scan-analysis' }, { projectRoot: root });
    assert.equal(response.ok, false);
    assert.equal(response.code, 'V2_CONFIGURATION_REQUIRED');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
