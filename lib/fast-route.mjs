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
import { isSelfContainedReasoningPrompt } from './direct-reasoning.mjs';
import { floorRole } from './mac-profiles.mjs';
import { meter, meterFail } from './token-meter.mjs';

export const LANES = ['write', 'act', 'open', 'image', 'lookup'];
export const ROUTER_MODEL = 'huihui_ai/qwen3-abliterated:1.7b';
export const WRITER_MODEL = 'huihui_ai/qwen3-abliterated:8b';
/** The pre-pick router default: the starter floor's router (lib/mac-profiles.mjs FLOOR_ROLES) — the
 *  same on every Mac. These defaults are only what the fast lane uses before a per-task pick exists
 *  (and the router's offline default); the smallest-sufficient selector picks per task. Customize →
 *  Router overrides it. */
export const defaultRouter = () => floorRole('router') ?? ROUTER_MODEL;

/** Pure: the model the write lane uses — the local model the owner pinned in the bar's picker (an Ollama tag), else
 *  the starter floor's writer (the measured small writer, identical on every Mac). Only the write lane
 *  changes: actions and lookups still go to the governed brain. */
export function writerModel(pin) {
  const p = String(pin ?? '').trim();
  // An Ollama tag: name, owner/name, or a Hugging Face GGUF as hf.co/owner/repo:quant.
  return p.length <= 160 && /^[\w.-]+(\/[\w.-]+){0,2}(:[\w.-]+)?$/.test(p) ? p : (floorRole('writer') ?? WRITER_MODEL);
}

// CRM records go to the governed brain only when the owner is acting on them ("draft a proposal
// for the merchant"), not when the words appear in an explanation or a story.
const CRM = /\b(draft|send|show|list|update|add|create|open|pull|log|mark)\b[\s\S]{0,48}\b(merchants?|leads?|invoices?|proposals?|deals?|customers?|clients?|payouts?|clover|crm)\b|\b(my|our)\s+(merchants?|leads?|invoices?|proposals?|deals?|customers?|clients?|payouts?|schedule|team)\b|\b(job board|pay link)\b/i;
// External actions. Ambiguous English ("pay attention", "order these steps", "mark the differences",
// "reply with the number") is not an action. Those stay with the model.
const ACT_SURE = /^(?:please\s+)?(?:send|text|message|whatsapp|e-?mail|buy|refund)\b/i;
const ACT_PAY = /^(?:please\s+)?pay\b(?!\s+attention\b)/i;
const ACT_CHARGE = /^(?:please\s+)?charge\b/i;
const ACT_CHARGE_OBJECT = /\b(card|invoice|customer|account|\$|dollars?)\b/i;
const ACT_CALL = /^(?:please\s+)?(?:call|ring)\b/i;
const ACT_NAMED = /\b(mom|dad|him|her|them|me|phone)\b|\b[A-Z][a-z]{2,}\b/;
const ACT_FILE = /^(?:please\s+)?(?:delete|remove)\b[\s\S]{0,40}\b(files?|folders?|apps?|e-?mails?|messages?)\b/i;
const ACT_BOOK = /^(?:please\s+)?book\b[\s\S]{0,40}\b(tables?|flights?|rooms?|tickets?|appointments?)\b/i;
function isExplicitAct(t) {
  if (ACT_SURE.test(t) || ACT_PAY.test(t)) return true;
  if (ACT_CHARGE.test(t) && ACT_CHARGE_OBJECT.test(t)) return true;
  if (ACT_CALL.test(t) && ACT_NAMED.test(t) && !/\bfunctions?\b/i.test(t)) return true;
  if (ACT_FILE.test(t) || ACT_BOOK.test(t)) return true;
  return false;
}
const OPEN = /^(please\s+)?(open|launch|start|go to|pull up|bring up)\b/i;
const IMAGE = /\b(make|draw|generate|create|design|paint|render)\b.{0,40}\b(posters?|logos?|images?|pictures?|photos?|flyers?|banners?|icons?|art|illustrations?|crests?|renders?)\b/i;
// "make a list of pictures" and "a story about a poster" are writing, not a picture to draw.
function isImageAsk(t) {
  if (!IMAGE.test(t)) return false;
  if (/\b(list of|story about|essay|paragraph|poem about|explain|describe|what|which)\b/i.test(t) && !/\b(posters?|logos?|flyers?|banners?|icons?|illustrations?|crests?)\b/i.test(t)) return false;
  return true;
}
const WRITE = /^(please\s+)?(write|draft|summari[sz]e|explain|rewrite|translate|describe|outline|brainstorm|proofread)\b/i;
// LOOKUP is for facts the writer can't know: what changes (news, prices, scores, weather, hours, who holds a post now),
// anything on this Mac (its files, apps, mail, calendar), or an explicit search. A question the writer answers from what
// it knows ("what is the capital of Japan", "who wrote Pride and Prejudice") is NOT a lookup: sending it to web research
// pasted source sentences back instead of an answer (2026-10-18). Those go to the router, which can still say lookup.
const LOOKUP_VERB = /^(please\s+)?(find|search|look up|google|check)\b/i;
const QUESTION = /^(what|what's|whats|who|who's|when|where|which|how many|how much)\b/i;
// Live facts only. Bare "now", "current", "score", "hours", "record", or a year stole math and
// puzzles ("what is 2000 times 15", "what's the score of this riddle") into web search.
const LIVE = /\b(today|tonight|yesterday|tomorrow|right now|currently|latest|recent|recently|this (week|month|year|morning|afternoon|evening|weekend)|last (night|week|weekend|month|year|season)|news|headlines?|prices?|stocks?|shares?|exchange rate|weather|forecast|temperature outside|won|wins|winning|standings|open (now|today|late)|opening hours|near me|nearby|traffic|flights?|delays?|ceo|president|prime minister|governor|mayor|population|ranking|rankings)\b/i;
// This Mac only when the owner says it is theirs. Bare "files" or "memory" is a general question.
const MINE = /\b(?:my|mine|our|ours)\s+(?:files?|folders?|desktop|downloads|calendar|inbox|e-?mails?|messages?|texts?|contacts?|photos?|apps?|disk|battery|memory|storage)\b|\b(?:on|in)\s+(?:my|our)\s+(?:desktop|downloads|calendar|inbox|mac|computer|laptop)\b|\bthis\s+(?:mac|computer|laptop)\b/i;
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
// The next clause has to START with a tool imperative. "then the last line starts" is still one
// piece of writing; "then check Stripe" is a second action.
const CHAIN_STEP_LEAD = /^(?:please\s+|and\s+|then\s+)?(?:send|text|message|e-?mail|pay|post|publish|open|run|check|probe|test|fetch|search|find|look\s+up|connect|book|delete|install|scan)\b/i;
export function hasChainedSteps(text) {
  const t = String(text || '');
  const m = CHAIN_SEPARATOR.exec(t);
  if (!m) return false;
  return CHAIN_STEP_LEAD.test(t.slice(m.index + m[0].length).trim());
}

/** Pure: the lane the rules are sure of, or null. Order matters: actions and CRM records first (they keep their gates). */
export function ruleLane(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  if (isExplicitAct(t)) return 'act';
  if (OPEN.test(t)) return 'open';
  if (hasChainedSteps(t)) return 'act';
  if (isImageAsk(t)) return 'image';
  if (CRM.test(t)) return 'act';
  if (WRITE.test(t)) return 'write';
  if (CALC.test(t) || CALC_VERB.test(t)) return 'write';   // a calculation/estimate, before the lookup catch-all
  if (isSelfContainedReasoningPrompt(t)) return 'write';   // a closed puzzle is local text, never a web lookup
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
  if (reflex) {
    try {
      const d = await reflex({ state: { text: String(text).slice(0, 1000) }, questions: { lane: { options: LANES } } });
      const picked = d?.answers?.lane?.option;
      if (d?.disposition === 'auto-proceed' && LANES.includes(picked)) return { lane: picked, by: 'reflex', ms: Date.now() - t0 };
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
        messages: [{ role: 'system', content: ROUTER_SYSTEM }, { role: 'user', content: String(text).slice(0, 1000) }] }),
      signal: AbortSignal.timeout(timeoutMs) });
    // The lane is the first thing it says; a small model sometimes keeps going (writes the haiku itself), so read it from the start.
    const j = r.ok ? await r.json() : null;
    if (j) meter(j, { lane: 'router', kind: 'router', model }); else meterFail({ lane: 'router', kind: 'router', model });
    const lane = /"lane"\s*:\s*"(\w+)"/.exec(j?.message?.content || '')?.[1] ?? null;
    if (LANES.includes(lane)) return { lane, by: 'router', ms: Date.now() - t0 };
  } catch (error) { meterFail({ lane: 'router', kind: 'router', model, error }); /* the router is down or slow: the governed brain takes it */ }
  return { lane: 'act', by: 'default', ms: Date.now() - t0 };
}
