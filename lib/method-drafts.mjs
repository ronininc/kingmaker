// lib/method-drafts.mjs — method files written in the background (owner, 2026-11-11: "pipelines
// and method files being written in the background around the clock … just by learning from
// videos").
//
// An OBSERVATION is what an analysis pass saw in a piece of reference footage: the lens, where
// the camera and the key light sat, how bright the light was, the frame size. This module turns
// one observation into a DRAFT method file: the render method with those values as its dials.
//
// A draft is a proposal. It is written to a drafts folder, never into catalog/methods/, and it
// carries the status "awaiting-owner". It becomes a capability only when the owner moves it into
// the catalog. Every draft is checked before it is kept: it must parse, use only step types the
// conductor already knows, and conduct to completion in a scratch folder.
//
// The observation's free text (title, source, notes) is data: it is clipped, stripped of
// anything that could close a string or a code fence, and only ever placed in a comment-like
// `note` step and the file's prose — never in a step that writes a script.

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createMethodConductor, parseMethodFile } from './method-conductor.mjs';
import { shouldScan } from './idle-gaps.mjs';

export const DRAFT_STATUS = 'awaiting-owner';
/** The conductor's step vocabulary (lib/method-conductor.mjs). A draft using anything else is refused here first. */
export const CONDUCTOR_STEP_TYPES = Object.freeze(['inspect', 'read-json', 'read-json-dir', 'read-text', 'guard', 'evaluate-signals', 'band', 'render', 'write-json', 'append-jsonl', 'verify', 'check-tool', 'declare', 'note', 'reason']);

const DIALS = Object.freeze({
  lensMm: [10, 300, 50], cameraDistance: [0.5, 200, 9], cameraHeight: [0, 100, 2.5],
  lightX: [-100, 100, 4], lightY: [-100, 100, -4], lightZ: [0, 100, 6], lightWatts: [1, 100000, 800],
  widthPx: [64, 8192, 1280], heightPx: [64, 8192, 720], samples: [1, 4096, 32],
});
const plain = (v, max) => String(v ?? '').replace(/[`"\\{}<>]/g, '').replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, max);
const slug = (v) => plain(v, 60).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'untitled';

/** Clamp an observation's numbers to sane ranges; anything missing or not a number takes the base method's value. */
export function dialsFromObservation(observation, baseInputs = {}) {
  const look = observation?.look ?? {};
  const out = {};
  for (const [key, [min, max, fallback]] of Object.entries(DIALS)) {
    const clamp = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Math.min(max, Math.max(min, Number(v))));
    out[key] = clamp(look[key]) ?? clamp(baseInputs?.[key]) ?? fallback;
  }
  return out;
}

/** The dials the observation itself gave a usable number for. */
export function observedDialNames(observation) {
  const look = observation?.look ?? {};
  return Object.keys(DIALS).filter((key) => look[key] != null && look[key] !== '' && Number.isFinite(Number(look[key])));
}

/**
 * Build the draft's text from an observation and the base method file's text.
 * Returns { id, title, text, sha256, dials, source }.
 */
export function draftMethodFromObservation(observation, baseMethodText) {
  const base = parseMethodFile(baseMethodText);
  const title = plain(observation?.title, 80) || 'Untitled look';
  const source = plain(observation?.source?.ref ?? observation?.source, 160) || 'unknown source';
  const kind = plain(observation?.source?.kind, 24) || 'footage';
  const dials = dialsFromObservation(observation, base.inputs);
  const observed = new Set(observedDialNames(observation));
  const id = `draft-${slug(title)}-${createHash('sha256').update(JSON.stringify([title, source, dials])).digest('hex').slice(0, 8)}`;
  const notes = (Array.isArray(observation?.notes) ? observation.notes : []).map((n) => plain(n, 200)).filter(Boolean).slice(0, 8);
  const spec = {
    id, version: '0.1', title: `${title} (draft look for ${base.title})`, domain: base.domain, kind: 'draft',
    inputs: { ...base.inputs, ...dials },
    steps: [
      { n: 1, id: 'provenance', type: 'note', text: `Draft look "${title}", observed in ${kind}: ${source}. Status: ${DRAFT_STATUS}. Based on method ${base.id} v${base.version}.` },
      ...base.steps.map((s, i) => ({ ...s, n: i + 2 })),
    ],
  };
  const text = [
    `# Method draft — ${title}`, '',
    `Status: **${DRAFT_STATUS}**. Written in the background from an observation of ${kind} (${source}).`,
    `It is the "${base.title}" method with the camera, light and frame set to what was observed.`,
    'It is not in the catalog and is not used for any request until the owner moves it there.', '',
    '## Observed', '',
    ...Object.entries(dials).map(([k, v]) => `- ${k}: ${v}${observed.has(k) ? '' : ' (not observed; kept from the base method)'}`),
    ...(notes.length ? ['', '## Notes from the observation', '', ...notes.map((n) => `- ${n}`)] : []), '',
    '## Executable block', '', '```kingmaker-method', JSON.stringify(spec, null, 2), '```', '',
  ].join('\n');
  return { id, title, text, sha256: createHash('sha256').update(text).digest('hex'), dials, source: { kind, ref: source } };
}

/** A draft is kept only if it parses, uses known step types, and conducts to completion in a scratch folder. */
export async function checkDraft(draft) {
  let spec;
  try { spec = parseMethodFile(draft.text); } catch (e) { return { ok: false, reason: `does not parse: ${e.message}` }; }
  const unknown = spec.steps.filter((s) => !CONDUCTOR_STEP_TYPES.includes(s.type)).map((s) => s.type);
  if (unknown.length) return { ok: false, reason: `uses step types the conductor does not have: ${[...new Set(unknown)].join(', ')}` };
  const scratch = mkdtempSync(join(tmpdir(), 'kingmaker-draft-check-'));
  try {
    const file = `${draft.id}.method.md`;
    const index = JSON.stringify({ schema: 'kingmaker.methods/1', methods: [{ id: draft.id, file, title: draft.title, domain: spec.domain, quality: { tier: 'draft', score: 0, basis: 'draft check' } }] });
    const conductor = createMethodConductor({ indexUrl: new URL('file:///draft-check/index.json'), readText: async (loc) => (String(loc).endsWith('index.json') ? index : draft.text) });
    const result = await conductor.conduct(draft.id, { workDir: scratch });
    if (result.status !== 'completed') return { ok: false, reason: `did not conduct to completion (${result.status})` };
    return { ok: true, steps: spec.steps.length };
  } catch (e) { return { ok: false, reason: `conduction threw: ${e.message}` }; }
  finally { rmSync(scratch, { recursive: true, force: true }); }
}

/** Write a checked draft into the drafts folder and record it in drafts.json. Refuses a draft that fails its check. */
export async function writeDraft(draftsDir, draft, { now = () => new Date() } = {}) {
  const checked = await checkDraft(draft);
  if (!checked.ok) return { written: false, reason: checked.reason };
  mkdirSync(draftsDir, { recursive: true });
  const file = `${draft.id}.method.md`;
  const list = listDrafts(draftsDir);
  if (list.some((d) => d.id === draft.id)) return { written: false, reason: 'already drafted', file };
  writeFileSync(join(draftsDir, file), draft.text);
  list.push({ id: draft.id, title: draft.title, file, sha256: draft.sha256, status: DRAFT_STATUS, source: draft.source, at: now().toISOString() });
  writeFileSync(join(draftsDir, 'drafts.json'), JSON.stringify({ schema: 'kingmaker.method-drafts/1', drafts: list }, null, 2) + '\n');
  return { written: true, file, id: draft.id };
}

export function listDrafts(draftsDir) {
  try { const d = JSON.parse(readFileSync(join(draftsDir, 'drafts.json'), 'utf8')); return Array.isArray(d.drafts) ? d.drafts : []; } catch { return []; }
}

/** Observations waiting to be drafted: every *.json in the inbox folder, oldest name first. */
export function pendingObservations(inboxDir) {
  let names = []; try { names = readdirSync(inboxDir).filter((n) => n.endsWith('.json')).sort(); } catch { return []; }
  const out = [];
  for (const name of names) { try { out.push({ name, observation: JSON.parse(readFileSync(join(inboxDir, name), 'utf8')) }); } catch { /* unreadable: skipped */ } }
  return out;
}

/**
 * The background loop, on the same idle rule as lib/idle-gaps.mjs: only when the owner has been
 * away long enough and nothing is running. Each tick drafts at most `perTick` observations from
 * the inbox, moves nothing into the catalog, and leaves one note in the bar when it wrote something.
 */
export function createIdleMethodDrafts({ inboxDir, draftsDir, baseMethodText, note = async () => {}, busy = () => false, log = () => {}, now = Date.now, perTick = 3, idleMs, everyMs } = {}) {
  let lastActivity = now();
  let lastRun = null;
  let running = false;
  const done = new Set();
  const tick = async () => {
    if (running || !shouldScan({ now: now(), lastActivity, lastScan: lastRun, busy: busy(), idleMs, everyMs })) return { ran: false, written: 0 };
    running = true; lastRun = now();
    let written = 0; const refused = [];
    try {
      const text = typeof baseMethodText === 'function' ? await baseMethodText() : baseMethodText;
      for (const { name, observation } of pendingObservations(inboxDir).filter((p) => !done.has(p.name)).slice(0, perTick)) {
        done.add(name);
        const r = await writeDraft(draftsDir, draftMethodFromObservation(observation, text));
        if (r.written) written++; else if (r.reason !== 'already drafted') refused.push({ name, reason: r.reason });
      }
      log('method_drafts', { written, refused: refused.length });
      if (written) await note(`While you were away I drafted ${written} method file${written === 1 ? '' : 's'} from reference footage. They are waiting for your OK and are not in use.`);
      return { ran: true, written, refused };
    } catch (e) { log('method_drafts', { error: String(e?.message || e).slice(0, 160) }); return { ran: true, written, refused, error: String(e?.message || e) }; }
    finally { running = false; }
  };
  return { touch() { lastActivity = now(); }, tick };
}
