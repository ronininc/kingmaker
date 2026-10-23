// light-runtime/state-schema.mjs — the one contract between Kingmaker's engine side and the light runtime's
// window (light-runtime/index.html, served by scripts/light-runtime-server.mjs).
//
// The state dir (default: this folder; the server takes KINGMAKER_LIGHT_DIR) holds three files:
//
//   control.json       — the owner's three switches, written ONLY by the surface (through the server):
//                        { proofRun: 'start' | 'stop' | null, reflex: bool, reflexPin: bool }.
//                        scripts/run-10m-proof.mjs consumes proofRun as an intent flag (it clears it back
//                        to null when it takes the job); the reflex flags are the surface-level statement
//                        of the same switches the engine reads as KINGMAKER_REFLEX / KINGMAKER_REFLEX_PIN —
//                        the env always wins on the engine side, and this file never approves anything.
//   proof-report.json  — the latest 10M token proof, written by scripts/run-10m-proof.mjs:
//                        { at, stages: [{ label, tokens, seconds, tokPerSec?, kind, source? }] } where kind
//                        is 'REAL' or 'SIMULATED'. Tiles and the verdict against the 200 tok/s target are
//                        COMPUTED here from the stages, never trusted from the report.
//   verdicts.json      — optional: the latest reflex verdicts [{ question, answer, probability, model, ms, at }].
//
// Honesty rules, enforced in the math below: a stage labeled SIMULATED counts toward the displayed totals
// but can never certify the target — with no REAL stage the verdict is UNMEASURED however fast the
// simulation ran. Rates are derived from tokens and seconds, not copied from a claim.
import { existsSync, readFileSync, renameSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

/** The proof's bar (Robbie, 2026-10-21): sustained tokens per second across the whole 10M token run. */
export const PROOF_TARGET_TOK_PER_SEC = 200;

export const CONTROL_FILE = 'control.json';
export const PROOF_REPORT_FILE = 'proof-report.json';
export const VERDICTS_FILE = 'verdicts.json';

export const STATE_SCHEMA = 1;

const round1 = (n) => Math.round(n * 10) / 10;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** A tok/s for display: whole numbers at proof scale, one decimal below 100, a dash for nothing measured. */
export const fmtTokS = (v) => (v === null || v === undefined ? '—' : v >= 100 ? String(Math.round(v)) : v.toFixed(1));

/* ---------------- control.json ---------------- */

/** The switches at rest: no run intent, both reflex switches on (their engine defaults). */
export const defaultControl = () => ({ proofRun: null, reflex: true, reflexPin: true });

/** Validate + normalize a control object. Unknown keys are dropped; wrong types are errors, never coerced. */
export function validateControl(v) {
  const errors = [];
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { ok: false, errors: ['control must be an object'], value: null };
  const value = defaultControl();
  if ('proofRun' in v) {
    if (v.proofRun === null || v.proofRun === 'start' || v.proofRun === 'stop') value.proofRun = v.proofRun;
    else errors.push(`proofRun must be 'start', 'stop' or null, got ${JSON.stringify(v.proofRun)}`);
  }
  for (const k of ['reflex', 'reflexPin']) {
    if (k in v) { if (typeof v[k] === 'boolean') value[k] = v[k]; else errors.push(`${k} must be a boolean, got ${JSON.stringify(v[k])}`); }
  }
  return { ok: errors.length === 0, errors, value: errors.length === 0 ? value : null };
}

/** The control file's current state: the default when absent, and the default (never a throw) when malformed —
 *  a corrupt switch file must not take the surface down; validateControl is where malformed is reported. */
export function readControl(dir) {
  const f = join(dir, CONTROL_FILE);
  if (!existsSync(f)) return defaultControl();
  try { return validateControl(JSON.parse(readFileSync(f, 'utf8'))).value ?? defaultControl(); } catch { return defaultControl(); }
}

/** Merge a patch over the current control and write it back (temp + rename, 0600 — the calibration.json
 *  pattern from lib/mac-profiles.mjs). An invalid patch throws with every error named. */
export function writeControl(dir, patch) {
  const next = { ...readControl(dir), ...(patch ?? {}) };
  const { ok, errors, value } = validateControl(next);
  if (!ok) throw new Error(`light-runtime control: ${errors.join('; ')}`);
  const path = join(dir, CONTROL_FILE), temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600); renameSync(temp, path);
  return value;
}

/* ---------------- proof-report.json ---------------- */

const STAGE_KINDS = new Set(['REAL', 'SIMULATED']);

/** One stage, normalized: the rate is computed from tokens/seconds when both are known (a claimed rate is
 *  only a fallback, and a stage with neither seconds nor a claimed rate carries rate null — unmeasured). */
function normalizeStage(raw, i, errors) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { errors.push(`stage ${i}: must be an object`); return null; }
  const label = typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim()
    : typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : null;
  if (!label) errors.push(`stage ${i}: a label is required`);
  if (!isNum(raw.tokens)) errors.push(`stage ${i} (${label ?? '?'}): tokens must be a number ≥ 0`);
  const kind = typeof raw.kind === 'string' ? raw.kind.trim().toUpperCase() : null;
  if (!STAGE_KINDS.has(kind)) errors.push(`stage ${i} (${label ?? '?'}): kind must be REAL or SIMULATED`);
  const seconds = isNum(raw.seconds) && raw.seconds > 0 ? raw.seconds : null;
  const claimed = isNum(raw.tokPerSec) ? raw.tokPerSec : isNum(raw.tokS) ? raw.tokS : null;
  const tokPerSec = seconds !== null && isNum(raw.tokens) ? round1(raw.tokens / seconds) : claimed;
  if (errors.length) return null;
  return {
    id: typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : `stage-${i + 1}`,
    label, tokens: raw.tokens, seconds, tokPerSec, kind,
    source: typeof raw.source === 'string' && raw.source.trim() ? raw.source.trim() : null,
  };
}

/** Validate + normalize a proof report. The value keeps only the stages and the run time — tiles are
 *  computed by computeTiles, so a report can never inflate its own verdict. */
export function validateProofReport(v) {
  const errors = [];
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { ok: false, errors: ['proof report must be an object'], value: null };
  if (!Array.isArray(v.stages) || v.stages.length === 0) errors.push('proof report needs a non-empty stages array');
  const stages = [];
  if (Array.isArray(v.stages)) v.stages.forEach((s, i) => { const n = normalizeStage(s, i, errors); if (n) stages.push(n); });
  if (errors.length) return { ok: false, errors, value: null };
  return { ok: true, errors, value: { at: typeof v.at === 'string' ? v.at : null, stages } };
}

/** The four tiles, computed: the total, the sustained rate over the whole run (total tokens over total
 *  seconds — the rate the 200 target judges), the peak stage rate, and the write share (decode's share of
 *  every token the meter counted: generated / (generated + prompt)). A tile with nothing behind it is null. */
export function computeTiles(stages, meter = null) {
  const totalTokens = stages.reduce((s, x) => s + x.tokens, 0);
  const totalSeconds = stages.reduce((s, x) => s + (x.seconds ?? 0), 0);
  const sustainedTokPerSec = totalSeconds > 0 ? round1(totalTokens / totalSeconds) : null;
  const rates = stages.map((x) => x.tokPerSec ?? (x.seconds > 0 ? round1(x.tokens / x.seconds) : null)).filter((r) => r !== null);
  const peakTokPerSec = rates.length ? Math.max(...rates) : null;
  const g = meter?.generated, p = meter?.prompt;
  const writeSharePct = isNum(g) && isNum(p) && g + p > 0 ? round1((g / (g + p)) * 100) : null;
  return { totalTokens, sustainedTokPerSec, peakTokPerSec, writeSharePct };
}

/** The verdict against the target. UNMEASURED unless at least one REAL stage carried tokens — a simulated
 *  run, however fast, proves nothing about the machine. */
export function targetState(stages, tiles, target = PROOF_TARGET_TOK_PER_SEC) {
  const measured = stages.some((s) => s.kind === 'REAL' && s.tokens > 0);
  if (!measured || tiles.sustainedTokPerSec === null) return 'UNMEASURED';
  return tiles.sustainedTokPerSec >= target ? 'PASS' : 'FAIL';
}

/* ---------------- verdicts.json ---------------- */

/** The latest reflex verdicts, normalized for the wall: non-objects dropped, fields nulled when absent,
 *  newest kept last, capped at 12 — the wall is a glance, not the audit chain. */
export function normalizeVerdicts(v) {
  if (!Array.isArray(v)) return [];
  return v.filter((x) => x && typeof x === 'object' && !Array.isArray(x)).slice(-12).map((x) => ({
    question: typeof x.question === 'string' ? x.question : null,
    answer: typeof x.answer === 'string' ? x.answer : null,
    probability: isNum(x.probability) ? x.probability : null,
    model: typeof x.model === 'string' ? x.model : null,
    ms: isNum(x.ms) ? x.ms : null,
    at: typeof x.at === 'string' ? x.at : null,
  }));
}

/* ---------------- the assembled state ---------------- */

/**
 * Pure: assemble the canonical state the window renders. Inputs are the tree's own shapes:
 *   meter    — lib/token-meter.mjs meterSnapshot() ({ decodeTokS, prefillTokS, generated, prompt, since }),
 *              or a totals-only read of the metrics log ({ generated, prompt } — rates null);
 *   profile  — lib/mac-profiles.mjs currentProfile();
 *   seatPlan — lib/reflex-seat.mjs reflexSeatPlan();
 *   report   — the RAW proof report (validated here; a malformed one surfaces as proofError, never a crash);
 *   reflexOn / pinOn — the effective switches (the surface's control resolved against the engine's env by
 *              the caller — env wins there, exactly as lib/reflex-layer.mjs and lib/reflex-seat.mjs rule).
 */
export function assembleState({ meter = null, profile = null, seatPlan = null, report = null, verdicts = null, control = null, reflexOn = true, pinOn = true, now = new Date() } = {}) {
  let proof = null, proofError = null;
  if (report !== null && report !== undefined) {
    const v = validateProofReport(report);
    if (!v.ok) proofError = v.errors.join('; ');
    else {
      const tiles = computeTiles(v.value.stages, meter);
      proof = {
        at: v.value.at, stages: v.value.stages, tiles,
        target: { tokPerSec: PROOF_TARGET_TOK_PER_SEC, state: targetState(v.value.stages, tiles) },
        simulated: v.value.stages.some((s) => s.kind === 'SIMULATED'),
        measured: v.value.stages.some((s) => s.kind === 'REAL' && s.tokens > 0),
      };
    }
  }
  const state = {
    schema: STATE_SCHEMA,
    generatedAt: now.toISOString(),
    machine: profile ? {
      class: profile.class, label: profile.label, chip: profile.mac?.chip ?? null,
      ramGb: profile.mac?.ramGb ?? null, model: profile.mac?.model ?? null,
      concurrent: profile.concurrent, context: profile.context, maxResidentGb: profile.maxResidentGb,
      gpuBudgetGb: Number.isFinite(profile.gpuBudgetGb) ? profile.gpuBudgetGb : null,
      voice: profile.voice, imageLane: profile.imageLane, basis: profile.basis ?? null,
    } : null,
    seats: profile ? ['router', 'writer', 'coder', 'vision', 'reasoning'].map((role) => ({ role, model: profile[role] ?? null })) : [],
    seatPlan: seatPlan ? {
      active: Boolean(seatPlan.active), model: seatPlan.model ?? null, seatGb: seatPlan.seatGb ?? null,
      workerGb: seatPlan.workerGb ?? null, pairGb: seatPlan.pairGb ?? null, budgetGb: seatPlan.budgetGb ?? null,
      maxLoadedModels: seatPlan.maxLoadedModels ?? null, reason: seatPlan.reason ?? null,
    } : null,
    reflex: { enabled: Boolean(reflexOn), pinEnabled: Boolean(pinOn) },
    meter: meter ? {
      decodeTokS: meter.decodeTokS ?? null, prefillTokS: meter.prefillTokS ?? null,
      generated: meter.generated ?? null, prompt: meter.prompt ?? null, since: meter.since ?? null,
    } : null,
    proof, proofError,
    verdicts: normalizeVerdicts(verdicts),
    control: validateControl(control ?? defaultControl()).value ?? defaultControl(),
  };
  return { ...state, pill: pillText(state) };
}

/** The title bar's one number. With a measured proof it is the sustained rate against the target; a
 *  simulated-only run says so instead of borrowing the verdict; with no proof it falls back to the reflex. */
export function pillText(state) {
  const t = state?.proof?.target;
  if (state?.proof && t) {
    if (t.state === 'PASS' || t.state === 'FAIL') return `PROOF · ${fmtTokS(state.proof.tiles.sustainedTokPerSec)} T/S · TARGET ${t.tokPerSec}`;
    if (state.proof.tiles.sustainedTokPerSec !== null) return `PROOF · SIMULATED · TARGET ${t.tokPerSec}`;
    return `PROOF · UNMEASURED · TARGET ${t.tokPerSec}`;
  }
  return state?.reflex?.enabled ? 'REFLEX ONLINE' : 'REFLEX OFF';
}

/** Validate an assembled state (consumers and tests): the shape the window depends on, nothing looser. */
export function validateState(state) {
  const errors = [];
  if (!state || typeof state !== 'object' || Array.isArray(state)) return { ok: false, errors: ['state must be an object'] };
  if (state.schema !== STATE_SCHEMA) errors.push(`schema must be ${STATE_SCHEMA}`);
  if (typeof state.generatedAt !== 'string' || Number.isNaN(Date.parse(state.generatedAt))) errors.push('generatedAt must be an ISO time');
  if (typeof state.pill !== 'string' || !state.pill) errors.push('pill must be a non-empty string');
  if (!state.reflex || typeof state.reflex.enabled !== 'boolean' || typeof state.reflex.pinEnabled !== 'boolean') errors.push('reflex.enabled and reflex.pinEnabled must be booleans');
  if (!Array.isArray(state.seats)) errors.push('seats must be an array');
  if (!Array.isArray(state.verdicts)) errors.push('verdicts must be an array');
  const cv = validateControl(state.control); if (!cv.ok) errors.push(...cv.errors.map((e) => `control: ${e}`));
  if (state.proof !== null && state.proof !== undefined) {
    const tiles = state.proof.tiles ?? {};
    if (!isNum(tiles.totalTokens)) errors.push('proof.tiles.totalTokens must be a number ≥ 0');
    if (!['PASS', 'FAIL', 'UNMEASURED'].includes(state.proof.target?.state)) errors.push('proof.target.state must be PASS, FAIL or UNMEASURED');
    for (const [i, s] of (state.proof.stages ?? []).entries()) {
      if (!STAGE_KINDS.has(s.kind)) errors.push(`proof stage ${i}: kind must be REAL or SIMULATED`);
      if (!isNum(s.tokens)) errors.push(`proof stage ${i}: tokens must be a number ≥ 0`);
    }
  }
  return { ok: errors.length === 0, errors };
}
