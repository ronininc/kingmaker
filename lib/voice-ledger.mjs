// THE VOICE TURN LEDGER: one line per spoken turn in <userData>/voice-turns.jsonl, the same file and record the
// desktop app writes (its voice-turn recorder and main-process sink). The engine's self-assessment reads it
// through SOLOMON_VOICE_TURNS_PATH to judge voice by real completed
// turns. Kingmaker sets that path for its core (profile.mjs) and its voice loop appends here, so "is voice
// working" is answered from what actually happened, not left UNREPORTED.
//
// PRIVACY (the recorder's own invariant): LENGTHS of the transcript and the answer, never their words, never audio.

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const VOICE_TURNS_FILE = 'voice-turns.jsonl';
/** The server's window: the last 50 decisive (completed / failed) turns. */
export const VOICE_TURN_WINDOW = 50;
/** The furthest states a Kingmaker voice turn can reach, in the window app's progression names. */
const COMPLETED_STATES = ['WAKE_ACCEPTED', 'TRANSCRIBING', 'SUBMITTING_GOVERNED_TURN', 'SPEAKING'];
const FAILED_STATES = ['WAKE_ACCEPTED', 'TRANSCRIBING', 'SUBMITTING_GOVERNED_TURN'];

export function voiceTurnsPath(paths) {
  return join(paths.userData, VOICE_TURNS_FILE);
}

/**
 * Pure: one ledger line in the window app's shape. `turn` = {seq, startedAtMs, endedAtMs, outcome
 * ('completed' | 'failed' | 'aborted'), reason, route, disposition, transcriptChars, answerChars, internetUsed,
 * spoke}.
 */
export function voiceTurnRecord(turn, { version = '', pid = process.pid } = {}) {
  const outcome = ['completed', 'failed', 'aborted', 'stalled'].includes(turn.outcome) ? turn.outcome : 'failed';
  const events = outcome === 'completed' ? COMPLETED_STATES : FAILED_STATES;
  const reached = events[events.length - 1];
  const startedAtMs = Number(turn.startedAtMs) || Date.now();
  return {
    turn: Number(turn.seq) || 0,
    startedAtMs,
    durationMs: Math.max(0, (Number(turn.endedAtMs) || startedAtMs) - startedAtMs),
    outcome,
    reachedState: reached,
    endedAt: reached,
    stalledAt: outcome === 'completed' ? null : reached,
    reason: turn.reason ? String(turn.reason).slice(0, 120) : null,
    route: turn.route ? String(turn.route).slice(0, 120) : null,
    internetUsed: turn.internetUsed === true,
    transcriptChars: Math.max(0, Number(turn.transcriptChars) || 0),
    answerChars: Math.max(0, Number(turn.answerChars) || 0),
    disposition: turn.disposition ? String(turn.disposition).slice(0, 80) : null,
    speechRuntimes: turn.spoke ? ['macos-say'] : [],
    // `say` exiting is not proof the line was audible; only the window app's playback confirms that.
    audiblePlaybackConfirmed: false,
    events,
    processId: pid,
    appVersion: version ? `sol-ghost ${version}` : 'sol-ghost',
    surface: 'sol-ghost',
    startedAt: new Date(startedAtMs).toISOString(),
  };
}

/** Appends one record per finished voice turn. Observation only: a write failure never touches the turn. */
export function createVoiceTurnLedger({ path, version = '', append = appendFileSync, mkdir = mkdirSync, now = Date.now }) {
  let seq = 0;
  return {
    path,
    record(turn) {
      seq += 1;
      const record = voiceTurnRecord({ seq, endedAtMs: now(), ...turn }, { version });
      try {
        mkdir(dirname(path), { recursive: true, mode: 0o700 });
        append(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
      } catch { return null; }
      return record;
    },
  };
}

/** Pure: the server's tally (voice-turn-ledger.ts tallyVoiceTurns): the window is over decisive turns only. */
export function tallyVoiceTurns(text, window = VOICE_TURN_WINDOW) {
  const records = [];
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    try { const r = JSON.parse(line); if (r && typeof r === 'object') records.push(r); } catch { /* torn line */ }
  }
  const outcomeOf = (r) => String(r.outcome ?? '').toLowerCase();
  const aborted = records.filter((r) => outcomeOf(r) === 'aborted').length;
  const decisive = records.filter((r) => ['completed', 'failed', 'stalled'].includes(outcomeOf(r)));
  const recent = window > 0 ? decisive.slice(-window) : decisive;
  let completed = 0; let failed = 0;
  for (const r of recent) { if (outcomeOf(r) === 'completed') completed += 1; else failed += 1; }
  return { total: recent.length, completed, failed, aborted };
}

export function readVoiceTurnTally(path, read = (p) => readFileSync(p, 'utf8')) {
  try { return tallyVoiceTurns(read(path)); } catch { return tallyVoiceTurns(''); }
}
