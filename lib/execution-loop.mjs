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
//   WEIGHTS PICK — smallest sufficient (the metered doctrine, owner 2026-11-14: "smallest base
//     required model for each task over a metered connection" — device RAM tier gates NOTHING):
//     the task's requirement (the picked method's declared `weights` requirement, an explicit
//     run requirement, or the lane default for the classified task) is screened against the
//     measured records (catalog/bench score shares + the Brain Library catalog's role/capability
//     evidence), and the SMALLEST sufficient model wins — never the fastest, never a device-fit
//     rejection. The pick carries a delivery plan, in lane order: resident when it fits the
//     measured free memory; metered-stream (1 MiB pin-verified portions,
//     lib/brain-library-access.mjs) when it fits the device but not its free memory; the
//     SANDBOX lane (lib/sandbox-lane.mjs — containerized, paged execution under this device's
//     own Docker control: Kingmaker's device-level control of its Linux sandbox) when the
//     model exceeds the device's whole memory but the sandbox is in the device's posture.
//     There is no model-size limit on local execution: only when the sandbox lane is absent
//     or declined does the run ESCALATE through the existing lanes — a policy routing (the
//     task is served elsewhere now rather than left waiting), never a refusal and never a
//     claim that this device cannot run the model. Every candidate's verdict is recorded.
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
//   ITERATION — the loop's final step (owner's done-criterion, 2026-11-13): when the caller
//     enables it (iterationStore), a COMPLETED conduction is filed back as the next version
//     of its own method file — proven inputs as the new defaults, steps verbatim, an
//     iteration-log receipt appended — into a local method store (lib/method-iteration.mjs).
//     The next run can conduct the improved file from that store: conduct → evaluate →
//     write the improved method → conduct again. An iteration failure is recorded in the
//     trace and never undoes the conduction it follows.
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
//   await loop.run(request, { workDir, inputs?, now?, capacityOverride?, ramGb?, methodHint?, requirement? });
//     // request:  the person's natural-language ask (string)
//     // workDir:  the folder the conducted method acts inside (required)
//     // capacityOverride: 'parallel' | 'sequential' — forces the prep mode
//     // ramGb:    the machine's measured RAM (default: this machine's total) — delivery planning
//     //           only (which lane serves the pick: host, or the sandbox past the device's
//     //           memory); it never screens a model out
//     // methodHint: an exact method id or query that wins the method pick when given
//     // requirement: an explicit weights requirement { role, minEvalShare?, capabilities? } —
//     //           wins over the picked method's declared requirement and the lane default
//     // → { request, refused, coverage, fetched, context, picks: { method, weights }, prep, clock, conduction, trace }
//     //   on refusal: { refused: true, reason, requestSummary, coverage, closest, unblock, conduction: null, clock: null, ... }
//     //   trace: [{ phase, status, detail, ... }]  status ∈ 'executed' | 'declared' | 'failed' | 'refused'
//   loop.describeFramework() → the loop's own method-file descriptor, via conductor discovery.

import { readFile, readdir } from 'node:fs/promises';
import { cpus, freemem, totalmem } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_PORTION_BYTES } from './brain-library-access.mjs';
import { buildSandboxPlan, normalizeSandboxPosture, probeSandboxPosture } from './sandbox-lane.mjs';
import { ROLES } from './mac-profiles.mjs';
import { createMethodConductor } from './method-conductor.mjs';
import { iterateMethod } from './method-iteration.mjs';
import { createModuleReader } from './module-reader.mjs';
import { resolvePaths } from './paths.mjs';
import { createRepoReadText, libraryRemoteEnabled, repoIndexUrl } from './brain-library-repo.mjs';

export const BENCH_DIR_URL = new URL('../catalog/bench/', import.meta.url);
export const PARALLEL_MIN_FREE_MEM_MB = 512; // stated threshold: below this free memory, prep scopes down
export const PARALLEL_MIN_CORES = 2;         // stated threshold: a single-core machine preps one section at a time
export const TOKENS_PER_STEP = 150;          // the method step profile's per-step token allowance for the ETA
export const MIN_EVAL_SHARE = 0.5;           // the standing sufficiency floor: a task that declares no floor of its
//                                             own is met by a model whose measured evaluation share reaches this
export const COVERAGE_MIN_RELEVANCE = 6;     // no-guessing gate (item 17): the picked method's relevance (scoreMethod:
//                                             DISTINCT matched terms only — id/title word = 3, domain = 3, input key = 1,
//                                             each distinct term counted once, pen-test F2/F3) must reach 6 — i.e. at
//                                             least two distinct strong terms, or an equivalent combination of
//                                             distinct signals. A relevance of 0–5 is a guess, and guesses refuse.

const wordsOf = (s) => String(s ?? '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };

/** Pure: pull the source a request names (first http(s) URL), or null when it names none. */
export function sourceOf(request) {
  const m = /https?:\/\/[^\s"'<>)]+/['exec'](String(request ?? ''));
  return m ? m[0].replace(/[.,;:]$/, '') : null;
}

/** Pure: extract the relevant details (title + text facts) from an HTML page's text. */
export function extractDetails(html, url) {
  const raw = String(html ?? '');
  const title = (/<title[^>]*>([\s\S]*?)<\/title>/i['exec'](raw)?.[1] ?? '').replace(/\s+/g, ' ').trim() || null;
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

/** The bench directory's entry names, for host-catalog discovery. File URLs only; anything
 *  else (an injected benchDirUrl in a test, an unreadable directory) yields no names and the
 *  loader simply runs on its jsonl sources, exactly as it did before catalog ingestion. */
async function defaultListBenchDir(benchDirUrl) {
  if (benchDirUrl?.protocol !== 'file:') return [];
  return readdir(fileURLToPath(benchDirUrl));
}

/** Load + aggregate this tree's bench records: per-model median gen rate, load time, resident size, evaluation share.
 *  Two source families, one evidence pool:
 *   • bench_host.jsonl + eval_host.jsonl — the standing raw runs (snake_case rows; the eval
 *     file's score/of is the adequacy screen's authoritative evaluation, where it exists).
 *   • the host catalog JSONs the bench WRITER leaves beside them (lib/model-bench.mjs runBench:
 *     catalog/bench/<slug>.json — m3-8gb.json, m5-pro-24gb.json and kin; schema 1:
 *     { slug, host, results: [{ model, loadS, speed.genTokS, resident.sizeGb, and the measured
 *     sections tools.twoStep / tools.native / route / write, each { pass, of } }] }).
 *     `kingmaker models bench` writes ONLY the catalog JSON — so a bench run on a real host
 *     feeds selection only when the loader reads these too. (Found 2026-11-14: the real 8 GB
 *     Mac run measured the granite writer at tools twoStep 17/18, native 15/18 into
 *     m3-8gb.json, yet writing/reasoning still resolved through the unevidenced fallback —
 *     no record for the granite ever reached this loader.)
 *  Aggregation: gen/load samples pool across sources and median together; size is the latest
 *  finite reading. Evaluation: where eval_host.jsonl has no score for a model, the catalog
 *  sections are its evaluation of record — the pass/of totals across the sections the writer
 *  measured become the model's eval share. Admission to the catalog pass is by the WRITER'S
 *  SHAPE (a slug string + a results array), never by filename: the same directory holds other
 *  JSON that is not a host bench (conc_8gb.json is a concurrency report) and must not be read
 *  as one. Discovery and per-file reads never throw — a missing or malformed catalog file is
 *  skipped, and the jsonl behavior above is unchanged in every particular.
 *  Provenance: a record measured only in catalog JSONs names the first such file in benchFile
 *  (the ETA derivation cites it); a record with jsonl samples keeps 'bench_host.jsonl'. */
export async function loadBenchRecords({ benchDirUrl = BENCH_DIR_URL, readText = (loc) => readFile(loc, 'utf8'), listDir = null } = {}) {
  const byModel = new Map();
  const row = (model) => { if (!byModel.has(model)) byModel.set(model, { model, genTokS: [], loadS: [], sizeGb: null, evalScore: null, evalOf: null, benchFile: 'bench_host.jsonl', jsonlSamples: 0, sectionScore: 0, sectionOf: 0 }); return byModel.get(model); };
  const hostText = await readText(new URL('bench_host.jsonl', benchDirUrl));
  for (const line of hostText.split('\n').filter(Boolean)) {
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (!r.model || !Number.isFinite(r.gen_tok_s)) continue;
    const m = row(r.model);
    m.genTokS.push(r.gen_tok_s);
    m.jsonlSamples += 1;
    if (Number.isFinite(r.load_s)) m.loadS.push(r.load_s);
    if (Number.isFinite(r.resident?.size_gb)) m.sizeGb = r.resident.size_gb;
  }
  let names = [];
  try { names = listDir ? await listDir(benchDirUrl) : await defaultListBenchDir(benchDirUrl); } catch { names = []; }
  for (const name of [...(names ?? [])].filter((n) => typeof n === 'string' && n.endsWith('.json')).sort()) {
    let parsed; try { parsed = JSON.parse(await readText(new URL(name, benchDirUrl))); } catch { continue; }
    if (!parsed || typeof parsed.slug !== 'string' || !Array.isArray(parsed.results)) continue;
    for (const r of parsed.results) {
      if (!r?.model || !Number.isFinite(r.speed?.genTokS)) continue;
      const m = row(r.model);
      if (!m.jsonlSamples && m.genTokS.length === 0) m.benchFile = name;
      m.genTokS.push(r.speed.genTokS);
      if (Number.isFinite(r.loadS)) m.loadS.push(r.loadS);
      if (Number.isFinite(r.resident?.sizeGb)) m.sizeGb = r.resident.sizeGb;
      for (const s of [r.tools?.twoStep, r.tools?.native, r.route, r.write]) {
        if (Number.isFinite(s?.pass) && Number.isFinite(s?.of) && s.of > 0) { m.sectionScore += s.pass; m.sectionOf += s.of; }
      }
    }
  }
  try {
    const evalText = await readText(new URL('eval_host.jsonl', benchDirUrl));
    for (const line of evalText.split('\n').filter(Boolean)) {
      let r; try { r = JSON.parse(line); } catch { continue; }
      if (!r.model || !Number.isFinite(r.score) || !Number.isFinite(r.of)) continue;
      const m = row(r.model); m.evalScore = r.score; m.evalOf = r.of;
    }
  } catch { /* evaluation records are the adequacy screen; absent, adequacy is judged on fit + measurement alone */ }
  for (const m of byModel.values()) {
    if (m.evalScore == null && m.sectionOf > 0) { m.evalScore = m.sectionScore; m.evalOf = m.sectionOf; }
  }
  return [...byModel.values()].map((m) => ({
    model: m.model, genTokS: median(m.genTokS), loadS: median(m.loadS) ?? 0, sizeGb: m.sizeGb,
    evalShare: m.evalScore != null && m.evalOf ? m.evalScore / m.evalOf : null, benchFile: m.benchFile,
    samples: m.genTokS.length,
  })).filter((m) => m.genTokS != null);
}

/** The lanes a task escalates through when its smallest sufficient model is not served
 *  locally under the device's current posture (the sandbox lane absent or declined). */
export const ESCALATION_LANES = Object.freeze([
  'the cloud model lane (the connected model services)',
  'a paired bigger host on the mesh',
]);

/**
 * Pure: normalize a task requirement — the input "smallest sufficient" reads. A method file
 * declares it in its executable block (`weights: { role, minEvalShare?, capabilities? }`); a run
 * may carry one explicitly; the loop otherwise derives the lane default from the classified task.
 * Unknown roles are dropped and floors clamped, never invented upward.
 */
export function normalizeRequirement(requirement = {}) {
  const req = requirement && typeof requirement === 'object' ? requirement : {};
  return {
    role: ROLES.includes(req.role) ? req.role : null,
    minEvalShare: Number.isFinite(req.minEvalShare) ? Math.min(1, Math.max(0, req.minEvalShare)) : MIN_EVAL_SHARE,
    capabilities: Array.isArray(req.capabilities) ? req.capabilities.filter((c) => typeof c === 'string' && c) : [],
  };
}

/** Pure: how one picked model reaches this device — in verified portions either way. The
 *  lanes, in order: resident when it fits the measured free memory; metered-stream when it
 *  fits the device's whole memory but not its free memory; the SANDBOX lane when it exceeds
 *  the device's whole memory and the sandbox is in the device's posture (containerized,
 *  paged execution under Kingmaker's Docker control — lib/sandbox-lane.mjs). The sandbox
 *  branch is only reachable for a pick the selector actually made: with no sandbox posture
 *  an over-memory model is never picked (the run escalates instead), so the fall-through
 *  below stays metered-stream — portions are how its bytes would arrive regardless. */
export function deliveryPlan(record, { freeGb = null, ramGb = null, sandbox = null } = {}) {
  const bytes = Number.isFinite(record?.sizeGb) ? Math.round(record.sizeGb * 2 ** 30) : null;
  const portions = bytes == null ? null : Math.max(1, Math.ceil(bytes / MAX_PORTION_BYTES));
  const base = { bytes, portions, portionBytes: MAX_PORTION_BYTES };
  if (bytes != null && Number.isFinite(freeGb) && record.sizeGb <= freeGb) {
    return { ...base, strategy: 'resident', detail: `${record.model} fits the measured free memory (${freeGb} GB): delivered in ${portions} pin-verified portion(s), then resident` };
  }
  const posture = normalizeSandboxPosture(sandbox);
  if (bytes != null && Number.isFinite(ramGb) && record.sizeGb > ramGb && posture.available) {
    const plan = buildSandboxPlan({ model: record.model, weightsBytes: bytes, ramBytes: Math.round(ramGb * 2 ** 30) });
    return {
      ...base, strategy: 'sandbox', sandbox: plan,
      detail: `${record.model} exceeds this device's whole memory (${ramGb} GB), so it serves through the sandbox lane: ${plan.runner.image} under Kingmaker's Docker control (${plan.execution.command} ${plan.execution.args.join(' ')}), answering at ${plan.runner.endpoint}; the model is memory-mapped from the sandbox store and paged under a ${plan.paging.memoryBytes}-byte container ceiling with a ${plan.paging.swapAllowanceBytes}-byte disk-backed paging allowance, after its ${portions} pin-verified portion(s) are fed into the store`,
    };
  }
  return { ...base, strategy: 'metered-stream', detail: `${record.model} is delivered over the metered connection in ${portions ?? '?'} pin-verified 1 MiB portion(s) (lib/brain-library-access.mjs); residency is cycled by the eviction policy as it materializes` };
}

/**
 * Pure: choose this run's weights — the SMALLEST model that meets the task requirement (the
 * metered doctrine, owner 2026-11-14). The screen is sufficiency only: role evidence, the
 * declared capabilities (a record's tabled role is capability evidence for its own name), and
 * the eval-share floor (a record with no evaluation judges on measurement alone, this tree's
 * standing rule). Role evidence takes precedence: when any record carries the required role,
 * only those records are sufficient — a model tabled for other work is never sufficient for
 * this role. Records carrying NO role evidence at all (raw bench records, unenriched) form a
 * fallback pool used only when no evidenced candidate is sufficient; a pick from it carries
 * `evidenced: false` and the 'sufficient-unevidenced' verdict, so the fallback is visible in
 * every trace, never silent (found by the rework's proof run on this tree's bench data: an
 * unevidenced 0.6b stock model out-picking evidenced role models on size alone).
 * Device memory never screens a candidate OUT: it shapes the pick's delivery plan in lane
 * order — resident, metered-stream, then the SANDBOX lane (lib/sandbox-lane.mjs): a model
 * larger than the device's whole memory still serves locally when the sandbox is in the
 * device's posture, executed containerized and paged under Kingmaker's own Docker control
 * (the owner's no-GGUF-limit ruling, 2026-11-14: Kingmaker's device-level control of its
 * Linux sandbox includes Docker, so the sandbox is a local execution surface, not an
 * off-device step). Only when the sandbox lane is absent or declined does an over-memory
 * smallest-sufficient model turn the outcome into an ESCALATION naming the model and the
 * lanes — a policy routing, never a tier refusal and never a device-incapacity claim.
 * Among the sufficient: smallest size wins; measured generation rate, then load time, break
 * ties. Returns { pick, escalate, requirement, considered } — every candidate carries its
 * verdict and reason, winner included.
 */
export function pickSmallestSufficient(records, { requirement = {}, device = null } = {}) {
  const req = normalizeRequirement(requirement);
  const ramGb = Number.isFinite(device?.ramGb) ? device.ramGb : null;
  const freeGb = Number.isFinite(device?.freeGb) ? device.freeGb : null;
  const considered = [];
  const evidenced = [];
  const unevidenced = [];
  for (const r of records ?? []) {
    const hasRoles = Array.isArray(r.roles) && r.roles.length > 0;
    const roleEvidenced = hasRoles && (!req.role || r.roles.includes(req.role));
    if (req.role && hasRoles && !roleEvidenced) {
      considered.push({ model: r.model, verdict: 'not-sufficient', reason: `no measured ${req.role} evidence — its tabled roles are ${r.roles.join(', ')}` });
      continue;
    }
    const caps = new Set([...(Array.isArray(r.capabilities) ? r.capabilities : []), ...(Array.isArray(r.roles) ? r.roles : [])]);
    const missingCap = req.capabilities.find((c) => !caps.has(c));
    if (missingCap) {
      considered.push({ model: r.model, verdict: 'not-sufficient', reason: `lacks the ${missingCap} capability this task requires` });
      continue;
    }
    if (typeof r.evalShare === 'number' && r.evalShare < req.minEvalShare) {
      considered.push({ model: r.model, verdict: 'not-sufficient', reason: `evaluation share ${r.evalShare.toFixed(2)} below the sufficiency floor ${req.minEvalShare} this task requires` });
      continue;
    }
    (roleEvidenced ? evidenced : unevidenced).push(r);
  }
  const bySize = (a, b) => (a.sizeGb ?? Infinity) - (b.sizeGb ?? Infinity) || (b.genTokS || 0) - (a.genTokS || 0) || (a.loadS || 0) - (b.loadS || 0);
  evidenced.sort(bySize);
  unevidenced.sort(bySize);
  // With no role required there is nothing to evidence: every screen-passing record competes.
  // With a role required, evidenced candidates win outright; the unevidenced pool is the
  // labeled fallback, used only when no evidenced candidate is sufficient.
  const fromFallback = Boolean(req.role) && evidenced.length === 0;
  let sufficient;
  if (!req.role) sufficient = [...evidenced, ...unevidenced].sort(bySize);
  else if (fromFallback) sufficient = unevidenced;
  else {
    sufficient = evidenced;
    for (const r of unevidenced) considered.push({ model: r.model, verdict: 'not-sufficient', reason: `carries no ${req.role} evidence, and evidenced candidates exist — unevidenced records are a fallback only` });
  }
  // Local servability, in lane order: the host runner serves a model up to the device's
  // whole memory (resident / metered-stream by free memory); past that, the sandbox lane
  // serves it locally — containerized, paged — whenever the sandbox is in the device's
  // posture. Size alone never makes a sufficient model unservable; only an absent or
  // declined sandbox lane leaves an over-memory model to the escalation below.
  const posture = normalizeSandboxPosture(device?.sandbox);
  const hostServable = (r) => ramGb == null || !Number.isFinite(r.sizeGb) || r.sizeGb <= ramGb;
  const servable = (r) => hostServable(r) || posture.available;
  const pick = sufficient.find(servable) ?? null;
  for (const r of sufficient) {
    if (r === pick) continue;
    considered.push(servable(r)
      ? { model: r.model, verdict: fromFallback ? 'sufficient-unevidenced' : 'sufficient', reason: `sufficient (${r.sizeGb ?? '?'} GB, eval share ${r.evalShare ?? 'unmeasured'}) but larger than the smallest sufficient pick${fromFallback ? ' — from the unevidenced fallback pool (no role evidence on record)' : ''}` }
      : { model: r.model, verdict: 'sufficient-not-served', reason: `sufficient, but at ${r.sizeGb} GB it exceeds this device's ${ramGb} GB whole memory, and local serving past the device's memory runs through the sandbox lane (containerized, paged execution under Kingmaker's Docker control) — that lane is ${posture.declined ? 'declined in' : 'absent from'} this device's posture (${posture.reason})` });
  }
  if (!pick) {
    if (sufficient.length) {
      const s = sufficient[0];
      return {
        pick: null, requirement: req, considered,
        escalate: {
          model: s.model, sizeGb: s.sizeGb ?? null,
          reason: `the smallest sufficient model for this task is ${s.model} (${s.sizeGb ?? '?'} GB), and no smaller sufficient model exists. This device (${ramGb} GB) serves models on the host runner up to its whole memory; past that, local serving runs through the sandbox lane — containerized, paged execution under Kingmaker's own Docker control — and that lane is ${posture.declined ? 'declined in' : 'absent from'} this device's posture (${posture.reason}). By policy the task therefore escalates through the existing lanes and is served elsewhere now, rather than sit unserved. It is not refused, and it is not refused for its size.`,
          lanes: [...ESCALATION_LANES],
        },
      };
    }
    return { pick: null, escalate: null, requirement: req, considered };
  }
  const delivery = deliveryPlan(pick, { freeGb, ramGb, sandbox: posture });
  const pickOut = {
    model: pick.model,
    genTokS: pick.genTokS ?? null,
    loadS: pick.loadS ?? null,
    sizeGb: pick.sizeGb ?? null,
    evalShare: pick.evalShare ?? null,
    benchFile: pick.benchFile ?? null,
    verdict: 'picked',
    evidenced: !fromFallback,
    delivery,
    reason: `smallest sufficient for ${req.role ? `the ${req.role} task` : 'this task'}: ${pick.model} at ${pick.sizeGb ?? '?'} GB, eval share ${pick.evalShare ?? 'unmeasured'} (floor ${req.minEvalShare})${fromFallback ? ' — from the unevidenced fallback pool: no record carries role evidence for this task, so sufficiency rests on the eval floor and capabilities alone' : ''} — delivery: ${delivery.strategy}`,
  };
  considered.push({ model: pick.model, verdict: 'picked', reason: pickOut.reason });
  return { pick: pickOut, escalate: null, requirement: req, considered };
}

/**
 * Pure: attach the catalog's role/capability/size evidence to bench records (bench records
 * measure speed and score; the Brain Library catalog tables what each model can fill). A record
 * the catalog does not know keeps its own fields untouched — unknown evidence stays unknown.
 */
export function enrichRecords(records, catalogModels) {
  if (!Array.isArray(catalogModels) || !catalogModels.length) return records ?? [];
  const byTag = new Map(catalogModels.map((m) => [m.tag, m]));
  return (records ?? []).map((r) => {
    const c = byTag.get(r.model);
    if (!c) return r;
    return {
      ...r,
      sizeGb: r.sizeGb ?? c.downloadGb ?? null,
      roles: r.roles ?? c.roles ?? undefined,
      capabilities: r.capabilities ?? c.capabilities ?? undefined,
    };
  });
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
 * Weights for one run. The default is `pickSmallestSufficient` over the requirement: the
 * smallest model that meets the task, with its delivery plan — or an escalation when the
 * smallest sufficient model is not served locally under this device's posture (the sandbox
 * lane absent or declined — see pickSmallestSufficient). A weight hunter may run first
 * (the owner's override lane): it replaces the pick only when it names a model and a positive
 * measured tok/s, and the run then keeps that one model (`swap: false`). A hunter that
 * declines or throws leaves the selector's outcome — pick or escalation — unchanged.
 * Returns the pick object, `{ escalate, considered, requirement }`, or null when no measured
 * model is sufficient at all.
 */
export async function resolveWeightsPick(records, { requirement = {}, device = null, request = '', beforeWeights = null } = {}) {
  const base = pickSmallestSufficient(records, { requirement, device });
  if (typeof beforeWeights === 'function') {
    let hunted = null;
    try { hunted = await beforeWeights({ request, requirement: base.requirement, device, records, benchPick: base.pick }); } catch { hunted = null; }
    if (hunted?.model && Number.isFinite(Number(hunted.genTokS)) && Number(hunted.genTokS) > 0) {
      return {
        model: hunted.model,
        genTokS: Number(hunted.genTokS),
        loadS: Number(hunted.loadS) || 0,
        sizeGb: hunted.sizeGb ?? null,
        evalShare: hunted.evalShare ?? null,
        benchFile: hunted.benchFile || 'brain-library',
        verdict: 'picked',
        evidenced: true, // the hunter's own role-eligibility screen (scoreLibraryModels) is its evidence
        reason: hunted.reason || `weight hunter picked ${hunted.model} for this task; the run keeps that one model`,
        swap: false,
        availability: hunted.availability ?? null,
        delivery: hunted.delivery ?? (base.pick?.model === hunted.model ? base.pick.delivery : null),
        requirement: base.requirement,
        considered: Array.isArray(hunted.considered) ? hunted.considered : base.considered,
      };
    }
  }
  if (!base.pick) return base.escalate ? { escalate: base.escalate, considered: base.considered, requirement: base.requirement } : null;
  return { ...base.pick, considered: base.considered, requirement: base.requirement };
}

export function createExecutionLoop({
  conductor = null,
  reader = null,
  remote = undefined,
  fetchImpl = defaultFetch,
  benchDirUrl = BENCH_DIR_URL,
  capacity = null,
  beforeWeights = null,
  sandboxPosture = undefined,
  iterationStore = null,
  iterationSourceIndexUrl = null,
} = {}) {
  // The device's sandbox posture (Part C): measured once per loop instance and
  // memoized — the weights pick reads it as a device fact, like RAM. Injected
  // postures (a posture object, a boolean, or a function returning either) win;
  // the default is the real probe (lib/sandbox-lane.mjs probeSandboxPosture:
  // KINGMAKER_SANDBOX=off declines, Docker answers or the lane is absent with
  // its reason). A probe failure is recorded as an absent lane with the reason
  // — it never throws into a run.
  let sandboxPromise = null;
  const resolveSandbox = () => {
    if (!sandboxPromise) {
      sandboxPromise = (async () => {
        if (sandboxPosture === undefined) return probeSandboxPosture();
        const v = typeof sandboxPosture === 'function' ? await sandboxPosture() : sandboxPosture;
        return normalizeSandboxPosture(v);
      })().catch((e) => ({ available: false, declined: false, reason: `the sandbox posture probe failed (${e?.message ?? e}) — the lane is treated as absent` }));
    }
    return sandboxPromise;
  };
  // Intelligence streaming (FIX-G): the default conductor + module reader are the
  // product's library readers, and with remote enabled (the default;
  // KINGMAKER_LIBRARY_REMOTE=off — or remote: false — forces bundled-only) they are
  // built on the conductor/reader seam as designed: the Brain Library repo's
  // intelligence indexes, read through lib/brain-library-repo.mjs's readText, with
  // this tree's bundled catalog as the per-read offline floor. `remote` may be an
  // options object for the supplier ({ baseUrl, fetchImpl, intelligencePath,
  // timeoutMs }). An explicitly injected conductor/reader always wins, untouched.
  const remoteOn = remote === undefined ? libraryRemoteEnabled() : remote !== false && remote !== null;
  // Iteration reads the conducted method from the same index this loop's conductor
  // reads (the repo index when the loop builds a remote conductor; the bundled
  // catalog otherwise — iterateMethod's own default, so no override is passed) —
  // unless the caller names a source index, which is how a run conducted FROM a
  // local method store iterates the store's own file.
  let iterationReadText = null;
  let iterationIndexUrl = null;
  if (!conductor || !reader) {
    const repoOpts = remote && typeof remote === 'object' ? remote : {};
    const readText = remoteOn
      ? createRepoReadText({ ...repoOpts, fallbackCatalogUrl: new URL('../catalog/', import.meta.url) })
      : null;
    if (readText && !conductor) { iterationReadText = readText; iterationIndexUrl = repoIndexUrl('methods', repoOpts); }
    if (!conductor) conductor = remoteOn ? createMethodConductor({ indexUrl: repoIndexUrl('methods', repoOpts), readText }) : createMethodConductor();
    if (!reader) reader = remoteOn ? createModuleReader({ indexUrl: repoIndexUrl('training', repoOpts), readText }) : createModuleReader();
  }
  /** The loop reads its own framework: its method file, discovered through the conductor's library path. */
  async function describeFramework() {
    const methods = await conductor.listMethods();
    return methods.find((m) => m.id === 'execution-loop') ?? null;
  }

  async function run(request, { workDir, inputs = {}, now = Date.now(), capacityOverride = null, ramGb = null, methodHint = null, requirement = null } = {}) {
    if (!workDir) throw new Error('execution-loop: run() needs a workDir — the conducted method acts inside it and nowhere else');
    const startedAt = now instanceof Date ? now.getTime() : now;
    const trace = [];
    // The device's measured RAM: delivery planning only (which lane serves the pick). It gates nothing.
    const deviceRamGb = ramGb ?? Math.round((totalmem() / 1e9) * 10) / 10;

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
        prepSections.method = { id: null, title: null, quality: null, stepCount: 0, reason: 'the Brain Library holds no method for this pick', relevance: 0, coverageScore: 0, requiresFetchedDetails: false, weights: null, candidates };
        return prepSections.method;
      }
      const chosenRelevance = ranked.find((r) => r.method.id === chosen.id)?.relevance ?? scoreMethod(chosen, request);
      prepSections.method = { id: chosen.id, title: chosen.title, quality: chosen.quality, stepCount: chosen.stepCount, reason, relevance: chosenRelevance, coverageScore: chosenRelevance, requiresFetchedDetails: chosen.requiresFetchedDetails === true, weights: chosen.weights ?? null, candidates };
      return prepSections.method;
    };
    const sectionWeights = async () => {
      let records = await loadBenchRecords({ benchDirUrl });
      // The catalog's role/capability evidence joins the bench measurements (best effort: a
      // catalog that cannot be built here leaves the records as measured, roles unknown).
      try {
        const { buildLibrary } = await import('./brain-library.mjs');
        records = enrichRecords(records, buildLibrary().models);
      } catch { /* records stand as measured */ }
      // The requirement the selector reads: an explicit run requirement wins; else the picked
      // method's declared `weights` requirement; else the lane default for the classified task.
      let req = requirement ?? prepSections.method?.weights ?? null;
      if (!req) {
        let role = 'writer';
        try { const { classifyTask } = await import('./weight-hunter.mjs'); role = classifyTask(request) ?? 'writer'; } catch { /* the write lane is the standing default */ }
        req = { role };
      }
      const device = { ramGb: deviceRamGb, freeGb: Math.round((freemem() / 2 ** 30) * 10) / 10, sandbox: await resolveSandbox() };
      const weights = await resolveWeightsPick(records, { requirement: req, device, request, beforeWeights });
      prepSections.weights = weights;
      return prepSections.weights;
    };
    // The weights pick reads the method pick (its declared requirement), so it runs after it;
    // context-read and method-pick keep the prep mode's concurrency.
    const sections = [['context-read', sectionContext], ['method-pick', sectionMethod], ['weights-pick', sectionWeights]];
    if (prep.mode === 'parallel') { await Promise.all([sectionContext(), sectionMethod()]); await sectionWeights(); }
    else for (const [, fn] of sections) await fn();
    trace.push({ phase: 'prep', status: 'executed', detail: `prep mode ${prep.mode}: ${prep.reason}`, result: { mode: prep.mode, sections: sections.map(([n]) => n), order: 'context-read and method-pick first (concurrent in parallel mode), weights-pick after — it reads the picked method\'s declared requirement' } });
    trace.push({ phase: 'context-read', status: 'executed', detail: `governing context read via the module reader: ${prepSections.context.parts.length} part(s), ${prepSections.context.chars} chars (part files opened: ${prepSections.context.stats.partFilesRead.join(', ') || 'none'})`, result: prepSections.context });
    trace.push({ phase: 'method-pick', status: 'executed', detail: `method pick: ${prepSections.method.id} — ${prepSections.method.reason}`, result: prepSections.method });
    if (prepSections.weights?.model) {
      trace.push({ phase: 'weights-pick', status: 'executed', detail: `weights pick: ${prepSections.weights.model} — ${prepSections.weights.reason}`, result: { model: prepSections.weights.model, delivery: prepSections.weights.delivery ?? null, considered: prepSections.weights.considered } });
    } else if (prepSections.weights?.escalate) {
      trace.push({ phase: 'weights-pick', status: 'escalated', detail: `weights pick escalated: ${prepSections.weights.escalate.reason}`, result: { escalate: prepSections.weights.escalate, considered: prepSections.weights.considered } });
    } else {
      trace.push({ phase: 'weights-pick', status: 'failed', detail: 'weights pick: no measured model in the bench records is sufficient for this task\'s requirement', result: { considered: prepSections.weights?.considered ?? [] } });
    }

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
        prep, clock: null, conduction: null, iteration: null, trace,
      };
    };
    // The weights outcomes that end the run before the gate: an escalation (the task is handed
    // to another lane — not a refusal, and never a size rejection) and the no-sufficient-model
    // refusal (a catalog gap, stated as one).
    if (prepSections.weights?.escalate) {
      const esc = prepSections.weights.escalate;
      trace.push({ phase: 'weights-pick', status: 'escalated', detail: `run escalated before conduction: ${esc.reason} Lanes: ${esc.lanes.join('; ')}`, result: { escalate: esc } });
      return {
        request: String(request), refused: false, escalated: true, escalation: esc,
        requestSummary: String(request).replace(/\s+/g, ' ').trim().slice(0, 200),
        coverage, closest,
        fetched, context: prepSections.context,
        picks: { method: prepSections.method, weights: prepSections.weights },
        prep, clock: null, conduction: null, trace,
      };
    }
    if (!prepSections.weights?.model) {
      return refuse(
        'no-sufficient-weights',
        `weights gate REFUSED: no measured model in the bench records meets this task's requirement (${JSON.stringify(prepSections.weights?.requirement ?? {})}) — the smallest-sufficient selector found nothing sufficient, so no conduction runs on an unmeasured guess. Considered: ${(prepSections.weights?.considered ?? []).map((c) => `${c.model} (${c.verdict})`).join(', ') || 'no bench records'}`,
        'a model meeting the requirement, benched into catalog/bench (kingmaker models bench) and tabled in the Brain Library catalog — the same request through the same code then picks it',
      );
    }
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

    // ── 5. ITERATION (the loop's final step) ────────────────────────────────────
    // A completed conduction files its own next version (lib/method-iteration.mjs):
    // the run's effective inputs — the values that just worked — become the method
    // file's new defaults in a local method store, steps verbatim, receipt appended.
    // iterationStore: a store directory, or true for the default
    // (<state>/brain-library/methods, beside the tool registry). Off when unset.
    let iteration = null;
    if (iterationStore && conduction.status === 'completed') {
      const storeDir = iterationStore === true ? join(resolvePaths().state, 'brain-library', 'methods') : String(iterationStore);
      try {
        const sourceIndexUrl = iterationSourceIndexUrl ?? iterationIndexUrl;
        iteration = await iterateMethod({
          methodId: conduction.method.id,
          conduction,
          storeDir,
          ...(sourceIndexUrl ? { sourceIndexUrl } : {}),
          ...(iterationReadText ? { readText: iterationReadText } : {}),
          inputUpdates: conduction.inputs ?? {},
          note: `execution-loop run: ${String(request).replace(/\s+/g, ' ').trim().slice(0, 120)}`,
        });
        trace.push({ phase: 'iteration', status: 'executed', detail: `iteration: ${iteration.id} v${iteration.fromVersion} → v${iteration.toVersion} filed in the local method store (${iteration.path}) — the next conduction can read the improved file from there`, result: iteration });
      } catch (e) {
        trace.push({ phase: 'iteration', status: 'failed', detail: `iteration failed: ${String(e?.message ?? e).slice(0, 240)} — recorded; the conduction result stands`, result: { error: String(e?.message ?? e).slice(0, 240) } });
      }
    }

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
      iteration,
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
