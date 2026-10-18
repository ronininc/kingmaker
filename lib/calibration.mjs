// lib/calibration.mjs — Customize: the owner calibrates each of Kingmaker's functions (the owner, 2026-10-15: "a customize
// button … where a user goes in to mess with their calibration and weights so they can customize functions"). Each
// function runs on model weights the owner picks and is tuned by a few numbers; everything lives in one file in the data
// folder (calibration.json, 0600), read again on every turn, so a change applies to the next turn with no restart.
// Unknown keys are dropped and every number is clamped, so a hand-edited file can never break a turn. Actions keep their
// gates whatever is set here: nothing in calibration can make a send, a payment or a record change skip its approval.
import { chmodSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultRouter } from './fast-route.mjs';
import { classSetting } from './mac-profiles.mjs';

export const CALIBRATION_FILE = 'calibration.json';
const TAG = /^[\w.-]+(\/[\w.-]+){0,2}(:[\w.-]+)?$/;
/** Customize → Mac profile: auto, or one of lib/mac-profiles.mjs CLASSES (kept literal here: no import cycle). */
const PROFILE_CHOICES = [['auto', 'Auto: this Mac\'s RAM and chip'], ['8', '8 GB standard'], ['16', '16 GB'], ['24', '24 GB'], ['32', '32 GB'], ['48', '48 GB'], ['64', '64 GB and up']]
  .map(([value, label]) => ({ value, label }));

/** What each function is, its controls and its defaults: the Customize screen is drawn from this. */
export const FUNCTIONS = Object.freeze([
  // The Mac profile (lib/mac-profiles.mjs): the models, context and limits for this Mac's class, picked from its RAM and
  // chip. The Customize screen shows the live profile under it (withProfile).
  { id: 'macProfile', name: 'Mac profile', what: 'Which models, context and memory limits this Mac runs. Auto reads its RAM and chip; a class above this Mac\'s own may swap.',
    controls: [{ key: 'profile', kind: 'choice', label: 'Profile', default: 'auto', options: PROFILE_CHOICES }] },
  { id: 'router', name: 'Router', what: 'Gives every request its lane (write, act, open, image, look up) before anything runs.',
    controls: [
      { key: 'governanceSpine', kind: 'choice', label: 'Governance spine', default: 'custom',
        options: [{ value: 'custom', label: 'Custom' }, { value: 'kingmaker-x-heretic', label: 'Kingmaker x Heretic 😈' }] },
      { key: 'model', kind: 'model', label: 'Model', default: defaultRouter() }] },
  // The writer's MODEL is the bar's picker (Auto, or a pinned model): it lives there only, never twice.
  { id: 'writer', name: 'Writer', what: 'Answers in words: drafts, summaries, ideas, rewrites. Its model is the picker at the bottom right of the bar.',
    controls: [{ key: 'temperature', kind: 'number', label: 'Temperature (steady ↔ creative)', default: 0.7, min: 0, max: 1.5, step: 0.1 },
      { key: 'context', kind: 'number', label: 'Context (tokens it reads)', default: classSetting('context') ?? 8192, min: 2048, max: 10000000, step: 2048 }] },
  { id: 'followUp', name: 'Follow-up memory', what: '"Make it shorter" or "the second one" goes back to the last written answer for this long.',
    controls: [{ key: 'minutes', kind: 'number', label: 'Minutes', default: 10, min: 0, max: 120, step: 1 }] },
  { id: 'suggest', name: 'Next command', what: 'The suggestion in the empty box after an answer (Tab takes it).',
    controls: [{ key: 'on', kind: 'switch', label: 'On', default: true },
      { key: 'governanceSpine', kind: 'choice', label: 'Governance spine', default: 'custom',
        options: [{ value: 'custom', label: 'Custom' }, { value: 'kingmaker-x-heretic', label: 'Kingmaker x Heretic 😈' }] },
      { key: 'model', kind: 'model', label: 'Model', default: defaultRouter() }] },
  { id: 'crmJobs', name: 'Work requests → CRM jobs', what: '"Make an ad", "write the proposal": a job on the connected CRM\'s board. Off: the writer does it here.',
    controls: [{ key: 'on', kind: 'switch', label: 'On', default: true }] },
  { id: 'idleGaps', name: 'Close capability gaps while idle', what: 'While you are away, what Kingmaker could not do becomes a proposal or starts being built. Turning it on is always yours.',
    controls: [{ key: 'on', kind: 'switch', label: 'On', default: true },
      { key: 'idleMinutes', kind: 'number', label: 'After idle (minutes)', default: 10, min: 2, max: 240, step: 1 },
      { key: 'everyMinutes', kind: 'number', label: 'At most every (minutes)', default: 60, min: 10, max: 1440, step: 10 }] },
  { id: 'sources', name: 'Sources under answers', what: 'How many source links an answer lists in the bar.',
    controls: [{ key: 'max', kind: 'number', label: 'Most links', default: 8, min: 0, max: 20, step: 1 }] },
]);

/** Pure: the defaults, as { functionId: { key: value } }. */
export function defaults() {
  return Object.fromEntries(FUNCTIONS.map((f) => [f.id, Object.fromEntries(f.controls.map((c) => [c.key, c.default]))]));
}

/** Pure: any object → a valid calibration (unknown keys dropped, numbers clamped and stepped, bad models back to default). */
export function normalize(input) {
  const out = defaults();
  const src = input && typeof input === 'object' ? input : {};
  for (const f of FUNCTIONS) {
    const given = src[f.id] && typeof src[f.id] === 'object' ? src[f.id] : {};
    for (const c of f.controls) {
      const v = given[c.key];
      if (v === undefined) continue;
      if (c.kind === 'switch') out[f.id][c.key] = v === true || v === 'on';
      else if (c.kind === 'choice') { const s = String(v).trim(); if (c.options.some((o) => o.value === s)) out[f.id][c.key] = s; }
      else if (c.kind === 'model') { const s = String(v).trim(); if (s.length <= 160 && TAG.test(s)) out[f.id][c.key] = s; }
      else if (c.kind === 'number') {
        const n = Number(v);
        if (Number.isFinite(n)) { const stepped = Math.round(n / c.step) * c.step; out[f.id][c.key] = Number(Math.min(c.max, Math.max(c.min, stepped)).toFixed(2)); }
      }
    }
  }
  return out;
}

/** Pure: the functions with the live Mac profile written under "Mac profile" (what the Customize screen draws). */
export function withProfile(functions, line) {
  return functions.map((f) => (f.id === 'macProfile' && line ? { ...f, what: `${f.what}\nNow: ${line}` } : f));
}

export function readCalibration(stateDir) {
  try { return normalize(JSON.parse(readFileSync(join(stateDir, CALIBRATION_FILE), 'utf8'))); } catch { return defaults(); }
}

/** Save (normalized, atomically, 0600) and return what was saved. */
export function writeCalibration(stateDir, value) {
  const v = normalize(value);
  const path = join(stateDir, CALIBRATION_FILE), temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ schema: 1, ...v }, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600); renameSync(temp, path);
  return v;
}
