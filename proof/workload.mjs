// proof/workload.mjs — the deterministic 10M-token workload: the doing-more-with-less doctrine
// as a stage plan. Reads are enormous (large prefill over corpus chunks), reflex decisions are
// batched (one forward pass per 64 fixed-answer questions), writes are minimal and bounded
// (decode is the dear part, so the write lane is a sliver of the budget by design).
//
// Determinism is a hard requirement, not a nicety: same seed + same corpus ⇒ same plan, same
// planned token counts, byte for byte. The only randomness is a seeded PRNG consumed in a
// fixed order; nothing reads the clock, Math.random, or the network.
//
// Token counting at plan time uses estimateTokens() — a named, deterministic estimator
// (word-runs + punctuation, the shape of a BPE count). At run time the REAL transport replaces
// estimates with the endpoint's own reported counts (the token-meter convention); the counting
// (simulated) transport uses this same estimator, which is what makes simulated totals exact.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const ESTIMATOR_NAME = 'wordpiece-estimate-v1';

/** Deterministic token estimate: maximal word runs count once each, every other non-space
 *  character counts once. Close to a BPE count for English text, exact for textForTokens(). */
export function estimateTokens(text) {
  const m = String(text).match(/[A-Za-z0-9]+|[^\sA-Za-z0-9]/g);
  return m ? m.length : 0;
}

/** A string of EXACTLY n estimated tokens (n word-runs). The counting transport generates
 *  completions with this, so a simulated run's generated counts are exact, never rounded. */
export function textForTokens(n) {
  if (!Number.isFinite(n) || n <= 0) return '';
  return Array.from({ length: Math.floor(n) }, () => 'tok').join(' ');
}

/** mulberry32: a small seeded PRNG, identical on every platform (32-bit integer math only). */
export function mulberry32(seed) {
  let a = Number(seed) >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORD_BANK = Object.freeze(('kingmaker engine governs every step the machine reads the corpus and writes almost nothing ' +
  'a token minted is a delegation scoped timed and revocable the audit chain records what the hands did ' +
  'reading is parallel and cheap writing is sequential and dear capability lives around the model not inside it ' +
  'the reflex answers in one forward pass the worker thinks only when thinking is what the moment needs ' +
  'weights are memory mapped from disk the seat stays pinned the pair fits the budget the gate is a word not a click ' +
  'service function power to the people the node is sovereign the governor is local the proof is the run itself').split(' '));

/** A deterministic synthetic corpus: `chunks` strings of ~chunkChars, generated from the seed.
 *  For VM runs and tests — the Mac proof points the harness at a real corpus directory instead. */
export function syntheticCorpus({ seed = 1, chunks = 24, chunkChars = 48000 } = {}) {
  const rng = mulberry32((Number(seed) >>> 0) ^ 0xC0FFEE);
  const out = [];
  for (let c = 0; c < chunks; c += 1) {
    const sentences = [];
    let len = 0;
    while (len < chunkChars) {
      const words = 8 + Math.floor(rng() * 7);
      const s = Array.from({ length: words }, () => WORD_BANK[Math.floor(rng() * WORD_BANK.length)]).join(' ');
      sentences.push(s[0].toUpperCase() + s.slice(1) + '.');
      len += s.length + 2;
    }
    out.push(sentences.join(' '));
  }
  return out;
}

const CORPUS_EXTS = new Set(['.txt', '.md', '.mjs', '.js', '.ts', '.json', '.mdx']);

/** Load a real corpus directory: text files in name order, sliced into ~chunkChars chunks.
 *  The corpus is an INPUT the harness is pointed at — never bundled content. */
export function loadCorpus(dir, { chunkChars = 48000 } = {}) {
  const names = readdirSync(dir).filter((n) => CORPUS_EXTS.has(n.slice(n.lastIndexOf('.')))).sort();
  if (!names.length) throw new Error(`workload: no corpus text files in ${dir}`);
  const chunks = [];
  for (const name of names) {
    const text = readFileSync(join(dir, name), 'utf8');
    for (let i = 0; i < text.length; i += chunkChars) chunks.push(text.slice(i, i + chunkChars));
  }
  if (!chunks.length) throw new Error(`workload: corpus in ${dir} is empty`);
  return { chunks, files: names };
}

/** The reflex question bank: fixed questions, fixed answer spaces (the decision-router's shape).
 *  A batch is 64 of these (the endpoint's own cap, lib/decision-router.mjs calibration). */
export const REFLEX_QUESTIONS = Object.freeze([
  { name: 'is_action', prompt: 'Does this state ask the machine to act on the world?', options: ['act', 'answer'] },
  { name: 'touches_money', prompt: 'Does this touch money, payment, or billing?', options: ['yes', 'no'] },
  { name: 'touches_records', prompt: 'Does this change a stored record?', options: ['yes', 'no'] },
  { name: 'is_lookup', prompt: 'Does answering need a live or local fact?', options: ['yes', 'no'] },
  { name: 'risk_band', prompt: 'How risky is proceeding without asking?', options: ['low', 'medium', 'high'] },
  { name: 'lane', prompt: 'Which lane should carry this?', options: ['write', 'act', 'open', 'image', 'lookup'] },
  { name: 'needs_owner', prompt: 'Must the owner approve before this proceeds?', options: ['yes', 'no'] },
  { name: 'is_reversible', prompt: 'Can this be undone cleanly?', options: ['yes', 'no'] },
]);
export const REFLEX_BATCH = 64;

export const READ_INSTRUCTION = 'Read the following corpus chunk. Reply with a digest of exactly the requested length: the load-bearing claims, in order, nothing else.';
export const WRITE_INSTRUCTION = 'Write the short passage the context asks for, at exactly the requested length, and stop.';
export const READ_GEN_TOKENS = 128;
export const WRITE_GEN_TOKENS = 512;
export const REFLEX_STATE_CHARS = 6000;
/** One stage ≈ this many planned tokens: small enough for live progress + resume, large
 *  enough that a 10M run is ~50 stages, not ~5,000. */
export const STAGE_TOKEN_TARGET = 200_000;

const stridePick = (arr, i) => arr[(i * 7) % arr.length];

/**
 * Build the plan. Pure: (totalTokens, seed, corpus) in, stage plan out.
 * Budget split defaults mirror the doctrine: read 88%, reflex 9.5%, write 2.5% of TOKENS.
 * Repetitions are sized from the corpus's mean chunk estimate, then the read lane is topped
 * up / trimmed call-by-call so the planned total lands within one read call of the target.
 */
export function buildPlan({
  totalTokens = 10_000_000,
  seed = 1,
  corpus,
  split = { read: 0.88, reflex: 0.095, write: 0.025 },
  stageTokenTarget = STAGE_TOKEN_TARGET,
} = {}) {
  if (!Array.isArray(corpus) || !corpus.length) throw new Error('workload: a corpus (array of chunk strings) is required');
  const rng = mulberry32(Number(seed) >>> 0);
  const chunkTokens = corpus.map((c) => estimateTokens(c));
  const meanChunk = chunkTokens.reduce((s, n) => s + n, 0) / corpus.length;

  // --- read lane: chunk in, bounded digest out.
  const readPerCall = Math.round(meanChunk) + estimateTokens(READ_INSTRUCTION) + READ_GEN_TOKENS;
  const readCalls = [];
  const makeReadCall = (i) => {
    const chunk = stridePick(corpus, i);
    const prompt = `${READ_INSTRUCTION}\n\n${chunk}`;
    return { type: 'read', prompt, plannedPromptTokens: estimateTokens(prompt), plannedGenTokens: READ_GEN_TOKENS };
  };
  const readTarget = Math.floor(totalTokens * split.read);
  let readPlanned = 0;
  while (readPlanned + readPerCall <= readTarget || readCalls.length === 0) {
    const c = makeReadCall(readCalls.length);
    readCalls.push(c); readPlanned += c.plannedPromptTokens + c.plannedGenTokens;
    if (readCalls.length > 1 && readPlanned >= readTarget) break;
  }

  // --- reflex lane: a corpus slice as state, one batch of 64 fixed-space questions per call.
  const makeReflexCall = (i) => {
    const state = stridePick(corpus, i + 3).slice(0, REFLEX_STATE_CHARS);
    const questions = {};
    for (let q = 0; q < REFLEX_BATCH; q += 1) {
      const base = REFLEX_QUESTIONS[Math.floor(rng() * REFLEX_QUESTIONS.length)];
      questions[`${base.name}_${q}`] = { prompt: base.prompt, options: base.options };
    }
    const payload = { state, questions };
    return { type: 'reflex', state, questions, plannedPromptTokens: estimateTokens(JSON.stringify(payload)), plannedGenTokens: REFLEX_BATCH };
  };
  const reflexCalls = [];
  const reflexTarget = Math.floor(totalTokens * split.reflex);
  let reflexPlanned = 0;
  const reflexPerCall = (() => { const c = makeReflexCall(0); reflexCalls.push(c); const n = c.plannedPromptTokens + c.plannedGenTokens; reflexPlanned += n; return n; })();
  while (reflexPlanned + reflexPerCall <= reflexTarget) {
    const c = makeReflexCall(reflexCalls.length);
    reflexCalls.push(c); reflexPlanned += c.plannedPromptTokens + c.plannedGenTokens;
  }

  // --- write lane: a short context in, a bounded passage out. The sliver, on purpose.
  const makeWriteCall = (i) => {
    const excerpt = stridePick(corpus, i + 11).slice(0, 512);
    const prompt = `${WRITE_INSTRUCTION}\n\nContext: ${excerpt}`;
    return { type: 'write', prompt, plannedPromptTokens: estimateTokens(prompt), plannedGenTokens: WRITE_GEN_TOKENS };
  };
  const writeCalls = [];
  const writeTarget = Math.floor(totalTokens * split.write);
  let writePlanned = 0;
  while (writeCalls.length === 0 || writePlanned + WRITE_GEN_TOKENS <= writeTarget) {
    const c = makeWriteCall(writeCalls.length);
    if (writeCalls.length > 0 && writePlanned + c.plannedPromptTokens + c.plannedGenTokens > writeTarget) break;
    writeCalls.push(c); writePlanned += c.plannedPromptTokens + c.plannedGenTokens;
  }

  // Top-up / trim the read lane so the planned total hugs the target (within one read call).
  let planned = readPlanned + reflexPlanned + writePlanned;
  while (planned + readPerCall <= totalTokens) {
    const c = makeReadCall(readCalls.length);
    readCalls.push(c); const n = c.plannedPromptTokens + c.plannedGenTokens; readPlanned += n; planned += n;
  }
  while (planned > totalTokens && readCalls.length > 1) {
    const c = readCalls.pop(); const n = c.plannedPromptTokens + c.plannedGenTokens; readPlanned -= n; planned -= n;
  }

  // Group each lane's calls into stages of ~stageTokenTarget planned tokens.
  const groupStages = (lane, calls) => {
    const stages = [];
    let cur = [], curTokens = 0;
    for (const c of calls) {
      cur.push(c); curTokens += c.plannedPromptTokens + c.plannedGenTokens;
      if (curTokens >= stageTokenTarget) { stages.push(cur); cur = []; curTokens = 0; }
    }
    if (cur.length) stages.push(cur);
    return stages.map((stageCalls, i) => ({
      id: `${lane}-${String(i + 1).padStart(3, '0')}`,
      lane,
      calls: stageCalls,
      plannedTokens: stageCalls.reduce((s, c) => s + c.plannedPromptTokens + c.plannedGenTokens, 0),
    }));
  };
  const byLane = { read: groupStages('read', readCalls), reflex: groupStages('reflex', reflexCalls), write: groupStages('write', writeCalls) };

  // Interleave proportionally: sort stages by their midpoint fraction of their own lane's
  // tokens, so every lane is spread across the whole run instead of front-loaded.
  const laneTotals = Object.fromEntries(Object.entries(byLane).map(([l, ss]) => [l, ss.reduce((s, x) => s + x.plannedTokens, 0)]));
  const keyed = [];
  for (const lane of ['read', 'reflex', 'write']) {
    let before = 0;
    for (const st of byLane[lane]) {
      keyed.push({ st, key: (before + st.plannedTokens / 2) / laneTotals[lane], laneOrder: { read: 0, reflex: 1, write: 2 }[lane] });
      before += st.plannedTokens;
    }
  }
  keyed.sort((a, b) => (a.key - b.key) || (a.laneOrder - b.laneOrder));
  const stages = keyed.map((k) => k.st);

  return {
    seed: Number(seed),
    totalTokens,
    split,
    estimator: ESTIMATOR_NAME,
    corpusChunks: corpus.length,
    stages,
    plannedTokens: stages.reduce((s, x) => s + x.plannedTokens, 0),
    plannedByLane: laneTotals,
    calls: { read: readCalls.length, reflex: reflexCalls.length, write: writeCalls.length },
  };
}
