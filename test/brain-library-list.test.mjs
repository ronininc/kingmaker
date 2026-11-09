import assert from 'node:assert/strict';
import test from 'node:test';

import { cmdLibrary } from '../lib/bench-cli.mjs';
import { buildLibrary, LIBRARY_REPO } from '../lib/brain-library.mjs';

async function capture(args) {
  const library = buildLibrary({ now: '2026-11-03T00:00:00.000Z' });
  const oldFetch = globalThis.fetch;
  const oldLog = console.log;
  const lines = [];
  globalThis.fetch = async () => ({ ok: true, json: async () => library });
  console.log = (...parts) => lines.push(parts.join(' '));
  let code = 0;
  try { code = await cmdLibrary({}, args); } finally {
    globalThis.fetch = oldFetch;
    console.log = oldLog;
  }
  return { code, lines, library };
}

test('the shipped library list prints this Mac\'s role picks from the public catalog', async () => {
  const { code, lines, library } = await capture(['list']);
  assert.equal(code, 0);
  assert.ok(lines.some((line) => line.includes(LIBRARY_REPO)));
  assert.ok(lines.some((line) => line.includes('updated 2026-11-03')));
  const roles = library.classes.find((item) => lines.some((line) => line.includes(`${item.pack}`)));
  assert.ok(roles);
  assert.ok(lines.some((line) => line.includes(roles.roles.writer)));
});

test('an unknown library verb is refused', async () => {
  const { code, lines } = await capture(['all']);
  assert.equal(code, 1);
  assert.ok(lines.some((line) => line.includes('kingmaker models library')));
});
