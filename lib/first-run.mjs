// lib/first-run.mjs — the first-run tour (the owner, 2026-10-15: a "highlight the objective" walkthrough tied into the
// install, for owners who aren't technical). The installer opens Kingmaker; the first time the bar reports in, the engine
// sends it this tour and the bar draws it: the rest of the bar dimmed, one control lit, one sentence, Next or Skip.
// Three steps (OpenHuman cut its own wizard from six to three; read 2026-10-15, ideas only):
//   access  turn on the Microphone, Accessibility and Screen Recording, each with its live state and its own button
//   wake    say the wake word once (or click the microphone): the step ticks itself when Kingmaker hears it
//   first   three things to ask, one click puts one in the box
// Shown once: firstrun.json in the data folder says it was seen (finished or skipped). It comes back on asking:
// the logo's menu (Show the Tour), kingmaker://tour, or `kingmaker tour`.
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const tourPath = (state) => join(state, 'firstrun.json');

/** Things to ask on the first day: each something Kingmaker does on a stock Mac with no setup. */
export const TOUR_EXAMPLES = Object.freeze([
  'Write a thank-you note to a customer',
  'Make a flyer for a Saturday sale',
  'What can you do for my business?',
]);

/** Pure: the tour's steps, for the bar to draw. `target` names the bar control to light (null: the card alone). */
export function tourSteps({ wakeWord = 'Kingmaker', examples = TOUR_EXAMPLES } = {}) {
  const word = String(wakeWord || 'Kingmaker').trim().slice(0, 40) || 'Kingmaker';
  return [
    { id: 'access', target: 'gear', title: 'Let Kingmaker hear you and use your Mac',
      body: 'Turn these on once. macOS asks you for each; Kingmaker never turns them on by itself. You can change them later under the gear.',
      permissions: ['Microphone', 'Accessibility', 'Screen Recording'] },
    { id: 'wake', target: 'mic', title: `Say “${word}”`,
      body: `Say “${word}” out loud once, or click the microphone. Kingmaker answers when it hears its name, then listens for what you want.`,
      waitFor: 'awake' },
    { id: 'first', target: 'field', title: 'Ask for something',
      body: 'Type here, or just say it. Try one of these:', examples: examples.slice(0, 3).map((e) => String(e).slice(0, 80)) },
  ];
}

/** What firstrun.json says: { seen, how, step, at }. Missing or unreadable: not seen. */
export function readTour(state) {
  try { const j = JSON.parse(readFileSync(tourPath(state), 'utf8')); return { seen: j.seen === true, how: j.how ?? null, step: j.step ?? null, at: j.at ?? null }; }
  catch { return { seen: false, how: null, step: null, at: null }; }
}

/** The tour was finished ('done') or skipped (at `step`): it won't show by itself again. */
export function markTour(state, how = 'done', step = null, now = new Date()) {
  const rec = { seen: true, how: how === 'skipped' ? 'skipped' : 'done', step: step ? String(step).slice(0, 20) : null, at: now.toISOString() };
  mkdirSync(state, { recursive: true });
  const f = tourPath(state), tmp = `${f}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(rec)}\n`, { mode: 0o600 }); renameSync(tmp, f);
  return rec;
}

/** Forget it was seen: it shows the next time the bar reports in. */
export function resetTour(state) { rmSync(tourPath(state), { force: true }); }

/** The @@ghost message that starts the tour, or null when it was seen and nobody asked for it again. */
export function tourMessage(state, { wakeWord, force = false } = {}) {
  if (!force && readTour(state).seen) return null;
  return { tour: { steps: tourSteps({ wakeWord }), wakeWord: wakeWord || 'Kingmaker' } };
}

/** Pure: a control line from the bar → what to do: { start: force } | { done: how, step } | null. */
export function tourControl(line) {
  const m = /^tour-(check|start|done)(?:\s+(done|skipped))?(?:\s+([a-z]{1,20}))?\s*$/.exec(String(line || '').trim());
  if (!m) return null;
  if (m[1] === 'done') return { done: m[2] || 'done', step: m[3] || null };
  return { start: m[1] === 'start' };
}

export const TOUR_LINK = 'kingmaker://tour';
const openLink = (link) => new Promise((done) => execFile('/usr/bin/open', [link], (error) => done(!error)));

/** `kingmaker tour`: forget it was seen and ask the running bar to show it now (kingmaker://tour, which also starts
 *  Kingmaker when it isn't running). Tests pass their own `open`: a test never opens a real link. */
export async function tourCommand(state, { open = openLink } = {}) {
  resetTour(state);
  return (await open(TOUR_LINK)) ? 'The tour is showing in the Kingmaker bar.' : 'The tour will show the next time Kingmaker starts.';
}
