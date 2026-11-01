// `kingmaker enroll`: the owner's voiceprint, enrolled at a terminal the owner is typing at, never from the
// voice path, a pipe, the menu bar app or an MCP client. This console is Kingmaker's stand-in for the
// desktop's authoritative window: the engine's own install.mjs registers its guarded enrollment handlers on an
// in-process ipcMain, and only this console's event is authoritative. The voice loop gets no handlers, so it
// can never start, commit or forget an enrollment.
//
// Gate: stdin and stdout are a terminal, Kingmaker is not running (it holds the old print and would re-seal
// it), and the owner types the two words shown. Then the engine's own enrollment runs unchanged: five prompted
// sentences, each checked (too short, wrong phrase, Kingmaker's own voice, a second voice), the coherence check,
// and the sealed centroid. Only embeddings are kept, in memory, until commit; no audio is ever stored.

import { randomInt } from 'node:crypto';
import { isNonSpeech } from './voice.mjs';

const CHALLENGE_WORDS = Object.freeze(['amber', 'anchor', 'cedar', 'comet', 'copper', 'falcon', 'harbor', 'lantern', 'maple', 'meadow', 'orbit', 'otter', 'quartz', 'river', 'saddle', 'walnut']);
export const MAX_ENROLL_ATTEMPTS = 20;
/** Rejections in a row on ONE sentence before it is set aside (whisper can mishear one sentence forever). */
export const STUCK_LIMIT = 3;
export const MAX_RESTARTS = 2;

/** Two distinct words the owner must type back. */
export function challengeWords(rand = randomInt) {
  const a = rand(CHALLENGE_WORDS.length);
  let b = rand(CHALLENGE_WORDS.length - 1);
  if (b >= a) b += 1;
  return `${CHALLENGE_WORDS[a]} ${CHALLENGE_WORDS[b]}`;
}

/** Pure: may enrollment start here? Reasons in plain words; empty when it may. */
export function enrollBlockers({ stdinTTY, stdoutTTY, ghostRunningPid, micTool, sttReady, speakerReady }) {
  const out = [];
  if (!stdinTTY || !stdoutTTY) out.push('Enrollment is typed by you at a terminal. Run `kingmaker enroll` in Terminal (not from a script, a pipe or the menu bar app).');
  if (ghostRunningPid) out.push(`Kingmaker is running (pid ${ghostRunningPid}). Quit it first: it holds your old print and would seal it back.`);
  if (!micTool) out.push('No microphone tool: brew install sox');
  if (!sttReady) out.push('The bundled whisper.cpp or its model is missing from Solomon.app.');
  if (!speakerReady) out.push('The bundled speaker model (CAM++) is missing from Solomon.app.');
  return out;
}

/** Pure: why a sample was not accepted, in words the owner can act on. */
export function explainRejection(reason, heard) {
  switch (reason) {
    case 'too_short': return 'too short. Say the whole sentence at a normal pace.';
    case 'wrong_phrase': return `that didn't match the sentence (heard: "${String(heard ?? '').slice(0, 80)}").`;
    case 'matches_self': return "that sounded like Kingmaker's own voice, which can never count as you.";
    case 'inconsistent_with_prior': return "that didn't sound like your earlier samples. Same voice, same distance from the mic.";
    case 'bad_embedding': return 'the speaker model gave no voiceprint for that one. Say it again.';
    case 'narration_overlap': return 'Kingmaker was talking. Say it again.';
    default: return String(reason ?? 'not accepted');
  }
}

/**
 * In-process stand-in for Electron's ipcMain. install.mjs registers its guarded handlers here; only this
 * console's own event object passes isAuthoritativeSender.
 */
export function createConsoleIpc({ onProgress = () => {} } = {}) {
  const handlers = new Map();
  const event = Object.freeze({ sender: Object.freeze({ send: (channel, payload) => onProgress(channel, payload), isDestroyed: () => false }) });
  return {
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn), removeHandler: (channel) => handlers.delete(channel) },
    isAuthoritativeSender: (e) => e === event,
    invoke: async (channel) => {
      const fn = handlers.get(channel);
      return fn ? fn(event) : { ok: false, reason: 'NO_HANDLER' };
    },
  };
}

/**
 * The guided enrollment loop over the engine's own enrollment. Injected I/O, so it is tested without a mic.
 *   next()   → {kind:'utterance', utt:{samples, speechMs}} | {kind:'line', text} | {kind:'end'}
 *   transcribe(samples) → text;  embed(samples) → number[] | null
 * Returns {ok, reason?, sampleCount?, meanPairwise?, minPairwise?}.
 */
export async function runEnrollment({ ov, ipc, channels, next, transcribe, embed, out = () => {}, maxAttempts = MAX_ENROLL_ATTEMPTS, stuckLimit = STUCK_LIMIT, maxRestarts = MAX_RESTARTS }) {
  const started = await ipc.invoke(channels.enrollStart);
  if (!started?.ok) return { ok: false, reason: started?.reason || 'enroll_start_refused' };
  let progress = started.progress;
  let attempts = 0;
  let stuck = 0;
  let restarts = 0;
  try {
    while (progress.accepted < progress.target) {
      out(`  ${progress.accepted + 1}/${progress.target}  Say: "${progress.currentPrompt}"`);
      const got = await next();
      if (got.kind === 'end') { await ipc.invoke(channels.enrollCancel); return { ok: false, reason: 'cancelled' }; }
      if (got.kind === 'line') {
        const t = String(got.text ?? '').trim().toLowerCase();
        if (t === 'cancel' || t === ':q') { await ipc.invoke(channels.enrollCancel); return { ok: false, reason: 'cancelled' }; }
        if (t === 'done') {
          if (progress.canCommit) break;
          out(`  Need at least ${progress.minRequired} accepted samples first (${progress.accepted} so far).`);
        }
        continue;
      }
      const { samples, speechMs } = got.utt;
      let embedding = null;
      try {
        const [heard, vec] = await Promise.all([transcribe(samples), Promise.resolve(embed(samples)).catch(() => null)]);
        embedding = vec;
        // A keyboard, a cough or a door ("[typing]", "(keyboard clicking)") is not an attempt: listen again.
        if (isNonSpeech(heard)) continue;
        attempts += 1;
        const r = ov.enrollment.addSample({ embedding, speechMs, capturedDuringNarration: false, transcript: heard });
        out(r.accepted ? '     ✓ got it' : `     ✗ ${explainRejection(r.reason, heard)}`);
        stuck = r.accepted ? 0 : stuck + 1;
      } finally {
        samples?.fill?.(0);
        embedding?.fill?.(0);
      }
      progress = ov.enrollment.progress();
      if (!progress.active) return { ok: false, reason: 'enrollment_expired' };
      if (stuck >= stuckLimit) {
        // The engine keeps one sentence until it is accepted. Set a stuck one aside: finish with what it
        // already accepted (its own minimum and coherence checks still decide), or start over with new sentences.
        if (progress.canCommit) { out(`  That sentence isn't being heard right; finishing with the ${progress.accepted} accepted.`); break; }
        if (restarts >= maxRestarts) { await ipc.invoke(channels.enrollCancel); return { ok: false, reason: 'too_many_attempts' }; }
        restarts += 1; stuck = 0;
        out('  That sentence isn\'t being heard right; starting over with new sentences.');
        const again = await ipc.invoke(channels.enrollStart);
        if (!again?.ok) return { ok: false, reason: again?.reason || 'enroll_start_refused' };
        progress = again.progress;
        continue;
      }
      if (attempts >= maxAttempts && progress.accepted < progress.target) {
        if (progress.canCommit) break;
        await ipc.invoke(channels.enrollCancel);
        return { ok: false, reason: 'too_many_attempts' };
      }
    }
    const committed = await ipc.invoke(channels.enrollCommit);
    if (!committed?.ok) return { ok: false, reason: committed?.reason || 'commit_refused', meanPairwise: committed?.meanPairwise, minPairwise: committed?.minPairwise };
    return { ok: true, sampleCount: committed.sampleCount, meanPairwise: committed.meanPairwise, minPairwise: committed.minPairwise, status: committed.status };
  } catch (error) {
    try { await ipc.invoke(channels.enrollCancel); } catch { /* wiped anyway on exit */ }
    throw error;
  }
}
