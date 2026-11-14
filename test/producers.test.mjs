// Tests for the ingest producers' registration (lib/producers.mjs) and their wiring into the
// MCP registry (lib/mcp.mjs): the registration shape the tool-calling layer consumes, arg
// validation against each tool's own schema, the runner's receipt discipline over a scripted
// exec (job folder, artifact read-back, hash recomputed from disk, meta cross-check), every
// failure path refusing to fabricate a receipt, and tools/list + tools/call through the
// registry itself with an injected fake runner.
// Run: node --test test/producers.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  PRODUCER_TOOLS, PRODUCER_TOOL_NAMES, validateProducerArgs, createProducerRunner, callProducerTool, sha256Hex,
} from '../lib/producers.mjs';
import { TOOLS, handleMessage } from '../lib/mcp.mjs';

const EXPECTED = ['ingest-browser-capture', 'ingest-site-crawl', 'ingest-youtube-transcript', 'ingest-voice-transcribe', 'voice-synthesize'];

test('registration: exactly the five producers, uniquely named, MCP-shaped', () => {
  assert.deepEqual(PRODUCER_TOOLS.map((t) => t.name), EXPECTED);
  assert.equal(PRODUCER_TOOL_NAMES.size, 5);
  const allNames = TOOLS.map((t) => t.name);
  assert.equal(new Set(allNames).size, allNames.length, 'no name collisions in the full registry');
  for (const t of PRODUCER_TOOLS) {
    assert.ok(typeof t.description === 'string' && t.description.length > 40, `${t.name} has a real description`);
    assert.equal(t.inputSchema.type, 'object');
    assert.equal(t.inputSchema.additionalProperties, false);
    assert.ok(t.annotations?.title, `${t.name} has a title`);
    assert.ok(allNames.includes(t.name), `${t.name} is in lib/mcp.mjs TOOLS`);
  }
});

test('validation: required keys, unknown keys, types, the youtube one-of rule', () => {
  assert.throws(() => validateProducerArgs('ingest-browser-capture', {}), /requires "url"/);
  assert.throws(() => validateProducerArgs('ingest-browser-capture', { url: 'https://x', bogus: 1 }), /unknown argument "bogus"/);
  assert.throws(() => validateProducerArgs('ingest-site-crawl', { url: 'https://x', maxPages: '30' }), /must be an integer/);
  assert.throws(() => validateProducerArgs('ingest-youtube-transcript', {}), /exactly one of/);
  assert.throws(() => validateProducerArgs('ingest-youtube-transcript', { videoId: 'a', query: 'b' }), /exactly one of/);
  assert.throws(() => validateProducerArgs('nope', {}), /unknown tool/);
  assert.doesNotThrow(() => validateProducerArgs('ingest-youtube-transcript', { videoId: 'WfXW6iY7_Gw' }));
  assert.doesNotThrow(() => validateProducerArgs('ingest-voice-transcribe', { audioPath: '/tmp/a.wav' }));
  assert.doesNotThrow(() => validateProducerArgs('ingest-voice-transcribe', { audioPaths: ['/tmp/a.wav', '/tmp/b.ogg'] }));
  assert.throws(() => validateProducerArgs('ingest-voice-transcribe', {}), /exactly one of "audioPath" or "audioPaths"/);
  assert.throws(() => validateProducerArgs('ingest-voice-transcribe', { audioPath: '/a', audioPaths: ['/b'] }), /exactly one of/);
  assert.throws(() => validateProducerArgs('ingest-voice-transcribe', { audioPaths: [] }), /non-empty array of strings/);
  assert.throws(() => validateProducerArgs('ingest-voice-transcribe', { audioPaths: ['/a', 7] }), /non-empty array of strings/);
});

// A scripted exec that behaves like a producer: parses --out, writes the artifact + meta.
const ARTIFACT = 'PRODUCER ARTIFACT — fixture text\nline two\n';
const fakeExecOk = async (cmd, argv) => {
  const out = argv[argv.indexOf('--out') + 1];
  writeFileSync(join(out, 'output.txt'), ARTIFACT);
  writeFileSync(join(out, 'output.meta.json'), JSON.stringify({
    tool: 'fixture', outputChars: ARTIFACT.length,
    outputSha256: createHash('sha256').update(ARTIFACT, 'utf8').digest('hex'),
  }));
  return { code: 0, stdout: 'fixture producer done', stderr: '', timedOut: false, spawnError: null };
};

test('runner: a call lands a job folder and a receipt whose hash is recomputed from disk', async () => {
  const workRoot = mkdtempSync(join(tmpdir(), 'producers-test-'));
  const runner = createProducerRunner({ workRoot, exec: fakeExecOk });
  const receipt = await runner.run('ingest-browser-capture', { url: 'https://example.com/' });
  assert.equal(receipt.tool, 'ingest-browser-capture');
  assert.ok(existsSync(receipt.outputPath));
  assert.equal(readFileSync(receipt.outputPath, 'utf8'), ARTIFACT);
  assert.equal(receipt.chars, ARTIFACT.length);
  assert.equal(receipt.sha256, sha256Hex(ARTIFACT));
  assert.equal(receipt.meta.outputChars, ARTIFACT.length);
  assert.match(receipt.stdoutTail, /fixture producer done/);
});

test('runner: the producer command lines carry the tool args as argv', async () => {
  const workRoot = mkdtempSync(join(tmpdir(), 'producers-test-'));
  const seen = [];
  const runner = createProducerRunner({
    workRoot,
    exec: async (cmd, argv, opts) => { seen.push([cmd, argv, opts.timeoutMs]); return fakeExecOk(cmd, argv); },
  });
  await runner.run('ingest-youtube-transcript', { query: 'Blender Conference talk' });
  await runner.run('ingest-voice-transcribe', { audioPath: '/audio/jfk.wav' });
  await runner.run('ingest-voice-transcribe', { audioPaths: ['/audio/a.wav', '/audio/b.ogg'] });
  assert.equal(seen[0][0], 'node');
  assert.ok(seen[0][1].includes('produce-youtube.mjs'));
  assert.ok(seen[0][1].includes('--query'));
  assert.equal(seen[1][0], 'python3');
  assert.ok(seen[1][1].includes('produce-voice.py'));
  assert.ok(seen[1][1].includes('/audio/jfk.wav'));
  // One batched voice call = one process, one --audio per file (one model load).
  assert.deepEqual(seen[2][1].filter((x) => x === '--audio').length, 2);
  assert.ok(seen[2][1].includes('/audio/a.wav') && seen[2][1].includes('/audio/b.ogg'));
});

test('runner: failures never resolve with a receipt', async () => {
  const workRoot = mkdtempSync(join(tmpdir(), 'producers-test-'));
  const nonzero = createProducerRunner({ workRoot, exec: async () => ({ code: 3, stdout: '', stderr: 'boom', timedOut: false, spawnError: null }) });
  await assert.rejects(() => nonzero.run('ingest-site-crawl', { url: 'https://x' }), /exited 3/);
  const silent = createProducerRunner({ workRoot, exec: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false, spawnError: null }) });
  await assert.rejects(() => silent.run('ingest-site-crawl', { url: 'https://x' }), /wrote no output\.txt/);
  const noSpawn = createProducerRunner({ workRoot, exec: async () => ({ code: 1, stdout: '', stderr: '', timedOut: false, spawnError: 'spawn node ENOENT' }) });
  await assert.rejects(() => noSpawn.run('ingest-site-crawl', { url: 'https://x' }), /could not start/);
  const timedOut = createProducerRunner({ workRoot, exec: async () => ({ code: 1, stdout: '', stderr: '', timedOut: true, spawnError: null }) });
  await assert.rejects(() => timedOut.run('ingest-site-crawl', { url: 'https://x' }), /exceeded its .* cap/);
  const lyingMeta = createProducerRunner({
    workRoot,
    exec: async (cmd, argv) => {
      const out = argv[argv.indexOf('--out') + 1];
      writeFileSync(join(out, 'output.txt'), ARTIFACT);
      writeFileSync(join(out, 'output.meta.json'), JSON.stringify({ outputSha256: 'f'.repeat(64) }));
      return { code: 0, stdout: '', stderr: '', timedOut: false, spawnError: null };
    },
  });
  await assert.rejects(() => lyingMeta.run('ingest-site-crawl', { url: 'https://x' }), /meta hash mismatch/);
});

test('callProducerTool: MCP result shape; errors are isError, never thrown', async () => {
  const good = { run: async (name) => ({ tool: name, sha256: 'ab'.repeat(32), chars: 3 }) };
  const r = await callProducerTool('ingest-site-crawl', { url: 'https://x' }, { runner: good });
  assert.equal(r.isError, undefined);
  assert.match(r.content[0].text, /"sha256"/);
  const bad = { run: async () => { throw new Error('producer exploded'); } };
  const r2 = await callProducerTool('ingest-site-crawl', { url: 'https://x' }, { runner: bad });
  assert.equal(r2.isError, true);
  assert.match(r2.content[0].text, /producer exploded/);
  const r3 = await callProducerTool('ingest-nonsense', {}, { runner: good });
  assert.equal(r3.isError, true);
});

test('registry: tools/list carries the five producers; tools/call routes to the runner', async () => {
  const list = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, {});
  const names = list.result.tools.map((t) => t.name);
  for (const n of EXPECTED) assert.ok(names.includes(n), `tools/list includes ${n}`);
  let routed = null;
  const deps = { producers: { runner: { run: async (name, args) => { routed = [name, args]; return { tool: name, ok: true }; } } } };
  const call = await handleMessage(
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'ingest-voice-transcribe', arguments: { audioPath: '/a.wav' } } },
    deps,
  );
  assert.deepEqual(routed, ['ingest-voice-transcribe', { audioPath: '/a.wav' }]);
  assert.match(call.result.content[0].text, /"ok": true/);
});
