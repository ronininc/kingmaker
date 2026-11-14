// lib/producers.mjs — the producers in Kingmaker's MCP registry (lib/mcp.mjs adds
// PRODUCER_TOOLS to TOOLS, beside IPHONE_TOOLS). Five background tools, headless: four
// ingest lanes that bring raw material into the node (a browser capture (Playwright), the
// CRM's own site crawler, a YouTube transcript pull (yt-dlp), a voice transcription
// (faster-whisper)) and one voice lane that makes material on the node (voice synthesis,
// Kokoro-82M through the voice runtime's ONNX sidecar). Each call runs the producer script
// in lib/producers/ as a child process (argv, no shell) in its own job folder and returns
// a RECEIPT — where the artifact landed, its size, its SHA-256 recomputed from the bytes
// on disk, and the producer's own meta record. The artifact itself is the record; the
// receipt never carries the artifact's content (for synthesis: never the audio itself).
//
// These are production lanes, not gates: a producer run changes nothing outside its job
// folder, sends nothing, approves nothing. What a caller does with the material (fold it
// into the evidence store, quote it, publish it, act on it) keeps that path's own gates.
//
// Node-local bindings (the producer scripts resolve them from the environment, with the
// fleet's proven locations as defaults): KINGMAKER_PLAYWRIGHT_PACKAGE (a package.json whose
// node_modules carry playwright), KINGMAKER_SITE_CRAWL_MODULE (the CRM build's
// worker/site-crawl.ts), KINGMAKER_WHISPER_MODEL (a faster-whisper model name or local CT2
// folder), and for synthesis KINGMAKER_KOKORO_PYTHON (the voice runtime's python; default
// python3), KINGMAKER_KOKORO_MODEL / KINGMAKER_KOKORO_VOICES (the Kokoro-82M ONNX weights
// on this node) and KINGMAKER_KOKORO_SIDECAR (the voice-sidecar dir). A node that lacks a
// binding gets the producer's own error as the receipt's error — never a fabricated
// artifact, and never a download: the weights are node-local by design.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

export const PRODUCER_TOOLS = Object.freeze([
  {
    name: 'ingest-browser-capture',
    description: 'Capture one web page with the headless browser (Playwright/Chromium): final URL, HTTP status, title, full page text, links and assets, written as an ingest artifact in a fresh job folder. Returns the receipt (artifact path, chars, SHA-256, meta) — not the page text. Read-only against the page; the capture is the start of an ingest lane, nothing is sent or approved.',
    inputSchema: obj({
      url: { type: 'string', description: 'The page to capture (http/https).' },
      settleMs: { type: 'integer', description: 'Extra settle time after load, ms (default 3000; late DOM and analytics keep networkidle from ever settling, so the capture waits on load + this).' },
    }, ['url']),
    annotations: { title: 'Ingest: browser capture', readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'ingest-site-crawl',
    description: 'Crawl a site with the CRM build\u2019s own crawler (worker/site-crawl.ts): same-site pages and assets checked, broken links/assets recorded, every visited URL listed, written as an ingest artifact in a fresh job folder. Returns the receipt (artifact path, chars, SHA-256, meta with the crawl counts). Read-only against the site.',
    inputSchema: obj({
      url: { type: 'string', description: 'The site root to crawl (http/https).' },
      maxPages: { type: 'integer', description: 'Page cap (default 30).' },
      maxChecks: { type: 'integer', description: 'Total check cap, pages + assets + external (default 220).' },
    }, ['url']),
    annotations: { title: 'Ingest: site crawl', readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'ingest-youtube-transcript',
    description: 'Pull a YouTube video\u2019s metadata and English transcript with yt-dlp: give a videoId (or url) for a known video, or a query to search and take the first result whose cleaned English transcript is substantial. Written as an ingest artifact in a fresh job folder. Returns the receipt (artifact path, chars, SHA-256, meta with video id/title/transcript size). Read-only.',
    inputSchema: obj({
      videoId: { type: 'string', description: 'A YouTube video id or watch URL. Mutually exclusive with query.' },
      query: { type: 'string', description: 'Search words (yt-dlp ytsearch). Mutually exclusive with videoId.' },
      minTranscriptChars: { type: 'integer', description: 'Search mode only: stop at the first candidate whose cleaned transcript reaches this many chars (default 4000).' },
    }),
    annotations: { title: 'Ingest: YouTube transcript', readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'ingest-voice-transcribe',
    description: 'Transcribe audio on this node with the voice runtime (faster-whisper, local weights, offline): segment-timed transcripts written as an ingest artifact in a fresh job folder. Give audioPath for one file, or audioPaths for several — one call loads the model once and transcribes them all, so batching files in one call is the cheap shape. Returns the receipt (artifact path, chars, SHA-256, meta with each audio file\u2019s own SHA-256, duration and segment count). The audio never leaves the node.',
    inputSchema: obj({
      audioPath: { type: 'string', description: 'Path to one audio file on this node. Mutually exclusive with audioPaths.' },
      audioPaths: { type: 'array', items: { type: 'string' }, description: 'Paths to several audio files on this node, transcribed under one model load. Mutually exclusive with audioPath.' },
    }),
    annotations: { title: 'Ingest: voice transcription', readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'voice-synthesize',
    description: 'Synthesize speech on this node with the voice runtime (Kokoro-82M, ONNX, local weights, offline): the text is spoken by the picked voice and written as ONE WAV in a fresh job folder, with a per-line timing map measured from the synthesized audio so an edit can sync picture to the actual voice. Give text for one passage, or lines (one entry per spoken line) when the timing map matters — batching lines in one call loads the model once. Returns the receipt (artifact path, duration, sample rate, input chars, SHA-256, meta with the timing map) — never the audio itself. The text never leaves the node.',
    inputSchema: obj({
      text: { type: 'string', description: 'One passage to speak (max 6000 chars). Mutually exclusive with lines.' },
      lines: { type: 'array', items: { type: 'string' }, description: 'Spoken lines, one entry each (max 6000 chars total); the receipt meta maps each line to its start/end seconds in the WAV. Mutually exclusive with text.' },
      voice: { type: 'string', description: 'Kokoro voice name from the weights on this node (default am_adam). An unknown voice fails with a named error.' },
      speed: { type: 'number', description: 'Speaking rate multiplier (default 1.0; the runtime clamps to 0.8–1.15).' },
      pauseMs: { type: 'integer', description: 'Silence between lines, ms (default 350; lines mode only).' },
    }),
    annotations: { title: 'Voice: synthesis (Kokoro)', readOnlyHint: false, openWorldHint: false },
  },
]);

export const PRODUCER_TOOL_NAMES = new Set(PRODUCER_TOOLS.map((t) => t.name));

/** Pure: SHA-256 of a text or buffer, hex — the receipt fingerprint. */
export const sha256Hex = (data) => createHash('sha256').update(data).digest('hex');

const TOOL_SCRIPTS = {
  'ingest-browser-capture': { argv: (a, out) => ['node', ['produce-browser.mjs', '--out', out, '--url', a.url, ...(a.settleMs !== undefined ? ['--settle-ms', String(a.settleMs)] : [])]], timeoutMs: 180_000, artifact: 'output.txt', kind: 'text' },
  'ingest-site-crawl': { argv: (a, out) => ['node', ['produce-crawler.mjs', '--out', out, '--url', a.url, ...(a.maxPages !== undefined ? ['--max-pages', String(a.maxPages)] : []), ...(a.maxChecks !== undefined ? ['--max-checks', String(a.maxChecks)] : [])]], timeoutMs: 300_000, artifact: 'output.txt', kind: 'text' },
  'ingest-youtube-transcript': { argv: (a, out) => ['node', ['produce-youtube.mjs', '--out', out, ...(a.videoId ? ['--video-id', a.videoId] : ['--query', a.query]), ...(a.minTranscriptChars !== undefined ? ['--min-transcript-chars', String(a.minTranscriptChars)] : [])]], timeoutMs: 600_000, artifact: 'output.txt', kind: 'text' },
  // Voice gets the longest cap: transcription cost scales with audio length and cell
  // contention, and the producer writes incrementally (each finished file lands on disk,
  // meta.complete false until the last), so a long cap risks delay, never total loss.
  'ingest-voice-transcribe': { argv: (a, out) => ['python3', ['produce-voice.py', '--out', out, ...(a.audioPaths ?? [a.audioPath]).flatMap((p) => ['--audio', p])]], timeoutMs: 1_800_000, artifact: 'output.txt', kind: 'text' },
  // Synthesis shares the long cap and the incremental-write discipline (each finished
  // line lands in output.wav, meta.complete false until the last). Two engines speak the
  // same producer contract; the node-local bindings pick between them
  // (KINGMAKER_KOKORO_ENGINE forces a choice): "sidecar" — the shipped voice runtime's
  // python sidecar (KINGMAKER_KOKORO_PYTHON, default python3) — and "kokoro-js" — the
  // Node engine over the quantized weights, used where the sidecar's spaCy-dependent
  // G2P cannot load and whenever KINGMAKER_KOKORO_JS is bound. A node with neither
  // binding gets the producer's named error, never a substitute engine or a download.
  'voice-synthesize': {
    argv: (a, out) => {
      const engine = process.env.KINGMAKER_KOKORO_ENGINE
        || (process.env.KINGMAKER_KOKORO_JS ? 'kokoro-js' : 'sidecar');
      const shared = ['--out', out,
        ...(a.lines ? a.lines.flatMap((l) => ['--line', l]) : ['--text', a.text]),
        ...(a.voice !== undefined ? ['--voice', a.voice] : []),
        ...(a.speed !== undefined ? ['--speed', String(a.speed)] : []),
        ...(a.pauseMs !== undefined ? ['--pause-ms', String(a.pauseMs)] : [])];
      return engine === 'kokoro-js'
        ? ['node', ['produce-voice-synth.mjs', ...shared]]
        : [process.env.KINGMAKER_KOKORO_PYTHON || 'python3', ['produce-voice-synth.py', ...shared]];
    },
    timeoutMs: 1_800_000, artifact: 'output.wav', kind: 'audio',
  },
};

/** Pure: the sample rate in a RIFF/WAVE header (bytes 24–27, little-endian), or null when
 *  the bytes are not a WAV — the runner's independent check on a synthesis meta record. */
export function wavSampleRate(bytes) {
  if (!bytes || bytes.length < 44) return null;
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') return null;
  return bytes.readUInt32LE(24);
}

/** Pure: validate call args against the tool's own inputSchema (required keys, flat types,
 *  no unknown keys — the schemas declare additionalProperties: false). Throws TypeError. */
export function validateProducerArgs(name, args = {}) {
  const tool = PRODUCER_TOOLS.find((t) => t.name === name);
  if (!tool) throw new TypeError(`producers: unknown tool "${name}"`);
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new TypeError(`producers: ${name} args must be an object`);
  const props = tool.inputSchema.properties ?? {};
  for (const key of Object.keys(args)) {
    if (!(key in props)) throw new TypeError(`producers: ${name} got unknown argument "${key}"`);
  }
  for (const key of tool.inputSchema.required ?? []) {
    if (args[key] === undefined || args[key] === null || args[key] === '') throw new TypeError(`producers: ${name} requires "${key}"`);
  }
  for (const [key, spec] of Object.entries(props)) {
    const v = args[key];
    if (v === undefined) continue;
    if (spec.type === 'string' && typeof v !== 'string') throw new TypeError(`producers: ${name} argument "${key}" must be a string`);
    if (spec.type === 'integer' && !Number.isInteger(v)) throw new TypeError(`producers: ${name} argument "${key}" must be an integer`);
    if (spec.type === 'number' && typeof v !== 'number') throw new TypeError(`producers: ${name} argument "${key}" must be a number`);
    if (spec.type === 'boolean' && typeof v !== 'boolean') throw new TypeError(`producers: ${name} argument "${key}" must be a boolean`);
    if (spec.type === 'array' && (!Array.isArray(v) || v.length === 0 || v.some((x) => typeof x !== 'string' || x === ''))) {
      throw new TypeError(`producers: ${name} argument "${key}" must be a non-empty array of strings`);
    }
  }
  if (name === 'ingest-youtube-transcript') {
    const hasId = typeof args.videoId === 'string' && args.videoId.trim() !== '';
    const hasQuery = typeof args.query === 'string' && args.query.trim() !== '';
    if (hasId === hasQuery) throw new TypeError('producers: ingest-youtube-transcript needs exactly one of "videoId" or "query"');
  }
  if (name === 'ingest-voice-transcribe') {
    const hasOne = typeof args.audioPath === 'string' && args.audioPath.trim() !== '';
    const hasMany = Array.isArray(args.audioPaths) && args.audioPaths.length > 0;
    if (hasOne === hasMany) throw new TypeError('producers: ingest-voice-transcribe needs exactly one of "audioPath" or "audioPaths"');
  }
  if (name === 'voice-synthesize') {
    const hasText = typeof args.text === 'string' && args.text.trim() !== '';
    const hasLines = Array.isArray(args.lines) && args.lines.length > 0;
    if (hasText === hasLines) throw new TypeError('producers: voice-synthesize needs exactly one of "text" or "lines"');
    const total = hasLines ? args.lines.join('').length : args.text.length;
    if (total > 6000) throw new TypeError(`producers: voice-synthesize text is ${total} chars; the cap is 6000 (batch longer work across calls)`);
    if (args.speed !== undefined && !(args.speed >= 0.5 && args.speed <= 2)) throw new TypeError('producers: voice-synthesize "speed" must be between 0.5 and 2');
    if (args.pauseMs !== undefined && !(args.pauseMs >= 0 && args.pauseMs <= 3000)) throw new TypeError('producers: voice-synthesize "pauseMs" must be between 0 and 3000');
  }
  return args;
}

const defaultExec = (cmd, argv, { cwd, timeoutMs }) => new Promise((resolve) => {
  execFile(cmd, argv, { cwd, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
    resolve({
      code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
      stdout: String(stdout ?? ''),
      stderr: String(stderr ?? ''),
      timedOut: Boolean(error && error.killed && error.signal === 'SIGTERM'),
      spawnError: error && error.code === 'ENOENT' ? error.message : null,
    });
  });
});

let seq = 0;

/**
 * The producer runner: one call = one job folder = one child process, headless.
 * `producersDir` holds the producer scripts (default: lib/producers/ beside this module);
 * `workRoot` is where job folders land (required — the caller owns the state layout).
 * run(name, args) resolves with the receipt and throws a named Error on any failure
 * (validation, spawn, non-zero exit, missing artifact, meta/hash mismatch) — a failed
 * producer NEVER resolves with a receipt for an artifact that is not on disk.
 */
export function createProducerRunner({ producersDir = join(dirname(fileURLToPath(import.meta.url)), 'producers'), workRoot, exec = defaultExec, now = () => new Date() } = {}) {
  if (!workRoot) throw new Error('producers: a workRoot (job folder parent) is required');
  return {
    async run(name, args = {}) {
      validateProducerArgs(name, args);
      const spec = TOOL_SCRIPTS[name];
      const stamp = now().toISOString().replace(/[:.]/g, '-');
      const jobDir = join(workRoot, `${name}-${stamp}-${++seq}`);
      await mkdir(jobDir, { recursive: true });
      const [cmd, argv] = spec.argv(args, jobDir);
      const r = await exec(cmd, argv, { cwd: producersDir, timeoutMs: spec.timeoutMs });
      // Every failure names the job folder: producers write incrementally where they can,
      // so a failed call's folder may still hold finished work — the caller must be able
      // to find it from the error alone.
      if (r.spawnError) throw new Error(`producers: ${name} could not start (${r.spawnError}) (job folder: ${jobDir})`);
      if (r.timedOut) throw new Error(`producers: ${name} exceeded its ${Math.round(spec.timeoutMs / 1000)}s cap and was killed (job folder: ${jobDir}; producer progress: ${r.stdout.trim().slice(-300) || 'none'})`);
      if (r.code !== 0) throw new Error(`producers: ${name} exited ${r.code}: ${(r.stderr || r.stdout).trim().slice(-400)} (job folder: ${jobDir})`);
      const artifactName = spec.artifact ?? 'output.txt';
      const outputPath = join(jobDir, artifactName);
      const metaPath = join(jobDir, 'output.meta.json');
      let bytes;
      try { bytes = await readFile(outputPath); } catch { throw new Error(`producers: ${name} exited 0 but wrote no ${artifactName} in ${jobDir}`); }
      let meta = null;
      try { meta = JSON.parse(await readFile(metaPath, 'utf8')); } catch { /* meta is the producer's own record; its absence is reported, not fatal */ }
      const sha256 = sha256Hex(bytes);
      if (meta && typeof meta.outputSha256 === 'string' && meta.outputSha256 !== sha256) {
        throw new Error(`producers: ${name} meta hash mismatch (meta ${meta.outputSha256.slice(0, 12)}… vs disk ${sha256.slice(0, 12)}…) — the artifact on disk is not the artifact the producer recorded`);
      }
      const receipt = {
        tool: name,
        args,
        jobDir,
        outputPath,
        metaPath: meta ? metaPath : null,
        sha256,
        meta,
        stdoutTail: r.stdout.trim().slice(-500),
      };
      if ((spec.kind ?? 'text') === 'audio') {
        // A binary artifact has no char count; its receipt carries the audio facts,
        // cross-checked against the bytes themselves (the WAV header's sample rate),
        // not just the producer's say-so. Input chars come from the meta record and
        // are checked against the call's own text.
        const headerRate = wavSampleRate(bytes);
        if (headerRate === null) throw new Error(`producers: ${name} wrote ${artifactName} in ${jobDir} but it is not a WAV file`);
        if (meta && typeof meta.sampleRate === 'number' && meta.sampleRate !== headerRate) {
          throw new Error(`producers: ${name} meta sample rate mismatch (meta ${meta.sampleRate} vs WAV header ${headerRate}) — the artifact on disk is not the artifact the producer recorded`);
        }
        receipt.bytes = bytes.length;
        receipt.sampleRate = headerRate;
        receipt.durationSec = meta && typeof meta.durationSec === 'number' ? meta.durationSec : null;
        receipt.chars = meta && typeof meta.inputChars === 'number' ? meta.inputChars : null;
      } else {
        receipt.chars = bytes.toString('utf8').length;
      }
      return receipt;
    },
  };
}

const text = (value) => ({ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) });

/** One producer tool call → MCP result. `deps.runner` is a createProducerRunner instance
 *  (or anything with run(name, args)); `deps.workRoot` builds the default runner lazily. */
export async function callProducerTool(name, args = {}, deps = {}) {
  if (!PRODUCER_TOOL_NAMES.has(name)) return { content: [text(`unknown tool: ${name}`)], isError: true };
  try {
    const runner = deps.runner ?? (deps._defaultRunner ??= createProducerRunner({ workRoot: deps.workRoot, producersDir: deps.producersDir }));
    const receipt = await runner.run(name, args);
    return { content: [text(receipt)] };
  } catch (error) {
    return { content: [text(`producers: ${error?.message ?? error}`)], isError: true };
  }
}
