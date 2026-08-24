import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  IntegrityError,
  createBackupManifest,
  createBackupManifestEntry,
  createValidatedSourceBackup,
  hashFileSha256,
  readBackupManifest,
  readTechnicalState,
  writeBackupManifest,
  writeTechnicalState,
} from '../src/integrity/index.js';
import { scan } from '../src/scanner/index.js';

async function temporaryTestDirectory() {
  return mkdtemp(join(tmpdir(), 'selfminifier-integrity-'));
}

test('SHA-256 conhecido é hexadecimal minúsculo e arquivos reais falham explicitamente', async () => {
  const root = await temporaryTestDirectory();
  try {
    const filePath = join(root, 'conteúdo-ç.txt');
    await writeFile(filePath, 'abc', 'utf8');
    assert.equal(await hashFileSha256(filePath), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    await assert.rejects(hashFileSha256(join(root, 'ausente.txt')), (error) => (
      error instanceof IntegrityError && error.code === 'FILE_HASH_FAILED'
    ));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('backup da fonte é criado e validado sem alterar a origem', async () => {
  const root = await temporaryTestDirectory();
  try {
    const originRoot = join(root, 'Origem com ç');
    const sourcePath = join(originRoot, 'sub', 'aplicação.js');
    const backupRoot = join(root, '_source_versions');
    await mkdir(join(originRoot, 'sub'), { recursive: true });
    await writeFile(sourcePath, 'const saudação = "olá";\n', 'utf8');
    const before = await readFile(sourcePath, 'utf8');
    const backup = await createValidatedSourceBackup({ sourcePath, originRoot, backupRoot, executionId: 'exec-001', originId: 'origem-001' });
    assert.equal(backup.valid, true);
    assert.equal(backup.originalSha256, backup.backupSha256);
    assert.equal(await readFile(backup.backupPath, 'utf8'), before);
    assert.equal(await readFile(sourcePath, 'utf8'), before);
    assert.equal(backup.backupRelativePath, 'exec-001/origem-001/sub/aplicação.js');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('falha de validação de hash rejeita o backup', async () => {
  const root = await temporaryTestDirectory();
  try {
    const sourcePath = join(root, 'origem', 'app.js');
    await mkdir(join(root, 'origem'));
    await writeFile(sourcePath, 'const value = 1;');
    let call = 0;
    await assert.rejects(createValidatedSourceBackup({
      sourcePath,
      originRoot: join(root, 'origem'),
      backupRoot: join(root, '_source_versions'),
      executionId: 'exec-002',
      originId: 'origem-001',
    }, {
      hashFile: async (filePath) => (++call === 1 ? hashFileSha256(filePath) : '0'.repeat(64)),
    }), (error) => error instanceof IntegrityError && error.code === 'BACKUP_HASH_MISMATCH');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('origens distintas com o mesmo nome relativo não colidem', async () => {
  const root = await temporaryTestDirectory();
  try {
    const backupRoot = join(root, '_source_versions');
    const first = join(root, 'primeira', 'app.js');
    const second = join(root, 'segunda', 'app.js');
    await mkdir(join(root, 'primeira'));
    await mkdir(join(root, 'segunda'));
    await writeFile(first, 'const first = 1;');
    await writeFile(second, 'const second = 2;');
    const firstBackup = await createValidatedSourceBackup({ sourcePath: first, originRoot: join(root, 'primeira'), backupRoot, executionId: 'exec-003', originId: 'origem-001' });
    const secondBackup = await createValidatedSourceBackup({ sourcePath: second, originRoot: join(root, 'segunda'), backupRoot, executionId: 'exec-003', originId: 'origem-002' });
    assert.notEqual(firstBackup.backupPath, secondBackup.backupPath);
    assert.notEqual(firstBackup.backupSha256, secondBackup.backupSha256);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('manifesto UTF-8 faz round-trip e explicita campos futuros indisponíveis', async () => {
  const root = await temporaryTestDirectory();
  try {
    const sourcePath = join(root, 'origem-ç', 'app.js');
    const backupRoot = join(root, '_source_versions');
    await mkdir(join(root, 'origem-ç'));
    await writeFile(sourcePath, 'const café = true;', 'utf8');
    const backup = await createValidatedSourceBackup({ sourcePath, originRoot: join(root, 'origem-ç'), backupRoot, executionId: 'exec-004', originId: 'origem-001' });
    const manifest = createBackupManifest({
      executionId: 'exec-004',
      timestamp: '2026-08-21T10:15:00.000Z',
      origins: [{ originId: 'origem-001', rootPath: join(root, 'origem-ç') }],
      files: [createBackupManifestEntry(backup)],
    });
    const manifestPath = join(backupRoot, 'exec-004', 'manifest.json');
    await writeBackupManifest(manifestPath, manifest);
    assert.deepEqual(await readBackupManifest(manifestPath), manifest);
    assert.equal(manifest.meminifyVersion, null);
    assert.equal(manifest.files[0].minifiedSha256, null);
    assert.equal(manifest.files[0].minifiedSize, null);
    assert.match(await readFile(manifestPath, 'utf8'), /origem-ç/);
    await writeFile(join(root, 'corrupt-manifest.json'), '{ inválido', 'utf8');
    await assert.rejects(readBackupManifest(join(root, 'corrupt-manifest.json')), (error) => error instanceof IntegrityError && error.code === 'MANIFEST_INVALID_JSON');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('estado técnico faz round-trip e estado inválido falha fechado', async () => {
  const root = await temporaryTestDirectory();
  try {
    const statePath = join(root, 'Dados', 'estado.json');
    const state = {
      formatVersion: 1,
      records: [{
        sourcePath: join(root, 'origem', 'aplicação.js'),
        outputPath: null,
        sourceHash: 'a'.repeat(64),
        minifiedHash: null,
        outputMode: 'BackupESobrescreverOriginais',
        minificationTimestamp: null,
        engine: null,
        engineVersion: null,
        profile: null,
        sourceSize: 20,
        minifiedSize: null,
      }],
    };
    await writeTechnicalState(state, statePath);
    assert.deepEqual(await readTechnicalState(statePath), state);
    await writeFile(statePath, '{"formatVersion":1,"records":[{}]}', 'utf8');
    await assert.rejects(readTechnicalState(statePath), (error) => error instanceof IntegrityError && error.code === 'INVALID_TECHNICAL_STATE');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Dados/Temporarios é exclusão técnica obrigatória do scanner', async () => {
  const root = await temporaryTestDirectory();
  try {
    const temporaryDirectory = join(root, 'Dados', 'Temporarios');
    await mkdir(temporaryDirectory, { recursive: true });
    await writeFile(join(root, 'app.js'), 'const app = 1;');
    await writeFile(join(temporaryDirectory, 'interno.js'), 'const interno = 1;');
    const result = await scan({ globalIncludes: ['**/*.js'], globalExcludes: [], sources: [{ id: 'origem-001', path: root, type: 'Diretorio', recursive: true, mode: 'Todos', includes: [], excludes: [] }] }, { runtimeRoot: root });
    assert.ok(result.eligible.some((item) => item.normalizedPath.endsWith('app.js')));
    assert.ok(result.ignored.some((item) => item.normalizedPath === temporaryDirectory && item.reason === 'MANDATORY_TECHNICAL_EXCLUSION'));
    assert.ok(!result.eligible.some((item) => item.normalizedPath.endsWith('interno.js')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
