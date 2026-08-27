import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadApplicationMetadata } from '../src/runtime/version.js';
import { runBridgeRequest } from '../src/app/bridge.mjs';

test('versão autoritativa vem do package.json e é exposta pela ponte', async () => {
  const metadata = await loadApplicationMetadata(process.cwd());
  const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
  assert.equal(metadata.version, packageJson.version);
  assert.equal((await runBridgeRequest({ command: 'version' }, { projectRoot: process.cwd() })).version, packageJson.version);
});

test('UI renderiza cabeçalho persistente a partir da identidade compartilhada, sem versão fixa', async () => {
  const ui = await readFile('src/app/ui.ps1', 'utf8');
  assert.match(ui, /\$script:AppVersion = \$identity\.version/);
  assert.match(ui, /function Show-AppHeader/);
  assert.match(ui, /SELFMINIFIER v\$\(\$script:AppVersion\)/);
  assert.doesNotMatch(ui, /SELFMINIFIER v0\.2\.\d/);
});
