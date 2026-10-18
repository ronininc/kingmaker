import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDLE_MS, SCAN_EVERY_MS, createIdleGaps, scanLine, shouldScan } from '../lib/idle-gaps.mjs';

test('it scans only after 10 idle minutes, never mid-turn, at most once an hour', () => {
  const t0 = 1_000_000;
  assert.equal(shouldScan({ now: t0 + IDLE_MS - 1, lastActivity: t0 }), false);
  assert.equal(shouldScan({ now: t0 + IDLE_MS, lastActivity: t0 }), true);
  assert.equal(shouldScan({ now: t0 + IDLE_MS, lastActivity: t0, busy: true }), false);
  assert.equal(shouldScan({ now: t0 + IDLE_MS, lastActivity: t0, lastScan: t0 + IDLE_MS - 60_000 }), false);
  assert.equal(shouldScan({ now: t0 + SCAN_EVERY_MS + IDLE_MS, lastActivity: t0, lastScan: t0 }), true);
});

test('the note says what moved, names the gaps, and stays silent when nothing did', () => {
  assert.equal(scanLine({ outcomes: [] }), null);
  assert.equal(scanLine({ outcomes: [{ gap: { capabilityKey: 'x' }, skippedReason: 'already registered' }] }), null);
  const line = scanLine({ outcomes: [
    { gap: { capabilityKey: 'pdf_merge' }, proposal: { id: 'p1' }, acquisitionStarted: true },
    { gap: { capabilityKey: 'calendar-sync' }, proposal: { id: 'p2' }, acquisitionStarted: false },
    { gap: { capabilityKey: 'x' }, skippedReason: 'risk' },
  ] });
  assert.match(line, /worked on 2 capability gaps \(pdf merge, calendar sync\): 1 being built now, 1 proposed for your OK; 1 left alone/);
  assert.match(line, /only turns on when you say so/);
});

test('the loop: a turn resets the clock; one scan at a time; a failed scan is logged, not spoken', async () => {
  let t = 0; const notes = []; const logs = []; let calls = 0;
  const idle = createIdleGaps({
    now: () => t, note: async (l) => notes.push(l), log: (e, d) => logs.push(d),
    scan: async () => { calls++; return { ok: true, json: { outcomes: [{ gap: { capabilityKey: 'a' }, proposal: {}, acquisitionStarted: false }] } }; },
  });
  t = IDLE_MS - 1; assert.equal(await idle.tick(), false);
  idle.touch(); t += IDLE_MS; assert.equal(await idle.tick(), true);
  assert.equal(calls, 1); assert.equal(notes.length, 1);
  t += 60_000; assert.equal(await idle.tick(), false, 'not again within the hour');
  let tb = 0;
  const broken = createIdleGaps({ now: () => tb, note: async (l) => notes.push(l), log: (e, d) => logs.push(d), scan: async () => { throw new Error('down'); } });
  tb = IDLE_MS; assert.equal(await broken.tick(), true);
  assert.equal(notes.length, 1, 'nothing shown for a failed scan');
  assert.equal(logs.at(-1).ok, false);
});
