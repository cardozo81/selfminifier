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

test('UI exibe a versão sem constante duplicada', async () => {
  const ui = await readFile('src/app/ui.ps1', 'utf8');
  assert.match(ui, /SELFMINIFIER v\$\(\$identity\.version\)/);
});
