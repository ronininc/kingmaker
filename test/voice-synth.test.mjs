// Tests for the voice-synthesize producer's registration (lib/producers.mjs) and wiring
// into the MCP registry (lib/mcp.mjs): the fifth producer tool's shape, its validation
// rules (text/lines one-of, caps, ranges), the runner's AUDIO receipt discipline over a
// scripted exec (job folder, WAV read-back, hash recomputed from disk, sample rate
// cross-checked against the WAV header itself — not the producer's word), every failure
// path refusing to fabricate a receipt, and tools/call routing through the registry.
// The real Kokoro run is proven separately (live receipts); here the producer is scripted.
// Run: node --test test/voice-synth.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  PRODUCER_TOOLS, validateProducerArgs, createProducerRunner, wavSampleRate,
} from '../lib/producers.mjs';
import { TOOLS, handleMessage } from '../lib/mcp.mjs';

const TOOL = PRODUCER_TOOLS.find((t) => t.name === 'voice-synthesize');

/** A minimal valid 24 kHz mono WAV: header + 2400 samples (0.1 s) of silence. */
function fixtureWav(rate = 24_000, samples = 2400) {
  const data = Buffer.alloc(44 + samples * 2);
  data.write('RIFF', 0, 'ascii'); data.writeUInt32LE(36 + samples * 2, 4);
  data.write('WAVE', 8, 'ascii'); data.write('fmt ', 12, 'ascii');
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(rate, 24); data.writeUInt32LE(rate * 2, 28);
  data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34);
  data.write('data', 36, 'ascii'); data.writeUInt32LE(samples * 2, 40);
  return data;
}
const WAV = fixtureWav();
const WAV_SHA = createHash('sha256').update(WAV).digest('hex');

test('registration: voice-synthesize is the fifth producer, MCP-shaped, in the registry', () => {
  assert.ok(TOOL, 'voice-synthesize is registered');
  assert.equal(PRODUCER_TOOLS.length, 5);
  assert.ok(TOOL.description.length > 40);
  assert.equal(TOOL.inputSchema.type, 'object');
  assert.equal(TOOL.inputSchema.additionalProperties, false);
  assert.ok(TOOL.annotations?.title);
  const allNames = TOOLS.map((t) => t.name);
  assert.equal(new Set(allNames).size, allNames.length, 'no name collisions in the full registry');
  assert.ok(allNames.includes('voice-synthesize'));
});

test('validation: exactly one of text/lines, char cap, speed and pause ranges', () => {
  assert.throws(() => validateProducerArgs('voice-synthesize', {}), /exactly one of "text" or "lines"/);
  assert.throws(() => validateProducerArgs('voice-synthesize', { text: 'a', lines: ['b'] }), /exactly one of/);
  assert.throws(() => validateProducerArgs('voice-synthesize', { text: 'x'.repeat(6001) }), /cap is 6000/);
  assert.throws(() => validateProducerArgs('voice-synthesize', { text: 'ok', speed: 3 }), /between 0.5 and 2/);
  assert.throws(() => validateProducerArgs('voice-synthesize', { text: 'ok', pauseMs: 4000 }), /between 0 and 3000/);
  assert.throws(() => validateProducerArgs('voice-synthesize', { text: 'ok', bogus: 1 }), /unknown argument "bogus"/);
  assert.doesNotThrow(() => validateProducerArgs('voice-synthesize', { text: 'Speak this.' }));
  assert.doesNotThrow(() => validateProducerArgs('voice-synthesize', { lines: ['One.', 'Two.'], voice: 'am_adam', speed: 0.95, pauseMs: 500 }));
});

test('wavSampleRate: reads the header, refuses non-WAV bytes', () => {
  assert.equal(wavSampleRate(WAV), 24_000);
  assert.equal(wavSampleRate(Buffer.from('not a wav at all, just some text bytes padded out......')), null);
  assert.equal(wavSampleRate(Buffer.alloc(10)), null);
  assert.equal(wavSampleRate(null), null);
});

const fakeExecOk = async (cmd, argv) => {
  const out = argv[argv.indexOf('--out') + 1];
  writeFileSync(join(out, 'output.wav'), WAV);
  writeFileSync(join(out, 'output.meta.json'), JSON.stringify({
    tool: 'fixture-tts', voice: 'am_adam', sampleRate: 24_000, durationSec: 0.1,
    inputChars: 11, lines: [], complete: true, outputSha256: WAV_SHA,
  }));
  return { code: 0, stdout: 'kokoro sidecar ready in 1.0s\noutput.wav written', stderr: '', timedOut: false, spawnError: null };
};

test('runner: a synthesis lands a job folder and an audio receipt verified from disk', async () => {
  const workRoot = mkdtempSync(join(tmpdir(), 'voice-synth-test-'));
  const runner = createProducerRunner({ workRoot, exec: fakeExecOk });
  const receipt = await runner.run('voice-synthesize', { text: 'Speak this.' });
  assert.equal(receipt.tool, 'voice-synthesize');
  assert.ok(existsSync(receipt.outputPath));
  assert.ok(receipt.outputPath.endsWith('output.wav'));
  assert.deepEqual(readFileSync(receipt.outputPath), WAV);
  assert.equal(receipt.sha256, WAV_SHA);
  assert.equal(receipt.bytes, WAV.length);
  assert.equal(receipt.sampleRate, 24_000);
  assert.equal(receipt.durationSec, 0.1);
  assert.equal(receipt.chars, 11);
});

test('runner: the synthesis command line carries lines, voice and speed as argv', async () => {
  const workRoot = mkdtempSync(join(tmpdir(), 'voice-synth-test-'));
  const seen = [];
  const runner = createProducerRunner({
    workRoot,
    exec: async (cmd, argv, opts) => { seen.push([cmd, argv, opts.timeoutMs]); return fakeExecOk(cmd, argv); },
  });
  await runner.run('voice-synthesize', { lines: ['One.', 'Two.'], voice: 'am_adam', speed: 0.95, pauseMs: 500 });
  assert.ok(seen[0][1].includes('produce-voice-synth.py'));
  assert.deepEqual(seen[0][1].filter((x) => x === '--line').length, 2);
  assert.ok(seen[0][1].includes('am_adam') && seen[0][1].includes('0.95') && seen[0][1].includes('500'));
  assert.equal(seen[0][2], 1_800_000);
});

test('runner: audio failure shapes never resolve with a receipt', async () => {
  const workRoot = mkdtempSync(join(tmpdir(), 'voice-synth-test-'));
  const silent = createProducerRunner({ workRoot, exec: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false, spawnError: null }) });
  await assert.rejects(() => silent.run('voice-synthesize', { text: 'x' }), /wrote no output\.wav/);
  const notWav = createProducerRunner({
    workRoot,
    exec: async (cmd, argv) => {
      const out = argv[argv.indexOf('--out') + 1];
      writeFileSync(join(out, 'output.wav'), Buffer.from('definitely not a wav file, whatever the name says'));
      return { code: 0, stdout: '', stderr: '', timedOut: false, spawnError: null };
    },
  });
  await assert.rejects(() => notWav.run('voice-synthesize', { text: 'x' }), /not a WAV file/);
  const lyingRate = createProducerRunner({
    workRoot,
    exec: async (cmd, argv) => {
      const out = argv[argv.indexOf('--out') + 1];
      writeFileSync(join(out, 'output.wav'), WAV);
      writeFileSync(join(out, 'output.meta.json'), JSON.stringify({ sampleRate: 16_000, outputSha256: WAV_SHA }));
      return { code: 0, stdout: '', stderr: '', timedOut: false, spawnError: null };
    },
  });
  await assert.rejects(() => lyingRate.run('voice-synthesize', { text: 'x' }), /sample rate mismatch/);
  const nonzero = createProducerRunner({ workRoot, exec: async () => ({ code: 2, stdout: '', stderr: 'kokoro binding missing', timedOut: false, spawnError: null }) });
  await assert.rejects(() => nonzero.run('voice-synthesize', { text: 'x' }), /exited 2/);
});

test('registry: tools/call routes voice-synthesize to the producer runner', async () => {
  let routed = null;
  const deps = { producers: { runner: { run: async (name, args) => { routed = [name, args]; return { tool: name, ok: true }; } } } };
  const call = await handleMessage(
    { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'voice-synthesize', arguments: { text: 'Speak this.' } } },
    deps,
  );
  assert.deepEqual(routed, ['voice-synthesize', { text: 'Speak this.' }]);
  assert.match(call.result.content[0].text, /"ok": true/);
});
