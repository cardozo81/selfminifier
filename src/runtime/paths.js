import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RUNTIME_RELATIVE_PATHS = Object.freeze({
  temporaryDirectory: 'Dados/Temporarios',
  technicalState: 'Dados/estado.json',
  historyDirectory: 'Dados/Historico',
  recoveryDirectory: 'Dados/Restauracao',
  lastExecutionJournal: 'Dados/Restauracao/ultima-execucao.bkp',
  manualRestoreJournal: 'Dados/Restauracao/restauracao-em-andamento.bkp',
});

export function resolveApplicationRoot(moduleUrl = import.meta.url) {
  return resolve(dirname(fileURLToPath(moduleUrl)), '..', '..');
}

export function resolveApplicationPaths(baseDirectory = resolveApplicationRoot()) {
  const root = resolve(baseDirectory);
  return Object.freeze({
    root,
    configuration: join(root, 'Configuracao', 'configuracao.ini'),
    example: join(root, 'Configuracao', 'configuracao.ini.example'),
    backupRoot: join(root, '_source_versions'),
  });
}

export function resolveRuntimePaths(baseDirectory = resolveApplicationRoot()) {
  const root = resolve(baseDirectory);
  return Object.freeze({
    temporaryDirectory: resolve(root, RUNTIME_RELATIVE_PATHS.temporaryDirectory),
    technicalState: resolve(root, RUNTIME_RELATIVE_PATHS.technicalState),
    historyDirectory: resolve(root, RUNTIME_RELATIVE_PATHS.historyDirectory),
    recoveryDirectory: resolve(root, RUNTIME_RELATIVE_PATHS.recoveryDirectory),
    lastExecutionJournal: resolve(root, RUNTIME_RELATIVE_PATHS.lastExecutionJournal),
    manualRestoreJournal: resolve(root, RUNTIME_RELATIVE_PATHS.manualRestoreJournal),
  });
}
