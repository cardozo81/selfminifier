import { rm } from 'node:fs/promises';
import { readTechnicalState, writeTechnicalState } from '../integrity/state.js';
import { inspectRegularFile, removeExactFile, restoreExactFile } from './filesystem.js';
import { ExecutionError } from './errors.js';
import { readExecutionJournal, writeExecutionJournal } from './journal.js';

async function restoreStateSnapshot(journal) {
  const statePath = journal.statePath;
  if (journal.stateBefore.existed) {
    await writeTechnicalState(journal.stateBefore.value, statePath);
    const restored = await readTechnicalState(statePath);
    if (JSON.stringify(restored) !== JSON.stringify(journal.stateBefore.value)) {
      throw new ExecutionError('STATE_ROLLBACK_FAILED', 'O estado técnico não corresponde ao snapshot anterior após o rollback.');
    }
  } else {
    await rm(statePath, { force: true });
  }
}

async function rollbackItem(item) {
  if (!['mutation-intent', 'confirmed'].includes(item.status)) return true;
  const current = await inspectRegularFile(item.destinationPath);
  if (item.operation === 'create-output') {
    if (!current.exists) return true;
    return removeExactFile(item.destinationPath, item.expectedOutputHash);
  }
  if (current.exists && current.hash === item.previousHash) return true;
  if (!current.exists || current.hash !== item.expectedOutputHash || !item.recovery) return false;
  return restoreExactFile(item.destinationPath, item.recovery.path, item.expectedOutputHash, item.recovery.hash, item.recovery.compression ?? 'none');
}

async function validateCompletedConsistency(journal) {
  if (journal.historyPath) {
    const history = await inspectRegularFile(journal.historyPath).catch(() => ({ exists: false, hash: null }));
    if (!history.exists || history.hash !== journal.historyExpectedHash) {
      throw new ExecutionError('JOURNAL_STATE_CONTRADICTION', 'O histórico concluído não corresponde ao journal da execução.');
    }
  }
  if (journal.manifestPath) {
    const manifest = await inspectRegularFile(journal.manifestPath).catch(() => ({ exists: false, hash: null }));
    if (!manifest.exists || manifest.hash !== journal.manifestExpectedHash) {
      throw new ExecutionError('JOURNAL_STATE_CONTRADICTION', 'O manifesto concluído não corresponde ao journal da execução.');
    }
  }
  if (journal.items.length === 0) return;
  let state;
  try { state = await readTechnicalState(journal.statePath); } catch (cause) {
    throw new ExecutionError('JOURNAL_STATE_CONTRADICTION', 'O journal concluído não possui estado técnico confiável correspondente.', { cause });
  }
  for (const item of journal.items) {
    if (item.manualRestoreStatus) continue;
    const sourceIdentity = process.platform === 'win32' ? item.sourcePath.toLowerCase() : item.sourcePath;
    const record = state.records.find((candidate) => (
      (process.platform === 'win32' ? candidate.sourcePath?.toLowerCase() : candidate.sourcePath) === sourceIdentity
    ));
    if (!record || record.outputPath !== item.destinationPath || record.minifiedHash !== item.expectedOutputHash || record.outputMode !== journal.outputMode) {
      throw new ExecutionError('JOURNAL_STATE_CONTRADICTION', 'O journal concluído e o estado técnico possuem informações divergentes.', { itemId: item.id });
    }
  }
}

export async function rollbackExecutionJournal(journal, journalPath) {
  if (journal.historyPath) {
    const history = await inspectRegularFile(journal.historyPath).catch(() => ({ exists: true, hash: null }));
    if (history.exists) {
      if (!journal.historyExpectedHash || !await removeExactFile(journal.historyPath, journal.historyExpectedHash)) {
        journal.status = 'recovery-required';
        await writeExecutionJournal(journalPath, journal);
        return { status: 'recovery-required', journal };
      }
    }
    journal.historyStatus = 'rolled-back';
    await writeExecutionJournal(journalPath, journal);
  }
  if (journal.manifestPath) {
    const manifest = await inspectRegularFile(journal.manifestPath).catch(() => ({ exists: true, hash: null }));
    if (manifest.exists) {
      if (!journal.manifestExpectedHash || !await removeExactFile(journal.manifestPath, journal.manifestExpectedHash)) {
        journal.status = 'recovery-required';
        await writeExecutionJournal(journalPath, journal);
        return { status: 'recovery-required', journal };
      }
    }
    journal.manifestStatus = 'rolled-back';
    await writeExecutionJournal(journalPath, journal);
  }
  let ambiguous = false;
  for (const item of [...journal.items].reverse()) {
    const restored = await rollbackItem(item).catch(() => false);
    item.status = restored ? 'rolled-back' : 'recovery-required';
    ambiguous ||= !restored;
    if (ambiguous) {
      journal.status = 'recovery-required';
      await writeExecutionJournal(journalPath, journal);
      break;
    }
    await writeExecutionJournal(journalPath, journal);
  }
  if (ambiguous) return { status: 'recovery-required', journal };
  try {
    await restoreStateSnapshot(journal);
  } catch (cause) {
    journal.status = 'recovery-required';
    await writeExecutionJournal(journalPath, journal);
    return { status: 'recovery-required', journal, cause };
  }
  journal.status = 'rolled-back';
  await writeExecutionJournal(journalPath, journal);
  return { status: 'rolled-back', journal };
}

export async function recoverInterruptedExecution(journalPath) {
  const journal = await readExecutionJournal(journalPath);
  if (!journal) return { status: 'none' };
  if (journal.status === 'completed') {
    await validateCompletedConsistency(journal);
    return { status: journal.status, journal };
  }
  if (journal.status === 'rolled-back') return { status: journal.status, journal };
  if (journal.status === 'recovery-required') {
    throw new ExecutionError('RECOVERY_REQUIRED', 'A execução anterior exige recuperação manual comprovada.', { journal });
  }
  const recovery = await rollbackExecutionJournal(journal, journalPath);
  if (recovery.status === 'recovery-required') {
    throw new ExecutionError('RECOVERY_REQUIRED', 'A execução interrompida não pôde ser recuperada deterministicamente.', { journal: recovery.journal });
  }
  return recovery;
}
