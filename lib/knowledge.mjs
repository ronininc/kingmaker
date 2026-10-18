// KNOWLEDGE AS AMBIENT CONTEXT.
//
// Operator: the knowledge base "is not supposed to be searched by the user, it's supposed to function as context on
// a great many things and skills the same way human memory acts." The engine's turns draw on it on their own (the
// corpus-first lane, the engine knowledge router) whenever an index is there; with no index they get nothing. So
// after start, Kingmaker builds that index itself, quietly, in the background, from the sources already on this Mac:
//
//   WHAT    The bundled, Electron-free engine pieces, used as shipped: knowledge-provision.mjs (desktopKnowledgeEnv,
//           knowledgeStatus) and the scripts under <runtime>/scripts: solomon-index-knowledge.mjs (what is already
//           extracted becomes context first), the extract script (KNOWLEDGE_STAGES), then the index again for what the
//           extraction added. Both are offline, resumable (receipts / mtime: a killed run picks up where it
//           stopped) and crash-safe (a shard is built aside and renamed in whole). The DOWNLOAD stage is never run
//           here: fetching the library stays the operator's explicit yes in the window app.
//   WHERE   Exactly where the running core reads it. desktopKnowledgeEnv (the function the headless launcher ran at
//           boot) names the index dir the core was given; the core resolves it on every query
//           (knowledge-index.ts indexDir/availableFields read the folder per call, handles keyed by file
//           identity), so a shard that lands there is context on the next turn, with no restart. The library is
//           Kingmaker's own (operator 2026-10-13): index, sources and extracted mirror all live under its data dir;
//           a path inside the desktop app's ~/.solomon is refused, never read, so Kingmaker has no runtime dependency on it.
//   PACE    Every script runs paced (pacer.mjs: the engine's AIMD duty cycle, SIGSTOP/SIGCONT on its process group,
//           at nice 10): a busy Mac slows it, an idle one gives it everything, it is never refused for load.
//   ROOM    Disk is the one hard limit: on an 8 GB Mac the core keeps 20 GB free for swap (disk-floor-guard.ts,
//           SOLOMON_DISK_FLOOR_GB). A stage that would cross that floor waits for the next start, and a running
//           one that reaches it is stopped there (resumable) instead of eating the swap room.
//   SAID    Nothing while it works. One line when the library first becomes available to turns.

import { execFileSync, spawn } from 'node:child_process';
import { closeSync, createReadStream, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statfsSync, statSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { StringDecoder } from 'node:string_decoder';
import { homedir, setPriority, totalmem } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { pacerFor } from './pacer.mjs';
import { meetingHold } from './meeting.mjs';
import { insideDesktopAppData, pidAlive } from './paths.mjs';

const GIB = 1024 ** 3;
/** The core's floor on an 8 GB-class Mac (disk-floor-guard.ts DEFAULT_DISK_FLOOR_GB) and the minimum anywhere. */
export const DEFAULT_DISK_FLOOR_GB = 20;
export const MIN_FREE_BYTES = 4 * GIB;
/** An FTS5 shard holds the text plus its inverted index: about 1.5× the extracted JSONL. */
export const INDEX_BYTES_PER_EXTRACTED_BYTE = 1.5;
/** Room an extraction is given beyond the floor before it starts (it is watched while it runs). */
export const EXTRACT_HEADROOM_BYTES = 4 * GIB;

export const KNOWLEDGE_STAGES = Object.freeze([
  { id: 'index', script: 'solomon-index-knowledge.mjs', nodeArgs: ['--experimental-sqlite'] },
  { id: 'extract', script: 'solomon-extract-knowledge.mjs', nodeArgs: [] },
  { id: 'index', script: 'solomon-index-knowledge.mjs', nodeArgs: ['--experimental-sqlite'] },
]);

/** Where the bundled pieces are for this runtime (fork: the engine's source; a built runtime: its runtime folder in Resources). */
export function knowledgeLayout(paths) {
  return {
    provisionModule: join(paths.desktopModules, 'knowledge-provision.mjs'),
    scriptsDir: paths.runtimeSource === 'fork' ? join(paths.fork.root, 'scripts') : join(paths.runtimeDir ?? join(paths.resources, 'solomon-runtime'), 'scripts'),
  };
}

export function loadProvision(paths, importer = (url) => import(url)) {
  return importer(pathToFileURL(knowledgeLayout(paths).provisionModule).href);
}

const hasEntries = (dir, list = readdirSync) => { try { return list(dir).length > 0; } catch { return false; } };

/**
 * Pure (given `provision` and `list`): where the core reads the index (`served`), where the sources and the
 * extracted mirror are, and the env the scripts run with. `env` = the core's env (backendEnv).
 */
export function knowledgePlan({ env, runtimeHome, provision, home = homedir(), list = readdirSync }) {
  const dataDir = join(runtimeHome, 'data');
  const k = provision.desktopKnowledgeEnv({ env, dataDir, envPath: join(runtimeHome, '.env') }) ?? {};
  // The desktop app's data dir (~/.solomon) is never Kingmaker's library, even when the provision module offers it as a shared fallback.
  const homes = [...new Set([home, env?.HOME].filter(Boolean))];
  const own = (p) => (p && !insideDesktopAppData(p, homes) ? p : undefined);
  const served = own(k.SOLOMON_INDEX_DIR) ?? join(own(k.SOLOMON_DATA_DIR) ?? dataDir, 'knowledge', 'index');
  const sources = own(k.SOLOMON_CORPUS_DIR) ?? join(dataDir, 'knowledge', 'sources');
  const extracted = own(k.SOLOMON_EXTRACTED_DIR) ?? join(dirname(sources), 'extracted');
  const fields = k.SOLOMON_KNOWLEDGE_FIELDS ?? env?.SOLOMON_KNOWLEDGE_FIELDS;
  return {
    served, sources, extracted,
    env: { HOME: home, SOLOMON_DATA_DIR: dirname(dirname(sources)), SOLOMON_CORPUS_DIR: sources, SOLOMON_EXTRACTED_DIR: extracted, SOLOMON_INDEX_DIR: served, ...(fields ? { SOLOMON_KNOWLEDGE_FIELDS: fields } : {}) },
  };
}

/** The fields the core can draw on right now: the .db shards in the folder it reads. */
export function servedFields(served, list = readdirSync) {
  try { return list(served).filter((n) => n.endsWith('.db')).map((n) => n.slice(0, -3)); } catch { return []; }
}

/** The free-space floor this Mac keeps (the core's own rule). */
export function diskFloorBytes(env = process.env, totalMemBytes = totalmem()) {
  if (Math.round(Number(totalMemBytes) / GIB) > 8) return MIN_FREE_BYTES;
  const raw = String(env.SOLOMON_DISK_FLOOR_GB ?? '').trim();
  const gb = raw === '' ? DEFAULT_DISK_FLOOR_GB : Number(raw);
  return Math.max(MIN_FREE_BYTES, Number.isFinite(gb) && gb >= 0 ? gb * GIB : DEFAULT_DISK_FLOOR_GB * GIB);
}

export function freeBytes(...dirs) {
  for (const d of dirs) {
    try { const s = statfsSync(d); return s.bavail * s.bsize; } catch { /* missing: try the next */ }
  }
  return null;
}

/** Bytes the index stage still has to write: extracted fields whose shard is missing or older, × 1.5. */
export function pendingIndexBytes(plan, { list = readdirSync, stat = statSync } = {}) {
  let bytes = 0;
  let fields;
  try { fields = list(plan.extracted).filter((n) => !n.startsWith('.')); } catch { return 0; }
  for (const field of fields) {
    let jsonl;
    try { jsonl = stat(join(plan.extracted, field, 'extracted.jsonl')); } catch { continue; }
    let db = null;
    try { db = stat(join(plan.served, `${field}.db`)); } catch { /* not built */ }
    if (!db || jsonl.mtimeMs > db.mtimeMs) bytes += jsonl.size;
  }
  return Math.ceil(bytes * INDEX_BYTES_PER_EXTRACTED_BYTE);
}

/** Pure: may this stage start with `free` bytes free? → {ok, needBytes}. */
export function stageFits(stage, { free, floor, pendingIndex }) {
  if (free === null || free === undefined) return { ok: true, needBytes: 0 }; // unreadable: the run-time watch still applies
  const needBytes = floor + (stage.id === 'index' ? pendingIndex : EXTRACT_HEADROOM_BYTES);
  return { ok: free >= needBytes, needBytes };
}

/**
 * Run one script paced, in its own process group (so pausing and stopping reach its children too), output to
 * `logFd`. Stops it (resumable) when `signal` aborts or the disk floor is reached. → {code, stoppedFor}.
 */
export function runPacedScript({ stage, scriptsDir, nodeBin, env, signal, logFd = 'ignore', spawnImpl = spawn, pace = (pgid, opts) => pacerFor(pgid, opts), diskLow = () => false, onStart = () => {}, log = () => {} }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(nodeBin, [...stage.nodeArgs, join(scriptsDir, stage.script)], { env, stdio: ['ignore', logFd, logFd], detached: true });
    } catch (error) { resolve({ code: -1, stoppedFor: null, error: String(error?.message ?? error) }); return; }
    let stoppedFor = null;
    let settled = false;
    const pid = child.pid;
    try { setPriority(pid, 10); } catch { /* best effort: pacing still applies */ }
    onStart(pid);
    const pacer = pace(pid, {
      onSignals: () => { if (!stoppedFor && diskLow()) stop('disk'); },
      onChange: (d) => log('knowledge_pace', { duty: d.duty, why: d.why }),
    });
    function stop(reason) {
      if (stoppedFor || settled) return;
      stoppedFor = reason;
      pacer.stop(); // never leave it frozen
      try { process.kill(-pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* gone */ } }
    }
    const onAbort = () => stop('cancelled');
    if (signal?.aborted) onAbort(); else signal?.addEventListener?.('abort', onAbort, { once: true });
    pacer.start();
    const finish = (code) => {
      if (settled) return;
      settled = true;
      pacer.stop();
      signal?.removeEventListener?.('abort', onAbort);
      resolve({ code, stoppedFor });
    };
    child.once('error', () => finish(-1));
    child.once('exit', (code) => finish(code ?? -1));
  });
}

/** A job left behind by a Kingmaker that died without cleaning up (SIGKILL): resumed and stopped at the next start. */
export function reapOrphanedJob(jobFile, { read = (p) => readFileSync(p, 'utf8'), alive = pidAlive, commandOf = psCommand, kill = (pid, sig) => process.kill(pid, sig), remove = (p) => rmSync(p, { force: true }) } = {}) {
  let job;
  try { job = JSON.parse(read(jobFile)); } catch { return false; }
  remove(jobFile);
  const pid = Number(job?.pid);
  if (!Number.isInteger(pid) || pid <= 1 || !alive(pid)) return false;
  // Only a process that is really one of these scripts: a reused pid is never signalled.
  if (!/solomon-(index|extract)-knowledge\.mjs/.test(String(commandOf(pid) ?? ''))) return false;
  for (const sig of ['SIGCONT', 'SIGTERM']) { try { kill(-pid, sig); } catch { /* gone */ } }
  return true;
}

function psCommand(pid) {
  try { return execFileSync('/bin/ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', timeout: 3_000 }); } catch { return ''; }
}

/** Pure: the one line, said when the library first becomes context. */
export function availableLine(fieldCount) {
  return `Your knowledge library is in: ${fieldCount} ${fieldCount === 1 ? 'field' : 'fields'} of it now inform my answers.`;
}

/**
 * Build the knowledge index in the background. Quiet; resolves with what happened:
 *   {state: 'present' | 'built' | 'partial' | 'no-sources' | 'deferred-disk' | 'deferred-meeting' | 'failed' | 'cancelled' | 'unavailable', ...}
 * `announce(line)` is called at most once, when the served index goes from no shards to some.
 */
export async function provisionKnowledge({
  paths, env, signal, log = () => {}, announce = () => {}, out = () => {},
  load = () => loadProvision(paths), home = homedir(), nodeBin = process.execPath, run = runPacedScript,
  free = (plan) => freeBytes(plan.served, dirname(plan.served), plan.extracted, home), floor = diskFloorBytes(env),
  jobFile = join(paths.state, 'knowledge-job.json'), logFile = join(paths.logs, 'knowledge.log'),
  scriptsDir = knowledgeLayout(paths).scriptsDir, exists = existsSync, reap = () => reapOrphanedJob(jobFile),
  inMeeting = () => meetingHold(paths).active,
  hybrid = hybridSearchEnabled(), embed = null, buildVectors = buildVectorShards, vectorBatch = 64,
}) {
  try { if (reap()) log('knowledge_orphan_reaped', {}); } catch { /* best effort */ }
  let provision;
  try { provision = await load(); } catch (error) {
    log('knowledge_unavailable', { reason: String(error?.message ?? error).slice(0, 160) });
    return { state: 'unavailable' };
  }
  const plan = knowledgePlan({ env, runtimeHome: paths.runtimeHome, provision, home });
  const statusEnv = { ...plan.env };
  const before = servedFields(plan.served);
  let status;
  try { status = provision.knowledgeStatus(statusEnv); } catch { status = { state: before.length ? 'PARTIAL' : 'ABSENT' }; }
  log('knowledge_status', { state: status.state, served: plan.served, fields: before.length });
  if (status.state === 'PRESENT') return { state: 'present', fields: before.length };
  if (!hasEntries(plan.sources) && !hasEntries(plan.extracted)) return { state: 'no-sources' };
  if (!KNOWLEDGE_STAGES.every((s) => exists(join(scriptsDir, s.script)))) {
    log('knowledge_unavailable', { reason: `scripts missing in ${scriptsDir}` });
    return { state: 'unavailable' };
  }

  // Scripts get this Mac's plain environment plus the knowledge roots: never the core's secrets.
  const childEnv = { ...process.env, ...plan.env, PATH: `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${process.env.PATH ?? ''}` };
  for (const key of ['SOLOMON_DESKTOP_CONTROL_NONCE', 'SOLOMON_VOICE_ATTESTATION_KEY']) delete childEnv[key];
  if (process.versions.electron) childEnv.ELECTRON_RUN_AS_NODE = '1';

  mkdirSync(plan.served, { recursive: true, mode: 0o700 });
  mkdirSync(dirname(logFile), { recursive: true, mode: 0o700 });
  let logFd = 'ignore';
  try { logFd = openSync(logFile, 'a', 0o600); } catch { /* run without a log */ }
  let announced = before.length > 0;
  let result = { state: 'built' };
  try {
    for (const stage of KNOWLEDGE_STAGES) {
      if (signal?.aborted) { result = { state: 'cancelled' }; break; }
      // The owner's meeting comes first: no new heavy stage starts while the hold is on; it resumes on a later start.
      if (inMeeting()) { result = { state: 'deferred-meeting', stage: stage.id }; break; }
      const fits = stageFits(stage, { free: free(plan), floor, pendingIndex: stage.id === 'index' ? pendingIndexBytes(plan) : 0 });
      if (!fits.ok) {
        const gb = (n) => Math.round(n / GIB);
        out(`Knowledge: not built further yet. ${gb(free(plan) ?? 0)} GB free; this Mac keeps ${gb(floor)} GB free for swap and the next step needs about ${gb(fits.needBytes - floor)} GB more. It resumes on a later start.`);
        result = { state: 'deferred-disk', stage: stage.id, needBytes: fits.needBytes };
        break;
      }
      log('knowledge_stage', { stage: stage.id });
      const r = await run({
        stage, scriptsDir, nodeBin, env: childEnv, signal, logFd, log,
        diskLow: () => { const f = free(plan); return f !== null && f < floor; },
        onStart: (pid) => { try { writeFileSync(jobFile, JSON.stringify({ pid, stage: stage.id, startedAt: new Date().toISOString() }), { mode: 0o600 }); } catch { /* reaping is best effort */ } },
      });
      try { rmSync(jobFile, { force: true }); } catch { /* fine */ }
      log('knowledge_stage_done', { stage: stage.id, code: r.code, stoppedFor: r.stoppedFor });
      const now = servedFields(plan.served);
      if (!announced && now.length > 0) { announced = true; announce(availableLine(now.length)); }
      if (r.stoppedFor === 'cancelled') { result = { state: 'cancelled' }; break; }
      if (r.stoppedFor === 'disk') { result = { state: 'deferred-disk', stage: stage.id }; break; }
      if (r.code !== 0) { result = { state: 'failed', stage: stage.id, code: r.code }; break; }
    }
  } finally {
    if (typeof logFd === 'number') { try { closeSync(logFd); } catch { /* closed */ } }
  }

  // Hybrid search (off unless KINGMAKER_HYBRID_SEARCH=1): once the FTS5 shards are built, add a <field>.vec.db beside
  // each, paced the same way — deferred by the owner's meeting or the disk floor, abortable, resumable (up-to-date
  // shards are skipped). Additive: a failure here (no embedder, model not pulled) never fails the knowledge index.
  let vectors = { state: hybrid ? 'skipped' : 'off' };
  if (hybrid && result.state !== 'cancelled' && !signal?.aborted) {
    const stop = () => Boolean(signal?.aborted) || inMeeting() || (() => { const f = free(plan); return f !== null && f < floor; })();
    if (stop()) { vectors = { state: 'deferred' }; }
    else if (servedFields(plan.served).length > 0) {
      try {
        const built = await buildVectors({ plan, embed: embed ?? ollamaEmbedder(), batch: vectorBatch, signal, shouldStop: stop, log });
        vectors = { state: built.some((r) => r.skipped === 'stopped') ? 'deferred' : 'built',
          fields: built.filter((r) => r.skipped == null || r.skipped === 'up-to-date').length, rows: built.reduce((a, r) => a + (r.rows || 0), 0) };
      } catch (error) { vectors = { state: 'failed', reason: String(error?.message ?? error).slice(0, 160) }; }
    }
    log('knowledge_vectors_done', vectors);
  }

  let after = status;
  try { after = provision.knowledgeStatus(statusEnv); } catch { /* keep the first reading */ }
  const fields = servedFields(plan.served).length;
  if (result.state === 'built' && after.state !== 'PRESENT') result = { state: 'partial' };
  log('knowledge_done', { ...result, fields, library: after.state, vectors: vectors.state });
  return { ...result, fields, library: after.state, vectors };
}

// ── Hybrid search, step 2: the per-field vector shard (docs/HYBRID-SEARCH.md) ───────────────────────────────────────
//
// Beside each FTS5 <field>.db the keyword stage builds, this writes <field>.vec.db: one unit-normalized embedding per
// chunk, sharing the SAME rows and the SAME chunk identity so the two rankings fuse cleanly with RRF (lib/rrf.mjs).
// The rows mirror solomon-index-knowledge.mjs exactly — the same extracted.jsonl, the same `text.length >= 40` filter,
// the same order — and the chunk's id is `${sourceId}#${chunk}`, which is what the FTS5 side carries for provenance.
// A plain Float32 BLOB table (no loadable extension): per-shard kNN is a scan, which is milliseconds at our shard size.
// Off by default — the flag gates whether the stage runs; with no <field>.vec.db the retrieval lane stays FTS5-only.

/** The vector shard's schema: one row per chunk, plus a meta row recording the embedder so a model swap forces a rebuild. */
export const VEC_SCHEMA = `CREATE TABLE vectors (
  docId TEXT PRIMARY KEY, sourceId TEXT, chunkNo INTEGER, dim INTEGER, vec BLOB NOT NULL
);
CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT);`;
/** The default embedder (catalog/essentials.json). bge-m3 is the multilingual alternate the caller picks per field. */
export const DEFAULT_EMBED_MODEL = 'nomic-embed-text:v2-moe';
/** Off unless the owner turns it on. */
export const hybridSearchEnabled = (env = process.env) => env.KINGMAKER_HYBRID_SEARCH === '1';
export const vecShardPath = (served, field) => join(served, `${field}.vec.db`);
const chunkId = (e) => `${e.sourceId ?? ''}#${e.chunk ?? 0}`;
/** The exact rows the FTS5 indexer keeps: a non-empty text of at least 40 characters. */
const indexable = (e) => Boolean(e && e.text && e.text.length >= 40);

/** Pure: a unit-normalized Float32Array of a number[] (zero vector left as zeros). */
export function normalizeVec(arr) {
  const v = Float32Array.from(arr, Number);
  let n = 0; for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n); if (n > 0) for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}
const vecToBlob = (v) => Buffer.from(v.buffer, v.byteOffset, v.byteLength);
const blobToVec = (b) => new Float32Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 4));

/** The local embedder: Ollama /api/embed, vectors unit-normalized. Injectable; → (texts) => Promise<Float32Array[]>. */
export function ollamaEmbedder({ model = DEFAULT_EMBED_MODEL, base = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434', fetchImpl = fetch, timeoutMs = 120_000 } = {}) {
  return async (texts) => {
    if (!texts.length) return [];
    const r = await fetchImpl(`${base.replace(/\/$/, '')}/api/embed`, { method: 'POST', headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(timeoutMs), body: JSON.stringify({ model, input: texts }) });
    if (!r.ok) throw new Error(`the embedder answered ${r.status}`);
    const j = await r.json();
    const embs = j?.embeddings;
    if (!Array.isArray(embs) || embs.length !== texts.length) throw new Error('the embedder returned the wrong number of vectors');
    return embs.map(normalizeVec);
  };
}

// Lines split on "\n" only, mirroring the FTS5 indexer (a raw U+2028/U+2029 inside a JSON string must not split a record).
async function* newlineLines(input) {
  const decoder = new StringDecoder('utf8');
  let rest = '';
  for await (const chunk of input) {
    const parts = (rest + (typeof chunk === 'string' ? chunk : decoder.write(chunk))).split('\n');
    rest = parts.pop();
    for (const part of parts) yield part.endsWith('\r') ? part.slice(0, -1) : part;
  }
  rest += decoder.end();
  if (rest) yield rest.endsWith('\r') ? rest.slice(0, -1) : rest;
}

/** Is <field>.vec.db present, openable, non-empty, built by THIS embedder, and newer than its extracted.jsonl? */
export function vecShardFresh(vecDb, jsonl, { model = DEFAULT_EMBED_MODEL } = {}) {
  if (!existsSync(vecDb)) return false;
  let conn = null;
  try {
    conn = new DatabaseSync(vecDb, { readOnly: true });
    const n = conn.prepare('SELECT count(*) AS n FROM vectors').get();
    if (!n || Number(n.n) <= 0) return false;
    const m = conn.prepare("SELECT v FROM meta WHERE k = 'model'").get();
    if (!m || m.v !== model) return false; // a different embedder → rebuild (never mix vector spaces)
  } catch { return false; } finally { if (conn) { try { conn.close(); } catch { /* gone */ } } }
  try { return statSync(vecDb).mtimeMs >= statSync(jsonl).mtimeMs; } catch { return false; }
}

/**
 * Build one field's <field>.vec.db from its extracted.jsonl, embedding in batches. Crash-safe: writes a .building file
 * and renames it in whole. A malformed non-empty line aborts the build and keeps the previous shard (as the FTS5
 * indexer does), so the two shards never disagree on which rows exist. deps: embed(texts)→Float32Array[]; shouldStop().
 * → { field, rows, skipped }.
 */
export async function buildVectorShard({ field, jsonl, vecDb, embed, model = DEFAULT_EMBED_MODEL, batch = 64, signal, shouldStop = () => false }) {
  if (!existsSync(jsonl)) return { field, rows: 0, skipped: 'no extracted.jsonl' };
  if (vecShardFresh(vecDb, jsonl, { model })) return { field, rows: 0, skipped: 'up-to-date' };
  mkdirSync(dirname(vecDb), { recursive: true });
  const tmp = `${vecDb}.building`;
  for (const s of ['', '-wal', '-shm']) { try { rmSync(tmp + s); } catch { /* absent */ } }
  const conn = new DatabaseSync(tmp);
  conn.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  conn.exec(VEC_SCHEMA);
  const insert = conn.prepare('INSERT OR REPLACE INTO vectors(docId, sourceId, chunkNo, dim, vec) VALUES (?, ?, ?, ?, ?)');
  const cleanup = () => { try { conn.close(); } catch { /* gone */ } for (const s of ['', '-wal', '-shm']) { try { rmSync(tmp + s); } catch { /* absent */ } } };

  let rows = 0, dim = 0, lineNo = 0, pending = [];
  const flush = async () => {
    if (!pending.length) return;
    const vecs = await embed(pending.map((p) => p.text));
    conn.exec('BEGIN');
    for (let i = 0; i < pending.length; i++) {
      const v = vecs[i]; dim ||= v.length;
      insert.run(pending[i].docId, pending[i].sourceId, pending[i].chunkNo, v.length, vecToBlob(v));
      rows++;
    }
    conn.exec('COMMIT');
    pending = [];
  };
  try {
    for await (const line of newlineLines(createReadStream(jsonl))) {
      lineNo++;
      if (signal?.aborted || shouldStop()) { cleanup(); return { field, rows: 0, skipped: 'stopped' }; }
      if (!line.trim()) continue;
      let e;
      try { e = JSON.parse(line); } catch (err) { cleanup(); throw new Error(`vector build ABORTED for field "${field}": malformed JSON at ${jsonl}:${lineNo} — ${err.message}. Previous shard retained.`); }
      if (!indexable(e)) continue;
      pending.push({ docId: chunkId(e), sourceId: e.sourceId ?? '', chunkNo: e.chunk ?? 0, text: e.text });
      if (pending.length >= batch) await flush();
    }
    await flush();
    conn.prepare('INSERT OR REPLACE INTO meta(k, v) VALUES (?, ?)').run('model', model);
    conn.prepare('INSERT OR REPLACE INTO meta(k, v) VALUES (?, ?)').run('dim', String(dim));
    conn.prepare('INSERT OR REPLACE INTO meta(k, v) VALUES (?, ?)').run('builtAt', new Date().toISOString());
    try { conn.exec('PRAGMA wal_checkpoint(TRUNCATE);'); } catch { /* optional */ }
    conn.close();
  } catch (err) { cleanup(); throw err; }
  renameSync(tmp, vecDb);
  for (const s of ['-wal', '-shm']) { try { rmSync(vecDb + s); } catch { /* absent */ } try { rmSync(tmp + s); } catch { /* absent */ } }
  return { field, rows, skipped: null };
}

/**
 * Build the vector shards for every extracted field whose shard is missing or stale. Mirrors the FTS5 index stage's
 * per-field loop. `embedderFor(field)` picks the model (English → nomic, non-English → bge-m3); default is nomic.
 * Honors a disk/meeting/abort `shouldStop()` between fields. → [{ field, rows, skipped }].
 */
export async function buildVectorShards({ plan, embed, embedderFor = null, model = DEFAULT_EMBED_MODEL, batch = 64, signal, shouldStop = () => false, list = readdirSync, log = () => {} }) {
  let fields = [];
  try { fields = list(plan.extracted, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name); } catch { return []; }
  const out = [];
  for (const field of fields) {
    if (signal?.aborted || shouldStop()) break;
    const jsonl = join(plan.extracted, field, 'extracted.jsonl');
    const m = embedderFor ? embedderFor(field) : model;
    const r = await buildVectorShard({ field, jsonl, vecDb: vecShardPath(plan.served, field), embed, model: m, batch, signal, shouldStop });
    log('knowledge_vectors', { field, rows: r.rows, skipped: r.skipped });
    out.push(r);
  }
  return out;
}

/** Pure: the best-n chunk ids for a query vector over a field's rows, by cosine (vectors are unit-normalized → dot). */
export function cosineTopN(rows, queryVec, n = 50) {
  const q = queryVec instanceof Float32Array ? queryVec : normalizeVec(queryVec);
  const scored = [];
  for (const row of rows) {
    const v = row.vec instanceof Float32Array ? row.vec : blobToVec(row.vec);
    let dot = 0; const len = Math.min(v.length, q.length);
    for (let i = 0; i < len; i++) dot += v[i] * q[i];
    scored.push({ docId: row.docId, score: dot });
  }
  scored.sort((a, b) => b.score - a.score || (String(a.docId) < String(b.docId) ? -1 : 1));
  return scored.slice(0, n);
}

/** Read a vector shard and return the best-n chunk ids for a query vector. → [{ docId, score }] best-first. */
export function vecSearch(vecDb, queryVec, { n = 50 } = {}) {
  if (!existsSync(vecDb)) return [];
  let conn = null;
  try {
    conn = new DatabaseSync(vecDb, { readOnly: true });
    const rows = conn.prepare('SELECT docId, vec FROM vectors').all();
    return cosineTopN(rows.map((r) => ({ docId: r.docId, vec: blobToVec(r.vec) })), queryVec, n);
  } catch { return []; } finally { if (conn) { try { conn.close(); } catch { /* gone */ } } }
}
