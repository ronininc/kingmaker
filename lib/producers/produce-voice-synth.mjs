// Voice-synthesis producer (kokoro-js engine) — the voice-synthesize tool's
// Node engine: Kokoro-82M through kokoro-js over onnxruntime-node, using the
// quantized ONNX weights already on this node (the browser voice POC's local
// model store). This is the engine that lands where the voice runtime's
// spaCy-dependent sidecar cannot load; produce-voice-synth.py is the same
// contract over the shipped sidecar, and the runner picks the engine from
// the node-local bindings (see lib/producers.mjs TOOL_SCRIPTS).
//
// Contract: argv --out <jobDir> (--text <text> | --line <line> [--line ...])
// [--voice <name>] [--speed <float>] [--pause-ms <int>]; writes output.wav
// + output.meta.json (outputSha256 in meta, a per-line timing map measured
// from the synthesized samples), rewrites both INCREMENTALLY after every
// line with meta.complete false until the last, prints progress lines, and
// exits non-zero with a named reason on failure. Lines longer than
// CHUNK_CHARS are split at sentence boundaries under the hood — the timing
// map still reports the caller's lines, so an assembly can sync to them.
//
// Bindings (environment, node-local; a missing binding is a named error,
// never a download and never a fabricated artifact):
//   KINGMAKER_KOKORO_JS      — dir whose node_modules carry kokoro-js
//   KINGMAKER_KOKORO_MODELS  — local model store root (holds
//                              onnx-community/Kokoro-82M-v1.0-ONNX)
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const argAll = (name) => { const out = []; for (let i = 0; i < argv.length; i++) if (argv[i] === name) out.push(argv[i + 1]); return out; };

const OUT = arg('--out');
if (!OUT) { console.error('voice-synthesize: --out is required'); process.exit(2); }
mkdirSync(OUT, { recursive: true });
const LINES = (argAll('--line').length ? argAll('--line') : [arg('--text')])
  .map((x) => String(x ?? '').trim()).filter(Boolean);
if (!LINES.length) { console.error('voice-synthesize: no text given'); process.exit(2); }
const VOICE = arg('--voice') ?? 'am_adam';
const SPEED = Number(arg('--speed') ?? 1.0);
const PAUSE_MS = Math.max(0, Math.min(3000, Number(arg('--pause-ms') ?? 350)));
const CHUNK_CHARS = 300;
const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';

const JS_DIR = process.env.KINGMAKER_KOKORO_JS ?? '';
const MODELS = process.env.KINGMAKER_KOKORO_MODELS ?? '';
if (!JS_DIR || !existsSync(join(JS_DIR, 'node_modules', 'kokoro-js'))) {
  console.error(`voice-synthesize: kokoro binding missing — KINGMAKER_KOKORO_JS does not name a dir with node_modules/kokoro-js (got ${JSON.stringify(JS_DIR)}); the runtime is node-local and is never downloaded by this producer`);
  process.exit(2);
}
if (!MODELS || !existsSync(join(MODELS, MODEL_ID, 'onnx', 'model_quantized.onnx'))) {
  console.error(`voice-synthesize: kokoro binding missing — KINGMAKER_KOKORO_MODELS does not name a local store holding ${MODEL_ID} (got ${JSON.stringify(MODELS)}); the weights are node-local and are never downloaded by this producer`);
  process.exit(2);
}

const sha256Hex = (buf) => createHash('sha256').update(buf).digest('hex');

function splitChunks(text) {
  if (text.length <= CHUNK_CHARS) return [text];
  const sentences = text.split(/(?<=[.!?…])\s+/);
  const chunks = [];
  let cur = '';
  for (const s of sentences) {
    if (s.length > CHUNK_CHARS) {
      if (cur) { chunks.push(cur); cur = ''; }
      for (let i = 0; i < s.length; i += CHUNK_CHARS) chunks.push(s.slice(i, i + CHUNK_CHARS));
    } else if (cur.length + (cur ? 1 : 0) + s.length <= CHUNK_CHARS) {
      cur = cur ? `${cur} ${s}` : s;
    } else { chunks.push(cur); cur = s; }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

function wavBytes(pcmFloat32, sr) {
  const n = pcmFloat32.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0, 'ascii'); buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8, 'ascii'); buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii'); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, pcmFloat32[i]));
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  return buf;
}

const { KokoroTTS } = await import(pathToFileURL(join(JS_DIR, 'node_modules', 'kokoro-js', 'dist', 'kokoro.js')).href);
const { env } = await import(pathToFileURL(join(JS_DIR, 'node_modules', '@huggingface', 'transformers', 'dist', 'transformers.node.cjs')).href)
  .catch(() => import(pathToFileURL(join(JS_DIR, 'node_modules', '@huggingface', 'transformers', 'src', 'env.js')).href));
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = MODELS.endsWith('/') ? MODELS : `${MODELS}/`;

const tLoad = Date.now();
const tts = await KokoroTTS.from_pretrained(MODEL_ID, { dtype: 'q8', device: 'cpu' });
const loadS = (Date.now() - tLoad) / 1000;
const voices = Object.keys(tts.voices ?? {});
if (!voices.includes(VOICE)) {
  console.error(`voice-synthesize: unknown voice ${JSON.stringify(VOICE)} — the weights on this node carry ${voices.length} voices (${voices.slice(0, 8).join(', ')}…)`);
  process.exit(2);
}
console.log(`kokoro-js ready in ${loadS.toFixed(1)}s: ${voices.length} voices, model ${MODEL_ID} (q8, cpu, local store)`);

let SR = 24_000;
let assembled = []; // Float32Array chunks
let assembledSamples = 0;
const linesMeta = [];
let cursor = 0;
const tSynth = Date.now();

function writeArtifact(complete) {
  const pcm = new Float32Array(assembledSamples);
  let off = 0;
  for (const c of assembled) { pcm.set(c, off); off += c.length; }
  const data = wavBytes(pcm, SR);
  writeFileSync(join(OUT, 'output.wav'), data);
  const meta = {
    tool: 'kokoro-js (Kokoro-82M-v1.0-ONNX q8 via onnxruntime-node, cpu, local weights)',
    voice: VOICE, speed: SPEED, pauseMs: PAUSE_MS,
    sampleRate: SR, channels: 1,
    durationSec: Math.round((assembledSamples / SR) * 1000) / 1000,
    inputChars: LINES.reduce((a, x) => a + x.length, 0),
    lines: linesMeta, complete,
    modelLoadSec: Math.round(loadS * 10) / 10,
    outputBytes: data.length, outputSha256: sha256Hex(data),
  };
  writeFileSync(join(OUT, 'output.meta.json'), JSON.stringify(meta, null, 2));
  return meta;
}

for (let li = 0; li < LINES.length; li++) {
  const line = LINES[li];
  const lineStart = cursor;
  let rmsAcc = 0, nChunks = 0;
  for (const chunk of splitChunks(line)) {
    const audio = await tts.generate(chunk, { voice: VOICE, speed: SPEED });
    const samples = audio.audio;
    if (audio.sampling_rate) SR = audio.sampling_rate;
    assembled.push(samples);
    assembledSamples += samples.length;
    cursor += samples.length / SR;
    let sq = 0;
    for (let i = 0; i < samples.length; i++) sq += samples[i] * samples[i];
    rmsAcc += Math.sqrt(sq / Math.max(1, samples.length));
    nChunks++;
  }
  linesMeta.push({
    index: li, text: line, chars: line.length, chunks: nChunks,
    startSec: Math.round(lineStart * 1000) / 1000, endSec: Math.round(cursor * 1000) / 1000,
    durationSec: Math.round((cursor - lineStart) * 1000) / 1000,
    rms: Math.round((rmsAcc / nChunks) * 10000) / 10000,
  });
  console.log(`line ${li + 1}/${LINES.length}: ${line.length} chars -> ${(cursor - lineStart).toFixed(2)}s (${nChunks} chunk${nChunks !== 1 ? 's' : ''})`);
  if (li < LINES.length - 1 && PAUSE_MS) {
    const silence = new Float32Array(Math.round((SR * PAUSE_MS) / 1000));
    assembled.push(silence);
    assembledSamples += silence.length;
    cursor += PAUSE_MS / 1000;
  }
  writeArtifact(li === LINES.length - 1);
}

const meta = writeArtifact(true);
const wall = (Date.now() - tSynth) / 1000;
console.log(`output.wav written: ${meta.durationSec}s of audio, ${meta.outputBytes} bytes, ${wall.toFixed(1)}s synthesis wall (model load ${loadS.toFixed(1)}s separate)`);
