// Tests for lib/weightsynth-host.mjs — file adapters, GGUF directory, HTTP
// judge transports against a stub endpoint, and the tap-gated pipeline.
// Run: node tests/host.test.mjs
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashTensorSet } from '../lib/weightsynth-core.mjs';
import { verifyForLoad } from '../lib/weightsynth-registry.mjs';
import { createHttpEvaluator, createHttpMeasurer, readGgufDirectory, readSafetensors, synthesize, writeSafetensors } from '../lib/weightsynth-host.mjs';

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed += 1; console.log(`  ok - ${name}`); };
const d = mkdtempSync(join(tmpdir(), 'wsynth-host-'));

/* safetensors round trip + determinism */
{
  const tensors = {
    'b.weight': { shape: [2], data: new Float32Array([3, 4]) },
    'a.weight': { shape: [2, 2], data: new Float32Array([1, 2, 3, 4]) },
  };
  const p1 = join(d, 'm1.safetensors'); const p2 = join(d, 'm2.safetensors');
  writeSafetensors(p1, tensors, { origin: 'test' });
  writeSafetensors(p2, tensors, { origin: 'test' });
  ok('writeSafetensors is byte-deterministic', readFileSync(p1).equals(readFileSync(p2)));
  const back = readSafetensors(p1);
  ok('round trip preserves the tensor-set hash', hashTensorSet(back.tensors) === hashTensorSet(tensors));
  ok('metadata survives', back.metadata.origin === 'test');
}

/* F16 decode */
{
  const header = { t: { dtype: 'F16', shape: [2], data_offsets: [0, 4] } };
  const headerText = JSON.stringify(header);
  const len = Buffer.alloc(8); len.writeBigUInt64LE(BigInt(Buffer.byteLength(headerText)));
  const data = Buffer.alloc(4); const dv = new DataView(data.buffer);
  dv.setFloat16(0, 1.5, true); dv.setFloat16(2, -2.25, true);
  const p = join(d, 'f16.safetensors');
  writeFileSync(p, Buffer.concat([len, Buffer.from(headerText), data]));
  const back = readSafetensors(p);
  ok('F16 tensors decode to float32 values', back.tensors.t.data[0] === 1.5 && back.tensors.t.data[1] === -2.25);
}

/* GGUF directory from a hand-built fixture */
{
  const parts = [];
  const push = (b) => parts.push(b);
  const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; };
  const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
  const ggstr = (s) => Buffer.concat([u64(Buffer.byteLength(s)), Buffer.from(s)]);
  push(Buffer.from('GGUF')); push(u32(3)); push(u64(1)); push(u64(2));
  push(ggstr('general.name')); push(u32(8)); push(ggstr('tiny-test'));
  push(ggstr('general.alignment')); push(u32(4)); push(u32(32));
  push(ggstr('token_embd.weight')); push(u32(2)); push(u64(4)); push(u64(8)); push(u32(0)); push(u64(0));
  const p = join(d, 'tiny.gguf');
  writeFileSync(p, Buffer.concat(parts));
  const dir = readGgufDirectory(p);
  ok('GGUF metadata parsed', dir.metadata['general.name'] === 'tiny-test' && dir.metadata['general.alignment'] === 32);
  ok('GGUF tensor directory parsed', dir.tensors.length === 1 && dir.tensors[0].name === 'token_embd.weight' && dir.tensors[0].type === 'F32' && dir.tensors[0].shape.join('x') === '4x8');
}

/* HTTP judge transports against a stub Ollama endpoint */
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const parsed = JSON.parse(body || '{}');
    const prompt = parsed.messages?.[0]?.content ?? '';
    let text = 'wrong';
    if (prompt.includes('capital of France')) text = 'Paris';
    if (prompt.includes('Count from one')) text = 'one two three';
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      message: { role: 'assistant', content: text },
      eval_count: 20, eval_duration: 1_000_000_000, prompt_eval_count: 10, prompt_eval_duration: 250_000_000,
    }));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
try {
  const evaluate = createHttpEvaluator({
    suite: [
      { prompt: 'What is the capital of France?', expect: { type: 'exact', value: 'Paris' } },
      { prompt: 'What is the capital of Spain?', expect: { type: 'exact', value: 'Madrid' } },
    ],
    heldOut: [{ prompt: 'Name the capital of France, one word.', expect: { type: 'contains', value: 'Paris' } }],
  });
  // heldOut prompt must hit the stub's Paris branch: it contains "capital of France"
  const ref = { baseUrl, model: 'candidate', protocol: 'ollama' };
  const ev = await evaluate(ref);
  ok('evaluator scores the fixed suite deterministically', ev.suiteScore === 0.5);
  ok('held-out set scored separately', ev.heldOutScore === 1);
  const measure = createHttpMeasurer({});
  const me = await measure(ref);
  ok('measurer reads decode rate from endpoint timings', me.decodeTokPerSec === 20 && me.prefillTokPerSec === 40);

  /* synthesize end to end */
  const parentA = { w: { shape: [2], data: new Float32Array([2, 4]) } };
  const parentB = { w: { shape: [2], data: new Float32Array([4, 8]) } };
  const pa = join(d, 'pa.safetensors'); const pb = join(d, 'pb.safetensors');
  writeSafetensors(pa, parentA); writeSafetensors(pb, parentB);
  const hA = hashTensorSet(parentA); const hB = hashTensorSet(parentB);
  const recipe = {
    version: 1, algorithm: 'linear', parents: [hA, hB], coefficients: [0.5, 0.5], seed: 'host-test',
    suite: { id: 'host-fixture', version: '1' },
    balance: { qualityWeight: 0.5, productionWeight: 0.5, qualityFloor: 0.8 },
    environment: { twinSpecHash: 'a'.repeat(64), toolchain: { name: 'weightsynth-core', version: '1.0.0' } },
  };
  const artifactPath = join(d, 'merged.safetensors');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' });

  const unsigned = await synthesize({ parents: [{ path: pa, license: 'Apache-2.0', source: 'fixture A' }, { path: pb, license: 'MIT', source: 'fixture B' }], recipe, artifactPath, judgeRef: ref, evaluate, measure });
  ok('pipeline merges + judges + pins', unsigned.artifactHash.length === 64 && unsigned.judge.quality === 1 && unsigned.judge.production === 20);
  ok('merged values are the linear blend', Math.abs(readSafetensors(artifactPath).tensors.w.data[0] - 3) < 1e-6);
  ok('without a tap the pin stays UNSIGNED (adoption is the founder act)', unsigned.adopted === false && unsigned.signature === null);
  ok('license inheritance takes the strictest parent', unsigned.inheritedLicense === 'Apache-2.0');

  const adopted = await synthesize({ parents: [{ path: pa, license: 'Apache-2.0', source: 'fixture A' }, { path: pb, license: 'MIT', source: 'fixture B' }], recipe, artifactPath, judgeRef: ref, evaluate, measure, verifyTap: (t) => t === 'tap-ok', tapToken: 'tap-ok', signingKeyPem: privPem });
  ok('with a verified tap the pin is signed', adopted.adopted === true && typeof adopted.signature === 'string');
  const load = verifyForLoad({ record: adopted.pin, signatureB64: adopted.signature, artifactHash: adopted.artifactHash, publicKeyPem: pubPem });
  ok('the signed pin passes the router load gate', load.ok === true);
} finally {
  server.close();
}
console.log(`weightsynth-host: ${passed} checks passed`);
