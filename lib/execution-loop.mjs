// lib/execution-loop.mjs — the execution loop (owner item 16, 2026-11-05): the channel that turns a
// person's natural request into conducted work on their own machine. The owner's shape, verbatim in
// structure:
//   a person asks Kingmaker to do something
//     → Kingmaker takes the request out to the internet with SEO/AEO and finds the details
//     → it picks the correct method files from the MemPalace architecture in the brain repo,
//       plus the correct weights using the weights hunter
//     → it executes the task as efficiently as possible on their machine
//     → prep sections run in parallel if the machine can handle it, otherwise scoped down to individually
//     → a clock counter in the display shows how long it will take, which it knows from the
//       weights/bench data it has
//     → Kingmaker is building the framework for itself, so it must be able to read it
//       (the loop's own framework is housed as a method file, catalog/methods/execution-loop.method.md,
//        discoverable and conductable through the same conductor path as every other method.)
//
// The legs, and what each one is built on (nothing here rebuilds an existing channel):
//   INTAKE + DETAIL FETCH — the request text is scanned for a source it names or implies (an
//     http(s) URL). When one is present it is fetched for real over HTTP(S) and the relevant
//     details (title + text facts) are extracted into the run context. When no source is named,
//     or the fetch fails, the fetch leg lands in the trace as 'declared'/'failed' WITH the reason —
//     details are never silently fabricated. No GitHub API is used (that lane is held elsewhere).
//   METHOD PICK — the conductor's library discovery (listMethods) ranked with the module reader's
//     quality-selection discipline (relevance first, quality score as boost/tie-break, quality
//     recorded). The pick and its reason land in the trace.
//   WEIGHTS PICK — hunter-style (~/workspace/weights-hunter/runner.mjs's pattern, re-implemented
//     against THIS tree's data, its bulk not copied): screen the catalog/bench records by the
//     machine (weights must fit the RAM budget), judge adequacy from the eval records
//     (catalog/bench/eval_host.jsonl score share), then select the FASTEST adequate weights by
//     measured generation rate (catalog/bench/bench_host.jsonl gen_tok_s, median per model).
//     Every rejected candidate's reason is recorded.
//   PREP — the three prep sections (governing-context module read via lib/module-reader.mjs,
//     method pick, weights pick) run IN PARALLEL when the machine can handle it and SEQUENTIALLY
//     (scoped down, one at a time) otherwise. Capacity is decided from node:os signals (free
//     memory + core count) against the stated thresholds below; the mode and why land in the trace.
//     A capacity override forces either mode (tests prove both).
//   ETA CLOCK — BEFORE execution, an estimated duration is derived from the bench record of the
//     picked weights (measured gen_tok_s + measured load_s) and the picked method's step profile
//     (step count × tokens-per-step, plus the governing-context size). The derivation — which bench
//     file, which model, what rate, what work size — is in the trace; the clock reading
//     { estimatedSeconds, startedAt, finishedAt, elapsedSeconds } is returned with the run.
//   EXECUTION — the picked method is conducted via lib/method-conductor.mjs against the caller's
//     workDir. The conduction result (status, outputs, its own trace) is carried through untouched.
//
// ── NO-GUESSING DOCTRINE — THE GATE (owner item 17, 2026-11-05) ─────────────────────────────
// The owner's law, in his terms: "No guessing: the models were never supposed to guess — they
// don't have the brain power to guess. Kingmaker works on a smaller machine because it is a
// routing layer taking orders, not a brain improvising. Capability comes from method files,
// not model improvisation." (His diagnosis of the OpenArt gap: prompts generate wrong because
// they were guessing.)
//
// THE GATE SITS HERE, at this loop's method pick, because that pick is the real routing
// decision point of this system: it is the one place a natural-language request is turned into
// conducted work. (lib/decision-router.mjs is NOT that point — it is a compiled reflex layer
// that answers typed calibration questions via Ollama; it never sees a request-to-work routing
// decision, and its header forbids editing the compiled output.)
//
// THE RULES THE GATE ENFORCES:
//   1. COVERAGE — a request may proceed to execution ONLY when a method file in the Brain
//      Library covers it. Coverage is the relevance score (scoreMethod below — the same
//      discovery/scoring the method pick already uses) of the picked method, and it must reach
//      COVERAGE_MIN_RELEVANCE. Quality NEVER creates coverage: quality is only a boost /
//      tie-break among relevant methods. Training-module context (the reader leg of prep) may
//      inform a run, but context is not coverage: no covering method = no execution.
//   2. STRUCTURED REFUSAL — when no method covers the request, run() returns a first-class
//      refusal (never an exception, never an improvised answer):
//        { refused: true, reason: 'no-method-coverage', request, requestSummary,
//          coverage: { score, threshold, methodId }, closest: [candidates + their scores],
//          unblock: 'a method file for <the capability gap>', conduction: null, clock: null,
//          trace: [..., { phase: 'coverage-gate', status: 'refused', ... }] }
//      No conduction runs, no output is fabricated, nothing falls back to free-form generation.
//   3. NO INVENTED DETAILS — when the fetch leg found no details (declared/failed), a covered
//      method that declares `requiresFetchedDetails: true` in its method file is halted by the
//      same gate with reason 'missing-required-details'. It never proceeds on invented details.
//
// Interface (item 17's router gate sits on exactly this):
//   const loop = createExecutionLoop();            // all deps injectable for tests/fixtures
//   await loop.run(request, { workDir, inputs?, now?, capacityOverride?, ramGb?, methodHint? });
//     // request:  the person's natural-language ask (string)
//     // workDir:  the folder the conducted method acts inside (required)
//     // capacityOverride: 'parallel' | 'sequential' — forces the prep mode
//     // ramGb:    the machine's RAM budget for the weights screen (default: this machine's total)
//     // methodHint: an exact method id or query that wins the method pick when given
//     // → { request, refused, coverage, fetched, context, picks: { method, weights }, prep, clock, conduction, trace }
//     //   on refusal: { refused: true, reason, requestSummary, coverage, closest, unblock, conduction: null, clock: null, ... }
//     //   trace: [{ phase, status, detail, ... }]  status ∈ 'executed' | 'declared' | 'failed' | 'refused'
//   loop.describeFramework() → the loop's own method-file descriptor, via conductor discovery.

import { readFile } from 'node:fs/promises';
import { cpus, freemem, totalmem } from 'node:os';
import { createMethodConductor } from './method-conductor.mjs';
import { createModuleReader } from './module-reader.mjs';

export const BENCH_DIR_URL = new URL('../catalog/bench/', import.meta.url);
export const PARALLEL_MIN_FREE_MEM_MB = 512; // stated threshold: below this free memory, prep scopes down
export const PARALLEL_MIN_CORES = 2;         // stated threshold: a single-core machine preps one section at a time
export const TOKENS_PER_STEP = 150;          // the method step profile's per-step token allowance for the ETA
export const MIN_EVAL_SHARE = 0.5;           // weights adequacy floor: eval score share (hunter-style screen)
export const COVERAGE_MIN_RELEVANCE = 6;     // no-guessing gate (item 17): the picked method's relevance (scoreMethod:
//                                             DISTINCT matched terms only — id/title word = 3, domain = 3, input key = 1,
//                                             each distinct term counted once, pen-test F2/F3) must reach 6 — i.e. at
//                                             least two distinct strong terms, or an equivalent combination of
//                                             distinct signals. A relevance of 0–5 is a guess, and guesses refuse.

const wordsOf = (s) => String(s ?? '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };

/** Pure: pull the source a request names (first http(s) URL), or null when it names none. */
export function sourceOf(request) {
  const m = /https?:\/\/[^\s"'<>)]+/.exec(String(request ?? ''));
  return m ? m[0].replace(/[.,;:]$/, '') : null;
}

/** Pure: extract the relevant details (title + text facts) from an HTML page's text. */
export function extractDetails(html, url) {
  const raw = String(html ?? '');
  const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw)?.[1] ?? '').replace(/\s+/g, ' ').trim() || null;
  const text = raw
    .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return { url, title, textExcerpt: text.slice(0, 600), textChars: text.length };
}

async function defaultFetch(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 5000);
  try {
    const res = await fetch(url, { signal: ctl.signal, redirect: 'follow' });
    return { status: res.status, ok: res.ok, body: await res.text() };
  } finally { clearTimeout(timer); }
}

/** Load + aggregate this tree's bench records: per-model median gen rate, load time, resident size, eval share. */
export async function loadBenchRecords({ benchDirUrl = BENCH_DIR_URL, readText = (loc) => readFile(loc, 'utf8') } = {}) {
  const byModel = new Map();
  const row = (model) => { if (!byModel.has(model)) byModel.set(model, { model, genTokS: [], loadS: [], sizeGb: null, evalScore: null, evalOf: null, benchFile: 'bench_host.jsonl' }); return byModel.get(model); };
  const hostText = await readText(new URL('bench_host.jsonl', benchDirUrl));
  for (const line of hostText.split('\n').filter(Boolean)) {
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (!r.model || !Number.isFinite(r.gen_tok_s)) continue;
    const m = row(r.model);
    m.genTokS.push(r.gen_tok_s);
    if (Number.isFinite(r.load_s)) m.loadS.push(r.load_s);
    if (Number.isFinite(r.resident?.size_gb)) m.sizeGb = r.resident.size_gb;
  }
  try {
    const evalText = await readText(new URL('eval_host.jsonl', benchDirUrl));
    for (const line of evalText.split('\n').filter(Boolean)) {
      let r; try { r = JSON.parse(line); } catch { continue; }
      if (!r.model || !Number.isFinite(r.score) || !Number.isFinite(r.of)) continue;
      const m = row(r.model); m.evalScore = r.score; m.evalOf = r.of;
    }
  } catch { /* eval records are the adequacy screen; absent, adequacy is judged on fit + measurement alone */ }
  return [...byModel.values()].map((m) => ({
    model: m.model, genTokS: median(m.genTokS), loadS: median(m.loadS) ?? 0, sizeGb: m.sizeGb,
    evalShare: m.evalScore != null && m.evalOf ? m.evalScore / m.evalOf : null, benchFile: m.benchFile,
    samples: m.genTokS.length,
  })).filter((m) => m.genTokS != null);
}

/**
 * Pure, hunter-style weights pick: screen by machine fit, judge adequacy by eval share, select the
 * fastest adequate by measured generation rate. Returns { pick, considered } — every candidate
 * carries its verdict and reason, winner included.
 */
export function pickWeights(records, { ramGb, minEvalShare = MIN_EVAL_SHARE } = {}) {
  const considered = records.map((r) => {
    const c = { model: r.model, genTokS: r.genTokS, loadS: r.loadS, sizeGb: r.sizeGb, evalShare: r.evalShare, benchFile: r.benchFile, verdict: 'rejected', reason: '' };
    if (r.sizeGb != null && ramGb != null && r.sizeGb > ramGb) { c.reason = `resident ${r.sizeGb} GB exceeds the machine's ${ramGb} GB RAM budget`; return c; }
    if (r.evalShare != null && r.evalShare < minEvalShare) { c.reason = `eval share ${r.evalShare.toFixed(2)} below the adequacy floor ${minEvalShare}`; return c; }
    c.verdict = 'adequate'; c.reason = `fits (${r.sizeGb ?? '?'} GB resident vs ${ramGb ?? '?'} GB budget)${r.evalShare != null ? `, eval share ${r.evalShare.toFixed(2)} adequate` : ', no eval record — adequacy on fit + measurement'}`;
    return c;
  });
  const adequate = considered.filter((c) => c.verdict === 'adequate')
    .sort((a, b) => (b.genTokS - a.genTokS) || ((a.sizeGb ?? 0) - (b.sizeGb ?? 0)));
  const pick = adequate[0] ?? null;
  if (pick) { pick.verdict = 'picked'; pick.reason += `; fastest adequate at ${pick.genTokS} tok/s measured (median, ${pick.benchFile})`; }
  return { pick, considered };
}

/** Pure: relevance of one method descriptor to a request (the reader's discipline, applied to methods). */
export function scoreMethod(method, request) {
  const q = String(request ?? '').toLowerCase();
  const qWords = new Set(wordsOf(q)); // request tokens are distinct by construction
  // Pen-test F2/F3: each DISTINCT matched term contributes ONCE, at its documented weight.
  // Scoring used to add per occurrence, so one request word repeated in a title
  // ("Tomatoes tomatoes") scored 12 — twice the coverage threshold from a single distinct
  // term. A term already counted in one signal (id/title) is not counted again as the
  // domain or an input key. Weights and the threshold are unchanged: id/title word 3,
  // domain 3, input key 1.
  const counted = new Set();
  let score = 0;
  const countOnce = (term, weight) => { if (term && qWords.has(term) && !counted.has(term)) { counted.add(term); score += weight; } };
  for (const w of new Set(wordsOf(`${method.id} ${method.title}`))) countOnce(w, 3);
  if (method.domain) countOnce(String(method.domain).toLowerCase(), 3);
  for (const k of new Set((method.inputKeys ?? []).map((k) => String(k).toLowerCase()))) countOnce(k, 1);
  return score;
}

/** Pure: the ETA derivation from a bench record + a method's step profile. No hardcoded durations. */
export function deriveEta({ weights, stepCount, contextChars = 0, tokensPerStep = TOKENS_PER_STEP }) {
  const estTokens = stepCount * tokensPerStep + Math.ceil(contextChars / 4);
  const genSeconds = estTokens / weights.genTokS;
  const estimatedSeconds = weights.loadS + genSeconds;
  return {
    estimatedSeconds, estTokens,
    derivation: {
      benchFile: `catalog/bench/${weights.benchFile}`, model: weights.model,
      genTokS: weights.genTokS, loadS: weights.loadS,
      formula: `load_s (${weights.loadS}) + estTokens (${estTokens} = ${stepCount} steps × ${tokensPerStep} tok/step + ${Math.ceil(contextChars / 4)} context tok) / gen_tok_s (${weights.genTokS})`,
      genSeconds,
    },
  };
}

/** This machine's capacity signals, in the shape the prep decision consumes. */
export function machineCapacity() {
  return { cores: cpus().length, freeMemMb: Math.floor(freemem() / 1e6), totalMemMb: Math.floor(totalmem() / 1e6) };
}

/** Pure: parallel-vs-scoped prep decision from capacity signals against the stated thresholds. */
export function decidePrepMode(capacity, override = null) {
  if (override === 'parallel' || override === 'sequential') {
    return { mode: override, reason: `capacity override forced '${override}'` };
  }
  const ok = capacity.cores >= PARALLEL_MIN_CORES && capacity.freeMemMb >= PARALLEL_MIN_FREE_MEM_MB;
  return ok
    ? { mode: 'parallel', reason: `${capacity.cores} cores and ${capacity.freeMemMb} MB free meet the thresholds (>= ${PARALLEL_MIN_CORES} cores, >= ${PARALLEL_MIN_FREE_MEM_MB} MB free) — prep sections run in parallel` }
    : { mode: 'sequential', reason: `${capacity.cores} cores / ${capacity.freeMemMb} MB free fall below the thresholds (>= ${PARALLEL_MIN_CORES} cores, >= ${PARALLEL_MIN_FREE_MEM_MB} MB free) — prep scoped down to one section at a time` };
}

/**
 * Weights for one run. With no `beforeWeights`, this is `pickWeights`: machine fit, eval
 * share, then the fastest adequate measured model. A weight hunter may run first. It
 * replaces that pick only when it names a model and a positive measured tok/s, and the
 * run then keeps that one model (`swap: false`). A hunter that declines or throws leaves
 * the bench pick unchanged.
 */
export async function resolveWeightsPick(records, { ramGb, request = '', beforeWeights = null } = {}) {
  if (typeof beforeWeights === 'function') {
    let hunted = null;
    try { hunted = await beforeWeights({ request, ramGb, records }); } catch { hunted = null; }
    if (hunted?.model && Number.isFinite(Number(hunted.genTokS)) && Number(hunted.genTokS) > 0) {
      return {
        model: hunted.model,
        genTokS: Number(hunted.genTokS),
        loadS: Number(hunted.loadS) || 0,
        sizeGb: hunted.sizeGb ?? null,
        evalShare: hunted.evalShare ?? null,
        benchFile: hunted.benchFile || 'brain-library',
        verdict: 'picked',
        reason: hunted.reason || `weight hunter picked ${hunted.model} for this task; the run keeps that one model`,
        swap: false,
        availability: hunted.availability ?? null,
        considered: Array.isArray(hunted.considered) ? hunted.considered : [],
      };
    }
  }
  const { pick, considered } = pickWeights(records, { ramGb });
  if (!pick) return null;
  return { ...pick, considered: considered.map((c) => ({ model: c.model, verdict: c.verdict, reason: c.reason })) };
}

export function createExecutionLoop({
  conductor = createMethodConductor(),
  reader = createModuleReader(),
  fetchImpl = defaultFetch,
  benchDirUrl = BENCH_DIR_URL,
  capacity = null,
  beforeWeights = null,
} = {}) {
  /** The loop reads its own framework: its method file, discovered through the conductor's library path. */
  async function describeFramework() {
    const methods = await conductor.listMethods();
    return methods.find((m) => m.id === 'execution-loop') ?? null;
  }

  async function run(request, { workDir, inputs = {}, now = Date.now(), capacityOverride = null, ramGb = null, methodHint = null } = {}) {
    if (!workDir) throw new Error('execution-loop: run() needs a workDir — the conducted method acts inside it and nowhere else');
    const startedAt = now instanceof Date ? now.getTime() : now;
    const trace = [];
    const ramBudgetGb = ramGb ?? Math.round((totalmem() / 1e9) * 10) / 10;

    // ── 1. INTAKE + DETAIL FETCH (the SEO/AEO leg) ──────────────────────────────
    const url = sourceOf(request);
    let fetched = null;
    if (!url) {
      trace.push({ phase: 'fetch', status: 'declared', detail: 'the request names no source — no detail fetch attempted, and no details fabricated; the run proceeds on the request text alone' });
    } else {
      try {
        const res = await fetchImpl(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        fetched = extractDetails(res.body, url);
        trace.push({ phase: 'fetch', status: 'executed', detail: `fetched ${url} (HTTP ${res.status}) — title "${fetched.title ?? '(none)'}", ${fetched.textChars} chars of text extracted into the run context`, result: { url, title: fetched.title } });
      } catch (e) {
        trace.push({ phase: 'fetch', status: 'failed', detail: `detail fetch of ${url} failed: ${e.message} — recorded, not fabricated; the run proceeds on the request text alone` });
      }
    }

    // ── 2. PREP (parallel or scoped down) ───────────────────────────────────────
    const cap = capacity ?? machineCapacity();
    const prep = decidePrepMode(cap, capacityOverride);
    const prepSections = {};
    const sectionContext = async () => {
      const read = await reader.readForSession(String(request), { maxParts: 2, maxChars: 6000 });
      prepSections.context = { parts: read.parts, stats: read.stats, chars: read.text.length };
      return prepSections.context;
    };
    const sectionMethod = async () => {
      const methods = await conductor.listMethods();
      // The gate's raw material (item 17): EVERY library method scored against this request with
      // the same scoreMethod the pick uses, ranked relevance-first (quality boosts only as a
      // tie-break — quality must never outrank relevance, or it could manufacture coverage).
      const ranked = methods.map((m) => ({ method: m, relevance: scoreMethod(m, request), qualityScore: m.quality?.score ?? 0 }))
        .map((r) => ({ ...r, rankScore: r.relevance + (r.qualityScore / 100) * 2 }))
        .sort((a, b) => (b.relevance - a.relevance) || (b.rankScore - a.rankScore) || (b.qualityScore - a.qualityScore));
      const candidates = ranked.map((r) => ({ id: r.method.id, title: r.method.title, coverageScore: r.relevance, relevance: r.relevance, qualityScore: r.qualityScore, rankScore: r.rankScore }));
      let chosen, reason;
      if (methodHint) {
        chosen = methods.find((m) => m.id === methodHint) ?? methods.find((m) => m.id.includes(String(methodHint).toLowerCase()));
        reason = `method hint "${methodHint}" given by the caller`;
      }
      if (!chosen && ranked.length) {
        chosen = ranked[0].method;
        reason = `top-ranked by relevance ${ranked[0].relevance} + quality boost (quality ${chosen.quality?.tier} ${chosen.quality?.score}) over ${ranked.length} library methods`;
      }
      if (!chosen) {
        // Empty library (or an unmatched hint): no pick exists. The gate below refuses on
        // coverage 0 — a missing pick must never crash the loop into an improvised answer.
        prepSections.method = { id: null, title: null, quality: null, stepCount: 0, reason: 'the Brain Library holds no method for this pick', relevance: 0, coverageScore: 0, requiresFetchedDetails: false, candidates };
        return prepSections.method;
      }
      const chosenRelevance = ranked.find((r) => r.method.id === chosen.id)?.relevance ?? scoreMethod(chosen, request);
      prepSections.method = { id: chosen.id, title: chosen.title, quality: chosen.quality, stepCount: chosen.stepCount, reason, relevance: chosenRelevance, coverageScore: chosenRelevance, requiresFetchedDetails: chosen.requiresFetchedDetails === true, candidates };
      return prepSections.method;
    };
    const sectionWeights = async () => {
      const records = await loadBenchRecords({ benchDirUrl });
      const weights = await resolveWeightsPick(records, { ramGb: ramBudgetGb, request, beforeWeights });
      if (!weights?.model) throw new Error(`no adequate weights in catalog/bench fit this machine (${ramBudgetGb} GB budget)`);
      prepSections.weights = weights;
      return prepSections.weights;
    };
    const sections = [['context-read', sectionContext], ['method-pick', sectionMethod], ['weights-pick', sectionWeights]];
    if (prep.mode === 'parallel') await Promise.all(sections.map(([, fn]) => fn()));
    else for (const [, fn] of sections) await fn();
    trace.push({ phase: 'prep', status: 'executed', detail: `prep mode ${prep.mode}: ${prep.reason}`, result: { mode: prep.mode, sections: sections.map(([n]) => n), order: prep.mode === 'parallel' ? 'concurrent (Promise.all)' : 'one at a time, in order' } });
    trace.push({ phase: 'context-read', status: 'executed', detail: `governing context read via the module reader: ${prepSections.context.parts.length} part(s), ${prepSections.context.chars} chars (part files opened: ${prepSections.context.stats.partFilesRead.join(', ') || 'none'})`, result: prepSections.context });
    trace.push({ phase: 'method-pick', status: 'executed', detail: `method pick: ${prepSections.method.id} — ${prepSections.method.reason}`, result: prepSections.method });
    trace.push({ phase: 'weights-pick', status: 'executed', detail: `weights pick: ${prepSections.weights.model} — ${prepSections.weights.reason}`, result: { model: prepSections.weights.model, considered: prepSections.weights.considered } });

    // ── 2b. THE NO-GUESSING GATE (item 17 — see the doctrine block at the top of this file) ──
    // Sits between the pick and any execution: this is the last point where a request can be
    // stopped before conduction, and the first point where coverage is known. A refusal returns
    // from here — no ETA is derived, no conduction runs, nothing is fabricated.
    const coverage = { score: prepSections.method.coverageScore ?? 0, threshold: COVERAGE_MIN_RELEVANCE, methodId: prepSections.method.id };
    const closest = [...(prepSections.method.candidates ?? [])]
      .sort((a, b) => (b.coverageScore - a.coverageScore) || (b.qualityScore - a.qualityScore))
      .slice(0, 3);
    const refuse = (reason, detail, unblock) => {
      trace.push({ phase: 'coverage-gate', status: 'refused', detail, result: { reason, coverage, closest, unblock } });
      return {
        request: String(request), refused: true, reason,
        requestSummary: String(request).replace(/\s+/g, ' ').trim().slice(0, 200),
        coverage, closest, unblock,
        fetched, context: prepSections.context,
        picks: { method: prepSections.method, weights: prepSections.weights },
        prep, clock: null, conduction: null, trace,
      };
    };
    if (coverage.score < coverage.threshold) {
      return refuse(
        'no-method-coverage',
        `coverage gate REFUSED: no method file in the Brain Library covers this request — best coverage score ${coverage.score} (${prepSections.method.id ?? 'no method picked'}) is below the threshold ${coverage.threshold}. Kingmaker is a routing layer, not a brain improvising: no conduction runs and no answer is fabricated. Closest candidates: ${closest.map((c) => `${c.id} (score ${c.coverageScore})`).join(', ') || 'none'}`,
        `a method file for the capability this request needs — "${String(request).replace(/\s+/g, ' ').trim().slice(0, 120)}" — added to the Brain Library (catalog/methods/); the same request through the same code then routes and conducts`,
      );
    }
    if (prepSections.method.requiresFetchedDetails && !fetched) {
      const fetchLeg = trace.find((x) => x.phase === 'fetch');
      return refuse(
        'missing-required-details',
        `coverage gate REFUSED: method ${prepSections.method.id} covers this request (coverage ${coverage.score} >= ${coverage.threshold}) but its method file declares requiresFetchedDetails — and the fetch leg found no details (status '${fetchLeg?.status ?? 'declared'}': ${fetchLeg?.detail ?? 'no source named'}). The method halts for missing details rather than proceed on invented ones; no conduction runs.`,
        'the load-bearing details this method requires: name a reachable source (an http(s) URL) in the request so the fetch leg loads real details — the loop will not invent them',
      );
    }
    trace.push({ phase: 'coverage-gate', status: 'executed', detail: `coverage gate passed: method ${prepSections.method.id} covers this request — coverage score ${coverage.score} >= threshold ${coverage.threshold} (relevance from the library discovery scoring; quality never creates coverage)`, result: { coverage, closest } });

    // ── 3. ETA CLOCK (derived before execution) ─────────────────────────────────
    const eta = deriveEta({ weights: prepSections.weights, stepCount: prepSections.method.stepCount, contextChars: prepSections.context.chars });
    trace.push({ phase: 'eta', status: 'executed', detail: `clock estimate ${eta.estimatedSeconds.toFixed(2)}s — ${eta.derivation.formula}`, result: eta });

    // ── 4. EXECUTION ────────────────────────────────────────────────────────────
    const conduction = await conductor.conduct(prepSections.method.id, { workDir, inputs, now: startedAt });
    trace.push({ phase: 'conduct', status: conduction.status === 'completed' ? 'executed' : 'failed', detail: `conducted ${conduction.method.id} v${conduction.method.version} (sha256 ${conduction.method.sha256.slice(0, 12)}…) → ${conduction.status}${conduction.reason ? `: ${conduction.reason}` : ''} · ${conduction.trace.length} step(s), ${conduction.declared.length} declared` });

    const finishedAt = Date.now();
    const clock = { estimatedSeconds: eta.estimatedSeconds, startedAt, finishedAt, elapsedSeconds: (finishedAt - startedAt) / 1000, derivation: eta.derivation };
    trace.push({ phase: 'clock', status: 'executed', detail: `clock: estimated ${clock.estimatedSeconds.toFixed(2)}s, elapsed ${clock.elapsedSeconds.toFixed(2)}s` });

    return {
      request: String(request),
      refused: false,
      coverage,
      fetched,
      context: prepSections.context,
      picks: { method: prepSections.method, weights: prepSections.weights },
      prep,
      clock,
      conduction,
      trace,
    };
  }

  return { run, describeFramework };
}

/** One-shot convenience: a fresh loop, one request. */
export async function runRequest(request, opts = {}) {
  const { loopOpts, ...runOpts } = opts;
  return createExecutionLoop(loopOpts).run(request, runOpts);
}
