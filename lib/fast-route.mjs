// lib/fast-route.mjs — Kingmaker's fast thought (Ronin's brain-boost layer): every command gets a lane before the heavy
// governed brain sees it, so the brain only carries what needs it.
//   1. Rules (instant): the obvious verbs and nouns.
//   2. The reflex (lib/reflex-producers.mjs, when the console wires one): the decision model scores the fixed lane
//      set in one forward pass — a confident verdict is the lane, an escalation is 'act'.
//   3. The lightweight local router (qwen3 1.7B abliterated, ~155 ms warm on a 24 GB M5 Pro, 10/12 alone, 12/12 with the
//      rules) for everything else — and for every reflex mid-confidence or failure.
//   4. Unsure or the router is down → 'act', the governed brain: a wrong guess never skips a gate.
// Lanes: write (a text answer: the local writer model answers directly), act (messages, money, records, the CRM: the
// governed brain with every approval), open (an app or site), image (make a picture), lookup (find facts). Only 'write'
// leaves the governed brain today, and the writer can only write text, so a misroute can't do anything on the Mac.
import { totalmem } from 'node:os';
import { classRole, classWriter } from './mac-profiles.mjs';
import { meter, meterFail } from './token-meter.mjs';

export const LANES = ['write', 'act', 'open', 'image', 'lookup'];
export const ROUTER_MODEL = 'huihui_ai/qwen3-abliterated:1.7b';
export const WRITER_MODEL = 'huihui_ai/qwen3-abliterated:8b';
/** The router for this Mac (lib/mac-profiles.mjs): ROUTER_MODEL on 16 GB and up; on an 8 GB Mac the one model that also
 *  writes, so routing never unloads the writer. Customize → Router overrides it. */
export const defaultRouter = (memBytes = totalmem()) => classRole('router', memBytes) ?? ROUTER_MODEL;

/** Pure: the model the write lane uses — the local model the owner pinned in the bar's picker (an Ollama tag), else
 *  this Mac's profile writer (lib/mac-profiles.mjs: WRITER_MODEL on 16 GB and up, the measured small writer on an 8 GB
 *  Mac, where the 8b's 5 GB would swap). Only the write lane changes: actions and lookups still go to the governed brain. */
export function writerModel(pin, { memBytes = totalmem() } = {}) {
  const p = String(pin ?? '').trim();
  // An Ollama tag: name, owner/name, or a Hugging Face GGUF as hf.co/owner/repo:quant.
  return p.length <= 160 && /^[\w.-]+(\/[\w.-]+){0,2}(:[\w.-]+)?$/.test(p) ? p : (classWriter(memBytes) ?? WRITER_MODEL);
}

// CRM and people nouns: anything about the business's records goes to the governed brain, which has the CRM's tools.
const CRM = /\b(merchants?|leads?|invoices?|proposals?|clover|crm|deals?|job board|schedule|payouts?|pay link|customers?|clients?|the team)\b/i;
const ACT = /^(please\s+)?(send|text|message|whatsapp|e-?mail|call|ring|pay|charge|refund|mark|delete|remove|cancel|book|invite|reply|forward|post|publish|buy|order|transfer|approve|connect)\b/i;
const OPEN = /^(please\s+)?(open|launch|start|go to|pull up|bring up)\b/i;
const IMAGE = /\b(make|draw|generate|create|design|paint|render)\b.{0,40}\b(posters?|logos?|images?|pictures?|photos?|flyers?|banners?|icons?|art|illustrations?|crests?|renders?)\b/i;
const WRITE = /^(please\s+)?(write|draft|summari[sz]e|explain|rewrite|translate|describe|outline|brainstorm|proofread)\b/i;
// LOOKUP is for facts the writer can't know: what changes (news, prices, scores, weather, hours, who holds a post now),
// anything on this Mac (its files, apps, mail, calendar), or an explicit search. A question the writer answers from what
// it knows ("what is the capital of Japan", "who wrote Pride and Prejudice") is NOT a lookup: sending it to web research
// pasted source sentences back instead of an answer (2026-10-18). Those go to the router, which can still say lookup.
const LOOKUP_VERB = /^(please\s+)?(find|search|look up|google|check)\b/i;
const QUESTION = /^(what|what's|whats|who|who's|when|where|which|how many|how much)\b/i;
const LIVE = /\b(today|tonight|yesterday|tomorrow|right now|now|currently|current|latest|recent|recently|this (week|month|year|morning|afternoon|evening|weekend)|last (night|week|weekend|month|year|season)|news|headlines?|prices?|stocks?|shares?|exchange rate|weather|forecast|temperature outside|scores?|won|wins|winning|standings|open (now|today|late)|opening hours|hours|near me|nearby|traffic|flights?|delays?|ceo|president|prime minister|governor|mayor|population|ranking|rankings|record|20\d\d)\b/i;
const MINE = /\b(my|mine|our|ours|this (mac|computer|laptop))\b|\b(files?|folders?|desktop|downloads|calendar|inbox|e-?mails?|messages?|texts?|contacts?|photos?|apps?|disk|battery|memory|storage)\b/i;
const LOOKUP = { test: (t) => LOOKUP_VERB.test(t) || (QUESTION.test(t) && (LIVE.test(t) || MINE.test(t))) };
// A quantity the model can work out itself (a number + a unit to convert) or an explicit calculation — the writer/
// reasoner answers it, it is NOT a fact to web-search. "how many words fit inside 10 million characters" is a calc.
const CALC = /^(how (many|much|long|far)|roughly how|about how)\b[\s\S]{0,90}\b\d[\d,. ]*(million|billion|thousand|hundred|[kmb])?\s*(characters?|words?|letters?|bytes?|[kmg]b|pages?|minutes?|seconds?|hours?|days?|dollars?)\b/i;
const CALC_VERB = /\b(calculate|compute|work (it )?out)\b/i;

// [4.3] A chained instruction ("write the summary, then email it to Yordi") is not one lane's job: routed by
// its first clause alone it lands on the write/image lane, which answers locally and the later steps never
// run. An explicit separator (newline, semicolon, " then ", an arrow) with another imperative after it
// sends the whole turn to the governed brain — the bar splits explicit chains into ordered sub-turns before
// this (lib/turn-chain.mjs), and the engine's planner owns the rest.
const CHAIN_SEPARATOR = /\n|;|\s+then\s+|->|→/i;
const CHAIN_STEP_VERB = /\b(?:send|text|message|e-?mail|call|pay|post|publish|save|open|run|check|probe|test|fetch|search|find|look up|connect|create|make|write|draft|add|book|show|list|read|try|use|ask|ping|start)\b/i;
export function hasChainedSteps(text) {
  const t = String(text || '');
  const m = CHAIN_SEPARATOR.exec(t);
  if (!m) return false;
  return CHAIN_STEP_VERB.test(t.slice(m.index + m[0].length));
}

/** Pure: the lane the rules are sure of, or null. Order matters: actions and CRM records first (they keep their gates). */
export function ruleLane(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  if (ACT.test(t)) return 'act';
  if (OPEN.test(t)) return 'open';
  if (hasChainedSteps(t)) return 'act';
  if (IMAGE.test(t)) return 'image';
  if (CRM.test(t)) return 'act';
  if (WRITE.test(t)) return 'write';
  if (CALC.test(t) || CALC_VERB.test(t)) return 'write';   // a calculation/estimate, before the lookup catch-all
  if (LOOKUP.test(t)) return 'lookup';
  return null;
}

export const ROUTER_SYSTEM = 'Route the command to one lane. write = answer from general knowledge (definitions, history, geography, science, words, math, how things work) or write text. act = send, pay, change records, message people. open = open an app or website. image = make a picture. lookup = facts that change or need a live source (news, prices, scores, weather, opening hours, who holds a post now) or anything on this Mac. Answer ONLY JSON {"lane":"write|act|open|image|lookup"}.';
/** The router reads one short command: a 2k context. Without it Ollama gives the router its default (16k on a 24 GB
 *  Mac), and the 0.6b then holds 2.4 GB for 30 minutes instead of ~0.6 GB (measured with /api/ps, 2026-10-15). */
export const ROUTER_CONTEXT = 2048;
/** The router's reply is held to this schema by Ollama (structured outputs), not just asked for: a small model can only
 *  answer one of the five lanes, so it can't ramble, misspell a lane or start writing the answer itself. */
export const LANE_SCHEMA = Object.freeze({ type: 'object', properties: { lane: { type: 'string', enum: LANES } }, required: ['lane'] });

/** How much of a command the lane deciders (the reflex, the generative router) are shown — and, for a
 *  longer text, WHICH parts: the head and the tail. Both deciders used to read text.slice(0, 1000), so
 *  for a long owner instruction the lane was decided on the background alone: the operative ask sits at
 *  the end ("Now execute…", "also charge their card before you finish"), past the cut, and a payment
 *  could be routed 'write' — handed to the local writer, which can only narrate it, while the governed
 *  brain never saw it (reproduced 2026-10-28; test/fast-route-routing.test.mjs). The view is head+tail
 *  now, and routeLane's long-guard covers the middle no view can show. */
export const ROUTER_VIEW_CHARS = 1000;
/** Pure: the deciders' view of a command — the text itself when it fits, else head + tail. */
export function routingView(text) {
  const t = String(text ?? '');
  if (t.length <= ROUTER_VIEW_CHARS) return t;
  const half = Math.floor(ROUTER_VIEW_CHARS / 2);
  return `${t.slice(0, half)}\n…\n${t.slice(-half)}`;
}

/** The lane for one command: rules, then the reflex (when a producer is wired), then the lightweight router, then
 *  'act'. Never throws.
 *  `reflex` (lib/reflex-producers.mjs) is the decision model asked as a producer — one forward pass over the fixed
 *  lane set, no text generated: a confident verdict (>= 0.9) IS the lane; an escalation lands on 'act', the governed
 *  brain, exactly where an unsure route has always landed; mid confidence and every reflex failure fall through to
 *  the generative router below, which stays this call site's reasoning path. Rules still run first (they carry the
 *  gates: actions and CRM records), and with no producer wired the flow is the pre-reflex one, byte for byte.
 *  `policy` (lib/eviction-policy.mjs, the console's only) admits the router's load through the reflex seat
 *  keeper's pair cap on an active co-residency plan; without one this is the legacy call, unchanged. */
export async function routeLane(text, { model = defaultRouter(), base = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434', timeoutMs = 2500, fetchImpl = fetch, policy = null, reflex = null } = {}) {
  const t0 = Date.now();
  const rule = ruleLane(text);
  if (rule) return { lane: rule, by: 'rule', ms: Date.now() - t0 };
  // THE LONG GUARD: beyond the rules (which read the whole text), every decider sees only routingView.
  // An instruction longer than the view has an unseen middle, so a verdict that would LEAVE the
  // governed brain — 'write' or 'image', the lanes the fast lane executes locally — is the unsure case,
  // and unsure has always meant 'act' (this file's step 4). Verdicts that stay governed (act, lookup,
  // open) keep the decider's word: the brain reads the full text itself.
  const longUnseen = String(text ?? '').length > ROUTER_VIEW_CHARS;
  const guard = (lane, by) => (longUnseen && (lane === 'write' || lane === 'image')
    ? { lane: 'act', by: 'long-guard', ms: Date.now() - t0 }
    : { lane, by, ms: Date.now() - t0 });
  const view = routingView(text);
  if (reflex) {
    try {
      const d = await reflex({ state: { text: view }, questions: { lane: { options: LANES } } });
      const picked = d?.answers?.lane?.option;
      if (d?.disposition === 'auto-proceed' && LANES.includes(picked)) return guard(picked, 'reflex');
      if (d?.disposition === 'escalate') return { lane: 'act', by: 'reflex-escalate', ms: Date.now() - t0 };
    } catch { /* a broken producer never makes routing worse: the generative router below still runs */ }
  }
  try {
    let keepAlive = '30m';
    if (policy) {
      const adm = await policy.admit({ model, intent: 'warm', legacy: '30m' });
      if (!adm.ok) return { lane: 'act', by: 'policy', refused: adm.reason, ms: Date.now() - t0 };
      keepAlive = adm.keepAlive;
    }
    const r = await fetchImpl(`${base.replace(/\/$/, '')}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, stream: false, format: LANE_SCHEMA, think: false, keep_alive: keepAlive, options: { temperature: 0, num_predict: 20, num_ctx: ROUTER_CONTEXT },
        messages: [{ role: 'system', content: ROUTER_SYSTEM }, { role: 'user', content: view }] }),
      signal: AbortSignal.timeout(timeoutMs) });
    // The lane is the first thing it says; a small model sometimes keeps going (writes the haiku itself), so read it from the start.
    const j = r.ok ? await r.json() : null;
    if (j) meter(j, { lane: 'router', kind: 'router', model }); else meterFail({ lane: 'router', kind: 'router', model });
    const lane = /"lane"\s*:\s*"(\w+)"/.exec(j?.message?.content || '')?.[1] ?? null;
    if (LANES.includes(lane)) return guard(lane, 'router');
  } catch (error) { meterFail({ lane: 'router', kind: 'router', model, error }); /* the router is down or slow: the governed brain takes it */ }
  return { lane: 'act', by: 'default', ms: Date.now() - t0 };
}
