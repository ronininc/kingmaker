import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setMeetingHold, clearMeetingHold, meetingHold, meetingRetryDelay, pollMeetingRelease, MEETING_MAX_MINUTES, MEETING_RECHECK_MS } from '../lib/meeting.mjs';
import { nextDuty, pacerFor, MIN_DUTY } from '../lib/pacer.mjs';
import { cooperativePacer } from '../lib/device-scan.mjs';

const paths = () => ({ state: mkdtempSync(join(tmpdir(), 'km-meet-')) });
const calm = { pressureLevel: 'normal', pagingBytesPerSecond: 0, thermal: 'nominal', cpuIdle: 0.9 };

test('the hold is the owner\'s explicit, bounded switch and expires by itself', () => {
  const p = paths(), t0 = Date.parse('2026-10-13T18:00:00Z');
  assert.equal(meetingHold(p, t0).active, false);
  const h = setMeetingHold(p, { minutes: 60, now: t0 });
  assert.equal(meetingHold(p, t0 + 59 * 60_000).active, true);
  assert.equal(meetingHold(p, t0 + 61 * 60_000).active, false, 'never sticks past its window');
  assert.equal(h.set_by, 'owner');
  assert.throws(() => setMeetingHold(p, { minutes: MEETING_MAX_MINUTES + 1 }), /minutes/);
  assert.throws(() => setMeetingHold(p, { minutes: 0 }), /minutes/);
  setMeetingHold(p, { minutes: 30, now: t0 }); clearMeetingHold(p);
  assert.equal(meetingHold(p, t0).active, false);
});

test('pacer: a meeting pauses the job (duty 0), then it ramps back gently, not to full speed at once', () => {
  assert.deepEqual(nextDuty(1, { ...calm, meeting: true }), { duty: 0, congested: true, why: 'owner meeting: background paused' });
  const after = nextDuty(0, { ...calm, meeting: false });
  assert.equal(after.duty, 0.1);
  assert.ok(after.duty < 1);
});

test('pacer: during a hold the process group stays SIGSTOPped and stop() always leaves it running', () => {
  const sent = []; let emit; const timers = [];
  const pacer = pacerFor(4242, {
    source: { subscribe: (fn) => { emit = fn; return () => {}; } },
    signal: (id, sig) => sent.push(sig), setTimer: (fn) => { timers.push(fn); return {}; }, clearTimer: () => {},
  });
  pacer.start();
  emit({ ...calm, meeting: true });
  timers.shift()?.(); // next period: the hold keeps it paused
  assert.equal(pacer.paused, true);
  assert.ok(sent.includes('SIGSTOP'));
  assert.ok(!sent.includes('SIGKILL') && !sent.includes('SIGTERM'), 'a meeting never kills work');
  pacer.stop();
  assert.equal(sent.at(-1), 'SIGCONT');
});

test('cooperative scans rest at the maximum during a hold instead of dividing by zero', async () => {
  let emit; const slept = [];
  const p = cooperativePacer({ source: { subscribe: (fn) => { emit = fn; return () => {}; } }, sleep: async (ms) => { slept.push(ms); emit({ ...calm, meeting: false }); }, maxSleepMs: 5000 });
  emit({ ...calm, meeting: true });
  assert.equal(await p.step(100), 5900, 'five seconds held, then a gentle 10% duty-cycle ramp');
  assert.deepEqual(slept, [5000, 900]);
  p.stop();
  assert.ok(MIN_DUTY > 0);
});

test('a deferred task polls the hold so meeting off wakes it before the original expiry', () => {
  const now = Date.parse('2026-10-13T18:00:00Z');
  assert.equal(meetingRetryDelay({ until: '2026-10-13T22:00:00Z' }, now), MEETING_RECHECK_MS);
  assert.equal(meetingRetryDelay({ until: '2026-10-13T18:00:05Z' }, now), MEETING_RECHECK_MS);
  assert.equal(meetingRetryDelay({ until: '2026-10-13T17:59:50Z' }, now), 1_000, 'an expired hold does not spin');
});

test('meeting polling performs no repeated knowledge work and releases it exactly once', () => {
  const timers = []; let holdReads = 0; let knowledgeRuns = 0;
  pollMeetingRelease({
    readHold: () => ({ active: ++holdReads < 4, until: '2026-10-13T22:00:00Z' }),
    onRelease: () => { knowledgeRuns += 1; },
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return { unref() {} }; },
    clearTimer: () => {},
    // A fixed clock inside the hold: with the real one, this test broke once 2026-10-13T22:00Z passed.
    now: () => Date.parse('2026-10-13T18:00:00Z'),
  });
  assert.equal(knowledgeRuns, 0);
  for (let i = 0; i < 3; i += 1) {
    const timer = timers.shift();
    assert.equal(timer.ms, MEETING_RECHECK_MS);
    timer.fn();
    assert.equal(knowledgeRuns, i === 2 ? 1 : 0, 'provisioning stays idle until the hold clears');
  }
  assert.equal(holdReads, 4);
  assert.equal(timers.length, 0);
});

test('a hand-edited or clock-skewed hold beyond the bound is ignored on read', async () => {
  const { writeFileSync } = await import('node:fs');
  const p = paths(), t0 = Date.parse('2026-10-13T18:00:00Z');
  writeFileSync(join(p.state, 'meeting-hold.json'), JSON.stringify({ since: '2026-10-13T18:00:00Z', until: '2030-01-01T00:00:00Z', set_by: 'owner' }));
  assert.deepEqual(meetingHold(p, t0), { active: false, invalid: true });
  writeFileSync(join(p.state, 'meeting-hold.json'), '{not json');
  assert.equal(meetingHold(p, t0).active, false);
});

test('a pacer resumes its group if Kingmaker exits mid-hold', () => {
  const sent = []; let emit;
  const pacer = pacerFor(4343, { source: { subscribe: (fn) => { emit = fn; return () => {}; } }, signal: (id, sig) => sent.push(sig), setTimer: () => ({}), clearTimer: () => {} });
  pacer.start();
  emit({ ...calm, meeting: true });
  process.emit('exit', 0);
  assert.equal(sent.at(-1), 'SIGCONT');
  pacer.stop();
  assert.equal(process.listenerCount('exit') >= 0, true);
});
