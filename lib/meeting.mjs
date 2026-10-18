// MEETING HOLD: the owner's calls come first (operator 2026-10-13: Discord meetings need intelligible,
// uninterrupted audio and video). While a hold is on, paced background work (knowledge index/extract, builds,
// device scans) is paused, never killed, and no new heavy stage starts. It is the owner's switch, set and cleared
// explicitly (`kingmaker meeting on [minutes] | off | status`), and it expires by itself so it can never stick.
// Nothing here listens to, records or inspects a call; it is only a dated flag in Kingmaker's own state dir.
// Automatic call detection is deliberately not guessed: it needs measured call-quality evidence first.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolvePaths } from './paths.mjs';

export const MEETING_DEFAULT_MINUTES = 90;
export const MEETING_MAX_MINUTES = 240;
export const MEETING_RECHECK_MS = 5_000;

export const meetingHoldPath = (paths) => join(paths.state, 'meeting-hold.json');

export function setMeetingHold(paths, { minutes = MEETING_DEFAULT_MINUTES, now = Date.now() } = {}) {
  const m = Math.round(Number(minutes));
  if (!Number.isFinite(m) || m < 1 || m > MEETING_MAX_MINUTES) throw new Error(`minutes must be 1–${MEETING_MAX_MINUTES}`);
  const file = meetingHoldPath(paths), hold = { since: new Date(now).toISOString(), until: new Date(now + m * 60_000).toISOString(), set_by: 'owner' };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file + '.tmp', JSON.stringify(hold)); renameSync(file + '.tmp', file);
  return hold;
}

export function clearMeetingHold(paths) { rmSync(meetingHoldPath(paths), { force: true }); }

/** A deferred task rechecks every five seconds at most, so an explicit `meeting off` releases it promptly without a
 * filesystem watcher or busy loop. The minimum avoids spinning around a just-expired timestamp. */
export function meetingRetryDelay(hold, now = Date.now(), maxPollMs = MEETING_RECHECK_MS) {
  const until = Date.parse(hold?.until ?? '');
  const remaining = Number.isFinite(until) ? until - now + 10_000 : maxPollMs;
  return Math.max(1_000, Math.min(maxPollMs, remaining));
}

/** After a heavy task reports deferred-meeting, poll only the tiny hold file. The expensive task is invoked once,
 * after release; it is never re-entered on each five-second check. Returns a cancellation function. */
export function pollMeetingRelease({ readHold, onRelease, signal, setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now } = {}) {
  let timer = null;
  const check = () => {
    timer = null;
    if (signal?.aborted) return;
    const hold = readHold();
    if (!hold?.active) { onRelease(); return; }
    timer = setTimer(check, meetingRetryDelay(hold, now()));
    timer?.unref?.();
  };
  check();
  return () => { if (timer) clearTimer(timer); timer = null; };
}

/** { active, since, until }: an expired or unreadable hold is inactive (fail open to normal pacing, never stuck). */
export function meetingHold(paths, now = Date.now()) {
  try {
    const file = meetingHoldPath(paths);
    if (!existsSync(file)) return { active: false };
    const h = JSON.parse(readFileSync(file, 'utf8'));
    const until = Date.parse(h.until);
    if (!Number.isFinite(until) || until <= now) return { active: false, expired: h.until };
    // The bound holds on read too: a hand-edited or clock-skewed file can never hold work past MEETING_MAX_MINUTES.
    if (until - now > MEETING_MAX_MINUTES * 60_000) return { active: false, invalid: true };
    return { active: true, since: h.since, until: h.until };
  } catch { return { active: false }; }
}

/** The reader the live pacer samples: this install's own state dir, resolved once. */
export function defaultMeetingHoldReader(env = process.env) {
  let paths = null;
  return () => {
    try { paths ??= resolvePaths(env); return meetingHold(paths).active; } catch { return false; }
  };
}
