import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export class RuntimePolicyError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'RuntimePolicyError';
    this.code = code;
    this.details = details;
  }
}

const SEMVER_PATTERN = /^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseNodeVersion(version) {
  if (typeof version !== 'string') throw new RuntimePolicyError('MALFORMED_NODE_VERSION', 'A versão do Node.js deve ser texto.');
  const match = version.trim().match(SEMVER_PATTERN);
  if (!match) throw new RuntimePolicyError('MALFORMED_NODE_VERSION', `A versão do Node.js é inválida: ${version}.`);
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), raw: version.trim() };
}

export function validateRuntimePolicy(policy) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) throw new RuntimePolicyError('INVALID_RUNTIME_POLICY', 'A política de runtime deve ser um objeto JSON.');
  if (policy.formatVersion !== 2) throw new RuntimePolicyError('INVALID_RUNTIME_POLICY', 'A versão da política de runtime não é suportada.');
  if (!Number.isInteger(policy.minimumMajor) || policy.minimumMajor < 1) throw new RuntimePolicyError('INVALID_RUNTIME_POLICY', 'A major mínima do Node.js é inválida.');
  if (!Array.isArray(policy.supportedMajorLines) || policy.supportedMajorLines.length === 0 || policy.supportedMajorLines.some((major) => !Number.isInteger(major) || major < policy.minimumMajor)) throw new RuntimePolicyError('INVALID_RUNTIME_POLICY', 'As linhas suportadas do Node.js são inválidas.');
  if (new Set(policy.supportedMajorLines).size !== policy.supportedMajorLines.length) throw new RuntimePolicyError('INVALID_RUNTIME_POLICY', 'As linhas suportadas do Node.js não podem se repetir.');
  if (!policy.supportedMajorLines.includes(policy.preferredMajor) || policy.preferredMajor < policy.minimumMajor) throw new RuntimePolicyError('INVALID_RUNTIME_POLICY', 'A linha preferida precisa ser suportada e não pode ser menor que a major mínima.');
  if (policy.preferredChannel !== 'LTS') throw new RuntimePolicyError('INVALID_RUNTIME_POLICY', 'O canal preferido do Node.js deve ser LTS.');
  const installVersion = parseNodeVersion(policy.approvedAutomaticInstallVersion);
  if (installVersion.major !== policy.preferredMajor) throw new RuntimePolicyError('INVALID_RUNTIME_POLICY', 'A versão de instalação automática precisa pertencer à linha preferida.');
  if (typeof policy.wingetPackage !== 'string' || !policy.wingetPackage) throw new RuntimePolicyError('INVALID_RUNTIME_POLICY', 'O pacote winget aprovado é obrigatório.');
  return Object.freeze({ ...policy, supportedMajorLines: Object.freeze([...policy.supportedMajorLines]) });
}

export async function loadRuntimePolicy(policyPath = resolve(process.cwd(), 'resources', 'runtime-policy.json')) {
  let text;
  try { text = await readFile(policyPath, 'utf8'); } catch (cause) { throw new RuntimePolicyError('RUNTIME_POLICY_READ_FAILED', `Não foi possível ler a política de runtime: ${policyPath}.`, { policyPath, cause }); }
  try { return validateRuntimePolicy(JSON.parse(text)); } catch (cause) {
    if (cause instanceof RuntimePolicyError) throw cause;
    throw new RuntimePolicyError('INVALID_RUNTIME_POLICY', `A política de runtime contém JSON inválido: ${policyPath}.`, { policyPath, cause });
  }
}

export function validateNodeRuntimeVersion(version, policy) {
  const parsed = parseNodeVersion(version);
  const validatedPolicy = validateRuntimePolicy(policy);
  if (parsed.major < validatedPolicy.minimumMajor || !validatedPolicy.supportedMajorLines.includes(parsed.major)) {
    return { valid: false, code: 'NODE_MAJOR_NOT_SUPPORTED', version: parsed, message: `A linha Node.js ${parsed.major} não é suportada pelo SelfMinifier. Versões suportadas: ${validatedPolicy.supportedMajorLines.map((major) => `Node.js ${major}.x`).join(', ')}.` };
  }
  const preferred = parsed.major === validatedPolicy.preferredMajor;
  const message = preferred
    ? `Node.js detectado: ${parsed.raw}. Status: compatível / recomendado.`
    : `Node.js detectado: ${parsed.raw}. Status: compatível. Canal: não-LTS / não preferencial. Recomendado para maior estabilidade: Node.js ${validatedPolicy.preferredMajor} LTS.`;
  return { valid: true, version: parsed, preferred, channel: preferred ? validatedPolicy.preferredChannel : 'non-LTS', message };
}
