// light-runtime/ask.mjs — THE ASK PATH of the light runtime (v2, Robbie's ruling 2026-10-28):
// the browser window is a SECONDARY RUNTIME, not a read-only wall. An ask typed in the window is
// routed by the SAME lane router the bar and the CLI use (lib/fast-route.mjs routeLane — rules,
// reflex, generative router, the head+tail routingView and the long-guard that escalates a long
// local-lane verdict to the governed brain), and then runs on a SEAT:
//
//   browser — an in-tab engine seat registered with this router (light-runtime/seat/seat.mjs:
//             a GGUF model executing in the tab via wllama/WebGPU-or-Wasm). Only the 'write'
//             lane may take it: the write lane is the one lane that leaves the governed brain,
//             and a tab can only write text — a misroute can do nothing on this machine.
//   native  — the FALLBACK seat: the running Kingmaker's job inbox (lib/job-inbox.mjs), the
//             exact typed-turn door `kingmaker job` uses — same bar guard, same governed brain,
//             same approval gates. 'act' / 'open' / 'image' / 'lookup' always land here, and so
//             does every 'write' when no browser seat is ready.
//
// Propose-only is inherited, never re-decided here: jobRefusal (lib/job-inbox.mjs) runs before
// routing, so a decision word or a bar/console command is refused exactly as a job is. Anything
// an ask sets in motion still waits for the owner's own word — given at the bar, or in this
// window's Approvals section (light-runtime/proposals.mjs), which speaks the engine's control
// surface as the owner. The job inbox itself still can never approve anything.
//
// Diagnostics are evidence, not decoration: lane + decider from routeLane itself; timings from
// the job's own stamps; token counts and decode rate from the token meter's log
// (lib/token-meter.mjs's file) over the ask's own window — calls the meter did not record read
// as nulls and render UNMEASURED. A browser seat's numbers are its own self-report and are
// labelled with that source, the spec's seat rule (kingmaker-browser-runtime-spec.md).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { routeLane } from '../lib/fast-route.mjs';
import { jobRefusal, findInbox, submitJob, getJob, jobConversation } from '../lib/job-inbox.mjs';
import { callsFile } from '../lib/token-meter.mjs';
import { streamEvents } from '../lib/client.mjs';
import { isGuardrailHeldAnswer, enginePort } from './proposals.mjs';
import { FAILURE_LINE } from './failures.mjs';

export const ASK_SCHEMA = 'kingmaker.light-ask/1';
const KEEP_ASKS = 50;
const SEAT_FRESH_MS = 20_000;   // a seat that has not polled/heartbeat in this long is not ready

/**
 * THE ASK'S LIVE STAGE — what the turn is doing while it is doing it, on the card, instead of the
 * v2 silence between "Running" and the answer landing (the 2026-10-28 hang: a turn could sit for
 * two minutes in one bookkeeping step and the card said nothing). Stages are NOT a parallel
 * channel: a native ask's stage advances from the engine's OWN turn feed (turn-feed.ts phases,
 * published by the governed turn as it passes each transition) read over the engine's existing
 * /api/conversation/feed/<id> stream — the snapshot replay on connect means a card that starts
 * watching mid-turn sees where the turn already is. The router's own transitions (queued, routed,
 * the seat taking the ask) seed the stage before the first feed event can arrive, and the terminal
 * stages (answered / held / failed) come from the ask's own settled state, never from the feed.
 * Stage only ever advances (STAGE_RANK): a late feed event can never walk a card backwards.
 */
export const ASK_STAGES = ['queued', 'routed', 'researching', 'thinking', 'waiting', 'answered', 'held', 'failed'];
const STAGE_RANK = { queued: 0, routed: 1, researching: 2, thinking: 3, waiting: 4, answered: 5, held: 5, failed: 5 };

/** Pure: one turn-feed phase → the ask stage it evidences (null = no stage information).
 *  Vocabulary only: 'answered'/'failed' map here so the terminal words exist in one place,
 *  but noteFeedEvent never applies them as a LIVE stage — a feed 'failed' is a lane's
 *  mid-turn report, not the turn's outcome (see noteFeedEvent). */
export function stageForFeedPhase(phase) {
  switch (phase) {
    case 'heard': case 'routed': case 'engine_planned': return 'researching';
    case 'executing': case 'executed': return 'thinking';
    case 'asked': case 'proposed': case 'directed': return 'waiting';
    case 'answered': return 'answered';
    case 'failed': return 'failed';
    default: return null;
  }
}

/** The default stage feed: the engine's per-conversation turn-feed stream, via lib/client.mjs's
 *  SSE reader (the same seam the proposals client uses for the control surface). A refused or
 *  missing stream is swallowed — the card keeps the router-observed stage, never a fake one. */
function engineFeed(engineStateDir) {
  return {
    watch(conversationId, onEvent) {
      const ac = new AbortController();
      streamEvents(enginePort(engineStateDir), `/api/conversation/feed/${encodeURIComponent(conversationId)}`, {
        signal: ac.signal,
        onEvent: ({ data } = {}) => { if (data && typeof data === 'object') onEvent(data); },
      }).catch(() => { /* engine stopped or feed refused — stage stays router-observed */ });
      return () => { try { ac.abort(); } catch { /* already closed */ } };
    },
  };
}

/**
 * The ask capability's tool definition — name, purpose, JSON schema — defined ONCE here and
 * registered with the MCP tool-calling layer in lib/mcp.mjs in the same pass (tool-wiring
 * doctrine, the K_OFFICE_TOOL precedent in lib/k-office.mjs). NOT adopted into the governed
 * brain's own manifest (solomon/server/src/runtime/brain-tools.ts) — with a reason, recorded in
 * LIGHT-RUNTIME-V2-REPORT.md: the local brain IS the engine an ask routes to; a tool that lets
 * it submit asks to itself is a recursion door, not a capability. External brains reach this
 * tool through MCP, which is their tool-calling layer.
 */
export const LIGHT_ASK_TOOL = Object.freeze({
  name: 'kingmaker_light_ask',
  description: 'Ask Kingmaker a question through its light runtime (the browser evidence wall) and get the governed answer '
    + 'back WITH its diagnostics: the lane the router chose, which seat answered (an in-tab browser engine seat for a '
    + 'write-lane ask, else the native engine through its job inbox), the model, timings and token counts the token '
    + 'meter recorded, and the ask\u2019s live stage (queued \u2192 routed \u2192 researching \u2192 thinking \u2192 answered/held) fed by the '
    + 'engine\u2019s own turn feed while the turn runs. Propose-only, exactly like a typed bar turn: decisions ("yes", "approve", "cancel"…) and '
    + 'bar/console commands are refused, and anything an ask sets in motion waits for the owner at the bar. '
    + 'Unmeasured diagnostics come back null — never invented.',
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'The question or instruction, in plain words.' },
      waitSeconds: { type: 'number', description: 'How long to wait for the answer before returning the ask id and its state. Default 120, max 600.' },
    },
    required: ['text'],
    additionalProperties: false,
  },
  annotations: { title: 'Ask Kingmaker (light runtime, propose-only)', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
});

/** The meter's records inside one ask's window [fromMs, toMs]: the calls this ask can honestly
 *  claim. Rates come from the records' own durations (evalNs / promptNs), never from wall time. */
export function meterWindow(stateDir, fromMs, toMs, { now = new Date() } = {}) {
  const out = { calls: [], prompt: null, generated: null, decodeTokS: null, prefillTokS: null };
  if (!stateDir || !Number.isFinite(fromMs)) return out;
  const f = callsFile(stateDir, now);
  if (!existsSync(f)) return out;
  let prompt = 0, generated = 0, evalNs = 0, promptNs = 0, seen = false;
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    const at = Date.parse(r.at);
    if (!Number.isFinite(at) || at < fromMs || (Number.isFinite(toMs) && at > toMs)) continue;
    seen = true;
    out.calls.push({ lane: r.lane ?? null, kind: r.kind ?? null, model: r.model ?? null, provider: r.provider ?? null, prompt: r.prompt ?? null, generated: r.generated ?? null, outcome: r.outcome ?? null });
    if (typeof r.prompt === 'number') prompt += r.prompt;
    if (typeof r.generated === 'number') generated += r.generated;
    if (typeof r.evalNs === 'number') evalNs += r.evalNs;
    if (typeof r.promptNs === 'number') promptNs += r.promptNs;
  }
  if (!seen) return out;
  out.prompt = prompt; out.generated = generated;
  out.decodeTokS = evalNs > 0 && generated > 0 ? Math.round((generated / (evalNs / 1e9)) * 10) / 10 : null;
  out.prefillTokS = promptNs > 0 && prompt > 0 ? Math.round((prompt / (promptNs / 1e9)) * 10) / 10 : null;
  return out;
}

const newId = (p) => `${p}_${randomBytes(9).toString('base64url')}`;

/**
 * The ask router: one instance per light server. Every seam is injectable for tests —
 *   route(text)      → routeLane's verdict (default: the real lib/fast-route.mjs routeLane)
 *   native           → { available(), submit(text, conversation), get(jobId) } over the job
 *                      inbox (default: lib/job-inbox.mjs against engineStateDir)
 *   meterWindowFor   → (fromMs, toMs) diagnostics (default: meterWindow over engineStateDir)
 */
export function createAskRouter({ engineStateDir = null, route = null, native = null, meterWindowFor = null, feed = null, now = () => Date.now() } = {}) {
  const routeImpl = route ?? ((text) => routeLane(text));
  const nativeImpl = native ?? {
    available: () => Boolean(engineStateDir && findInbox(engineStateDir)),
    submit: (text, conversation) => submitJob({ state: engineStateDir, text, conversation }),
    get: (id) => getJob({ state: engineStateDir, id }),
  };
  const meterFor = meterWindowFor ?? ((fromMs, toMs) => meterWindow(engineStateDir, fromMs, toMs));
  // The stage feed (injectable; the default reads the engine's turn feed when its state dir is
  // known). feed.watch(conversationId, onEvent) → close(). Absent a feed, stages stay at the
  // router-observed transitions — honest, just coarser.
  const feedImpl = feed ?? (engineStateDir ? engineFeed(engineStateDir) : null);

  const advanceStage = (a, stage) => {
    if (stage && (STAGE_RANK[stage] ?? 0) > (STAGE_RANK[a.stage] ?? 0)) { a.stage = stage; a.stageAtMs = now(); }
  };
  /** One turn-feed event for one native ask: advance its stage, and — the 2026-10-28 second
   *  occurrence — capture the turn's TERMINAL outcome when the feed reports it. The feed is the
   *  engine's own record of the turn (turn-feed.ts: the governed turn publishes 'answered' with
   *  the answer text as the event detail, before its bookkeeping even finishes; a turn that dies
   *  publishes 'failed'). The job inbox, by contrast, settles on the CLIENT-side wait: the bar
   *  session gives up at its 90 s timeout and the job lands 'done' carrying the spoken timeout
   *  line ("That didn't work: The operation was aborted due to timeout") — while the governed
   *  turn itself completes server-side seconds later (tonight: 123 s). The captured outcome is
   *  what lets view() reconcile that false failure into the answer that actually exists. Only
   *  the first terminal event counts; the watch closes once it is in hand. */
  const noteFeedEvent = (a, ev) => {
    // LIVE STAGE ONLY (the 2026-10-28 screen-recording defect): a feed phase advances the
    // card's stage only while it is a LIVE stage. The terminal phases never advance it —
    // turn-feed.ts defines 'failed' as "a lane could not do what it said", and lanes publish
    // it MID-TURN for a sub-step that failed while the governed turn itself carries on
    // (a source retrieval, an engine stage, a capability search). Mapping that event onto
    // the card made a RUNNING ask read "Running — Failed" (stage rank 5 is monotonic, so
    // no later live event could ever walk it back) until the settle flipped it to Answered.
    // Terminal truth arrives through the channels view() already trusts: the ask's own
    // settled state, and — for the outcome — the feedOutcome captured just below.
    const liveStage = stageForFeedPhase(ev?.phase);
    if (liveStage && liveStage !== 'answered' && liveStage !== 'failed') advanceStage(a, liveStage);
    if (!ev || a.feedOutcome) return;
    if ((ev.phase === 'answered' || ev.phase === 'failed') && typeof ev.detail === 'string' && ev.detail.trim()) {
      a.feedOutcome = { kind: ev.phase, text: ev.detail, atMs: now() };
      stopFeedWatch(a);
    }
  };
  /** Start watching the engine's turn feed for one native ask (once). The job's conversation id
   *  is jobConversation(ask.conversation) — the id the turn publishes under. */
  const startFeedWatch = (a) => {
    if (!feedImpl || a.feedClose || !a.conversation) return;
    try {
      a.feedClose = feedImpl.watch(jobConversation(a.conversation), (ev) => noteFeedEvent(a, ev)) || null;
    } catch { a.feedClose = null; /* a feed that will not open leaves the router-observed stage */ }
  };
  const stopFeedWatch = (a) => {
    if (a.feedClose) { try { a.feedClose(); } catch { /* already closed */ } a.feedClose = null; }
  };
  const seats = new Map();   // seatId → { token, label, capabilities, lastSeenMs, busyAskId }
  const asks = new Map();    // id → record (insertion order = submission order)

  const seatReady = (s) => s && !s.busyAskId && now() - s.lastSeenMs <= SEAT_FRESH_MS;
  const anySeatReady = () => [...seats.values()].some(seatReady);

  function registerSeat({ label = 'browser seat', capabilities = {} } = {}) {
    const seatId = newId('seat');
    const token = randomBytes(24).toString('base64url');
    seats.set(seatId, { token, label: String(label).slice(0, 80), capabilities, lastSeenMs: now(), busyAskId: null });
    return { seatId, token };
  }
  function seatAuth(seatId, token) {
    const s = seats.get(seatId);
    return s && token && s.token === token ? s : null;
  }
  function seatStatus() {
    return [...seats.entries()].map(([seatId, s]) => ({
      seatId, label: s.label, capabilities: s.capabilities,
      state: s.busyAskId ? 'busy' : (now() - s.lastSeenMs <= SEAT_FRESH_MS ? 'ready' : 'stale'),
      busyAskId: s.busyAskId,
    }));
  }

  /** Hand the seat its next queued browser ask, or null. Marks it running + the seat busy. */
  function seatPoll(seatId, token) {
    const s = seatAuth(seatId, token);
    if (!s) return { ok: false, error: 'SEAT_AUTH' };
    s.lastSeenMs = now();
    if (s.busyAskId) return { ok: true, ask: null };
    for (const a of asks.values()) {
      if (a.seat === 'browser' && a.state === 'queued') {
        a.state = 'running'; a.startedAtMs = now(); s.busyAskId = a.id;
        advanceStage(a, 'thinking');   // the tab has the ask and is producing text
        return { ok: true, ask: { id: a.id, text: a.text } };
      }
    }
    return { ok: true, ask: null };
  }

  /** A seat reports an ask's outcome. Its diagnostics ride as a self-report, labelled as such. */
  function seatResult(seatId, token, askId, { answer = null, diagnostics = null, error = null } = {}) {
    const s = seatAuth(seatId, token);
    if (!s) return { ok: false, error: 'SEAT_AUTH' };
    const a = asks.get(askId);
    if (!a || a.seat !== 'browser') return { ok: false, error: 'NO_SUCH_ASK' };
    s.lastSeenMs = now();
    if (s.busyAskId === askId) s.busyAskId = null;
    a.endedAtMs = now(); a.stageAtMs = a.endedAtMs;
    if (error) { a.state = 'failed'; a.error = String(error).slice(0, 300); }
    else {
      a.state = 'done'; a.answer = [String(answer ?? '')];
      a.diagnostics = { ...(a.diagnostics ?? {}), ...(diagnostics ?? {}), source: 'browser seat self-report' };
    }
    return { ok: true, view: view(a) };
  }

  /** Route one ask and place it on a seat. Throws { code } with jobRefusal's codes, unchanged.
   *  `surface` is the ask's TRUE origin, recorded at submission and carried on the view:
   *  'voice' for a spoken ask (its text is the in-tab transcription of what the owner said),
   *  'window' for everything typed in this window — the label is never inferred later from
   *  a transcript marker (the bar.log "(said)" class of mislabel: a surface is what it was
   *  when it was submitted, not what a log line resembles). */
  async function submitAsk(text, { conversation = null, surface = null } = {}) {
    const why = jobRefusal(typeof text === 'string' ? text : '');
    if (why) { const e = new Error(why); e.code = why; throw e; }
    const t = text.trim();
    const verdict = await routeImpl(t);
    const rec = {
      id: newId('ask'), text: t, conversation: conversation || null,
      surface: surface === 'voice' ? 'voice' : 'window',
      lane: verdict?.lane ?? null, by: verdict?.by ?? null, routeMs: verdict?.ms ?? null,
      seat: null, state: 'queued', stage: 'queued', stageAtMs: now(),
      submittedAtMs: now(), startedAtMs: null, endedAtMs: null,
      nativeJobId: null, answer: null, error: null, diagnostics: null, meterSettled: false,
      feedClose: null, feedOutcome: null,
    };
    asks.set(rec.id, rec);
    while (asks.size > KEEP_ASKS) { const evicted = asks.get(asks.keys().next().value); if (evicted) stopFeedWatch(evicted); asks.delete(asks.keys().next().value); }
    advanceStage(rec, 'routed');   // routeLane has spoken: lane + decider are on the record
    // THE SEAT RULE: only the write lane may leave the governed brain for a tab, and only
    // when a browser seat is actually ready. Everything else — and every refusal of the
    // seat — takes the native fallback, where the governed brain reads the full text itself.
    if (rec.lane === 'write' && anySeatReady()) {
      rec.seat = 'browser';
      return view(rec);
    }
    rec.seat = 'native';
    if (!nativeImpl.available()) {
      rec.state = 'failed'; rec.endedAtMs = now();
      rec.error = 'ENGINE_NOT_RUNNING';
      rec.errorHint = 'The Kingmaker engine is not running, and no browser seat can take this lane. Start it with: kingmaker start';
      return view(rec);
    }
    // A native ask runs as a job under its own conversation (the `kingmaker job --conversation`
    // pattern) — that id is also how the stage feed finds this ask's turn on the engine's feed.
    if (!rec.conversation) rec.conversation = `light-${rec.id}`;
    try {
      const j = await nativeImpl.submit(t, rec.conversation);
      rec.nativeJobId = j.id;
      rec.state = 'running';
    } catch (e) {
      rec.state = 'failed'; rec.endedAtMs = now();
      rec.error = e?.code || String(e?.message || e).slice(0, 200);
    }
    return view(rec);
  }

  /** The ask's current view; a native ask is refreshed from the inbox and, once done, its
   *  meter-window diagnostics are attached once (the settle the inbox itself waits for). */
  async function getAsk(id) {
    const a = asks.get(id);
    if (!a) return null;
    // The feed watch runs while the ask runs — and ALSO, once, for an ask that already settled
    // 'done' carrying an engine failure line with no feed outcome yet: that settle may be the
    // bar session's 90 s timeout line rather than the turn's truth, and only the feed can
    // correct it (its snapshot replay hands a late watcher the events it missed).
    const settledWithFailureLine = a.state === 'done' && Array.isArray(a.answer)
      && a.answer.some((l) => typeof l === 'string' && FAILURE_LINE.test(l.replace(/^Kingmaker: /, '')));
    if (a.seat === 'native' && a.nativeJobId && !a.feedOutcome
      && (a.state === 'running' || a.state === 'queued' || settledWithFailureLine)) {
      startFeedWatch(a);   // the turn's stage — and its terminal truth — from the engine's own feed
    }
    if (a.seat === 'native' && a.nativeJobId && (a.state === 'running' || a.state === 'queued')) {
      try {
        const j = await nativeImpl.get(a.nativeJobId);
        if (j?.ok) {
          if (j.startedMs != null) a.startedAtMs = j.startedMs;
          if (j.state === 'done') {
            a.state = 'done'; a.endedAtMs = j.endedMs ?? now(); a.stageAtMs = a.endedAtMs;
            a.answer = Array.isArray(j.answer) ? j.answer : [];
            stopFeedWatch(a);
          } else if (j.state === 'queued') a.state = 'queued';
          else a.state = 'running';
        }
      } catch { /* a lost poll is not a failed ask; the next poll reads the truth again */ }
    }
    if (a.state === 'done' && a.seat === 'native' && !a.meterSettled) {
      a.meterSettled = true;
      const m = meterFor(a.submittedAtMs - 250, (a.endedAtMs ?? now()) + 250);
      a.diagnostics = {
        ...(a.diagnostics ?? {}),
        models: [...new Set(m.calls.map((c) => c.model).filter(Boolean))],
        meterCalls: m.calls,
        promptTokens: m.prompt, generatedTokens: m.generated,
        decodeTokS: m.decodeTokS, prefillTokS: m.prefillTokS,
        source: m.calls.length ? 'token meter log, this ask\u2019s window' : 'token meter log: no calls recorded in this ask\u2019s window',
      };
    }
    return view(a);
  }

  /**
   * Record a failure that happened BEFORE any ask could exist — the voice path's honest
   * dead ends (no microphone, the ear will not load, a transcription that came back empty):
   * the failure is real, it belongs on the wall as a FAILED card with its true reason, and
   * there is no transcript to pretend otherwise with, so text stays null and the card says
   * so. The error text is the voice module's own report from the tab (labelled as such in
   * diagnostics, like a seat's self-report) — it is never dressed as an engine verdict.
   */
  function recordSurfaceFailure({ surface = 'voice', stage = null, error = null } = {}) {
    const rec = {
      id: newId('ask'), text: null, conversation: null,
      surface: surface === 'voice' ? 'voice' : 'window',
      lane: null, by: null, routeMs: null,
      seat: null, state: 'failed', stage: 'failed', stageAtMs: now(),
      submittedAtMs: now(), startedAtMs: null, endedAtMs: now(),
      nativeJobId: null, answer: null,
      error: `${stage ? `${String(stage).slice(0, 40)}: ` : ''}${String(error || 'VOICE_UNAVAILABLE').slice(0, 300)}`,
      diagnostics: { source: 'voice module self-report — the failure happened in the tab, before any transcript existed' },
      meterSettled: true, feedClose: null,
    };
    asks.set(rec.id, rec);
    while (asks.size > KEEP_ASKS) { const evicted = asks.get(asks.keys().next().value); if (evicted) stopFeedWatch(evicted); asks.delete(asks.keys().next().value); }
    return view(rec);
  }

  function view(a) {
    const queueMs = a.startedAtMs != null ? a.startedAtMs - a.submittedAtMs : null;
    const turnMs = a.startedAtMs != null && a.endedAtMs != null ? a.endedAtMs - a.startedAtMs : null;
    // A guardrail HELD turn ends like a done job at the inbox (the held line IS its answer), but it
    // must render AS held — with the engine's reason on the card, never as an answer and never
    // vanished. There is no proposal behind this class of hold; see proposals.mjs's header.
    const held = a.state === 'done' && Array.isArray(a.answer) && a.answer.some(isGuardrailHeldAnswer);
    // A native turn that DIED at the engine also settles 'done' at the inbox — its failure line
    // ("That didn't work: …", the bar session's spoken form when a turn dies) rides in as answer
    // text. Rendered as an answer it would read as a success; it is a FAILED ask, and the
    // engine's line is its reason, verbatim (the transcript's "Kingmaker:" tag stripped).
    const failLine = !held && a.state === 'done' && Array.isArray(a.answer)
      ? a.answer.map((l) => (typeof l === 'string' ? l.replace(/^Kingmaker: /, '') : '')).find((l) => FAILURE_LINE.test(l)) ?? null
      : null;
    const engineFailed = failLine != null;
    // RECONCILIATION: an engine failure line is the INBOX's settle, and the inbox settles on the
    // client-side wait — the bar session's 90 s timeout writes "That didn't work: The operation
    // was aborted due to timeout" into the job while the governed turn is still running. When
    // the engine's own turn feed has reported this turn ANSWERED (its terminal event, captured
    // by the feed watch), the feed is the truth and the line is not: the ask renders answered,
    // with the feed's answer text, and the diagnostics say which record settled it. A feed
    // 'failed' outcome never overrides anything — it agrees with the line, and the line's own
    // reason stands. A held turn is untouched (it never carries a failure line).
    const feedAnswered = engineFailed && a.feedOutcome?.kind === 'answered' ? a.feedOutcome : null;
    const viewState = held ? 'held' : feedAnswered ? 'done' : engineFailed ? 'failed' : a.state;
    // Terminal stages come from the ask's own settled state; a running stage is the feed's
    // latest LIVE stage. Belt and braces on the recording defect: a still-running ask's
    // stage is NEVER a terminal word, whatever an earlier build or a replayed feed event
    // left in a.stage — 'thinking' is the honest live stage for a turn in flight whose
    // finer stage is not known, and the terminal word lands only with the settle itself.
    const liveStage = a.stage === 'answered' || a.stage === 'held' || a.stage === 'failed' ? 'thinking' : a.stage;
    const stage = held ? 'held' : feedAnswered ? 'answered' : engineFailed ? 'failed' : a.state === 'done' ? 'answered' : a.state === 'failed' ? 'failed' : liveStage;
    return {
      schema: ASK_SCHEMA, ok: viewState !== 'failed', id: a.id, text: a.text,
      conversation: a.conversation, state: viewState, seat: a.seat,
      surface: a.surface ?? 'window',
      stage, stageAt: a.stageAtMs ? new Date(a.stageAtMs).toISOString() : null,
      ...(held ? { heldKind: 'guardrail', heldReason: 'Held by the engine’s input guardrail (REQUIRE_REVIEW) before reasoning. No proposal exists for this hold — nothing can approve it; the release is a restated ask the rails pass.' } : {}),
      ...(engineFailed && !feedAnswered ? { failedKind: 'engine' } : {}),
      answer: feedAnswered ? [feedAnswered.text] : a.answer, error: feedAnswered ? null : engineFailed ? failLine : (a.error ?? null), errorHint: a.errorHint ?? null,
      diagnostics: {
        lane: a.lane, by: a.by, routeMs: a.routeMs, queueMs, turnMs,
        ...(feedAnswered ? { settledBy: 'engine turn feed — the turn completed server-side after the client-side wait timed out; the inbox line was its timeout, not its outcome' } : {}),
        // A settled ask's own diagnostics ride its view — done AND failed alike (a failed
        // ask's record, e.g. a pre-transcript voice failure, is exactly where its source
        // label matters; nothing here invents diagnostics for an ask that has none).
        ...(((a.state === 'done' || a.state === 'failed') && a.diagnostics) || {}),
      },
      submittedAt: new Date(a.submittedAtMs).toISOString(),
      endedAt: a.endedAtMs ? new Date(a.endedAtMs).toISOString() : null,
    };
  }

  return {
    submitAsk, getAsk, registerSeat, seatPoll, seatResult, seatStatus, recordSurfaceFailure,
    listAsks: async () => { const out = []; for (const a of [...asks.values()].reverse()) out.push(await getAsk(a.id)); return out; },
    hasSeat: () => seats.size > 0,
  };
}

/** The tool's payload (lib/mcp.mjs's kingmaker_light_ask; the officeToolResult pattern):
 *  submit, then wait up to waitSeconds for the answer. A timeout is a state, not an error —
 *  the ask id keeps working at the wall. */
export async function lightAskToolResult({ text, waitSeconds = 120 } = {}, { askRouter, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  if (!askRouter) throw new Error('lightAskToolResult: an askRouter is required');
  const waitMs = Math.min(600, Math.max(1, Number(waitSeconds) || 120)) * 1000;
  let v;
  try { v = await askRouter.submitAsk(typeof text === 'string' ? text : ''); }
  catch (e) { return { ok: false, error: e?.code || String(e?.message || e), note: 'Refused before routing — the light ask is propose-only, exactly like a typed bar turn.' }; }
  const until = Date.now() + waitMs;
  while (v.state !== 'done' && v.state !== 'failed' && Date.now() < until) {
    await sleep(1000);
    v = (await askRouter.getAsk(v.id)) ?? v;
  }
  return { ...v, timedOut: v.state !== 'done' && v.state !== 'failed' };
}
