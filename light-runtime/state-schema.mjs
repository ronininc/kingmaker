// light-runtime/state-schema.mjs — the canonical state of the light runtime's window (the design of
// 2026-10-21: an evidence wall in a window, claims carrying sources). scripts/light-runtime-server.mjs
// assembles the inputs live from the tree's own sources — this Mac's profile (lib/mac-profiles.mjs), the
// reflex seat plan (lib/reflex-seat.mjs), the token meter's own log (lib/token-meter.mjs), and this state
// dir's proof-report.json + verdicts.json + control.json — and assembleState renders them into the ONE
// shape light-runtime/index.html draws.
//
// Honesty is the schema's job: every input is allowed to be absent, and an absent source renders as
// nulls and UNMEASURED — never as an invented number, a guessed verdict, or a decorative claim.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const LIGHT_STATE_SCHEMA = 'kingmaker.light-state/1';
export const CONTROL_FILE = 'control.json';
export const PROOF_REPORT_FILE = 'proof-report.json';
export const VERDICTS_FILE = 'verdicts.json';

/** The owner's three switches and their resting state: the proof is not armed, the reflex layer and its
 *  seat pin are. writeControl below is the only writer, and it holds this shape exactly. */
export const CONTROL_DEFAULTS = Object.freeze({ proofRun: false, reflex: true, reflexPin: true });
export const CONTROL_KEYS = Object.freeze(Object.keys(CONTROL_DEFAULTS));

const boolOr = (v, dflt) => (typeof v === 'boolean' ? v : dflt);

/** The control as it stands in `dir` (defaults where the file or a key is absent or not a boolean). */
export function readControl(dir) {
  if (!dir) return { ...CONTROL_DEFAULTS };
  let raw = null;
  try { raw = JSON.parse(readFileSync(join(dir, CONTROL_FILE), 'utf8')); } catch { raw = null; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...CONTROL_DEFAULTS };
  return {
    proofRun: boolOr(raw.proofRun, CONTROL_DEFAULTS.proofRun),
    reflex: boolOr(raw.reflex, CONTROL_DEFAULTS.reflex),
    reflexPin: boolOr(raw.reflexPin, CONTROL_DEFAULTS.reflexPin),
  };
}

/**
 * Patch the control in `dir` and return the result. Only the three switches exist; a patch naming
 * anything else, or setting a non-boolean, throws (the server answers 400) — a switch is never
 * half-written, and this file is the ONLY write the light runtime ever performs.
 */
export function writeControl(dir, patch = {}) {
  if (!dir) throw new Error('writeControl: a state dir is required');
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (!CONTROL_KEYS.includes(k)) throw new Error(`writeControl: "${k}" is not a light-runtime switch`);
    if (typeof v !== 'boolean') throw new Error(`writeControl: "${k}" must be true or false`);
  }
  const next = { ...readControl(dir), ...patch };
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${CONTROL_FILE}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(next, null, 1)}\n`);
  renameSync(tmp, join(dir, CONTROL_FILE));
  return next;
}

const isoOrNull = (v) => {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const numOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const strOrNull = (v) => (typeof v === 'string' && v.length > 0 ? v : null);

/** One verdict entry (from verdicts.json, any of its shapes) → one evidence card, or null when the entry
 *  carries nothing sayable. `marker` names the one line that carries the proof; it is kept only when it
 *  appears in the body verbatim, so the page's highlighter never invents emphasis. */
function toCard(entry, i, sourceFile) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const body = strOrNull(entry.body ?? entry.text ?? entry.detail ?? entry.summary ?? entry.verdict ?? entry.status);
  if (!body) return null;
  const marker = strOrNull(entry.marker ?? entry.highlight);
  return {
    n: i + 1,
    at: isoOrNull(entry.at ?? entry.time ?? entry.ts ?? entry.date ?? null),
    label: String(entry.label ?? entry.title ?? entry.name ?? 'VERDICT').toUpperCase(),
    body,
    source: `${String(entry.source ?? sourceFile).toUpperCase()}${entry.date || entry.at ? ` · ${String(entry.date ?? entry.at).slice(0, 10)}` : ''}`,
    marker: marker && body.includes(marker) ? marker : null,
  };
}

/** The evidence cards: the proof report's verdict first (it is the headline), then the verdicts file. */
function evidenceCards(report, verdicts) {
  const cards = [];
  const verdict = report?.verdict && typeof report.verdict === 'object' ? report.verdict : null;
  if (verdict && (verdict.status || verdict.arithmetic)) {
    cards.push({
      n: 1,
      at: isoOrNull(report.finishedAt ?? report.generatedAt ?? report.at ?? null),
      label: '10M PROOF · VERDICT',
      body: [verdict.status ? `Status: ${String(verdict.status).toUpperCase()}` : null, verdict.arithmetic ?? null].filter(Boolean).join(' — '),
      source: `${PROOF_REPORT_FILE.toUpperCase()}${report.finishedAt || report.generatedAt ? ` · ${String(report.finishedAt ?? report.generatedAt).slice(0, 10)}` : ''}`,
      marker: verdict.status ? `Status: ${String(verdict.status).toUpperCase()}` : null,
    });
  }
  const list = Array.isArray(verdicts) ? verdicts
    : Array.isArray(verdicts?.cards) ? verdicts.cards
      : Array.isArray(verdicts?.entries) ? verdicts.entries
        : Array.isArray(verdicts?.verdicts) ? verdicts.verdicts : [];
  for (const entry of list) {
    const card = toCard(entry, cards.length, VERDICTS_FILE);
    if (card) cards.push(card);
  }
  return cards;
}

/** The ticker tiles: heavy value on top, one-word label under. An absent source stamps UNMEASURED. */
function tickerTiles({ meter, seatPlan, report }) {
  const tiles = [];
  tiles.push(meter?.decodeTokS != null
    ? { value: `${Math.round(meter.decodeTokS)} TOK/S`, label: 'DECODE' }
    : { value: 'UNMEASURED', label: 'DECODE' });
  tiles.push(meter?.generated != null
    ? { value: Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(meter.generated), label: 'GENERATED' }
    : { value: 'UNMEASURED', label: 'GENERATED' });
  tiles.push(seatPlan
    ? seatPlan.active
      ? { value: `${seatPlan.pairGb} GB`, label: 'REFLEX PAIR' }
      : { value: 'NOT PINNED', label: 'REFLEX SEAT' }
    : { value: 'UNMEASURED', label: 'REFLEX SEAT' });
  const status = report?.verdict?.status;
  tiles.push({ value: status ? String(status).toUpperCase() : 'UNRUN', label: '10M PROOF' });
  return tiles;
}

/**
 * The canonical state. Inputs are the server's live assemblies; every one may be null.
 *   meter:    lib/token-meter.mjs's snapshot or its log totals ({ decodeTokS, prefillTokS, generated, prompt, since }; rates may be null)
 *   profile:  lib/mac-profiles.mjs's currentProfile for this Mac
 *   seatPlan: lib/reflex-seat.mjs's reflexSeatPlan for that profile
 *   report:   this state dir's proof-report.json, parsed (the 10-minute proof's own report)
 *   verdicts: this state dir's verdicts.json, parsed (array or { cards|entries|verdicts: [...] })
 *   control:  readControl's shape
 *   reflexOn / pinOn: the two reflex switches AS THEY STAND (control × env kill switches, resolved by the server)
 */
export function assembleState({ meter = null, profile = null, seatPlan = null, report = null, verdicts = null, control = null, reflexOn = false, pinOn = false, now = new Date() } = {}) {
  const ctl = { ...CONTROL_DEFAULTS, ...(control ?? {}) };
  const seatActive = Boolean(seatPlan?.active);
  const pill = !reflexOn ? 'REFLEX OFF · GOVERNED PATH'
    : seatActive && seatPlan?.model ? `REFLEX ONLINE · ${String(seatPlan.model).toUpperCase()}`
      : 'REFLEX ONLINE';
  return {
    schema: LIGHT_STATE_SCHEMA,
    surface: 'LIGHT RUNTIME',
    generatedAt: isoOrNull(now) ?? new Date().toISOString(),
    status: { pill, reflexOn: Boolean(reflexOn), pinOn: Boolean(pinOn), seatActive },
    machine: profile ? {
      label: strOrNull(profile.label),
      chip: strOrNull(profile.mac?.chip ?? null),
      model: strOrNull(profile.mac?.model ?? null),
      ramGb: numOrNull(profile.mac?.ramGb ?? null),
      classGb: numOrNull(profile.class),
      writerTokSEstimate: numOrNull(profile.writerTokSEstimate),
    } : null,
    meter: {
      measured: Boolean(meter && (meter.decodeTokS != null || meter.generated != null)),
      decodeTokS: numOrNull(meter?.decodeTokS),
      prefillTokS: numOrNull(meter?.prefillTokS),
      generated: numOrNull(meter?.generated),
      prompt: numOrNull(meter?.prompt),
      since: isoOrNull(meter?.since),
    },
    router: profile ? {
      writer: strOrNull(profile.writer), router: strOrNull(profile.router), coder: strOrNull(profile.coder),
      vision: strOrNull(profile.vision), reasoning: strOrNull(profile.reasoning),
      context: numOrNull(profile.context), concurrent: numOrNull(profile.concurrent),
      maxResidentGb: numOrNull(profile.maxResidentGb),
      seat: seatPlan ? {
        active: seatActive, model: strOrNull(seatPlan.model), reason: strOrNull(seatPlan.reason),
        seatGb: numOrNull(seatPlan.seatGb), workerGb: numOrNull(seatPlan.workerGb),
        pairGb: numOrNull(seatPlan.pairGb), budgetGb: numOrNull(seatPlan.budgetGb),
      } : null,
    } : null,
    evidence: evidenceCards(report, verdicts),
    tiles: tickerTiles({ meter, seatPlan, report }),
    proof: report?.verdict && typeof report.verdict === 'object'
      ? { status: strOrNull(report.verdict.status), arithmetic: strOrNull(report.verdict.arithmetic) }
      : null,
    control: { proofRun: Boolean(ctl.proofRun), reflex: Boolean(ctl.reflex), reflexPin: Boolean(ctl.reflexPin) },
    files: { control: CONTROL_FILE, proofReport: PROOF_REPORT_FILE, verdicts: VERDICTS_FILE },
  };
}
