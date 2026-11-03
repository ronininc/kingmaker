import assert from 'node:assert/strict';
import test from 'node:test';

import { cmdLibrary } from '../lib/bench-cli.mjs';
import { buildLibrary } from '../lib/brain-library.mjs';

async function capture(args) {
  const library = buildLibrary({ now: '2026-11-03T00:00:00.000Z' });
  const oldFetch = globalThis.fetch;
  const oldLog = console.log;
  const lines = [];
  globalThis.fetch = async () => ({ ok: true, json: async () => library });
  console.log = (...parts) => lines.push(parts.join(' '));
  try {
    assert.equal(await cmdLibrary({}, args), 0);
  } finally {
    globalThis.fetch = oldFetch;
    console.log = oldLog;
  }
  return lines;
}

test('default Brain Library view identifies five roles as a hardware view, not the full catalog', async () => {
  const lines = await capture(['list']);
  assert.ok(lines.some((line) => /Showing 5 active role assignments for this hardware, not the whole catalog/.test(line)));
  assert.ok(lines.some((line) => /Brain Library: 12 regular models \+ 3 large-system options/.test(line)));
});

test('full Brain Library view includes DeepSeek V4.1 Flash large-system option', async () => {
  const lines = await capture(['all']);
  assert.ok(lines.some((line) => line.includes('DeepSeek-V4.1-Flash-UNCENSORED')));
  assert.ok(lines.some((line) => /12 regular models \+ 3 large-system options/.test(line)));
  assert.ok(lines.some((line) => line.includes('kingmaker models all')));
});
