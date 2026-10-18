import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { markTour, readTour, resetTour, TOUR_LINK, tourCommand, tourControl, tourMessage, tourPath, tourSteps } from '../lib/first-run.mjs';

const place = () => mkdtempSync(join(tmpdir(), 'km-tour-'));

test('the tour is three steps: permissions, the wake word, a first thing to ask', () => {
  const steps = tourSteps({ wakeWord: 'Atlas' });
  assert.deepEqual(steps.map((s) => [s.id, s.target]), [['access', 'gear'], ['wake', 'mic'], ['first', 'field']]);
  assert.deepEqual(steps[0].permissions, ['Microphone', 'Accessibility', 'Screen Recording']);
  assert.match(steps[1].title, /Atlas/); assert.match(steps[1].body, /Say “Atlas”/); assert.equal(steps[1].waitFor, 'awake');
  assert.equal(steps[2].examples.length, 3);
  for (const s of steps) assert.ok(s.title.length <= 60 && s.body.length <= 220, `${s.id} reads in one breath`);
  assert.match(tourSteps({ wakeWord: '' })[1].title, /Kingmaker/, 'no wake word set: its own name');
});

test('shown once: seen after it is finished or skipped, and back when asked for', () => {
  const d = place();
  try {
    assert.equal(readTour(d).seen, false);
    assert.ok(tourMessage(d, { wakeWord: 'Atlas' }).tour.steps.length === 3, 'a new install gets it');
    markTour(d, 'skipped', 'wake', new Date('2026-10-15T00:00:00Z'));
    assert.deepEqual(readTour(d), { seen: true, how: 'skipped', step: 'wake', at: '2026-10-15T00:00:00.000Z' });
    assert.equal(statSync(tourPath(d)).mode & 0o777, 0o600);
    assert.equal(tourMessage(d, {}), null, 'not again by itself');
    assert.ok(tourMessage(d, { force: true }), 'but whenever the owner asks');
    resetTour(d); assert.equal(readTour(d).seen, false);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('the bar\'s control lines: check, start, done', () => {
  assert.deepEqual(tourControl('tour-check'), { start: false });
  assert.deepEqual(tourControl('tour-start'), { start: true });
  assert.deepEqual(tourControl('tour-done done first'), { done: 'done', step: 'first' });
  assert.deepEqual(tourControl('tour-done skipped access'), { done: 'skipped', step: 'access' });
  assert.equal(tourControl('tour-done hacked; rm -rf'), null);
  assert.equal(tourControl('tourist'), null);
});

test('`kingmaker tour` forgets it was seen and asks the bar for it (a stubbed opener: no real link opens)', async () => {
  const d = place();
  try {
    markTour(d, 'done');
    const opened = [];
    assert.match(await tourCommand(d, { open: async (l) => { opened.push(l); return true; } }), /showing in the Kingmaker bar/);
    assert.deepEqual(opened, [TOUR_LINK]); assert.equal(readTour(d).seen, false);
    assert.match(await tourCommand(d, { open: async () => false }), /next time Kingmaker starts/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('the phone app has its own first-open tour: once per phone, its three controls real, its script valid', async () => {
  const { PREVIEW_PAGES } = await import('../lib/phone-companion.mjs');
  const page = PREVIEW_PAGES.app();
  for (const id of ['tour', 'tourHole', 'tourCard', 'tourNext', 'tourSkip', 'f', 'callB', 'allowB', 'loc']) assert.match(page, new RegExp(`id="${id}"`), id);
  assert.match(page, /localStorage\.km_tour==='1'/, 'remembered on the phone');
  assert.match(page, /\[\?&\]tour\\b/, 'and shown again with ?tour');
  for (const [, code] of page.matchAll(/<script>([\s\S]*?)<\/script>/g)) assert.doesNotThrow(() => new Function(code), 'every script on the page parses');
});
