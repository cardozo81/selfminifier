import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export const STORAGE_STATES = Object.freeze({
  PRESENT: 'present',
  ABSENT: 'absent',
  PARTIAL: 'partial',
  UNAVAILABLE: 'unavailable',
});

export async function measureStorageDirectory(directoryPath) {
  let rootStats;
  try {
    rootStats = await lstat(directoryPath);
  } catch (error) {
    return Object.freeze(error?.code === 'ENOENT'
      ? { status: STORAGE_STATES.ABSENT, bytes: 0, complete: true }
      : { status: STORAGE_STATES.UNAVAILABLE, bytes: 0, complete: false });
  }
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    return Object.freeze({ status: STORAGE_STATES.UNAVAILABLE, bytes: 0, complete: false });
  }
  let bytes = 0;
  let complete = true;
  const pending = [directoryPath];
  while (pending.length > 0) {
    const current = pending.pop();
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      complete = false;
      continue;
    }
    for (const entry of entries) {
      const entryPath = join(current, entry.name);
      let stats;
      try {
        stats = await lstat(entryPath);
      } catch {
        complete = false;
        continue;
      }
      if (stats.isSymbolicLink()) continue;
      if (stats.isFile()) {
        bytes += Number(stats.size);
      } else if (stats.isDirectory()) {
        pending.push(entryPath);
      }
    }
  }
  return Object.freeze({
    status: complete ? STORAGE_STATES.PRESENT : STORAGE_STATES.PARTIAL,
    bytes,
    complete,
  });
}

export function summarizeStorageUsage(categories) {
  const totalContabilizado = categories.reduce((sum, category) => sum + category.bytes, 0);
  const complete = categories.every((category) => category.complete === true);
  return Object.freeze({ totalContabilizado, complete });
}
