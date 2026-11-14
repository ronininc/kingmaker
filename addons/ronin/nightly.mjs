// lib/nightly.mjs — THE OVERNIGHT LOOP: draft at night, one click in the morning (the owner, 2026-10-16: "this is data
// entry and system health monitoring. all other stuff is a daily task" · "draft everything, todo list for one click approval
// when finished for the following day").
//
// Once a night, inside the night window, with the switch on (the owner's own act: `:nightly on`, typed; it ships off):
//   1. HEALTH: the checks the owner listed in <state>/nightly-checks.json (kept on the install, never in this repo): `http`
//      (the page answers 2xx) and `fresh` (a file such as a dock's log was written within N minutes). A failed check
//      becomes a drafted fix.
//   2. DATA ENTRY: the chosen cloud brain (Claude or ChatGPT: never the local model at night) is asked, draft-only, for
//      the day's entries from what it can read through Kingmaker, following the owner's SOP (operating-sop.csv, read
//      through lib/instructions.mjs). Each entry is current → proposed with its source; one without a source is dropped,
//      one without a value becomes a question, and one carrying an SSN- or account-like number is dropped outright.
//   3. THE LIST: Data entry · Health fixes · Questions, saved in <state>/nightly/ (0600), shown in the bar as one card.
// NOTHING IS WRITTEN, SENT OR CHANGED OVERNIGHT. One click (`nightly approve <hash>`) approves exactly the list the
// card showed: the hash binds it, an edit makes a new hash (and a new card), a list older than 36 hours or replaced by
// a newer one is refused. Approved items go to the CRM as jobs (its agents and gates do the writing, each item re-read
// and reported); here every item says Submitted or Failed, never more than is known, and nothing is retried.
// Questions stay on the list until answered (`:nightly answer <n> <text>`); the answers ride into the next night's ask.
//
// USAGE: the loop lives inside the same limits as everything else. Its cloud drafts are metered as kind 'nightly'
// (lib/token-meter.mjs) and capped at MAX_DRAFTS_PER_DAY, scheduled and typed runs together. Approved items reach the CRM
// only through its job route, where Orosolu's share of the agents' usage is enforced: a job the CRM holds because that
// allocation is used up is reported as Held (it runs when the allocation allows), never done on this Mac instead.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const NIGHT_START_HOUR = 1;          // local time: the run starts no earlier than 1 am…
export const NIGHT_END_HOUR = 5;            // …and no later than 5 am
export const LIST_MAX_AGE_MS = 36 * 3600_000;
export const CHECK_TIMEOUT_MS = 15_000;
export const TICK_MS = 5 * 60_000;
export const CLOUD_BRAINS = Object.freeze(['claude', 'chatgpt']);
export const MAX_DRAFTS_PER_DAY = 6;
const FIELD_MAX = 400;

export const nightlyDir = (state) => join(state, 'nightly');
const switchFile = (state) => join(state, 'nightly.json');
const checksFile = (state) => join(state, 'nightly-checks.json');

const writePrivate = (file, value) => {
  writeFileSync(`${file}.tmp`, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
};
const readJson = (file, fallback) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; } };
const clip = (v, n = FIELD_MAX) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const localDate = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

// ── the switch ────────────────────────────────────────────────────────────────────────────────────────────────────────
/** { on, startHour, endHour, lastRun }: off unless the owner turned it on. */
export function readSwitch(state) {
  const s = readJson(switchFile(state), {});
  const hour = (v, d) => (Number.isInteger(v) && v >= 0 && v <= 23 ? v : d);
  const drafts = s.drafts && typeof s.drafts.date === 'string' && Number.isInteger(s.drafts.n) ? s.drafts : { date: '', n: 0 };
  // The loop's own brain (the owner's daytime pick may well be the local model, which never drafts at night).
  const brain = CLOUD_BRAINS.includes(s.brain) ? s.brain : null;
  return { on: s.on === true, startHour: hour(s.startHour, NIGHT_START_HOUR), endHour: hour(s.endHour, NIGHT_END_HOUR), lastRun: typeof s.lastRun === 'string' ? s.lastRun : null, drafts, brain };
}
export function writeSwitch(state, patch) {
  mkdirSync(state, { recursive: true });
  const next = { ...readJson(switchFile(state), {}), ...patch };
  writePrivate(switchFile(state), next);
  return readSwitch(state);
}
/** Pure: which brain drafts at night: the loop's own setting, else the daytime brain when it is a cloud one, else Claude. */
export const nightBrain = (saved, daytime) => saved ?? (CLOUD_BRAINS.includes(daytime) ? daytime : 'claude');
/** Pure: is `hour` inside [start, end)? A window may wrap midnight (e.g. 23 → 4). */
export function inWindow(hour, startHour = NIGHT_START_HOUR, endHour = NIGHT_END_HOUR) {
  return startHour <= endHour ? hour >= startHour && hour < endHour : hour >= startHour || hour < endHour;
}
/** Pure: which night's window `ms` falls in, named by the date the window opened. A wrapped window (23 → 4) is one
 *  night: its after-midnight hours belong to the evening before, so the loop runs once per window, not once per date. */
export function windowNight(ms, startHour = NIGHT_START_HOUR, endHour = NIGHT_END_HOUR) {
  const wraps = startHour > endHour;
  return localDate(wraps && new Date(ms).getHours() < endHour ? ms - 86_400_000 : ms);
}

/** Pure: `:nightly …` (typed) or the bar's `nightly …` control line → { op, … }, or null for anything else. */
export function nightlyCommand(line) {
  const t = String(line ?? '').trim();
  const m = /^:?nightly(?:\s+(.*))?$/i.exec(t);
  if (!m) return null;
  const rest = String(m[1] ?? '').trim();
  if (!rest || /^status$/i.test(rest)) return { op: 'status' };
  if (/^(on|off|show|run|later)$/i.test(rest)) return { op: rest.toLowerCase() };
  const b = /^brain\s+(claude|chatgpt)$/i.exec(rest);
  if (b) return { op: 'brain', brain: b[1].toLowerCase() };
  let a = /^approve(?:\s+([0-9a-f]{16,64}))?(?:\s+(?:skip|except|but)\s+([\d,\s]+))?$/i.exec(rest);
  if (a) return { op: 'approve', hash: a[1]?.toLowerCase() ?? null, skip: String(a[2] ?? '').split(/[,\s]+/).filter(Boolean) };
  a = /^(edit|answer)\s+(\d+)\s+([\s\S]+)$/i.exec(rest);
  if (a) return { op: a[1].toLowerCase(), id: a[2], text: clip(a[3]) };
  return { op: 'help' };
}

// ── health ────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** The owner's checks, validated: [{ name, kind: 'http', url } | { name, kind: 'fresh', file, maxAgeMinutes }], each with
 *  an optional `fix` (what to do when it fails). Anything malformed is left out (and named in `skipped`). */
export function readChecks(state) {
  const raw = readJson(checksFile(state), []);
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.checks) ? raw.checks : [];
  const checks = [], skipped = [];
  for (const c of list.slice(0, 50)) {
    const name = clip(c?.name, 80), fix = clip(c?.fix);
    if (c?.kind === 'http' && /^https?:\/\/[^\s]+$/i.test(String(c.url ?? ''))) checks.push({ name: name || c.url, kind: 'http', url: c.url, fix });
    else if (c?.kind === 'fresh' && typeof c.file === 'string' && c.file && Number(c.maxAgeMinutes) > 0) checks.push({ name: name || c.file, kind: 'fresh', file: c.file, maxAgeMinutes: Number(c.maxAgeMinutes), fix });
    else skipped.push(name || '(unnamed)');
  }
  return { checks, skipped };
}

/** Run each check once: [{ name, ok, detail, fix }]. Read-only: a GET and a file's timestamp, nothing else. */
export async function runChecks(checks, { fetchImpl = globalThis.fetch, stat = statSync, now = Date.now, timeoutMs = CHECK_TIMEOUT_MS } = {}) {
  const out = [];
  for (const c of checks) {
    if (c.kind === 'http') {
      try {
        const r = await fetchImpl(c.url, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
        out.push({ name: c.name, ok: r.status >= 200 && r.status < 300, detail: `answered ${r.status}`, fix: c.fix });
      } catch (e) { out.push({ name: c.name, ok: false, detail: `did not answer (${clip(e?.name === 'TimeoutError' ? 'timed out' : e?.message, 120)})`, fix: c.fix }); }
    } else if (c.kind === 'fresh') {
      try {
        const age = (now() - stat(c.file).mtimeMs) / 60_000;
        out.push({ name: c.name, ok: age <= c.maxAgeMinutes, detail: `last written ${Math.round(age)} min ago (limit ${c.maxAgeMinutes})`, fix: c.fix });
      } catch { out.push({ name: c.name, ok: false, detail: 'its file is missing', fix: c.fix }); }
    }
  }
  return out;
}

// ── the drafts ────────────────────────────────────────────────────────────────────────────────────────────────────────
// Never drafted, never stored, never shown: an SSN (123-45-6789) or EIN (12-3456789) shape, a card-length run of digits
// (13–19), or any number in a field about SSNs, EINs, tax IDs, IDs, bank/routing/account/card numbers or void checks.
// Phone numbers and 12-digit MIDs (the tracker's row key) stay: they are ordinary data entry.
const SENSITIVE_SHAPE = /\b\d{3}-\d{2}-\d{4}\b|\b\d{2}-\d{7}\b|\d(?:[\s-]?\d){12,18}/;
const SENSITIVE_TOPIC = /\b(ssn|social security|ein|tax ?id|tin|itin|routing|account (?:no|num|number)|acct|bank(?:ing)? (?:no|num|number|account|info|details)|card (?:no|num|number)|cvv|void(?:ed)? check|driver'?s? licen[cs]e|passport|id (?:no|num|number)|date of birth|dob)\b/i;
const isSensitive = (text, topic = '') => SENSITIVE_SHAPE.test(text) || (SENSITIVE_TOPIC.test(topic) && /\d{4,}/.test(text));

/** Pure: the ask for the night's data entry. `sop` is the owner's own SOP text for it; `answers` are last night's
 *  answered questions. */
export function draftPrompt({ sop = '', answers = [], date }) {
  return [
    `Overnight data entry for ${date}. DRAFT ONLY: do not change, write, send, approve or propose anything. Only read.`,
    'Using only facts you can read now through Kingmaker (kingmaker_turn for the CRM), list the entries that should be made from today\'s work.',
    'Reply with a JSON array and nothing else. Each element: {"target": where it goes (record or sheet row), "field": which field, "current": its value now, "proposed": the new value, "source": where you read the fact, "owner": who owns the next action}.',
    'Leave "proposed" empty when you are not sure: it becomes a question for the owner. Never guess a value. Never include a bank, card, routing, ID, SSN or EIN number. If there is nothing to enter, reply [].',
    sop && `The owner's SOP for this:\n${sop}`,
    answers.length ? `The owner answered these questions:\n${answers.map((a) => `- ${a.q} → ${a.answer}`).join('\n')}` : '',
  ].filter(Boolean).join('\n\n');
}

/** Pure: the brain's reply → { items: [{ target, field, current, proposed, source, owner }], questions: [text], dropped: [why] }. */
export function parseDrafts(text) {
  const s = String(text ?? '');
  const at = s.indexOf('['), end = s.lastIndexOf(']');
  let arr = null;
  if (at >= 0 && end > at) { try { arr = JSON.parse(s.slice(at, end + 1)); } catch { arr = null; } }
  if (!Array.isArray(arr)) return { items: [], questions: [], dropped: s.trim() ? ['the brain did not answer with a list'] : [] };
  const items = [], questions = [], dropped = [];
  for (const e of arr.slice(0, 200)) {
    if (!e || typeof e !== 'object') { dropped.push('an entry that was not an object'); continue; }
    const d = { target: clip(e.target, 200), field: clip(e.field, 120), current: clip(e.current), proposed: clip(e.proposed), source: clip(e.source, 300), owner: clip(e.owner, 60) };
    if (Object.values(d).some((v) => isSensitive(v, `${d.target} ${d.field}`))) { dropped.push(`an entry for ${d.target || 'a record'} carried a sensitive number and was left out`); continue; }
    if (!d.target) { dropped.push('an entry with no target'); continue; }
    if (!d.source) { dropped.push(`an entry for ${d.target} had no source`); continue; }
    if (!d.proposed) { questions.push(`${d.target}${d.field ? ` · ${d.field}` : ''}: what should it be? (seen: ${d.current || 'blank'}; source: ${d.source})`); continue; }
    items.push(d);
  }
  return { items, questions, dropped };
}

// ── the list ──────────────────────────────────────────────────────────────────────────────────────────────────────────
const approvable = (it) => it.group !== 'question';
/** Pure: the hash one click approves: this night's list (its creation time), every approvable item exactly as shown, in
 *  order. Two nights that drafted the same items still have different hashes, so an old card never approves a new list. */
export function listHash(items, createdAt = '') {
  const canon = items.filter(approvable).map((i) => [i.id, i.group, i.target, i.field ?? '', i.current ?? '', i.proposed, i.source ?? '', i.owner ?? '']);
  return createHash('sha256').update(JSON.stringify([String(createdAt), canon])).digest('hex').slice(0, 32);
}

/** Pure: build the night's list. */
export function buildList({ now, health = [], drafts = { items: [], questions: [], dropped: [] }, questions = [] }) {
  const items = [];
  const add = (o) => items.push({ id: String(items.length + 1), ...o });
  for (const d of drafts.items) add({ group: 'data', ...d });
  for (const h of health.filter((x) => !x.ok)) add({ group: 'fix', target: h.name, field: '', current: h.detail, proposed: h.fix || `Find out why ${h.name} ${h.detail} and put it right`, source: `health check, ${new Date(now).toISOString()}`, owner: '' });
  for (const q of [...questions, ...drafts.questions]) add({ group: 'question', target: clip(q), field: '', current: '', proposed: '', source: '', owner: '' });
  const list = { date: localDate(now), created_at: new Date(now).toISOString(), status: 'open', items,
    checked: health.length, healthy: health.filter((h) => h.ok).length, dropped: drafts.dropped ?? [] };
  return { ...list, hash: listHash(items, list.created_at) };
}

/** Pure: the owner edits one item's proposed value: a new list, a new hash (so the old card can't approve it). */
export function editItem(list, id, text) {
  const it = list.items.find((i) => i.id === String(id));
  if (!it || !approvable(it)) return { ok: false, error: it ? 'a question is answered, not edited' : `there is no item ${id}` };
  if (isSensitive(text, `${it.target} ${it.field}`)) return { ok: false, error: 'that holds a sensitive number; it never goes on the list' };
  const items = list.items.map((i) => (i === it ? { ...i, proposed: clip(text), edited: true } : i));
  return { ok: true, list: { ...list, items, hash: listHash(items, list.created_at) } };
}

/** Pure: answer a question (it stays on the list, answered, and rides into the next night's ask). */
export function answerItem(list, id, text) {
  const it = list.items.find((i) => i.id === String(id));
  if (!it || it.group !== 'question') return { ok: false, error: `item ${id} is not a question` };
  if (isSensitive(text, it.target)) return { ok: false, error: 'that holds a sensitive number; it never goes on the list' };
  return { ok: true, list: { ...list, items: list.items.map((i) => (i === it ? { ...i, answer: clip(text) } : i)) } };
}

/** Pure: may this click approve this list? → { ok, approved: items } or { ok: false, error }. */
export function approveList(list, { hash, skip = [] } = {}, now = Date.now()) {
  if (!list) return { ok: false, error: 'there is no list to approve' };
  if (list.status !== 'open') return { ok: false, error: `that list is already ${list.status}` };
  if (!hash) return { ok: false, error: `approving needs the list's code, so it is exactly the list you saw: look at it (:nightly show), then type :nightly approve ${list.hash}${skip.length ? ` skip ${skip.join(',')}` : ''}` };
  if (hash !== list.hash) return { ok: false, error: 'the list changed since that card was shown; look at the new one' };
  if (now - Date.parse(list.created_at) > LIST_MAX_AGE_MS) return { ok: false, error: 'that list is more than a day and a half old; tonight\'s run drafts it again' };
  const skipped = new Set(skip.map(String));
  return { ok: true, approved: list.items.filter((i) => approvable(i) && !skipped.has(i.id)), skipped: [...skipped] };
}

/** The approved items → the CRM, one job per group. submit(group, items) → { ok, taskId?, error? }. Never retried. */
export async function applyApproved(approved, { submit }) {
  const results = [];
  for (const group of ['data', 'fix']) {
    const items = approved.filter((i) => i.group === group);
    if (!items.length) continue;
    const r = await Promise.resolve(submit(group, items)).catch((e) => ({ ok: false, error: String(e?.message || e) }));
    for (const it of items) results.push({ id: it.id, status: r?.ok ? (r.held ? 'Held' : 'Submitted') : 'Failed',
      detail: r?.ok ? (r.held ? `job ${r.taskId}, held by the CRM: ${clip(r.held, 160)}` : `job ${r.taskId}`) : clip(r?.error || 'not submitted', 200) });
  }
  return results;
}

/** Pure: the job's words for one group of approved items. */
export function jobRequest(group, items) {
  const lines = items.map((i) => `${i.id}. ${i.target}${i.field ? ` · ${i.field}` : ''}: ${i.current || '(blank)'} → ${i.proposed}${i.source ? ` (source: ${i.source})` : ''}${i.owner ? ` [${i.owner}]` : ''}`).join('\n');
  return group === 'data'
    // "update … in the CRM": the job needs the CRM's own data and hands, so the CRM gives it to an agent that acts, never to
    // a writer that only writes words (a writer can't make an entry, and could only claim one).
    ? { request: `Update the records in the CRM and the shared sheets: the ${items.length} owner-approved overnight entr${items.length === 1 ? 'y' : 'ies'}, exactly as written`,
      detail: `The owner approved exactly these entries. Make each one and nothing else. If a field's value is no longer the "current" shown, do not change it: report it as Stale. After each, read it back and report it as Updated, Verified, Stale or Failed. Do not retry a failed one.\n\n${lines}` }
    : { request: `Update and fix, from the CRM: the ${items.length} owner-approved overnight health finding${items.length === 1 ? '' : 's'}`,
      detail: `The owner approved working on exactly these. Use safe, reversible steps only; anything that sends, pays, deploys or changes settings comes back to the owner as a tap. Report each as Fixed, Still broken or Needs the owner.\n\n${lines}` };
}

const GROUPS = [['data', 'Data entry'], ['fix', 'Health fixes'], ['question', 'Questions']];
/** Pure: the list as text (bar or console). */
export function listText(list) {
  if (!list) return 'No overnight list yet.';
  const out = [`Overnight list for ${list.date} (${list.status})${list.checked ? ` · ${list.healthy}/${list.checked} health checks OK` : ''}`];
  for (const [g, title] of GROUPS) {
    const items = list.items.filter((i) => i.group === g);
    if (!items.length) continue;
    out.push('', `${title}:`);
    for (const i of items) {
      if (g === 'question') out.push(`  ${i.id}. ${i.target}${i.answer ? ` — answered: ${i.answer}` : ''}`);
      else out.push(`  ${i.id}. ${i.target}${i.field ? ` · ${i.field}` : ''}: ${i.current || '(blank)'} → ${i.proposed}${i.edited ? ' (edited)' : ''}${i.source ? `\n      source: ${i.source}` : ''}${i.result ? `\n      ${i.result.status}: ${i.result.detail}` : ''}`);
    }
  }
  if (list.dropped?.length) out.push('', `Left out: ${list.dropped.join('; ')}.`);
  if (list.status === 'open' && list.items.some(approvable)) out.push('', `Approve all in one click on the card, or type :nightly approve ${list.hash} (add skip 2,3 to leave some out) · :nightly edit 2 <new value> · :nightly answer 4 <answer>.`);
  return out.join('\n');
}

/** Pure: the bar's one-click card (the same card as the sharing box, with its own words and commands), or null when
 *  there's nothing to approve. */
export function approvalCard(list) {
  if (!list || list.status !== 'open') return null;
  const n = (g) => list.items.filter((i) => i.group === g).length;
  const data = n('data'), fixes = n('fix'), qs = n('question');
  if (!data && !fixes) return null;
  const parts = [data && `${data} entr${data === 1 ? 'y' : 'ies'}`, fixes && `${fixes} health fix${fixes === 1 ? '' : 'es'}`].filter(Boolean).join(' and ');
  return {
    kind: 'nightly', title: `Last night's list: ${parts}`,
    body: `Drafted overnight; nothing has been changed yet.${qs ? ` ${qs} question${qs === 1 ? '' : 's'} for you too.` : ''}`,
    sharedLabel: 'Approving does: ', shared: 'each item goes to the CRM exactly as drafted, and comes back read and reported',
    neverLabel: 'Never: ', never: 'anything not on this list, a sent message, a payment or a changed setting',
    yes: 'Approve all', no: 'Not now', see: 'See the list',
    yesCommand: `nightly approve ${list.hash}`, noCommand: 'nightly later', seeCommand: 'nightly show',
  };
}

// ── the store ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const listFile = (state, date) => join(nightlyDir(state), `list-${date}.json`);
export function saveList(state, list) { mkdirSync(nightlyDir(state), { recursive: true, mode: 0o700 }); writePrivate(listFile(state, list.date), list); return list; }
/** The newest list (open or not), or null. */
export function latestList(state) {
  try {
    const files = readdirSync(nightlyDir(state)).filter((f) => /^list-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
    return files.length ? readJson(join(nightlyDir(state), files.at(-1)), null) : null;
  } catch { return null; }
}

/**
 * The loop. draft(prompt) → the brain's reply text, or null when no cloud brain is available; sop() → the owner's SOP
 * text for the night's work; submit(group, items) → { ok, taskId | error }; card(list|null) and note(text) reach the bar;
 * meeting() / busy() → true holds the run; brainName() → the lane in use.
 */
export function createNightly({ state, draft, sop = () => '', submit, card = () => {}, note = () => {}, brainName = () => 'local',
  meeting = () => false, busy = () => false, log = () => {}, now = Date.now, fetchImpl, stat, every = TICK_MS,
  setIntervalImpl = setInterval, clearIntervalImpl = clearInterval } = {}) {
  let timer = null, running = false, approving = false;

  async function runNow({ manual = false } = {}) {
    if (running) return { ok: false, error: 'already running' };
    running = true;
    try {
      const t = now();
      const prev = latestList(state);
      const { checks, skipped } = readChecks(state);
      const health = await runChecks(checks, { fetchImpl, stat, now });
      const answers = (prev?.items ?? []).filter((i) => i.group === 'question' && i.answer).map((i) => ({ q: i.target, answer: i.answer }));
      const carried = prev?.status === 'open' ? prev.items.filter((i) => i.group === 'question' && !i.answer).map((i) => i.target) : [];
      let drafts = { items: [], questions: [], dropped: [] };
      const used = readSwitch(state).drafts, today = localDate(t), n = used.date === today ? used.n : 0;
      if (CLOUD_BRAINS.includes(brainName()) && n >= MAX_DRAFTS_PER_DAY) {
        drafts.dropped.push(`no data drafts: the ${MAX_DRAFTS_PER_DAY} cloud drafts allowed today are used`);
      } else if (CLOUD_BRAINS.includes(brainName())) {
        writeSwitch(state, { drafts: { date: today, n: n + 1 } });
        const reply = await Promise.resolve(draft(draftPrompt({ sop: sop(), answers, date: localDate(t) }))).catch(() => null);
        drafts = reply == null ? { items: [], questions: [], dropped: [`the ${brainName()} brain did not answer, so there are no data drafts tonight`] } : parseDrafts(reply);
      } else carried.push('Overnight data entry needs the Claude or ChatGPT brain (the local model never runs it). Which one should it use?');
      if (skipped.length) drafts.dropped.push(`health checks not understood: ${skipped.join(', ')}`);
      // Last night's list is done with: whatever wasn't approved is checked again now, never carried forward blind.
      if (prev?.status === 'open' && prev.date !== localDate(t)) saveList(state, { ...prev, status: 'expired' });
      const list = saveList(state, buildList({ now: t, health, drafts, questions: [...new Set(carried)] }));
      if (!manual) { const s = readSwitch(state); writeSwitch(state, { lastRun: windowNight(t, s.startHour, s.endHour) }); }
      log('nightly_run', { date: list.date, data: list.items.filter((i) => i.group === 'data').length, fixes: list.items.filter((i) => i.group === 'fix').length,
        questions: list.items.filter((i) => i.group === 'question').length, checked: list.checked, healthy: list.healthy, manual });
      card(approvalCard(list));
      note(`Overnight list ready: ${list.items.length ? listText(list).split('\n')[0] : 'nothing to enter, every check passed'}.`);
      return { ok: true, list };
    } finally { running = false; }
  }

  function tick() {
    const s = readSwitch(state), t = now();
    if (!s.on || running || s.lastRun === windowNight(t, s.startHour, s.endHour) || !inWindow(new Date(t).getHours(), s.startHour, s.endHour)) return;
    if (meeting() || busy()) { log('nightly_held', { why: meeting() ? 'meeting' : 'busy' }); return; }
    void runNow().catch((e) => log('nightly_error', { error: clip(e?.message || e, 200) }));
  }

  async function approve({ hash, skip = [] } = {}) {
    // One approval at a time, and the list is claimed (saved as 'submitting') before anything goes out: a second click or
    // a pasted repeat is refused instead of sending the same entries twice. A list cut off mid-submit stays 'submitting'
    // (never resubmitted blind); the owner sees it and tonight's run drafts afresh.
    if (approving) return { ok: false, error: 'that list is already being submitted' };
    approving = true;
    try {
      const list = latestList(state);
      const ok = approveList(list, { hash, skip }, now());
      if (!ok.ok) return ok;
      saveList(state, { ...list, status: 'submitting' });
      return await submitApproved(list, ok);
    } finally { approving = false; }
  }

  async function submitApproved(list, ok) {
    const results = await applyApproved(ok.approved, { submit });
    const by = new Map(results.map((r) => [r.id, r]));
    const done = saveList(state, { ...list, status: 'approved', approved_at: new Date(now()).toISOString(), skipped: ok.skipped,
      items: list.items.map((i) => (by.has(i.id) ? { ...i, result: { status: by.get(i.id).status, detail: by.get(i.id).detail } } : i)) });
    log('nightly_approved', { date: done.date, submitted: results.filter((r) => r.status === 'Submitted').length, held: results.filter((r) => r.status === 'Held').length, failed: results.filter((r) => r.status === 'Failed').length, skipped: ok.skipped.length });
    card(null);
    return { ok: true, list: done, results };
  }

  function change(fn, id, text) {
    const list = latestList(state);
    if (!list || list.status !== 'open') return { ok: false, error: 'there is no open list' };
    const r = fn(list, id, text);
    if (!r.ok) return r;
    saveList(state, r.list);
    card(approvalCard(r.list));
    return r;
  }

  return {
    runNow, approve, tick,
    edit: (id, text) => change(editItem, id, text),
    answer: (id, text) => change(answerItem, id, text),
    current: () => latestList(state),
    /** On launch: an undecided list from last night shows its card again. */
    resume() { const l = latestList(state); if (l?.status === 'open' && now() - Date.parse(l.created_at) <= LIST_MAX_AGE_MS) card(approvalCard(l)); },
    status() {
      const s = readSwitch(state), l = latestList(state);
      return `Overnight loop ${s.on ? `on (runs once between ${s.startHour}:00 and ${s.endHour}:00` + `${s.lastRun ? `; last ran ${s.lastRun}` : ''})` : 'off (type :nightly on to start it)'}; brain: ${brainName()}${CLOUD_BRAINS.includes(brainName()) ? '' : ' (data entry needs Claude or ChatGPT)'}; health checks: ${readChecks(state).checks.length}${l ? `; latest list ${l.date}, ${l.status}` : ''}.`;
    },
    start() { if (!timer) { timer = setIntervalImpl(tick, every); timer?.unref?.(); } },
    stop() { if (timer) clearIntervalImpl(timer); timer = null; },
  };
}

export const CHECKS_EXAMPLE = Object.freeze([
  { name: 'Company site', kind: 'http', url: 'https://example.com/', fix: 'Check the site deploy and its domain' },
  { name: 'Desk dock log', kind: 'fresh', file: '/path/to/dock.log', maxAgeMinutes: 30, fix: 'Restart the dock' },
]);
export const checksPath = checksFile;
export const hasChecks = (state) => existsSync(checksFile(state));
