import { isAbsolute } from 'node:path';
import { OUTPUT_MODES } from '../domain/index.js';
import { readJsonUtf8, writeJsonUtf8Atomic } from '../integrity/json-store.js';
import { ARTIFACT_ID_PATTERN } from '../integrity/history.js';
import { SHA256_PATTERN, requireObject } from '../integrity/schema.js';
import { validateTechnicalState } from '../integrity/state.js';
import { ExecutionError } from './errors.js';
import { validateCalculatedExecutionRisk } from './risk.js';

export const JOURNAL_STATUSES = Object.freeze([
  'planned', 'prepared', 'running', 'completed', 'rolled-back', 'recovery-required',
]);

export const ITEM_STATUSES = Object.freeze([
  'planned', 'prepared', 'mutation-intent', 'confirmed', 'rolled-back', 'recovery-required',
]);

const OPERATIONS = new Set(['overwrite-original', 'create-output', 'replace-output']);
const MANIFEST_STATUSES = new Set(['not-applicable', 'planned', 'written', 'rolled-back']);
const HISTORY_STATUSES = new Set(['planned', 'written', 'rolled-back']);
const MANUAL_RESTORE_STATUSES = new Set(['restored-source', 'deleted-min', 'already-absent']);

function validHash(value) {
  return value === null || SHA256_PATTERN.test(value);
}

export function validateExecutionJournal(journal) {
  try {
    requireObject(journal, 'INVALID_EXECUTION_JOURNAL', 'Journal');
    if (journal.formatVersion !== 1 || typeof journal.executionId !== 'string' || !journal.executionId) throw new Error('Cabeçalho inválido.');
    if (!Object.values(OUTPUT_MODES).includes(journal.outputMode) || !JOURNAL_STATUSES.includes(journal.status) || !Array.isArray(journal.items)) throw new Error('Modo, status ou itens inválidos.');
    if (!validateCalculatedExecutionRisk(journal.executionRisk)) throw new Error('Risco da execução ausente ou inválido.');
    if (!MANIFEST_STATUSES.has(journal.manifestStatus) || (journal.manifestPath !== null && !isAbsolute(journal.manifestPath)) || !validHash(journal.manifestExpectedHash)) throw new Error('Controle de manifesto inválido.');
    const hasHistoryLinkage = ['historyPath', 'historyStatus', 'historyExpectedHash'].some((field) => Object.hasOwn(journal, field));
    if (hasHistoryLinkage && (
      !isAbsolute(journal.historyPath)
      || !HISTORY_STATUSES.has(journal.historyStatus)
      || !validHash(journal.historyExpectedHash)
      || (journal.historyStatus === 'written' && !journal.historyExpectedHash)
    )) {
      throw new Error('Controle de histórico inválido.');
    }
    if (!isAbsolute(journal.statePath) || typeof journal.stateBefore?.existed !== 'boolean') throw new Error('Snapshot de estado ausente.');
    validateTechnicalState(journal.stateBefore.value);
    const itemIds = new Set();
    const destinations = new Set();
    journal.items.forEach((item) => {
      if (!item || typeof item.id !== 'string' || !OPERATIONS.has(item.operation) || !ITEM_STATUSES.includes(item.status)) throw new Error('Item inválido.');
      if (typeof item.stateRecorded !== 'boolean') throw new Error('Estado de persistência do item inválido.');
      if (item.artifactId !== undefined && item.artifactId !== null && !ARTIFACT_ID_PATTERN.test(item.artifactId)) throw new Error('artifactId inválido.');
      if (!isAbsolute(item.sourcePath) || !isAbsolute(item.destinationPath)) throw new Error('Caminho não absoluto.');
      if (item.plannedRecoveryPath !== null && !isAbsolute(item.plannedRecoveryPath)) throw new Error('Caminho planejado de recuperação inválido.');
      if (!validHash(item.sourceHash) || !validHash(item.expectedOutputHash) || !validHash(item.previousHash)) throw new Error('Hash inválido.');
      if (item.recovery !== null) {
        if (!isAbsolute(item.recovery.path) || !SHA256_PATTERN.test(item.recovery.hash) || !['source-backup', 'preexisting-output'].includes(item.recovery.type)) throw new Error('Referência de recuperação inválida.');
      }
      if (item.manualRestoreStatus !== undefined && item.manualRestoreStatus !== null && !MANUAL_RESTORE_STATUSES.has(item.manualRestoreStatus)) {
        throw new Error('Estado de restauração manual inválido.');
      }
      const destinationIdentity = process.platform === 'win32' ? item.destinationPath.toLowerCase() : item.destinationPath;
      if (itemIds.has(item.id) || destinations.has(destinationIdentity)) throw new Error('Item ou destino duplicado.');
      itemIds.add(item.id);
      destinations.add(destinationIdentity);
    });
    if (journal.status === 'completed' && journal.items.some((item) => item.status !== 'confirmed' || item.stateRecorded !== true)) {
      throw new Error('Journal concluído contém item não confirmado no estado técnico.');
    }
    if (journal.status === 'completed' && journal.outputMode === OUTPUT_MODES.BACKUP_OVERWRITE
      && (journal.manifestStatus !== 'written' || !journal.manifestExpectedHash)) {
      throw new Error('Journal concluído de sobrescrita não comprova o manifesto.');
    }
    if (journal.status === 'completed' && hasHistoryLinkage && (journal.historyStatus !== 'written' || !journal.historyExpectedHash)) {
      throw new Error('Journal concluído não comprova o registro histórico.');
    }
    return journal;
  } catch (cause) {
    if (cause instanceof ExecutionError) throw cause;
    throw new ExecutionError('INVALID_EXECUTION_JOURNAL', 'O journal da última execução é inválido ou não confiável.', { cause });
  }
}

export async function readExecutionJournal(filePath) {
  try {
    return validateExecutionJournal(await readJsonUtf8(filePath, 'EXECUTION_JOURNAL'));
  } catch (cause) {
    if (cause?.code === 'EXECUTION_JOURNAL_READ_FAILED' && cause.details?.cause?.code === 'ENOENT') return null;
    if (cause instanceof ExecutionError) throw cause;
    throw new ExecutionError('INVALID_EXECUTION_JOURNAL', 'O journal da última execução não pôde ser validado.', { cause });
  }
}

export async function writeExecutionJournal(filePath, journal) {
  validateExecutionJournal(journal);
  await writeJsonUtf8Atomic(filePath, journal, 'EXECUTION_JOURNAL');
  return journal;
}
