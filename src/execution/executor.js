import { access, constants, lstat, realpath } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { OUTPUT_MODES } from '../domain/index.js';
import {
  ARTIFACT_ID_PATTERN,
  assertHistoricalExecutionWritable,
  createHistoricalIndex,
  createHistoricalExecutionRecord,
  generateArtifactId,
  historicalExecutionRecordHash,
  insertSelfMinifierTag,
  resolveHistoricalExecutionPath,
  createBackupManifest,
  createBackupManifestEntry,
  createValidatedSourceBackup,
  assertPathHasNoLinks,
  proveDirectoryWritable,
  writeBackupManifest,
  writeHistoricalExecutionRecord,
  writeTechnicalState,
} from '../integrity/index.js';
import {
  createNewFileExact,
  createValidatedRecoveryCopy,
  hashContentSha256,
  inspectRegularFile,
  readSourceUtf8Snapshot,
  removeExactFile,
  replaceFileExact,
} from './filesystem.js';
import { ExecutionError } from './errors.js';
import { writeExecutionJournal } from './journal.js';
import { recoverInterruptedExecution, rollbackExecutionJournal } from './recovery.js';
import { validateCalculatedExecutionRisk } from './risk.js';

function clone(value) {
  return structuredClone(value);
}

function pathIdentity(filePath) {
  const normalized = normalize(resolve(filePath));
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isInside(rootPath, candidatePath) {
  const relativePath = relative(rootPath, candidatePath);
  return relativePath === '' || (
    !isAbsolute(relativePath)
    && relativePath !== '..'
    && !relativePath.startsWith(`..${sep}`)
  );
}

function expectedMinifiedPath(sourcePath) {
  const extension = extname(sourcePath);
  return `${sourcePath.slice(0, -extension.length)}.min${extension}`;
}

async function assertV2ItemSecurityAtWriteTime(plan, item) {
  if (![2, 3].includes(plan.configurationSchemaVersion)) return;
  const projectRoot = normalize(resolve(plan.sources[0]?.path ?? ''));
  const sourcePath = normalize(resolve(item.sourcePath));
  const destinationPath = normalize(resolve(item.destinationPath));
  const expectedDestination = plan.outputMode === OUTPUT_MODES.BACKUP_OVERWRITE
    ? sourcePath
    : expectedMinifiedPath(sourcePath);
  if (
    !projectRoot
    || !isInside(projectRoot, sourcePath)
    || !isInside(projectRoot, destinationPath)
    || pathIdentity(destinationPath) !== pathIdentity(expectedDestination)
    || pathIdentity(dirname(destinationPath)) !== pathIdentity(dirname(sourcePath))
  ) {
    throw new ExecutionError('V2_WRITE_OUTSIDE_PROJECT_ROOT', 'A origem ou o destino V2 não permanece confinado à raiz autorizada.', {
      projectRoot,
      sourcePath,
      destinationPath,
    });
  }

  try {
    await assertPathHasNoLinks(projectRoot);
    await assertPathHasNoLinks(sourcePath);
    await assertPathHasNoLinks(dirname(destinationPath));
    const canonicalRoot = normalize(resolve(await realpath(projectRoot)));
    const canonicalSource = normalize(resolve(await realpath(sourcePath)));
    const canonicalDestinationDirectory = normalize(resolve(await realpath(dirname(destinationPath))));
    if (
      pathIdentity(canonicalRoot) !== pathIdentity(projectRoot)
      || !isInside(canonicalRoot, canonicalSource)
      || !isInside(canonicalRoot, canonicalDestinationDirectory)
    ) {
      throw new ExecutionError('V2_WRITE_PATH_INDIRECTION', 'A prova canônica da origem ou do destino V2 não corresponde à raiz autorizada.');
    }
    const stats = await lstat(sourcePath, { bigint: true });
    const writeMask = typeof stats.mode === 'bigint' ? 0o222n : 0o222;
    const noWriteBits = typeof stats.mode === 'bigint' ? 0n : 0;
    if (!stats.isFile() || stats.isSymbolicLink() || Number(stats.nlink) > 1) {
      throw new ExecutionError('V2_UNSAFE_SOURCE_AT_EXECUTION', 'A fonte V2 deixou de ser um arquivo regular com identidade física exclusiva.');
    }
    if ((stats.mode & writeMask) === noWriteBits) {
      throw new ExecutionError('READONLY_SOURCE_AT_EXECUTION', 'A fonte V2 tornou-se somente leitura após a análise.');
    }
    await access(sourcePath, constants.W_OK);
  } catch (cause) {
    if (cause instanceof ExecutionError) throw cause;
    throw new ExecutionError('V2_WRITE_SECURITY_REVALIDATION_FAILED', 'A segurança da origem ou do destino V2 não pôde ser comprovada no momento da escrita.', { cause });
  }
}

function operationFor(plan, item) {
  if (plan.outputMode === OUTPUT_MODES.BACKUP_OVERWRITE) return 'overwrite-original';
  return item.destinationExistedAtPlan ? 'replace-output' : 'create-output';
}

function plannedRecoveryPath(plan, item) {
  if (plan.outputMode === OUTPUT_MODES.BACKUP_OVERWRITE) {
    const relativePath = item.originRoot === item.sourcePath
      ? basename(item.sourcePath)
      : relative(item.originRoot, item.sourcePath);
    return join(plan.backupRoot, plan.executionId, item.backupOriginId, relativePath);
  }
  if (item.destinationExistedAtPlan) {
    return join(plan.runtimePaths.recoveryDirectory, plan.executionId, item.id, 'saida-preexistente.bkp');
  }
  return null;
}

function allocateArtifactId(generator, historyIndex) {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const artifactId = generator();
    if (!ARTIFACT_ID_PATTERN.test(artifactId)) throw new ExecutionError('ARTIFACT_ID_GENERATION_FAILED', 'O gerador produziu um artifactId fora do contrato aprovado.');
    if (historyIndex.reserveArtifactId(artifactId)) return artifactId;
  }
  throw new ExecutionError('ARTIFACT_ID_COLLISION', 'Não foi possível gerar um artifactId único para a execução.');
}

function createArtifactProvenance(plan, item, journalItem, outputHash, outputSize, backup) {
  return {
    artifactId: journalItem.artifactId,
    sourcePath: item.sourcePath,
    outputPath: item.destinationPath,
    inputHash: item.sourceHash,
    outputHash,
    sourceSize: item.sourceSize,
    outputSize,
    engine: plan.engine.id,
    engineVersion: plan.engine.version,
    profile: plan.profile,
    outputMode: plan.outputMode,
    timestamp: plan.timestamp,
    backup: backup ? {
      available: true,
      backupRoot: plan.backupRoot,
      backupRelativePath: backup.backupRelativePath,
      originalHash: backup.originalSha256,
      compression: backup.compression ?? 'none',
    } : {
      available: false,
      backupRoot: null,
      backupRelativePath: null,
      originalHash: null,
      compression: 'none',
    },
  };
}

function createJournal(plan) {
  const manifestPath = plan.outputMode === OUTPUT_MODES.BACKUP_OVERWRITE
    ? join(plan.backupRoot, plan.executionId, 'manifest.json')
    : null;
  return {
    formatVersion: 1,
    executionId: plan.executionId,
    meminifyVersion: plan.meminifyVersion ?? null,
    timestamp: plan.timestamp,
    outputMode: plan.outputMode,
    executionRisk: clone(plan.executionRisk),
    status: 'planned',
    statePath: plan.runtimePaths.technicalState,
    stateBefore: clone(plan.stateBefore),
    manifestPath,
    manifestStatus: manifestPath ? 'planned' : 'not-applicable',
    manifestExpectedHash: null,
    historyPath: resolveHistoricalExecutionPath(plan.runtimePaths.historyDirectory, plan.executionId),
    historyStatus: 'planned',
    historyExpectedHash: null,
    items: plan.items.map((item) => ({
      id: item.id,
      artifactId: null,
      sourcePath: item.sourcePath,
      destinationPath: item.destinationPath,
      operation: operationFor(plan, item),
      status: 'planned',
      sourceHash: item.sourceHash,
      previousHash: item.destinationExistedAtPlan ? item.destinationHashAtPlan : null,
      expectedOutputHash: null,
      plannedRecoveryPath: plannedRecoveryPath(plan, item),
      recovery: null,
      stateRecorded: false,
    })),
  };
}

function upsertStateRecord(state, plan, item, artifactId, outputHash, outputSize) {
  const identity = process.platform === 'win32' ? item.sourcePath.toLowerCase() : item.sourcePath;
  const records = state.records.filter((record) => (
    (process.platform === 'win32' ? record.sourcePath?.toLowerCase() : record.sourcePath) !== identity
  ));
  records.push({
    executionId: plan.executionId,
    artifactId,
    sourcePath: item.sourcePath,
    outputPath: item.destinationPath,
    sourceHash: item.sourceHash,
    minifiedHash: outputHash,
    outputMode: plan.outputMode,
    minificationTimestamp: plan.timestamp,
    engine: plan.engine.id,
    engineVersion: plan.engine.version,
    profile: plan.profile,
    executionRisk: plan.executionRisk.technicalLevel,
    sourceSize: item.sourceSize,
    minifiedSize: outputSize,
  });
  records.sort((left, right) => left.sourcePath.localeCompare(right.sourcePath));
  return { formatVersion: 1, records };
}

async function prepareRecovery(plan, item, journalItem, dependencies) {
  if (journalItem.operation === 'overwrite-original') {
    const currentRoot = await proveDirectoryWritable(plan.backupRoot);
    if (
      currentRoot.canonicalPath !== plan.backupRootCanonicalPath
      || currentRoot.physicalIdentity !== plan.backupRootPhysicalIdentity
    ) {
      throw new ExecutionError('BACKUP_ROOT_IDENTITY_CHANGED', 'A raiz física de backup mudou depois da pré-análise.', {
        backupRoot: plan.backupRoot,
        expectedCanonicalPath: plan.backupRootCanonicalPath,
        actualCanonicalPath: currentRoot.canonicalPath,
        expectedIdentity: plan.backupRootPhysicalIdentity,
        actualIdentity: currentRoot.physicalIdentity,
      });
    }
    const backup = await createValidatedSourceBackup({
      sourcePath: item.sourcePath,
      originRoot: item.originRoot,
      backupRoot: plan.backupRoot,
      expectedBackupRootIdentity: plan.backupRootPhysicalIdentity,
      executionId: plan.executionId,
      originId: item.backupOriginId,
    }, dependencies.backupDependencies);
    journalItem.recovery = { type: 'source-backup', path: backup.backupPath, hash: backup.backupSha256, compression: backup.compression ?? 'none' };
    return backup;
  }
  if (journalItem.operation === 'replace-output') {
    const current = await inspectRegularFile(item.destinationPath);
    if (!current.exists || current.hash !== item.destinationHashAtPlan) {
      throw new ExecutionError('TARGET_CHANGED', `O destino preexistente mudou após a pré-análise: ${item.destinationPath}.`);
    }
    const recovery = await createValidatedRecoveryCopy(item.destinationPath, journalItem.plannedRecoveryPath);
    journalItem.recovery = { type: 'preexisting-output', path: recovery.path, hash: recovery.hash };
  }
  return null;
}

function validateExecutionAuthorization(plan, options) {
  if (plan.status !== 'ready' || plan.diagnostics.blockers.length > 0) throw new ExecutionError('PLAN_BLOCKED', 'A pré-análise contém bloqueios e não pode ser executada.');
  if (options.confirmed !== true) throw new ExecutionError('EXECUTION_CONFIRMATION_REQUIRED', 'A execução exige confirmação explícita do chamador.');
  const authorizedConflictCount = plan.conflictPolicy === 'skip-existing' ? 0 : plan.conflicts.length;
  if (!validateCalculatedExecutionRisk(plan.executionRisk, { outputMode: plan.outputMode, profile: plan.profile, conflictCount: authorizedConflictCount })) {
    throw new ExecutionError('RISK_CALCULATION_REQUIRED', 'A execução exige uma classificação determinística de risco antes de qualquer mutação.');
  }
  if (plan.conflictPolicy !== 'skip-existing' && plan.conflicts.length > 0 && options.authorizeOverwriteConflicts !== true) return false;
  return true;
}

export async function executePlan(plan, minifier, options = {}, dependencies = {}) {
  if (!validateExecutionAuthorization(plan, options)) {
    return { status: 'cancelled', reason: 'CONFLICT_AUTHORIZATION_REQUIRED', conflicts: clone(plan.conflicts) };
  }
  if (!minifier || minifier.id !== plan.engine.id || minifier.version !== plan.engine.version) {
    throw new ExecutionError('MINIFIER_MISMATCH', 'O minificador da execução não corresponde ao plano imutável.');
  }

  await recoverInterruptedExecution(plan.runtimePaths.lastExecutionJournal);
  const persistHistory = dependencies.writeHistoricalExecutionRecord ?? writeHistoricalExecutionRecord;
  const buildHistoryIndex = dependencies.createHistoricalIndex ?? createHistoricalIndex;
  const historyPath = await assertHistoricalExecutionWritable(plan.runtimePaths.historyDirectory, plan.executionId);
  const historyIndex = await buildHistoryIndex(plan.runtimePaths.historyDirectory);
  if ([2, 3].includes(plan.configurationSchemaVersion) && plan.items.length === 0) {
    const history = createHistoricalExecutionRecord({
      executionId: plan.executionId,
      meminifyVersion: options.meminifyVersion ?? plan.meminifyVersion ?? null,
      timestamp: plan.timestamp,
      outputMode: plan.outputMode,
      projectRoot: plan.sources[0].path,
      artifacts: [],
    });
    const expectedHistoryHash = historicalExecutionRecordHash(history);
    try {
      await persistHistory(plan.runtimePaths.historyDirectory, history, { historyIndex, createHistoricalIndex: buildHistoryIndex });
      const writtenHistory = await inspectRegularFile(historyPath);
      if (!writtenHistory.exists || writtenHistory.hash !== expectedHistoryHash) {
        throw new ExecutionError('HISTORY_HASH_MISMATCH', 'O histórico persistido não corresponde à execução sem artefatos.');
      }
    } catch (cause) {
      const writtenHistory = await inspectRegularFile(historyPath).catch(() => ({ exists: false, hash: null }));
      if (writtenHistory.exists && (writtenHistory.hash !== expectedHistoryHash || !await removeExactFile(historyPath, expectedHistoryHash))) {
        throw new ExecutionError('RECOVERY_REQUIRED', 'A persistência histórica da execução sem artefatos ficou ambígua.', { cause, historyPath });
      }
      throw cause;
    }
    return {
      status: 'completed',
      executionId: plan.executionId,
      items: [],
      conflicts: clone(plan.conflicts),
      counts: {
        eligible: plan.scannerResult?.eligible?.length ?? 0,
        planned: 0,
        createdSuccessfully: 0,
        skippedConflicts: plan.conflicts.length,
        failed: 0,
      },
      summary: {
        processedCount: 0,
        originalBytes: 0,
        finalBytes: 0,
        reductionBytes: 0,
        reductionPercent: 0,
      },
      noFilesChanged: true,
      journalRecorded: false,
      manifestPath: null,
      historyPath,
    };
  }
  const journal = createJournal(plan);
  const journalPath = plan.runtimePaths.lastExecutionJournal;
  const persistJournal = dependencies.writeExecutionJournal ?? writeExecutionJournal;
  const workingState = clone(plan.stateBefore.value);
  const backupManifestEntries = [];
  const historicalArtifacts = [];
  await persistJournal(journalPath, journal);
  journal.status = 'prepared';
  await persistJournal(journalPath, journal);

  let summaryProcessedCount = 0;
  let summaryOriginalBytes = 0;
  let summaryFinalBytes = 0;

  try {
    journal.status = 'running';
    await persistJournal(journalPath, journal);
    for (let index = 0; index < plan.items.length; index += 1) {
      const item = plan.items[index];
      const journalItem = journal.items[index];
      await dependencies.hooks?.beforeItem?.({ item: clone(item), index });
      await assertV2ItemSecurityAtWriteTime(plan, item);
      let sourceSnapshot;
      try {
        sourceSnapshot = await (dependencies.readSourceUtf8Snapshot ?? readSourceUtf8Snapshot)(item.sourcePath);
      } catch (cause) {
        if (cause?.code === 'SOURCE_READ_FAILED' && cause.details?.cause?.code === 'ENOENT') {
          throw new ExecutionError('SOURCE_CHANGED', `A fonte mudou após a pré-análise: ${item.sourcePath}.`);
        }
        throw cause;
      }
      if (sourceSnapshot.hash !== item.sourceHash) {
        throw new ExecutionError('SOURCE_CHANGED', `A fonte mudou após a pré-análise: ${item.sourcePath}.`);
      }
      if (journalItem.operation === 'create-output') {
        const destination = await inspectRegularFile(item.destinationPath);
        if (destination.exists) throw new ExecutionError('LATE_DESTINATION_CONFLICT', `O destino passou a existir após a pré-análise: ${item.destinationPath}.`);
      }
      journalItem.artifactId = allocateArtifactId(dependencies.generateArtifactId ?? generateArtifactId, historyIndex);

      const backup = await prepareRecovery(plan, item, journalItem, dependencies);
      journalItem.status = 'prepared';
      await persistJournal(journalPath, journal);

      const minified = await minifier.minify({
        type: item.fileType,
        profile: plan.profile,
        source: sourceSnapshot.content,
        engineId: plan.engine.id,
      });
      if (minified.status !== 'success' || typeof minified.output !== 'string' || minified.output.length === 0) {
        throw new ExecutionError('INVALID_MINIFIED_OUTPUT', `O minificador não produziu saída válida para ${item.sourcePath}.`);
      }
      const finalOutput = insertSelfMinifierTag(minified.output, item.fileType, journalItem.artifactId);
      const outputHash = hashContentSha256(finalOutput);
      const outputSize = Buffer.byteLength(finalOutput, 'utf8');
      journalItem.expectedOutputHash = outputHash;
      journalItem.status = 'mutation-intent';
      await persistJournal(journalPath, journal);
      await dependencies.hooks?.beforeMutation?.({ item: clone(item), journalPath, journal: clone(journal) });

      try {
        if (journalItem.operation === 'create-output') {
          await createNewFileExact(item.destinationPath, finalOutput, outputHash);
        } else {
          await replaceFileExact(item.destinationPath, finalOutput, journalItem.previousHash, outputHash);
        }
      } catch (cause) {
        if (cause?.code === 'LATE_DESTINATION_CONFLICT' || cause?.code === 'TARGET_CHANGED') {
          journalItem.status = 'prepared';
          await persistJournal(journalPath, journal);
        }
        throw cause;
      }
      await dependencies.hooks?.afterMutation?.({ item: clone(item), outputHash });
      const output = await inspectRegularFile(item.destinationPath);
      if (!output.exists || output.hash !== outputHash) throw new ExecutionError('OUTPUT_HASH_MISMATCH', `A saída mudou antes da confirmação: ${item.destinationPath}.`);
      journalItem.status = 'confirmed';
      await persistJournal(journalPath, journal);

      summaryProcessedCount += 1;
      summaryOriginalBytes += item.sourceSize;
      summaryFinalBytes += outputSize;

      const updated = upsertStateRecord(workingState, plan, item, journalItem.artifactId, outputHash, outputSize);
      workingState.records = updated.records;
      await writeTechnicalState(workingState, plan.runtimePaths.technicalState);
      journalItem.stateRecorded = true;
      await persistJournal(journalPath, journal);

      if (backup) {
        backupManifestEntries.push(createBackupManifestEntry(backup, {
          engine: plan.engine.id,
          engineVersion: plan.engine.version,
          profile: plan.profile,
          executionRisk: plan.executionRisk.technicalLevel,
          artifactId: journalItem.artifactId,
          minifiedSize: outputSize,
          minifiedSha256: outputHash,
          status: 'minificado',
          minificationDate: plan.timestamp,
        }));
      }
      historicalArtifacts.push(createArtifactProvenance(plan, item, journalItem, outputHash, outputSize, backup));
    }

    let manifestPath = null;
    if (plan.outputMode === OUTPUT_MODES.BACKUP_OVERWRITE) {
      const usedOriginIds = new Set(backupManifestEntries.map((entry) => entry.originId));
      const origins = plan.items
        .filter((item) => usedOriginIds.has(item.backupOriginId))
        .map((item) => ({ originId: item.backupOriginId, rootPath: item.originRoot }))
        .filter((origin, index, list) => list.findIndex((candidate) => candidate.originId === origin.originId) === index);
      const manifest = createBackupManifest({
        executionId: plan.executionId,
        timestamp: plan.timestamp,
        meminifyVersion: options.meminifyVersion ?? null,
        origins,
        files: backupManifestEntries,
      });
      manifestPath = journal.manifestPath;
      journal.manifestExpectedHash = hashContentSha256(`${JSON.stringify(manifest, null, 2)}\n`);
      await persistJournal(journalPath, journal);
      await writeBackupManifest(manifestPath, manifest);
      const writtenManifest = await inspectRegularFile(manifestPath);
      if (!writtenManifest.exists || writtenManifest.hash !== journal.manifestExpectedHash) {
        throw new ExecutionError('MANIFEST_HASH_MISMATCH', 'O manifesto persistido não corresponde ao conteúdo esperado.');
      }
      journal.manifestStatus = 'written';
      await persistJournal(journalPath, journal);
    }

    const history = createHistoricalExecutionRecord({
      executionId: plan.executionId,
      meminifyVersion: options.meminifyVersion ?? plan.meminifyVersion ?? null,
      timestamp: plan.timestamp,
      outputMode: plan.outputMode,
      projectRoot: plan.sources[0].path,
      artifacts: historicalArtifacts,
    });
    journal.historyExpectedHash = historicalExecutionRecordHash(history);
    await persistJournal(journalPath, journal);
    await persistHistory(plan.runtimePaths.historyDirectory, history, { historyIndex, createHistoricalIndex: buildHistoryIndex });
    const writtenHistory = await inspectRegularFile(historyPath);
    if (!writtenHistory.exists || writtenHistory.hash !== journal.historyExpectedHash) {
      throw new ExecutionError('HISTORY_HASH_MISMATCH', 'O histórico persistido não corresponde ao conteúdo esperado.');
    }
    journal.historyStatus = 'written';
    await persistJournal(journalPath, journal);

    journal.status = 'completed';
    await persistJournal(journalPath, journal);
    const reductionBytes = summaryOriginalBytes - summaryFinalBytes;
    const summary = {
      processedCount: summaryProcessedCount,
      originalBytes: summaryOriginalBytes,
      finalBytes: summaryFinalBytes,
      reductionBytes,
      reductionPercent: summaryOriginalBytes > 0 ? (reductionBytes / summaryOriginalBytes) * 100 : 0,
    };
    return {
      status: 'completed',
      executionId: plan.executionId,
      items: clone(journal.items),
      conflicts: clone(plan.conflicts),
      counts: {
        eligible: plan.scannerResult?.eligible?.length ?? plan.items.length,
        planned: plan.items.length,
        createdSuccessfully: journal.items.filter((item) => item.status === 'confirmed').length,
        skippedConflicts: plan.conflictPolicy === 'skip-existing' ? plan.conflicts.length : 0,
        failed: 0,
      },
      summary,
      noFilesChanged: journal.items.length === 0,
      journalRecorded: true,
      manifestPath,
      historyPath,
    };
  } catch (cause) {
    const rollback = await rollbackExecutionJournal(journal, journalPath);
    if (rollback.status === 'recovery-required') {
      throw new ExecutionError('RECOVERY_REQUIRED', 'A execução falhou e o rollback encontrou estado ambíguo.', { cause, journal: rollback.journal });
    }
    throw new ExecutionError(cause.code ?? 'EXECUTION_FAILED', cause.message ?? 'A execução transacional falhou.', {
      cause,
      causeCode: cause.details?.causeCode ?? cause.code ?? null,
      causeMessage: cause.details?.causeMessage ?? cause.message ?? null,
      operation: cause.details?.operation ?? null,
      targetPath: cause.details?.targetPath ?? null,
      temporaryPath: cause.details?.temporaryPath ?? null,
      rollbackStatus: rollback.status,
    });
  }
}
