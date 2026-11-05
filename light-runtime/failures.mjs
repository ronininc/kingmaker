// light-runtime/failures.mjs — THE TURN REGISTRY (Robbie's ruling 2026-10-28): every failed turn
// registers in the browser, with its reason on the card. What happened before this module: his
// news question went in BY VOICE through the bar, the turn died at the bar's 90 s timeout, and
// the wall — which only ever rendered its own ask-box submissions — showed machinery stats
// (how long the engine "thought") while the product's actual failure appeared nowhere. An
// evidence wall that shows everything except what went wrong is not an evidence wall.
//
// THE SEAM — why bar.log: the registry is built from the engine's own transcript,
// <engineState>/logs/bar.log, the one durable record every owner surface writes to: typed bar
// turns, the app window's turns ("You (said):" — the shell writes its conversation-surface
// turns under that marker whether they were typed in its window or spoken; the marker does
// not distinguish keyboard from microphone, so the registry does not claim to either),
// console turns in self-held mode, phone turns, and job turns (the wall's own native asks
// ride the same queue — lib/job-inbox.mjs parses this file for exactly that reason). Each
// turn's question line AND the engine's spoken outcome line are in it, verbatim — including
// its failure speech ("That didn't work: …", lib/cli.mjs) and its guardrail held line. This
// is also what makes a BROWSER-TYPED ask's failure recoverable: the settle lives in the
// engine's record, so the card lands even when the asking client aborted at its own timeout
// or is gone entirely. The alternatives were weighed and found thinner:
//   • the turn feed (/api/conversation/feed) is live-only and in-memory — it carries phases,
//     not a durable outcome record, and dies with the engine process;
//   • the server log's turn-timing records carry phases and totals but no question text and
//     no failure reason — they ENRICH a card here (where the recorded time went), never source it;
//   • voice-turns.jsonl is reachable only through an env path the light server is never given.
// The registry reads the tail of bar.log and of logs/server.log (the timing join). Rotated logs
// (server.prev.log) are out of scope: the registry covers the current logs' retained tails, and
// a turn older than the tail is absent — absent, never reconstructed.
//
// THE ANSWERED RECONCILIATION (2026-10-28, second occurrence): the bar session settles a turn
// on its CLIENT-side wait — at 90 s it speaks "That didn't work: The operation was aborted due
// to timeout" into the transcript while the governed turn is still running server-side, and
// the turn then completes (tonight: 123 s). The transcript alone therefore convicts a turn
// that actually answered. The wall's ask router captures the engine turn feed's terminal
// 'answered' event for its own asks (ask.mjs's feedOutcome) — when the server hands such a
// reconciled ask to listFailures as `answered` (same words, inside the ask's own window), a
// matching FAILED transcript turn is suppressed: the feed is the engine's own record of the
// turn's outcome, and it outranks the bar session's timeout speech. Conservative by
// construction: only 'failed' turns can be suppressed this way (a held turn was held, an
// unanswered turn has no outcome line to contradict), only on an exact text + window match,
// and only for asks the feed itself settled — a turn with no live ask record (the wall
// restarted, the record evicted) still registers from the transcript alone, as before.
//
// THE COMPLETION RECONCILIATION (2026-10-28, the registry's second defect): afc6c79's seam
// covered only the wall's own feed-settled asks, and the parser locked a turn's outcome on
// its FIRST outcome line. Two completion records now close the rest of the gap:
//   • IN the transcript: the bar session speaks the timeout line at its 90 s client wait,
//     the governed turn completes server-side, and the engine writes the answer into
//     bar.log AFTER the failure line, inside the same turn. parseBarTurns treats a
//     substantive answer line (or a Sources delivery line) after a failure/held line as
//     the turn's completion — outcome 'answered', the failure line kept as superseded.
//   • FROM the caller: server.mjs hands EVERY ask view that settled 'done' (feed-settled
//     or inbox-settled alike) to listFailures as a completion record (`completed`, with
//     `answered` kept for the feed-settled subset) — a done ask card and a FAILED registry
//     card for the same turn can no longer coexist.
// A turn with NEITHER record — the timeout line and nothing after it, no live ask — is a
// truly timed-out turn and still registers FAILED, exactly as before.
//
// THE HONEST-ABSENCE RULE: a turn whose question was never answered and never explained — the
// engine moved on to a later question without a word — registers FAILED with
// reasonRecorded: false and reason: null; the card prints "reason not recorded". A cause is
// never invented. The log's LAST turn is never judged unanswered: it may still be running.
import { createHash } from 'node:crypto';
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { isGuardrailHeldAnswer } from './proposals.mjs';

export const FAILURE_SCHEMA = 'kingmaker.light-failure/1';
const KEEP_FAILURES = 20;
const BAR_TAIL_BYTES = 512 * 1024;    // the recent tail of the transcript — turns, not archaeology
const LOG_TAIL_BYTES = 1024 * 1024;   // timing records are one JSON line per turn

// The engine's failure speech, as a transcript line of its own: the bar session says exactly
// "That didn't work: <reason>" when a turn dies (lib/cli.mjs), and governed lanes return the
// same form. Anchored at the line's start so an answer merely QUOTING the phrase is not a failure.
export const FAILURE_LINE = /^That didn't work\b/;

/** Pure: bar.log's text → its turns, in order. Line grammar (the app/session transcript):
 *  "<iso> You: <text>" / "<iso> You (said): <text>" opens a turn; "<iso> Kingmaker: <line>" is
 *  the engine speaking; "Sources:"/"note:" lines ride along but never decide an outcome. */
export function parseBarTurns(text) {
  const turns = [];
  let cur = null;
  for (const raw of String(text || '').split('\n')) {
    const m = /^(\S+) (You(?: \(said\))?|Kingmaker|Sources|note): (.*)$/.exec(raw);
    if (!m) continue;
    const atMs = Date.parse(m[1]);
    if (!Number.isFinite(atMs)) continue;
    if (m[2].startsWith('You')) {
      cur = {
        atMs, at: new Date(atMs).toISOString(),
        // 'bar' = a typed "You:" line; 'window' = the app conversation window's "You (said):"
        // line — typed in the window or spoken, the transcript does not say which.
        surface: m[2].includes('(said)') ? 'window' : 'bar',
        text: m[3], kingLines: [], outcomeAtMs: null, outcomeLine: null, outcome: 'open',
        failureLine: null, supersededLine: null,
      };
      turns.push(cur);
      continue;
    }
    if (!cur) continue;
    if (m[2] === 'Sources') {
      // A Sources line is part of an answer's delivery (the job inbox reads it as answer
      // text): a turn that was spoken a failure line and then delivered its sources DID
      // complete — the transcript's own completion record, below.
      if (cur.outcome === 'failed' || cur.outcome === 'held') {
        cur.supersededLine = cur.outcomeLine;
        cur.outcome = 'answered'; cur.outcomeLine = m[3]; cur.outcomeAtMs = atMs;
      }
      continue;
    }
    if (m[2] !== 'Kingmaker') continue;
    cur.kingLines.push(m[3]);
    if (FAILURE_LINE.test(m[3])) {
      if (cur.outcome === 'open') { cur.outcome = 'failed'; cur.outcomeLine = m[3]; cur.outcomeAtMs = atMs; }
      cur.failureLine ??= m[3];
    } else if (isGuardrailHeldAnswer(m[3])) {
      if (cur.outcome === 'open') { cur.outcome = 'held'; cur.outcomeLine = m[3]; cur.outcomeAtMs = atMs; }
    } else if (cur.outcome === 'failed' || cur.outcome === 'held') {
      // THE TRANSCRIPT COMPLETION RECORD (2026-10-28, second registry defect): the bar
      // session spoke its client-side timeout line at 90 s, and the governed turn then
      // completed server-side and its answer was written into this same transcript,
      // after the failure line, before the next question. The first outcome line no
      // longer decides the turn: a substantive answer line after it IS the turn's
      // completion, recorded by the engine itself. The superseded failure line is kept
      // on the turn (supersededLine) — the timeout really was spoken — but the turn is
      // answered, and an answered turn never registers as a failure.
      cur.supersededLine = cur.outcomeLine;
      cur.outcome = 'answered'; cur.outcomeLine = m[3]; cur.outcomeAtMs = atMs;
    } else if (!cur.outcomeLine) {
      cur.outcomeLine = m[3]; cur.outcomeAtMs = atMs;
    }
  }
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    if (t.outcome !== 'open') continue;
    if (t.kingLines.length) { t.outcome = 'answered'; continue; }
    // No word back. If a LATER question exists, the engine moved on without answering this
    // one — a completed failure with no recorded reason. The last turn stays 'open': it may
    // still be running, and an in-flight turn is not a failure.
    t.outcome = i < turns.length - 1 ? 'unanswered' : 'open';
  }
  return turns;
}

/** Pure: the server log's text → its governed-turn timing records (the enrichment source):
 *  one JSON line per governed turn, context 'turn-timing', with the phase table in meta. */
export function parseTurnTiming(text) {
  const out = [];
  for (const raw of String(text || '').split('\n')) {
    if (!raw.includes('"turn-timing"')) continue;
    let r; try { r = JSON.parse(raw); } catch { continue; }
    if (r?.context !== 'turn-timing' || !String(r?.message || '').startsWith('governed-turn')) continue;
    const endMs = Date.parse(r.ts);
    const totalMs = Number(r?.meta?.totalMs);
    if (!Number.isFinite(endMs) || !Number.isFinite(totalMs)) continue;
    let slowest = null;
    for (const p of Array.isArray(r?.meta?.phases) ? r.meta.phases : []) {
      if (typeof p?.ms === 'number' && (!slowest || p.ms > slowest.ms)) slowest = { phase: String(p.phase || ''), ms: p.ms };
    }
    out.push({ endMs, totalMs, startMs: endMs - totalMs, route: r?.meta?.route ?? null, slowest });
  }
  return out;
}

/** Plain language for a recorded phase name — the record's own name when no plain form is
 *  known, never a dressed-up guess. 'pre-frontier' is the step the 2026-10-28 post-mortem
 *  proved: the governed turn's awaited memory-palace fold (the memory-filing step) sat in
 *  front of the answering brain for that phase's whole 120 s. */
export const PHASE_GLOSS = {
  'pre-frontier': 'the memory-filing step before the answering brain',
  'pre-comms': 'preparing the reply for delivery',
  'enrichment': 'gathering context for the answer',
  'knowledge-retrieval': 'looking up recorded knowledge',
  'memory-palace-recall': 'recalling from memory',
  'pre-knowledge': 'checking what is already known',
  'semantic-planner': 'planning the answer',
  'semantic-input-guard': 'the input safety check',
  'pre-input-guard': 'the input safety check',
  'pre-governed-turn': 'setting up the turn',
  'governed-turn': 'the governed turn itself',
  'frontier-and-narration': 'the answering brain composing the reply',
  'route-dispatch': 'handing the question to its engine',
  'runtime-request': 'calling the engine runtime',
  'pre-answer-lane': 'choosing the answering lane',
  'pre-operator-plan': 'planning the operator steps',
  'operator-plan': 'planning the operator steps',
  'post-processing': 'finishing the reply',
};
export const phaseGloss = (phase) => PHASE_GLOSS[phase] || `the ${phase} step`;

const secs = (ms) => `${(ms / 1000).toFixed(1)} s`;
/** The card's timing gloss: only what the joined timing record itself says. */
function timingGloss(rec) {
  if (!rec?.slowest?.phase) return null;
  return `Where the recorded time went: ${phaseGloss(rec.slowest.phase)} took ${secs(rec.slowest.ms)} of the turn's recorded ${secs(rec.totalMs)}.`;
}

/** The timing record that belongs to one bar turn: its start lands on the question (bar
 *  timestamps carry one-second precision; the record's start is endMs − totalMs). Nearest
 *  start wins; a record that starts before the previous turn's question is never claimed. */
function joinTiming(turn, records) {
  let best = null;
  for (const r of records) {
    if (r.startMs < turn.atMs - 2000 || r.startMs > turn.atMs + 15000) continue;
    if (!best || Math.abs(r.startMs - turn.atMs) < Math.abs(best.startMs - turn.atMs)) best = r;
  }
  return best;
}

const normText = (s) => String(s || '').replace(/\s+/g, ' ').trim();
/** A bar turn the wall already carries as its own ask card (same words, inside the ask's own
 *  window) is not registered twice — the ask card is that turn's card, reason included. */
function isKnownTurn(turn, exclude) {
  return (exclude || []).some((x) => x && normText(x.text) === normText(turn.text)
    && turn.atMs >= (x.submittedAtMs ?? Infinity) - 5000
    && turn.atMs <= (x.endedAtMs ?? x.submittedAtMs ?? 0) + 90000);
}

/** One registered failure as the wall renders it: self-contained — question, state, the
 *  engine's reason verbatim, the timing — so a screenshot of the card explains the failure. */
export function failureView(turn, timingRec) {
  const held = turn.outcome === 'held';
  // outcomeLine is the engine's spoken line as the transcript recorded it (the line grammar
  // already split the "Kingmaker:" speaker tag off) — carried verbatim, never paraphrased.
  const reason = turn.outcomeLine ?? null;
  return {
    schema: FAILURE_SCHEMA, ok: false,
    id: `fail_${createHash('sha256').update(`${turn.atMs}|${turn.text}`).digest('base64url').slice(0, 16)}`,
    state: held ? 'held' : 'failed',
    surface: turn.surface,
    text: turn.text,
    // failed → the engine's "That didn't work: …" line, verbatim; held → its held line,
    // verbatim; unanswered → null, and the card says the reason was not recorded.
    reason, reasonRecorded: Boolean(reason),
    ...(held ? { heldReason: 'Held by the engine’s input guardrail (REQUIRE_REVIEW) before reasoning. No proposal exists for this hold — nothing can approve it; the release is a restated ask the rails pass.' } : {}),
    gloss: timingRec ? timingGloss(timingRec) : null,
    slowestPhase: timingRec?.slowest?.phase ?? null,
    turnMs: turn.outcomeAtMs != null ? turn.outcomeAtMs - turn.atMs : null,
    recordMs: timingRec?.totalMs ?? null,
    route: timingRec?.route ?? null,
    submittedAt: turn.at,
    endedAt: turn.outcomeAtMs != null ? new Date(turn.outcomeAtMs).toISOString() : null,
    source: 'bar.log — the engine’s own transcript of its bar, window and console turns'
      + (timingRec ? '; turn timing from the engine’s server log' : ''),
  };
}

/** The registry's file reads (injectable): the tail of one file, first partial line dropped. */
export function readTail(file, bytes) {
  let fd;
  try { fd = openSync(file, 'r'); } catch { return ''; }
  try {
    const size = fstatSync(fd).size;
    const from = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - from);
    readSync(fd, buf, 0, buf.length, from);
    const text = buf.toString('utf8');
    return from > 0 ? text.slice(text.indexOf('\n') + 1) : text;
  } catch { return ''; } finally { try { closeSync(fd); } catch { /* already closed */ } }
}

/**
 * The registry: one instance per light server. `readBarLog` / `readServerLog` replace the
 * file reads (tests); `engineStateDir` is the engine's state dir (where logs/ lives).
 */
export function createFailureRegistry({ engineStateDir = null, readBarLog = null, readServerLog = null } = {}) {
  const barText = readBarLog ?? (() => (engineStateDir ? readTail(join(engineStateDir, 'logs', 'bar.log'), BAR_TAIL_BYTES) : ''));
  const logText = readServerLog ?? (() => (engineStateDir ? readTail(join(engineStateDir, 'logs', 'server.log'), LOG_TAIL_BYTES) : ''));
  function listFailures({ exclude = [], answered = [], completed = [] } = {}) {
    const turns = parseBarTurns(barText());
    const bad = turns.filter((t) => t.outcome === 'failed' || t.outcome === 'held' || t.outcome === 'unanswered');
    if (!bad.length) return [];
    const records = parseTurnTiming(logText());
    return bad
      .filter((t) => !isKnownTurn(t, exclude))
      // The answered/completed reconciliation: a FAILED transcript turn that a completion
      // record covers (the caller's reconciled ask records — `answered` for feed-settled
      // asks, `completed` for asks the job inbox settled with a real answer) is not a
      // failure — the bar line was the client-side timeout, not the turn's outcome.
      // Failed only: held and unanswered turns are never suppressed by a completion
      // record. Turns whose completion is recorded IN the transcript itself never reach
      // this filter at all — parseBarTurns already settled them 'answered'.
      .filter((t) => t.outcome !== 'failed' || (!isKnownTurn(t, answered) && !isKnownTurn(t, completed)))
      .slice(-KEEP_FAILURES).reverse()
      .map((t) => failureView(t, (t.outcome === 'failed' || t.outcome === 'held') ? joinTiming(t, records) : null));
  }
  return { listFailures };
}
