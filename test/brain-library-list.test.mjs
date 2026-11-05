import assert from 'node:assert/strict';
import test from 'node:test';

import { cmdLibrary } from '../lib/bench-cli.mjs';
import { APPLICATIONS, buildLibrary, LIBRARY_JSON_SCHEMA } from '../lib/brain-library.mjs';

async function capture(args) {
  const library = buildLibrary({ now: '2026-11-03T00:00:00.000Z' });
  const oldFetch = globalThis.fetch;
  const oldLog = console.log;
  const oldToken = process.env.KINGMAKER_BRAIN_LIBRARY_TOKEN;
  const lines = [];
  globalThis.fetch = async () => ({ ok: true, json: async () => library });
  process.env.KINGMAKER_BRAIN_LIBRARY_TOKEN = 'test-entitlement';
  console.log = (...parts) => lines.push(parts.join(' '));
  try {
    assert.equal(await cmdLibrary({}, args), 0);
  } finally {
    globalThis.fetch = oldFetch;
    console.log = oldLog;
    if (oldToken === undefined) delete process.env.KINGMAKER_BRAIN_LIBRARY_TOKEN;
    else process.env.KINGMAKER_BRAIN_LIBRARY_TOKEN = oldToken;
  }
  return lines;
}

test('default Brain Library view identifies five roles as a hardware view, not the full catalog', async () => {
  const lines = await capture(['list']);
  assert.ok(lines.some((line) => /Showing 5 active role assignments for this hardware, not the whole catalog/.test(line)));
  assert.ok(lines.some((line) => /Brain Library: 12 regular models \+ 3 large-system options/.test(line)));
  assert.ok(lines.some((line) => /Applications: moneyprinterturbo/.test(line)));
});

test('full Brain Library view includes DeepSeek V4.1 Flash large-system option', async () => {
  const lines = await capture(['all']);
  assert.ok(lines.some((line) => line.includes('DeepSeek-V4.1-Flash-UNCENSORED')));
  assert.ok(lines.some((line) => /12 regular models \+ 3 large-system options/.test(line)));
  assert.ok(lines.some((line) => line.includes('kingmaker models all')));
  assert.ok(lines.some((line) => line.includes('app     moneyprinterturbo')));
});

test('MoneyPrinterTurbo is a pinned, hash-bound application rather than a model', () => {
  const library = buildLibrary({ now: '2026-11-03T00:00:00.000Z' });
  const app = library.applications.find((item) => item.id === 'moneyprinterturbo');
  assert.equal(library.license, 'LicenseRef-Ronin-Paid');
  assert.ok(app);
  assert.equal(app.sourceCommit, '0824212');
  assert.equal(app.upstreamCommit, 'c8dbf96e9dfee43b30f7c3f440175d6bd4de61de');
  assert.equal(app.sha256, '10ecedc4f5cf7ab94dda8defc7a5c9b087e8e8912339ec49047e956061bb877e');
  assert.equal(app.size, 140_312_751);
  assert.equal(app.use.url, 'http://127.0.0.1:8510');
  assert.ok(!library.models.some((model) => model.tag === app.id));
  assert.deepEqual(app, { ...APPLICATIONS[0], install: [...APPLICATIONS[0].install], use: { ...APPLICATIONS[0].use, args: [...APPLICATIONS[0].use.args] } });
  assert.ok(LIBRARY_JSON_SCHEMA.properties.applications);
});
