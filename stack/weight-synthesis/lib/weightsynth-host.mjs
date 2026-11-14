/**
 * weightsynth-host.mjs — the host wiring for the Weight Synthesis Engine.
 *
 * The core (weightsynth-core.mjs) merges in-memory tensor sets; the Judge
 * (weightsynth-judge.mjs) measures through injected functions; the
 * registry (weightsynth-registry.mjs) pins and gates loads. None of them
 * touch a file or a network socket. This module is the host layer that
 * connects them to the real world:
 *
 *   · safetensors read/write — model files ↔ tensor sets. Writes are
 *     deterministic (sorted names, contiguous offsets, F32) so an
 *     artifact's bytes are a function of its tensors alone.
 *   · GGUF directory read — enumerate a GGUF file's metadata + tensor
 *     table (names, shapes, types) without loading weights: enough to
 *     fingerprint an architecture and plan a merge before committing.
 *   · HTTP judge transports — an evaluator that runs the FIXED suite
 *     against a serving endpoint (llama.cpp server / Ollama) with
 *     deterministic scoring, and a measurer that reads decode/prefill
 *     rates from the endpoint's own timings.
 *   · synthesize() — the pipeline: load parents → register (hash-checked)
 *     → license gate → execute recipe → write the artifact → judge it →
 *     build the pin. SIGNING the pin is the adoption act: it happens
 *     only with a verified founder tap, and the private key is passed
 *     in by the host at that moment — it is never stored here.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createTapGate } from '../../lib/governance.mjs';
import { contentId, executeRecipe, hashTensorSet } from './weightsynth-core.mjs';
import { judgeCandidate } from './weightsynth-judge.mjs';
import { createParentRegistry, pinRecord, signPin } from './weightsynth-registry.mjs';

/* ------------------------------------------------------------------ */
/* safetensors                                                         */
/* ------------------------------------------------------------------ */

const DTYPE_SIZES = { F32: 4, F16: 2, BF16: 2, I64: 8, I32: 4 };

function decodeTensor(dtype, buf, byteOffset, count) {
  const out = new Float32Array(count);
  const view = new DataView(buf.buffer, buf.byteOffset + byteOffset, count * DTYPE_SIZES[dtype]);
  if (dtype === 'F32') { for (let i = 0; i < count; i += 1) out[i] = view.getFloat32(i * 4, true); }
  else if (dtype === 'F16') { for (let i = 0; i < count; i += 1) out[i] = view.getFloat16(i * 2, true); }
  else if (dtype === 'BF16') { for (let i = 0; i < count; i += 1) { const bits = view.getUint16(i * 2, true) << 16; const f = new DataView(new ArrayBuffer(4)); f.setUint32(0, bits); out[i] = f.getFloat32(0); } }
  else throw new Error(`REFUSE: safetensors dtype ${dtype} is not a weight dtype this host decodes (F32/F16/BF16 only)`);
  return out;
}

/** Parse a safetensors file into { tensors, metadata }. */
export function readSafetensors(path) {
  const buf = readFileSync(path);
  if (buf.length < 8) throw new Error('REFUSE: safetensors file too small');
  const headerLen = Number(buf.readBigUInt64LE(0));
  const header = JSON.parse(buf.subarray(8, 8 + headerLen).toString('utf8'));
  const dataStart = 8 + headerLen;
  const tensors = {};
  for (const [name, info] of Object.entries(header)) {
    if (name === '__metadata__') continue;
    const count = info.shape.reduce((a, b) => a * b, 1);
    const [start, end] = info.data_offsets;
    if (end - start !== count * (DTYPE_SIZES[info.dtype] ?? -1)) throw new Error(`REFUSE: tensor ${name} byte range does not match its shape/dtype`);
    tensors[name] = { shape: info.shape, data: decodeTensor(info.dtype, buf, dataStart + start, count) };
  }
  return { tensors, metadata: header.__metadata__ ?? {} };
}

/** Write a tensor set as safetensors (F32). Deterministic: names sorted,
 *  header canonical, offsets contiguous — same tensors, same bytes. */
export function writeSafetensors(path, tensors, metadata = {}) {
  const names = Object.keys(tensors).sort();
  const header = {};
  if (Object.keys(metadata).length) header.__metadata__ = metadata;
  let offset = 0;
  const parts = [];
  for (const name of names) {
    const t = tensors[name];
    const bytes = Buffer.from(t.data.buffer, t.data.byteOffset, t.data.byteLength);
    header[name] = { dtype: 'F32', shape: t.shape, data_offsets: [offset, offset + bytes.length] };
    offset += bytes.length;
    parts.push(bytes);
  }
  const headerText = JSON.stringify(header);
  const lenBuf = Buffer.alloc(8);
  lenBuf.writeBigUInt64LE(BigInt(Buffer.byteLength(headerText)));
  writeFileSync(path, Buffer.concat([lenBuf, Buffer.from(headerText), ...parts]));
}

/* ------------------------------------------------------------------ */
/* GGUF directory                                                      */
/* ------------------------------------------------------------------ */

const GGUF_TYPES = { 0: 'F32', 1: 'F16', 2: 'Q4_0', 3: 'Q4_1', 6: 'Q5_0', 7: 'Q5_1', 8: 'Q8_0', 14: 'BF16' };

/** Parse a GGUF file's header: metadata KV + the tensor directory.
 *  Weights are NOT decoded — this is the pre-merge fingerprint pass. */
export function readGgufDirectory(path) {
  const buf = readFileSync(path);
  let off = 0;
  const take = (n) => { const s = buf.subarray(off, off + n); off += n; return s; };
  const u32 = () => { const v = buf.readUInt32LE(off); off += 4; return v; };
  const u64 = () => { const v = Number(buf.readBigUInt64LE(off)); off += 8; return v; };
  const str = () => { const n = u64(); const s = take(n).toString('utf8'); return s; };
  if (take(4).toString('latin1') !== 'GGUF') throw new Error('REFUSE: not a GGUF file');
  const version = u32();
  if (version < 2 || version > 3) throw new Error(`REFUSE: GGUF version ${version} not understood by this host`);
  const tensorCount = u64();
  const kvCount = u64();
  const readValue = (type) => {
    switch (type) {
      case 0: return take(1)[0];
      case 1: { const v = buf.readInt8(off); off += 1; return v; }
      case 2: { const v = buf.readUInt16LE(off); off += 2; return v; }
      case 3: { const v = buf.readInt16LE(off); off += 2; return v; }
      case 4: case 5: { const v = buf.readInt32LE(off); off += 4; return v; }
      case 6: { const v = buf.readFloatLE(off); off += 4; return v; }
      case 7: return take(1)[0] !== 0;
      case 8: return str();
      case 9: { const et = u32(); const n = u64(); const arr = []; for (let i = 0; i < n; i += 1) arr.push(readValue(et)); return arr; }
      case 10: return u64();
      case 11: { const v = Number(buf.readBigInt64LE(off)); off += 8; return v; }
      case 12: { const v = buf.readDoubleLE(off); off += 8; return v; }
      default: throw new Error(`REFUSE: GGUF metadata value type ${type} not understood`);
    }
  };
  const metadata = {};
  for (let i = 0; i < kvCount; i += 1) { const key = str(); const type = u32(); metadata[key] = readValue(type); }
  const tensors = [];
  for (let i = 0; i < tensorCount; i += 1) {
    const name = str();
    const nDims = u32();
    const shape = [];
    for (let d = 0; d < nDims; d += 1) shape.push(u64());
    const type = u32();
    const offset = u64();
    tensors.push({ name, shape, type: GGUF_TYPES[type] ?? `type-${type}`, offset });
  }
  const alignment = metadata['general.alignment'] ?? 32;
  const dataStart = Math.ceil(off / alignment) * alignment;
  return { version, metadata, tensors, dataStart };
}

/* ------------------------------------------------------------------ */
/* HTTP judge transports                                               */
/* ------------------------------------------------------------------ */

async function chatOnce({ baseUrl, model, protocol, prompt, fetchImpl, timeoutMs = 120_000 }) {
  const doFetch = fetchImpl ?? fetch;
  const root = String(baseUrl).replace(/\/$/, '');
  const url = protocol === 'ollama' ? `${root}/api/chat` : `${root}/v1/chat/completions`;
  const messages = [{ role: 'user', content: prompt }];
  const body = protocol === 'ollama'
    ? { model, messages, stream: false, options: { temperature: 0 } }
    : { model, messages, temperature: 0, stream: false };
  const res = await doFetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`weightsynth-host: endpoint HTTP ${res.status}`);
  const json = await res.json();
  const text = protocol === 'ollama' ? json?.message?.content : json?.choices?.[0]?.message?.content;
  if (typeof text !== 'string') throw new Error('weightsynth-host: endpoint returned no message content');
  return { text, raw: json };
}

function scoreCase(output, expect) {
  const out = String(output).trim();
  if (expect.type === 'exact') return out === String(expect.value).trim() ? 1 : 0;
  if (expect.type === 'contains') return out.includes(String(expect.value)) ? 1 : 0;
  if (expect.type === 'regex') return new RegExp(expect.value).test(out) ? 1 : 0;
  throw new Error(`REFUSE: unknown suite expectation type "${expect.type}"`);
}

const runSuite = async (ref, cases) => {
  let total = 0;
  for (const c of cases) {
    const { text } = await chatOnce({ ...ref, prompt: c.prompt });
    total += scoreCase(text, c.expect);
  }
  return total / cases.length;
};

/**
 * createHttpEvaluator({ suite, heldOut, fetchImpl })
 *   suite / heldOut: [{ prompt, expect: {type, value} }] — FIXED sets; the
 *   held-out set is the truth (the Judge prefers it), so it stays small,
 *   private, and never part of a recipe.
 * Returns the Judge's evaluate(artifactRef) where artifactRef =
 * { baseUrl, model, protocol } — the endpoint serving the candidate.
 */
export function createHttpEvaluator({ suite, heldOut, fetchImpl } = {}) {
  if (!Array.isArray(suite) || suite.length === 0) throw new Error('REFUSE: the evaluator needs a fixed suite');
  return async function evaluate(ref) {
    const withFetch = { ...ref, fetchImpl };
    const suiteScore = await runSuite(withFetch, suite);
    const heldOutScore = Array.isArray(heldOut) && heldOut.length ? await runSuite(withFetch, heldOut) : undefined;
    return { suiteScore, heldOutScore };
  };
}

/** createHttpMeasurer({ fetchImpl, prompt }) → the Judge's measure(ref):
 *  decode/prefill rates from the endpoint's own timing fields. */
export function createHttpMeasurer({ fetchImpl, prompt = 'Count from one to twenty.' } = {}) {
  return async function measure(ref) {
    const started = Date.now();
    const { raw } = await chatOnce({ ...ref, fetchImpl, prompt });
    const wallSec = (Date.now() - started) / 1000;
    if (ref.protocol === 'ollama' && raw.eval_count && raw.eval_duration) {
      return {
        decodeTokPerSec: raw.eval_count / (raw.eval_duration / 1e9),
        prefillTokPerSec: raw.prompt_eval_count && raw.prompt_eval_duration ? raw.prompt_eval_count / (raw.prompt_eval_duration / 1e9) : null,
      };
    }
    if (raw.timings?.predicted_per_second) {
      return { decodeTokPerSec: raw.timings.predicted_per_second, prefillTokPerSec: raw.timings.prompt_per_second ?? null };
    }
    const tokens = raw.usage?.completion_tokens;
    if (tokens && wallSec > 0) return { decodeTokPerSec: tokens / wallSec, prefillTokPerSec: null };
    throw new Error('REFUSE: the endpoint reported no timing fields — production cannot be measured, and an unmeasured candidate is not judged');
  };
}

/* ------------------------------------------------------------------ */
/* The pipeline                                                        */
/* ------------------------------------------------------------------ */

/**
 * synthesize({ parents, recipe, artifactPath, evaluate, measure, twinSpecHash,
 *              verifyTap, tapToken, signingKeyPem })
 *   parents: [{ path, license, source }] — safetensors files on disk.
 * Runs the whole line and returns { artifactHash, artifactPath, judge, pin,
 * signature, adopted }. The pin is SIGNED only when a founder tap verifies
 * AND a signing key is handed in for the act; otherwise the result is a
 * complete, judged, unsigned candidate — adoption stays the founder's.
 */
export async function synthesize({ parents, recipe, artifactPath, judgeRef, evaluate, measure, twinSpecHash = null, verifyTap, tapToken, signingKeyPem }) {
  if (!Array.isArray(parents) || parents.length === 0) throw new Error('REFUSE: no parents');
  const registry = createParentRegistry();
  const loaded = new Map();
  for (const p of parents) {
    const { tensors } = readSafetensors(p.path);
    const hash = hashTensorSet(tensors);
    registry.register({ hash, license: p.license, source: p.source, tensors });
    loaded.set(hash, { tensors });
  }
  const checked = registry.checkRecipe(recipe);
  const { tensors, artifactHash } = executeRecipe(recipe, loaded);
  writeSafetensors(artifactPath, tensors, { synthesizedBy: 'weightsynth-host', recipe: recipe.seed ?? '' });
  // The host serves the artifact, then judges it where it is served:
  // judgeRef is that endpoint descriptor ({ baseUrl, model, protocol }).
  const judged = await judgeCandidate({ id: 'candidate', artifactRef: judgeRef ?? { path: artifactPath }, evaluate, measure });
  const record = pinRecord({
    recipeId: contentId(recipe),
    artifactHash,
    parentHashes: recipe.parents,
    inheritedLicense: checked.inheritedLicense,
    judge: { quality: judged.quality, production: judged.production, suite: judged.suiteScore },
    twinSpecHash,
  });
  let signature = null;
  let adopted = false;
  if (typeof verifyTap === 'function' && signingKeyPem) {
    const gate = createTapGate(verifyTap);
    const refusal = await gate(tapToken);
    if (!refusal) { signature = signPin(record, signingKeyPem); adopted = true; }
  }
  return { artifactHash, artifactPath, judge: judged, pin: record, signature, adopted, inheritedLicense: checked.inheritedLicense };
}

/** sha256 of a file's bytes (parent intake receipts). */
export function fileSha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}
