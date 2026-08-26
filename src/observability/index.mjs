import { access, mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve, basename } from 'node:path';

function stamp(value = new Date()) {
  const pad = (number) => String(number).padStart(2, '0');
  return `${value.getFullYear()}${pad(value.getMonth() + 1)}${pad(value.getDate())}-${pad(value.getHours())}${pad(value.getMinutes())}${pad(value.getSeconds())}`;
}

function csv(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function formatBytes(value) { return Number.isFinite(value) ? String(value) : ''; }

function reduction(originalSize, finalSize) {
  if (!Number.isFinite(originalSize) || !Number.isFinite(finalSize)) return { bytes: null, percentage: null };
  return { bytes: originalSize - finalSize, percentage: originalSize === 0 ? 0 : ((originalSize - finalSize) / originalSize) * 100 };
}

async function fileSize(filePath) {
  try { return (await stat(filePath)).size; } catch { return null; }
}

function rowsFrom({ plan, result = null, status = null, durationMs = null, minificationDate = null }) {
  const resultItems = new Map((result?.items ?? []).map((item) => [item.id, item]));
  const rows = [];
  for (const item of plan.items ?? []) {
    const executionItem = resultItems.get(item.id);
    const finalSize = executionItem?.finalSize ?? null;
    const red = reduction(item.sourceSize, finalSize);
    rows.push({
      caminho: item.sourcePath,
      tipo: item.fileType,
      status: executionItem?.status === 'confirmed' ? 'minificado' : (executionItem?.status ?? status ?? 'elegível'),
      motivo: executionItem?.reason ?? '',
      tamanhoOriginal: item.sourceSize,
      tamanhoFinal: finalSize,
      reducaoBytes: red.bytes,
      reducaoPercentual: red.percentage,
      ultimaModificacao: null,
      dataMinificacao: minificationDate,
      motor: plan.engine?.id ?? null,
      versaoMotor: plan.engine?.version ?? null,
      perfil: plan.profile ?? null,
      duracaoMs: durationMs,
      destino: item.destinationPath,
    });
  }
  for (const item of plan.ignored ?? []) rows.push({
    caminho: item.normalizedPath,
    tipo: item.fileType,
    status: 'ignorado',
    motivo: item.reason ?? 'MOTIVO_NAO_INFORMADO',
    tamanhoOriginal: null,
    tamanhoFinal: null,
    reducaoBytes: null,
    reducaoPercentual: null,
    ultimaModificacao: null,
    dataMinificacao: null,
    motor: plan.engine?.id ?? null,
    versaoMotor: plan.engine?.version ?? null,
    perfil: plan.profile ?? null,
    duracaoMs: null,
    destino: null,
  });
  return rows;
}

function reportText({ plan, rows, resultStatus, durationMs, applicationVersion, summary = null }) {
  const minified = rows.filter((row) => row.status === 'minificado');
  const ignored = rows.filter((row) => row.status === 'ignorado');
  const errors = (plan.diagnostics?.errors?.length ?? 0) + (plan.diagnostics?.blockers?.length ?? 0);
  const hasSummary = summary !== null;
  const original = hasSummary ? summary.originalBytes : rows.reduce((sum, row) => sum + (Number.isFinite(row.tamanhoOriginal) ? row.tamanhoOriginal : 0), 0);
  const final = hasSummary ? summary.finalBytes : rows.reduce((sum, row) => sum + (Number.isFinite(row.tamanhoFinal) ? row.tamanhoFinal : 0), 0);
  const processedCount = hasSummary ? summary.processedCount : minified.length;
  const red = hasSummary ? { bytes: summary.reductionBytes, percentage: summary.reductionPercent } : reduction(original, final);
  const lines = [
    'Relatório operacional do SelfMinifier',
    `Versão do SelfMinifier: ${applicationVersion ?? ''}`,
    `Status: ${resultStatus ?? plan.status}`,
    `ID da execução: ${plan.executionId}`,
    `Arquivos encontrados: ${rows.length}`,
    `Elegíveis: ${plan.items?.length ?? 0}`,
    `Minificados: ${processedCount}`,
    `Ignorados: ${ignored.length}`,
    `Erros/bloqueios: ${errors}`,
    `JavaScript: ${rows.filter((row) => row.tipo === 'javascript').length}`,
    `CSS: ${rows.filter((row) => row.tipo === 'css').length}`,
    `Tamanho original (bytes): ${formatBytes(original)}`,
    `Tamanho final (bytes): ${formatBytes(final)}`,
    `Redução (bytes): ${formatBytes(red.bytes)}`,
    `Redução (%): ${red.percentage === null ? '' : red.percentage.toFixed(2)}`,
    `Duração (ms): ${formatBytes(durationMs)}`,
    `Motor/versão: ${plan.engine?.id ?? ''}/${plan.engine?.version ?? ''}`,
    `Perfil: ${plan.profile ?? ''}`,
    `Risco estimado da execução: ${plan.executionRisk?.displayLevel ?? ''}`,
    `Escopo da operação (arquivos): ${plan.scope?.fileCount ?? plan.items?.length ?? 0}`,
    `Modo de saída: ${plan.outputMode ?? ''}`,
    `Backup/referência: ${plan.backupRoot ?? ''}`,
    '',
    'Arquivos:',
  ];
  for (const row of rows) lines.push(`${row.status} | ${row.caminho} | ${row.tipo ?? ''} | motivo: ${row.motivo} | original: ${formatBytes(row.tamanhoOriginal)} | final: ${formatBytes(row.tamanhoFinal)} | destino: ${row.destino ?? ''}`);
  return `${lines.join('\n')}\n`;
}

const columns = ['caminho', 'tipo', 'status', 'motivo', 'tamanhoOriginal', 'tamanhoFinal', 'reducaoBytes', 'reducaoPercentual', 'ultimaModificacao', 'dataMinificacao', 'motor', 'versaoMotor', 'perfil', 'duracaoMs', 'destino'];
function reportCsv(rows) { return `${columns.join(',')}\n${rows.map((row) => columns.map((column) => csv(row[column])).join(',')).join('\n')}\n`; }

async function uniquePath(directory, prefix, extension, timestamp) {
  const base = `${prefix}-${timestamp}`;
  let candidate = join(directory, `${base}.${extension}`);
  let suffix = 1;
  while (true) {
    try { await access(candidate, constants.F_OK); candidate = join(directory, `${base}-${String(suffix).padStart(3, '0')}.${extension}`); suffix += 1; }
    catch { return candidate; }
  }
}

export async function writeOperationalReports({ projectRoot, plan, result = null, resultStatus = null, durationMs = null, applicationVersion = null, timestamp = new Date() }) {
  const directory = join(resolve(projectRoot), 'Dados', 'Relatorios');
  await mkdir(directory, { recursive: true });
  const rows = rowsFrom({ plan, result, status: resultStatus, durationMs, minificationDate: timestamp.toISOString() });
  for (const row of rows) if (row.tamanhoFinal === null && row.destino) row.tamanhoFinal = await fileSize(row.destino);
  const fileStamp = stamp(timestamp);
  const txtPath = await uniquePath(directory, 'execucao', 'txt', fileStamp);
  const csvPath = await uniquePath(directory, 'execucao', 'csv', fileStamp);
  await import('node:fs/promises').then(({ writeFile }) => Promise.all([
    writeFile(txtPath, reportText({ plan, rows, resultStatus, durationMs, applicationVersion, summary: result?.summary ?? null }), 'utf8'),
    writeFile(csvPath, reportCsv(rows), 'utf8'),
  ]));
  return { txtPath, csvPath, rows };
}

export async function writeTechnicalLog({ projectRoot, executionId, phases = [], result = null, error = null, technicalPaths = {}, runtime = null, applicationVersion = null, timestamp = new Date() }) {
  const directory = join(resolve(projectRoot), 'Dados', 'Logs');
  await mkdir(directory, { recursive: true });
  const path = await uniquePath(directory, 'tecnico', 'log', stamp(timestamp));
  const lines = [
    `SelfMinifier técnico | data=${timestamp.toISOString()}`,
    `executionId=${executionId ?? ''}`,
    `version=${applicationVersion ?? ''}`,
    `runtime=${JSON.stringify(runtime ?? {})}`,
    `paths=${JSON.stringify(technicalPaths)}`,
    ...phases.map((phase) => `phase=${JSON.stringify(phase)}`),
    `result=${JSON.stringify(result ?? {})}`,
  ];
  if (error) lines.push(`exception=${error.stack ?? error.message ?? String(error)}`);
  await (await import('node:fs/promises')).writeFile(path, `${lines.join('\n')}\n`, 'utf8');
  return { path };
}

async function list(directory, extension) {
  try { return (await readdir(directory, { withFileTypes: true })).filter((entry) => entry.isFile() && entry.name.endsWith(extension)).map((entry) => entry.name).sort(); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

export async function listArtifacts(projectRoot, kind) {
  if (!['logs', 'reports'].includes(kind)) throw new Error('Tipo de artefato inválido.');
  const directory = join(resolve(projectRoot), 'Dados', kind === 'logs' ? 'Logs' : 'Relatorios');
  return list(directory, kind === 'logs' ? '.log' : '.txt').then(async (textNames) => kind === 'logs' ? textNames : textNames.concat(await list(directory, '.csv')) .sort());
}

export async function readArtifact(projectRoot, kind, name) {
  if (!['logs', 'reports'].includes(kind)) throw new Error('Tipo de artefato inválido.');
  if (typeof name !== 'string' || basename(name) !== name || !/^[A-Za-z0-9._-]+$/.test(name)) throw new Error('Nome de artefato inválido.');
  if (kind === 'logs' && !name.endsWith('.log')) throw new Error('Extensão de log inválida.');
  if (kind === 'reports' && !name.endsWith('.txt') && !name.endsWith('.csv')) throw new Error('Extensão de relatório inválida.');
  const directory = join(resolve(projectRoot), 'Dados', kind === 'logs' ? 'Logs' : 'Relatorios');
  return readFile(join(directory, name), 'utf8');
}

export { columns, rowsFrom };
