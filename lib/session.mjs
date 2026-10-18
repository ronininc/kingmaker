// The owner session: the one place that holds the launch nonce. It is Kingmaker's equivalent of the
// desktop's authoritative window — a terminal you are sitting at. Typed lines from THIS terminal carry the
// nonce (operator_typed); `kingmaker say` from other shells and MCP clients never do, so they can only
// propose.
//
// VOICE: SOL_GHOST_VOICE_AUTHORITY (or `kingmaker voice`), Kingmaker's own rule; the engine's verified-owner
// rule is the engine's.
//   owner (default)  What Kingmaker hears while AWAKE is the owner's word, the same as typing it here: text +
//                    the nonce. It runs GREEN commands, proposals wait for a spoken or typed yes, and RED still
//                    needs its two challenge words ("confirm <words>"). Waking it ("ghost, wake up") is the only
//                    gate, so anything audible while it is awake has that authority.
//   verified         Opt-in, with a voiceprint enrolled (kingmaker enroll): a spoken turn goes as voice with only
//                    its own solvox2 attestation (minted for its exact text), never the nonce. The engine makes it
//                    owner_voice only when the enrolled owner said it live; anyone else can ask but not act.
//   propose          Spoken turns are a local program's (text, no nonce): propose-only; approvals typed.

import { cancelProposal, claimFeatureWatchAnnouncements, confirmProposal, pendingProposals, streamBackgroundTasks, streamControlEvents, streamFeatureWatch, turn } from './client.mjs';
import { asksToAnnounce, claimedLine, createTaskAnnouncer, followStream } from './announcements.mjs';
import { DESKTOP_NONCE_HEADER, VOICE_ATTESTATION_HEADER } from './profile.mjs';
import { browseTarget, describeBrowse, describeLinks, describeWall, evidenceLinks, evidenceTargets, openDesktopWall } from './evidence.mjs';
import { speak } from './voice.mjs';

const YES = /^(y|yes|yeah|yep|yup|go|go ahead|yes,? go ahead|do it|confirm|approve|approved|ok|okay)[.!]?$/i;
const NO = /^(n|no|nope|cancel|stop|don'?t|never mind|nevermind)[.!]?$/i;

/** Pure: what a typed console line is. */
export function classifyLine(line) {
  const t = String(line ?? '').trim();
  if (!t) return 'empty';
  if (/^:(q|quit|exit)$/i.test(t)) return 'quit';
  if (/^:(help|h|\?)$/i.test(t)) return 'help';
  if (/^:(pending|p)$/i.test(t)) return 'pending';
  if (/^:keys?(?:\s|$)/i.test(t)) return 'key';
  if (/^:craft(?:\s|$)/i.test(t)) return 'craft';
  if (YES.test(t)) return 'yes';
  if (NO.test(t)) return 'no';
  return 'text';
}

/** Pure: the provider word after `:key` ('' lists the providers). */
export function keyArg(line) {
  return String(line ?? '').trim().replace(/^:keys?\s*/i, '').trim();
}

/** Pure: a `key_handoff.console` event the owner console can act on (an operator's full view, never a redacted stub). */
export function consoleKeyHandoff(frame) {
  // The control stream sends the whole event ({ type, tenantId, at, data }); the handoff is its data.
  const data = frame && typeof frame === 'object' && frame.data && typeof frame.data === 'object' && !('handoffId' in frame) ? frame.data : frame;
  if (!data || typeof data !== 'object' || data.redacted) return null;
  return typeof data.handoffId === 'string' && typeof data.keyPageUrl === 'string' && typeof data.label === 'string' ? data : null;
}

/** Pure: the newest pending proposal (the one a bare yes/no refers to). */
export function newestPending(proposals) {
  return [...(proposals ?? [])].filter((p) => p && p.status === 'PENDING').sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0] ?? null;
}

/** The voice authorities, default first. */
export const VOICE_AUTHORITIES = Object.freeze(['owner', 'verified', 'propose']);

/**
 * Pure: how a turn goes over the wire. Typed here → text + the nonce. Spoken: 'owner' → text + the nonce;
 * 'propose' → text with no nonce (a local program); 'verified' → mode 'voice' with only its own attestation,
 * so the engine decides from the voiceprint (owner_voice, or unverified voice that can ask but not act).
 */
export function turnWire({ owner = false, mode = 'text', voiceAuthority = 'owner' } = {}) {
  if (mode === 'voice') {
    return voiceAuthority === 'verified'
      ? { mode: 'voice', owner: false, spoken: true, attested: true }
      : { mode: 'text', owner: voiceAuthority === 'owner', spoken: true };
  }
  return { mode, owner: owner === true, spoken: false };
}

/** SOL_GHOST_VOICE_AUTHORITY wins, then the saved choice (`kingmaker voice`), then 'owner'. Pure. */
export function resolveVoiceAuthority(env = process.env, saved = '') {
  const pick = (v) => { const t = String(v ?? '').trim().toLowerCase(); return VOICE_AUTHORITIES.includes(t) ? t : null; };
  return pick(env.SOL_GHOST_VOICE_AUTHORITY) ?? pick(saved) ?? 'owner';
}

/**
 * Pure: the headers of one turn. The console nonce, or a solvox2 attestation, never both: an attestation on
 * a text turn would make the engine judge it as voice (principal-verifier rule a), not as typed.
 */
export function turnHeaders({ owner, attestation, nonce }) {
  if (owner) return { [DESKTOP_NONCE_HEADER]: nonce };
  return typeof attestation === 'string' && attestation.startsWith('solvox2.') ? { [VOICE_ATTESTATION_HEADER]: attestation } : {};
}

/** Lines waiting to be said on Ghost's own initiative (a finished task, a capability ask): bounded like the desktop's. */
export const ANNOUNCE_QUEUE_MAX = 10;

export function createOwnerSession({
  port, secrets, runtimeHome, onState = () => {}, out = (line) => process.stdout.write(`${line}\n`), voiceOut = true, log = () => {},
  voiceAuthority = resolveVoiceAuthority(), turnImpl = turn, speakImpl = speak, openWall = openDesktopWall, beforeTurn = async () => {}, onKeyHandoff = () => {},
  narrationGate = () => ({ allowed: true, owner: null }), onNarrationSuppressed = async () => {}, onSaid = () => {},
  // The Kingmaker bar lists a turn's sources as links instead of opening them (onLinks gets them after the line is said);
  // without it (a terminal) they open on the desktop as before.
  onLinks = null,
  linkLimit = () => 8,   // Customize → Sources under answers
  // Never a bare "I can't": for an answer that only says it cannot, the closest capability Ghost has (device scan).
  capabilityLine = () => null,
  streams = { backgroundTasks: streamBackgroundTasks, featureWatch: streamFeatureWatch, claimAsks: claimFeatureWatchAnnouncements },
}) {
  const ownerHeaders = { [DESKTOP_NONCE_HEADER]: secrets.nonce };
  let conversationId = null;
  let muted = false; // the Kingmaker bar's mute: replies still go to the bar as text, nothing is spoken
  let spokenLimit = 0; // a typed turn: speak only the start of a long answer (the whole of it is on the screen)
  let pending = [];
  let speakingDepth = 0;
  let current = null;
  let lastAwaitingTurn = false;
  let turnsInFlight = 0;
  const announcements = [];
  let announcing = false;

  /** Print and speak a line. `print: false` only speaks it (the caller already printed it its own way). */
  async function say(text, { print = true } = {}) {
    const line = String(text ?? '').trim();
    if (!line) return { spoken: false, reason: 'empty' };
    if (print) out(`  ◆ ${line}`);
    try { onSaid(line); } catch { /* the bar's copy of a line never stops it being said */ }
    if (!voiceOut || muted) return { spoken: false, reason: muted ? 'muted' : 'voice_off' };
    const gate = narrationGate({ text: line, kind: 'narration' }) ?? { allowed: true };
    if (gate.allowed === false) {
      log('narration_suppressed', { owner: gate.owner ?? null, chars: line.length });
      await onNarrationSuppressed({ text: line, owner: gate.owner ?? null, kind: 'narration' });
      return { spoken: false, suppressed: gate.owner ?? 'governed-session' };
    }
    let spoken = line;
    if (spokenLimit && line.length > spokenLimit) {
      const sentences = line.match(/[^.!?]+[.!?]+(\s|$)/g) || [line];
      spoken = '';
      for (const sn of sentences) { if ((spoken + sn).length > spokenLimit && spoken) break; spoken += sn; }
      spoken = `${spoken.trim().slice(0, spokenLimit)} The rest is on your screen.`;
    }
    speakingDepth += 1;
    onState('speaking', { line: line.slice(0, 200) });
    const handle = speakImpl(spoken);
    current = handle;
    try { await handle.done; } finally {
      speakingDepth -= 1;
      if (current === handle) current = null;
      if (speakingDepth === 0) void drainAnnouncements();
    }
    return { spoken: true };
  }

  /**
   * ONE SPEAKER: a line Ghost says on its own waits until no turn is in flight and nothing is being said, then
   * is said in order. Driven by those two events (a turn ending, a line ending), never by a timer.
   */
  async function drainAnnouncements() {
    if (announcing) return;
    announcing = true;
    try {
      while (announcements.length && turnsInFlight === 0 && speakingDepth === 0) await say(announcements.shift());
    } finally { announcing = false; }
  }

  function announce(text) {
    const line = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (!line) return false;
    announcements.push(line);
    while (announcements.length > ANNOUNCE_QUEUE_MAX) log('announcement_dropped', { reason: 'queue_full', chars: announcements.shift().length });
    void drainAnnouncements();
    return true;
  }

  async function refreshPending() {
    const r = await pendingProposals(port, { headers: ownerHeaders }).catch(() => null);
    const list = r?.json?.data?.proposals ?? r?.json?.data ?? [];
    pending = Array.isArray(list) ? list : [];
    return pending;
  }

  function describe(p) {
    const who = p.requester?.kind && p.requester.kind !== 'operator_typed' ? ` (asked by ${p.requester.kind.replace(/_/g, ' ')})` : '';
    return `[${p.riskTier ?? '?'}] ${p.summary ?? p.origin}${who}${p.challenge ? ` — type the words: ${p.challenge}` : ''}`;
  }

  /** A governed turn. `owner` = typed at this terminal (nonce); mode 'voice' = heard while awake (turnWire).
   *  `attestation` (a solvox2 token for exactly `text`) is sent only under the 'verified' voice authority. */
  async function runTurn(text, opts) {
    turnsInFlight += 1;
    // The moment a self-check can be asked for: keep the health snapshot the server holds fresh (health.mjs).
    try { await beforeTurn(); } catch { /* telemetry never holds a turn */ }
    try { return await runTurnNow(text, opts); } finally {
      turnsInFlight -= 1;
      if (turnsInFlight === 0) void drainAnnouncements();
    }
  }

  async function runTurnNow(text, { owner, mode = 'text', attestation = null, conversationId: convOverride = null, image = null }) {
    const wire = turnWire({ owner, mode, voiceAuthority });
    const headers = turnHeaders({ owner: wire.owner, attestation: wire.attested ? attestation : null, nonce: secrets.nonce });
    // A phone turn carries its OWN stable conversationId (one thread per phone, so a follow-up resumes) and the latest
    // field photo. That thread is the phone's, not the bar's: its returned id never overwrites the bar's `conversationId`.
    const convForTurn = convOverride || conversationId;
    const r = await turnImpl(port, { text, conversationId: convForTurn, image, mode: wire.mode, headers });
    if (r.conversationId && !convOverride) conversationId = r.conversationId;
    lastAwaitingTurn = r.confirmationRequired;
    const d = r.raw?.data ?? {};
    log('turn', { spoken: wire.spoken, asOwner: wire.owner, route: r.route, disposition: d.conversationResult?.disposition, controlSurface: d.controlSurface, output: d.output ? JSON.stringify(d.output).slice(0, 1500) : null });
    if (!r.ok) { await say(r.spoken || `That turn failed (HTTP ${r.status}).`); return { followUp: false, ok: false, reason: `http_${r.status}`, route: r.route ?? null }; }
    // With the bar (onLinks), nothing opens by itself: Chrome tabs were Kingmaker's screen only while it had no window.
    // The sources are links under the answer (open or hidden, voice-only too), and the owner clicks the one they want.
    // Without a window (a terminal console) the old desktop wall stays: they open as Chrome windows, and the line says
    // so only once they actually opened.
    let opened = '';
    let browsed = '';
    let links = [];
    if (process.env.SOL_GHOST_OPEN_EVIDENCE !== '0') {
      if (onLinks) {
        links = evidenceLinks(r.raw, { port, runtimeHome, max: Math.max(0, Number(linkLimit()) || 0) });
        opened = describeLinks(links);
      } else if (runtimeHome) {
        const targets = evidenceTargets(r.raw, { port, runtimeHome });
        if (targets.length) opened = describeWall(await openWall(targets, { log }));
      }
      // The page the turn said to open ("open <site>", "read source 2"): only data.liveWebBrowse.url, in Chrome.
      const page = browseTarget(r.raw);
      if (page) browsed = describeBrowse(await openWall([page], { log, chromeOnly: true }));
    }
    let instead = null;
    try { instead = capabilityLine(text, r.spoken); } catch { instead = null; }
    const line = [r.spoken, instead, opened, browsed].filter(Boolean).join(' ');
    const delivery = await say(line);
    if (links.length) { try { onLinks(links); } catch { /* the bar is gone */ } }
    if (r.confirmationRequired) {
      await refreshPending();
      if (newestPending(pending)) {
        const how = wire.spoken && wire.owner ? '  ↳ say or type yes to approve, no to cancel'
          : wire.attested ? '  ↳ say "yes, go ahead" (your enrolled voice) or type y to approve; n to cancel'
            : '  ↳ type y to approve, n to cancel';
        out(how);
      } else if (r.readBack && wire.owner) out('  ↳ type y (or say go ahead) to make it, n to cancel');
    }
    return {
      followUp: r.confirmationRequired || /\?\s*$/.test(r.spoken),
      // For the voice-turn ledger: what happened, never what was said.
      ok: true, route: r.route ?? null, disposition: d.conversationResult?.disposition ?? null,
      internetUsed: d.internetUsed === true || d.truthState?.internetUsed === true, answerChars: line.length, spoke: delivery?.spoken === true,
    };
  }

  /** Approve/cancel the newest pending proposal, bound to its id (never a grammar guess). */
  async function decide(kind, readChallenge) {
    await refreshPending();
    const p = newestPending(pending);
    if (!p) {
      // A legacy confirmation that lives only in the conversation (no broker proposal): answer it there.
      if (lastAwaitingTurn && conversationId) return runTurn(kind === 'yes' ? 'yes, go ahead' : 'cancel', { owner: true });
      return say('Nothing is waiting for a yes.');
    }
    if (kind === 'no') {
      const r = await cancelProposal(port, p.proposalId, { headers: ownerHeaders });
      return say(r.json?.data?.spoken || (r.ok ? 'Cancelled. Nothing was changed.' : `Cancel failed (HTTP ${r.status}).`));
    }
    const typedChallenge = p.challenge ? await readChallenge(p.challenge) : undefined;
    const r = await confirmProposal(port, p.proposalId, { typedChallenge, headers: ownerHeaders });
    const data = r.json?.data ?? {};
    return say(data.spoken || data.message || (r.ok ? 'Approved.' : `Not approved: ${data.outcome || r.json?.error || r.status}.`));
  }

  /** Server-pushed control events: new proposals from voice / MCP / other programs show up here. */
  function watchControlEvents(signal) {
    const seen = new Set();
    const loop = async () => {
      while (!signal.aborted) {
        try {
          await streamControlEvents(port, {
            headers: ownerHeaders,
            signal,
            onEvent: async ({ type, data }) => {
              log('control_event', { type });
              // A background studio project: the glow shows the work while one runs (events, never polled).
              if (type === 'snapshot' && typeof data?.studioActive === 'number') onState(data.studioActive > 0 ? 'working' : 'idle');
              if (type === 'studio_project.changed') {
                onState(Number(data?.active ?? 0) > 0 ? 'working' : 'idle', typeof data?.phase === 'string' ? { line: data.phase } : {});
                if (typeof data?.spoken === 'string') await say(data.spoken);
                return;
              }
              // A turn asked for an API key ("connect my GitHub key"): this console takes it at its terminal.
              if (type === 'key_handoff.console') {
                const handoff = consoleKeyHandoff(data);
                if (handoff) onKeyHandoff(handoff);
                else log('key_request_dropped', { redacted: Boolean(data?.redacted), fields: Object.keys(data ?? {}).slice(0, 12) });
                return;
              }
              if (type === 'snapshot' && Array.isArray(data?.proposals)) pending = data.proposals;
              else await refreshPending();
              onState(pending.some((p) => p.status === 'PENDING') ? 'waiting' : 'clear', { pending: pending.filter((p) => p.status === 'PENDING').length });
              for (const p of pending) {
                if (p.status !== 'PENDING' || seen.has(p.proposalId)) continue;
                seen.add(p.proposalId);
                out(`  ⧗ waiting for you: ${describe(p)}`);
              }
              if (typeof data?.spoken === 'string' && type !== 'snapshot') await say(data.spoken);
            },
          });
        } catch (error) {
          if (signal.aborted) return;
          log('control_events_dropped', { message: String(error?.message || error).slice(0, 160) });
        }
        // The stream ended (server restart): reconnect after a short pause.
        await new Promise((r) => setTimeout(r, 2_000));
      }
    };
    void loop();
  }

  /**
   * "It's ready": the background-task stream (/api/tasks/events), the one the window app speaks from. Each task
   * that finishes after this starts is said once, in its own readyLine. Not /api/conversation/feed: opening that
   * marks the tenant as having a screen attached, which would change how headless turns report.
   */
  function watchBackgroundTasks(signal) {
    const announcer = createTaskAnnouncer({ tenantId: 'primary', armedAtMs: Date.now() });
    return followStream({
      name: 'background_tasks', signal, log,
      open: ({ onOpen }) => streams.backgroundTasks(port, {
        headers: ownerHeaders, signal, onOpen,
        onEvent: (frame) => {
          for (const { id, line } of announcer.linesFor(frame)) {
            log('background_task_ready', { taskId: id.slice(0, 60) });
            announce(line);
          }
        },
      }),
    });
  }

  /**
   * Capability asks: the feature watch's snapshot stream. A new ask's line is claimed from the server (so only
   * one surface ever says it) and said once. The answer is the operator's own next turn; nothing here decides.
   */
  function watchFeatureWatch(signal) {
    const tried = new Set();
    return followStream({
      name: 'feature_watch', signal, log,
      open: ({ onOpen }) => streams.featureWatch(port, {
        headers: ownerHeaders, signal, onOpen,
        onEvent: async ({ type, data }) => {
          if (type !== 'feature-watch') return;
          const askIds = asksToAnnounce(data, tried);
          if (!askIds.length) return;
          for (const id of askIds) tried.add(id);
          const r = await streams.claimAsks(port, askIds, { headers: ownerHeaders }).catch(() => null);
          const line = claimedLine(r);
          log('feature_watch_claimed', { asks: askIds.length, claimed: r?.json?.data?.claimed?.length ?? 0, spoken: Boolean(line) });
          if (line) announce(line);
        },
      }),
    });
  }

  return {
    say,
    announce,
    watchBackgroundTasks,
    watchFeatureWatch,
    isSpeaking: () => speakingDepth > 0,
    interrupt: () => { current?.stop(); },
    /** The bar's mute: on = nothing spoken (a line being said stops), off = speak again. */
    setMuted: (on) => { muted = Boolean(on); if (muted) current?.stop(); },
    setSpokenLimit: (n) => { spokenLimit = Math.max(0, Number(n) || 0); },
    get muted() { return muted; },
    runTurn,
    decide,
    refreshPending,
    describe,
    watchControlEvents,
    voiceAuthority,
    get conversationId() { return conversationId; },
    get pending() { return pending; },
  };
}
