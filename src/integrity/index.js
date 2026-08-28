export { IntegrityError } from './errors.js';
export { hashContentSha256, hashFileSha256 } from './hash.js';
export { assertPathHasNoLinks, createValidatedSourceBackup } from './backup.js';
export { gzipFileToFile, gunzipFileToFile, hashDecompressedGzipFile, readVerifiedBackupContent } from './gzip.js';
export { assertPhysicalPath, proveDirectoryWritable } from './physical-path.js';
export { createBackupManifest, createBackupManifestEntry, readBackupManifest, validateBackupManifest, writeBackupManifest } from './manifest.js';
export { readTechnicalState, validateTechnicalState, writeTechnicalState } from './state.js';
export {
  NO_SELFMINIFIER_TAG,
  SELFMINIFIER_TAG_NAME,
  classifySelfMinifierTag,
  createSelfMinifierTag,
  insertSelfMinifierTag,
  inspectSelfMinifierTags,
} from './selfminifier-tag.js';
export {
  ARTIFACT_ID_PATTERN,
  assertHistoricalExecutionWritable,
  createHistoricalIndex,
  createHistoricalExecutionRecord,
  findHistoricalArtifact,
  generateArtifactId,
  historicalExecutionRecordHash,
  listHistoricalExecutionRecords,
  readHistoricalExecutionRecord,
  resolveHistoricalExecutionPath,
  validateHistoricalExecutionRecord,
  writeHistoricalExecutionRecord,
} from './history.js';
