import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
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
import { writeJsonUtf8Atomic } from '../src/integrity/json-store.js';

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
    assert.equal(backup.compression, 'gzip');
    assert.equal(backup.backupRelativePath, 'exec-001/origem-001/sub/aplicação.js.gz');
    assert.notEqual(await readFile(backup.backupPath, 'utf8'), before);
    assert.equal(await readFile(sourcePath, 'utf8'), before);
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
    await assert.rejects(createValidatedSourceBackup({
      sourcePath,
      originRoot: join(root, 'origem'),
      backupRoot: join(root, '_source_versions'),
      executionId: 'exec-002',
      originId: 'origem-001',
    }, {
      hashDecompressed: async () => '0'.repeat(64),
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
    assert.equal(manifest.selfMinifierVersion, null);
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

test('persistência atômica repete EPERM transitório no Windows e mantém o mesmo rename seguro', async () => {
  const root = await temporaryTestDirectory();
  const targetPath = join(root, 'ultima-execucao.bkp');
  const original = '{"estado":"anterior"}\n';
  try {
    await writeFile(targetPath, original, 'utf8');
    let attempts = 0;
    let cleanupCalls = 0;
    const delays = [];
    await writeJsonUtf8Atomic(targetPath, { estado: 'novo' }, 'EXECUTION_JOURNAL', {
      platform: 'win32',
      rename: async (temporaryPath, destinationPath) => {
        attempts += 1;
        assert.equal(await readFile(targetPath, 'utf8'), original);
        if (attempts === 1) throw Object.assign(new Error('contenção transitória'), { code: 'EPERM' });
        return rename(temporaryPath, destinationPath);
      },
      wait: async (milliseconds) => { delays.push(milliseconds); },
      rm: async (...args) => { cleanupCalls += 1; return rm(...args); },
    });
    assert.equal(attempts, 2);
    assert.deepEqual(delays, [50]);
    assert.equal(cleanupCalls, 0);
    assert.deepEqual(JSON.parse(await readFile(targetPath, 'utf8')), { estado: 'novo' });
    assert.deepEqual(await readdir(root), ['ultima-execucao.bkp']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('persistência atômica aplica backoff limitado após múltiplos EPERM e então conclui', async () => {
  const root = await temporaryTestDirectory();
  const targetPath = join(root, 'estado.json');
  try {
    await writeFile(targetPath, '{"estado":"anterior"}\n', 'utf8');
    let attempts = 0;
    const delays = [];
    await writeJsonUtf8Atomic(targetPath, { estado: 'novo' }, 'TECHNICAL_STATE', {
      platform: 'win32',
      rename: async (temporaryPath, destinationPath) => {
        attempts += 1;
        if (attempts < 4) throw Object.assign(new Error(`contenção ${attempts}`), { code: 'EPERM' });
        return rename(temporaryPath, destinationPath);
      },
      wait: async (milliseconds) => { delays.push(milliseconds); },
    });
    assert.equal(attempts, 4);
    assert.deepEqual(delays, [50, 100, 200]);
    assert.deepEqual(JSON.parse(await readFile(targetPath, 'utf8')), { estado: 'novo' });
    assert.deepEqual(await readdir(root), ['estado.json']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('persistência atômica esgota EPERM de forma fail-closed e preserva diagnóstico', async () => {
  const root = await temporaryTestDirectory();
  const targetPath = join(root, 'ultima-execucao.bkp');
  const original = '{"estado":"anterior"}\n';
  try {
    await writeFile(targetPath, original, 'utf8');
    let attempts = 0;
    const delays = [];
    const simulatedCause = Object.assign(new Error('acesso negado durante rename'), { code: 'EPERM' });
    await assert.rejects(
      writeJsonUtf8Atomic(targetPath, { estado: 'novo' }, 'EXECUTION_JOURNAL', {
        platform: 'win32',
        rename: async () => { attempts += 1; throw simulatedCause; },
        wait: async (milliseconds) => { delays.push(milliseconds); },
      }),
      (error) => {
        assert.equal(error.code, 'EXECUTION_JOURNAL_WRITE_FAILED');
        assert.equal(error.details.causeCode, 'EPERM');
        assert.equal(error.details.causeMessage, 'acesso negado durante rename');
        assert.equal(error.details.operation, 'rename-temporary-to-target');
        assert.equal(error.details.targetPath, targetPath);
        assert.match(error.details.temporaryPath, /\.tmp$/);
        assert.equal(error.details.attempts, 4);
        assert.equal(error.details.cleanupCauseCode, null);
        return true;
      },
    );
    assert.equal(attempts, 4);
    assert.deepEqual(delays, [50, 100, 200]);
    assert.equal(await readFile(targetPath, 'utf8'), original);
    assert.deepEqual(await readdir(root), ['ultima-execucao.bkp']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('persistência atômica reporta falha de limpeza sem mascarar EPERM esgotado', async () => {
  const root = await temporaryTestDirectory();
  const targetPath = join(root, 'ultima-execucao.bkp');
  const original = '{"estado":"anterior"}\n';
  try {
    await writeFile(targetPath, original, 'utf8');
    const renameCause = Object.assign(new Error('contenção persistente'), { code: 'EPERM' });
    const cleanupCause = Object.assign(new Error('temporário ainda bloqueado'), { code: 'EACCES' });
    await assert.rejects(
      writeJsonUtf8Atomic(targetPath, { estado: 'novo' }, 'EXECUTION_JOURNAL', {
        platform: 'win32',
        rename: async () => { throw renameCause; },
        wait: async () => {},
        rm: async () => { throw cleanupCause; },
      }),
      (error) => {
        assert.equal(error.details.causeCode, 'EPERM');
        assert.equal(error.details.causeMessage, 'contenção persistente');
        assert.equal(error.details.attempts, 4);
        assert.equal(error.details.cleanupCauseCode, 'EACCES');
        assert.equal(error.details.cleanupCauseMessage, 'temporário ainda bloqueado');
        return true;
      },
    );
    assert.equal(await readFile(targetPath, 'utf8'), original);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('persistência atômica não repete erro estrutural de rename', async () => {
  const root = await temporaryTestDirectory();
  const targetPath = join(root, 'estado.json');
  try {
    let attempts = 0;
    let waits = 0;
    await assert.rejects(
      writeJsonUtf8Atomic(targetPath, { estado: 'novo' }, 'TECHNICAL_STATE', {
        platform: 'win32',
        rename: async () => {
          attempts += 1;
          throw Object.assign(new Error('destino estruturalmente inválido'), { code: 'ENOTDIR' });
        },
        wait: async () => { waits += 1; },
      }),
      (error) => error.details.causeCode === 'ENOTDIR' && error.details.attempts === 1,
    );
    assert.equal(attempts, 1);
    assert.equal(waits, 0);
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('persistência atômica não repete EPERM fora do Windows', async () => {
  const root = await temporaryTestDirectory();
  const targetPath = join(root, 'estado.json');
  try {
    let attempts = 0;
    await assert.rejects(
      writeJsonUtf8Atomic(targetPath, { estado: 'novo' }, 'TECHNICAL_STATE', {
        platform: 'linux',
        rename: async () => {
          attempts += 1;
          throw Object.assign(new Error('falha EPERM não Windows'), { code: 'EPERM' });
        },
        wait: async () => { assert.fail('não deveria aguardar fora do Windows'); },
      }),
      (error) => error.details.causeCode === 'EPERM' && error.details.attempts === 1,
    );
    assert.equal(attempts, 1);
    assert.deepEqual(await readdir(root), []);
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
    const result = await scan({
      schemaVersion: 2,
      engine: 'esbuild',
      profile: 'Padrao',
      outputMode: 'PreservarOriginaisECriarMinificados',
      projectRoot: root,
      fileTypes: ['javascript'],
      ignoredFolders: [],
      ignoredFiles: [],
    }, { runtimeRoot: root });
    assert.ok(result.eligible.some((item) => item.normalizedPath.endsWith('app.js')));
    assert.ok(result.ignored.some((item) => item.normalizedPath === temporaryDirectory && item.reason === 'MANDATORY_TECHNICAL_EXCLUSION'));
    assert.ok(!result.eligible.some((item) => item.normalizedPath.endsWith('interno.js')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
