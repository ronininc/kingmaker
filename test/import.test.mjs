import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const manifest = JSON.parse(readFileSync(new URL('../solomon-strip.json', import.meta.url), 'utf8'));
const rules = manifest.removeTestsReferencing.map((s) => new RegExp(s));
const hit = (text) => rules.some((rx) => rx.test(text));

test('the strip removes the UI and the window shell, never the engines', () => {
  for (const p of ['app/', 'desktop/main.mjs', 'desktop/preload.mjs']) assert.ok(p in manifest.remove, p);
  for (const p of ['server/', 'desktop/', 'contracts/', 'desktop/headless-server.mjs', 'desktop/owner-voice/']) assert.ok(!(p in manifest.remove), p);
});

test('a test suite goes only when it needs the stripped UI or Electron', () => {
  assert.ok(hit("import { x } from '../../app/src/machine/EvidenceMachine.tsx'"));
  assert.ok(hit("const { app } = require('electron')"));
  assert.ok(hit("const main = 'desktop/main.mjs'"));
  assert.ok(!hit("import { x } from '../../server/src/runtime/control-surface/contracts.ts'"));
  assert.ok(!hit("const ELECTRON_RUN_AS_NODE = '1'"));
});

test('the imported tree records where it came from and has no dangling imports into stripped paths', () => {
  const from = JSON.parse(readFileSync(new URL('../solomon/IMPORTED_FROM.json', import.meta.url), 'utf8'));
  assert.match(from.sha, /^[0-9a-f]{40}$/);
  assert.deepEqual(from.danglingImports, []);
});

test('every suite left in solomon/tests/run-all.ts has its file (the import prunes what the strip removed)', () => {
  const root = new URL('../solomon/', import.meta.url);
  const runAll = readFileSync(new URL('tests/run-all.ts', root), 'utf8');
  const suites = [...runAll.matchAll(/\{ name: '([^']+)', file: '([^']+)'/g)];
  assert.ok(suites.length > 0, 'run-all lists suites');
  const missing = suites.filter(([, , file]) => !existsSync(new URL(file, new URL('server/', root))));
  assert.deepEqual(missing.map(([, name]) => name), []);
  assert.ok(!/args: \[[^\]]*'\.\.\/app\//.test(runAll), 'no suite runs against the stripped app/');
  const from = JSON.parse(readFileSync(new URL('IMPORTED_FROM.json', root), 'utf8'));
  assert.ok(Array.isArray(from.prunedRunAllSuites), 'the pruned entries are recorded');
});
