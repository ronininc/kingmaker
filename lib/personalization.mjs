// lib/personalization.mjs — Kingmaker's continuous personalization memory (Jarvis build order, part 1, 2026-10-13).
//
// It learns HOW the owner wants Kingmaker to work, never WHAT Kingmaker may do:
//   • Ingests only authorized owner-interaction events handed to it (no passive capture, no meeting content).
//   • Tags corrections, verbosity feedback, repeated requests, approvals and rejections.
//   • Keeps curated durable memory (memory.json), dated daily notes (daily/YYYY-MM-DD.md) and a people/group index.
//     Every claim is concise, dated and points at its source event; a newer explicit statement supersedes an older one.
//   • The same request three times, or the same correction twice, becomes a standing-preference CANDIDATE (the owner
//     confirms it). An explicit "always/never/from now on" is recorded with its source; a conflicting one supersedes.
//   • A preference that would widen authority (skip an approval, auto-send/pay/buy, touch credentials) is refused:
//     learning never changes permissions or substitutes for an approval.
//   • Never stores credentials, codes or card data: such text is redacted before anything is written.
//   • A nightly local synthesis (alignment/YYYY-MM-DD.md) is read at session start; whereLearned() answers
//     "where did you learn that?" with the exact source events.
//   • Tenant-isolated (one store per tenant root; a foreign-tenant event throws), with retention and deletion.
// Pure Node, local-first, no model calls. Not wired into the runtime here: activation is a separate, consented switch.

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export const REQUEST_REPEAT_THRESHOLD = 3;
export const CORRECTION_REPEAT_THRESHOLD = 2;
export const DEFAULT_RETENTION_DAYS = 90;
const SOURCES = new Set(['voice', 'chat', 'cli', 'review', 'agent']); // where an authorized owner turn may come from

// ── secrets: never stored ────────────────────────────────────────────────────────────────────────────────
const luhn = (digits) => { let sum = 0, alt = false; for (let i = digits.length - 1; i >= 0; i--) { let n = +digits[i]; if (alt) { n *= 2; if (n > 9) n -= 9; } sum += n; alt = !alt; } return sum % 10 === 0; };
const SECRET_PATTERNS = [
  // Known credential shapes.
  /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{8,}\b/g, /\bsk-[A-Za-z0-9_-]{16,}\b/g, /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bxox[abpr]-[A-Za-z0-9-]{10,}\b/g, /\bAKIA[0-9A-Z]{16}\b/g, /\bronin_[a-z]+_[A-Za-z0-9_]{16,}\b/g,
  /\beyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]{5,}/g,                                   // JWT
  /\b\d{3}-\d{2}-\d{4}\b/g,                                                   // US SSN
  /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){3,7}(?: ?[A-Z0-9]{1,3})?\b/g,             // IBAN
  // Passwords and passphrases may contain spaces. Consume the assigned phrase through punctuation/end, not only its
  // first word; the narrower label list avoids treating ordinary prose such as "the secret to good tacos" as secret.
  /\b(?:password|passwd|passphrase|pw)\s*(?:is|:|=|was)\s*[^\n,;.!?]+/gi,
  // Other credential labels are normally single-token values: "the code is 381920", "token: abc".
  /\b(?:passcode|pin|otp|2fa|cvv|cvc|verification code|security code|one[- ]time code|login code|code|api key|access key|secret key|token|secret|routing(?: number)?|account(?: number)?)\s*(?:is|:|=|was)\s*\S+/gi,
  // A short numeric code next to its context: "enter 381920 to log in", "use 4821 to verify".
  /\b(?:enter|use|type|code|otp)\s+\d{4,8}\b(?=[^.]{0,30}\b(?:log ?in|sign ?in|verify|verification|confirm|unlock|code)\b)/gi,
  /\b(?:account|acct|routing)(?:\s+(?:number|no\.?|#))?\s*\d{6,17}\b/gi,                     // bank account / routing
  /\blogin\s+\S+\s*\/\s*\S+/gi,                                              // "login ana / hunter2"
  // A long mixed-case-and-digit run (a generated key), but not a lowercase hex SHA or a path.
  /\b(?=[A-Za-z0-9_-]{32,}\b)(?=[^\s/]*[A-Z])(?=[^\s/]*[a-z])(?=[^\s/]*\d)[A-Za-z0-9_-]{32,}\b/g,
];
export function redactSecrets(text) {
  let out = String(text ?? ''), hit = false;
  // Card numbers: 13–19 digits in card-like grouping, Luhn-valid, with a card-issuer leading digit.
  out = out.replace(/\b[3-6]\d{3}(?:[ -]?\d{3,4}){2,4}\b/g, (m) => { const d = m.replace(/\D/g, ''); if (d.length >= 13 && d.length <= 19 && luhn(d)) { hit = true; return '[card redacted]'; } return m; });
  for (const re of SECRET_PATTERNS) out = out.replace(re, () => { hit = true; return '[secret redacted]'; });
  return { text: out, redacted: hit };
}

// ── tagging ──────────────────────────────────────────────────────────────────────────────────────────────
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
const EXPLICIT = /^(?:please\s+)?(?:always|never|from now on|every time|going forward)\b/i;
const CORRECTION = /^(?:no[,.!]?\s|nope\b|wrong\b|that'?s (?:not|wrong)|not what i|actually[, ]|i said\b|i meant\b|instead[, ]|don'?t\b.*\b(?:instead|but)\b)/i;
const SHORTER = /\b(?:too long|shorter|more concise|less detail|be brief|tl;?dr|get to the point|too wordy)\b/i;
const LONGER = /\b(?:too short|more detail|elaborate|explain more|go deeper)\b/i;
const APPROVE = /^(?:yes\b|yep\b|approve[d]?\b|go ahead\b|do it\b|ship it\b|looks good\b|lgtm\b|perfect\b|that'?s right\b)/i;
const REJECT = /^(?:no,? don'?t\b|reject(?:ed)?\b|cancel\b|stop\b|don'?t do (?:that|it)\b|not that\b)/i;
// Learned preferences may only shape PRESENTATION (format, length, order, wording, units, what to lead with). Any
// statement that names a gated action, a permission, or acting for the owner is refused: learning never changes what
// Kingmaker may do, and never stands in for an approval. Deliberately broad; a refused preference is still recorded.
const AUTHORITY = /\b(?:pay(?:s|ing|ment|ments)?|paid|invoices?|refunds?|charge[sd]?|buy|bought|purchase[sd]?|orders?|transfer(?:s|red)?|wire[sd]?|send(?:s|ing)?|sent|repl(?:y|ies|ying)|respond(?:s|ing)?|e-?mail(?:s|ing)?|text(?:s|ing)? (?:them|him|her|clients?|leads?)|messag(?:e|es|ing)|dms?|post(?:s|ing)?|publish(?:es|ing)?|tweet|approv(?:e|es|ed|al|als|ing)|pre-?approved|permission|authori[sz](?:e|ed|ation)|merg(?:e|es|ed|ing)|deploy(?:s|ed|ing|ments?)?|releas(?:e|es|ing)|push(?:es|ing)? to|delet(?:e|es|ed|ing)|remov(?:e|es|ing) (?:files?|data|records?)|cancel(?:s|led|ling)?|sign(?:s|ed|ing)?\b(?! in)|accept(?:s|ed|ing)?|agree(?:s|d|ing)? to|terms|confirm(?:s|ed|ing|ation)?|without (?:asking|checking|me)|(?:don'?t|do not|stop|no need to) (?:ask|check|wait|confirm)|wait(?:ing)? for (?:me|my)|on my behalf|silence|book(?:s|ed|ing)?|schedul(?:e|es|ed|ing)|call (?:them|him|her|clients?|leads?)|trad(?:e|es|ing)|log ?in|passwords?|credentials?|api keys?)\b/i;

export function tagEvent(text) {
  const t = String(text ?? '').trim();
  const tags = [];
  if (EXPLICIT.test(t)) tags.push('explicit');
  if (CORRECTION.test(t)) tags.push('correction');
  if (SHORTER.test(t)) tags.push('verbosity:shorter'); else if (LONGER.test(t)) tags.push('verbosity:longer');
  if (APPROVE.test(t)) tags.push('approval'); else if (REJECT.test(t)) tags.push('rejection');
  if (!tags.length) tags.push('request');
  return tags;
}
const LEAD = /^(?:please\s+|always\s+|never\s+|from now on[, ]*|every time[, ]*|going forward[, ]*|no[,.!]?\s+|nope[, ]*|actually[, ]*|i said[, ]*|i meant[, ]*|instead[, ]*)+/i;
const subjectOf = (text) => norm(String(text).replace(LEAD, ''));
const polarityOf = (text) => (/^(?:please\s+)?(?:(?:from now on|every time|going forward)[, ]*)?(?:never|don'?t|do not)\b/i.test(String(text).trim()) ? 'never' : 'always');
const tokens = (s) => new Set(norm(s).split(' ').filter(Boolean));
const covers = (key, q) => { const k = tokens(key); return q.size > 0 && [...q].every((t) => k.has(t)); };
const idOf = (...parts) => createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 16);

// ── the store ────────────────────────────────────────────────────────────────────────────────────────────
export function openPersonalization({ root, tenant, now = () => new Date().toISOString(), retentionDays = DEFAULT_RETENTION_DAYS }) {
  if (!root || !tenant || !/^[a-z0-9-]{1,40}$/.test(tenant)) throw new Error('personalization needs a root and an exact tenant id');
  mkdirSync(join(root, 'daily'), { recursive: true }); mkdirSync(join(root, 'alignment'), { recursive: true });
  const memPath = join(root, 'memory.json'), eventsPath = join(root, 'events.jsonl');
  const blank = { tenant, preferences: {}, candidates: {}, refused: {}, counts: { request: {}, correction: {} }, people: {}, chains: {}, verbosity: [] };
  let mem = existsSync(memPath) ? JSON.parse(readFileSync(memPath, 'utf8')) : blank;
  if (mem.tenant !== tenant) throw new Error(`store belongs to tenant ${mem.tenant}, not ${tenant}`);
  const atomic = (file, body) => { writeFileSync(file + '.tmp', body); renameSync(file + '.tmp', file); };
  const save = () => atomic(memPath, JSON.stringify(mem, null, 1));
  const events = () => (existsSync(eventsPath) ? readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }) : []);
  const writeEvents = (list) => atomic(eventsPath, list.map((ev) => JSON.stringify(ev) + '\n').join(''));
  const day = (iso) => String(iso).slice(0, 10);
  const note = (iso, line) => appendFileSync(join(root, 'daily', `${day(iso)}.md`), `- ${String(iso).slice(11, 16)} ${line}\n`);
  // Provenance travels with the claim, so "where did you learn that?" survives raw-event retention.
  const snap = (rec) => ({ id: rec.id, at: rec.at, source: rec.source, text: rec.text });
  const refuse = (subject, rec, why) => { mem.refused[subject] = { text: rec.text, at: rec.at, source: rec.id, sources: [snap(rec)], why }; return 'refused-authority'; };
  const AUTH_WHY = 'preferences only shape presentation; they never change permissions or replace an approval';

  /** Ingest one authorized owner-interaction event. Returns { id, tags, outcome } or throws on a boundary violation. */
  function ingest(e) {
    if (e?.tenant !== tenant) throw new Error('event tenant does not match this store');
    if (e.consent !== true) throw new Error('only consented owner-interaction events are ingested');
    if (e.actor !== 'owner' && e.kind !== 'fix') throw new Error('only the owner\'s own turns (or an agent fix record) are ingested');
    if (!SOURCES.has(e.source)) throw new Error(`unknown event source: ${e.source}`);
    if (e.kind === 'fix' && !e.in_reply_to) throw new Error('a fix record must answer a correction (in_reply_to)');
    const at = e.at || now();
    const { text, redacted } = redactSecrets(e.text);
    const tags = e.kind === 'fix' ? ['fix'] : tagEvent(text);
    const priorEvents = events();
    const target = e.in_reply_to ? priorEvents.find((ev) => ev.id === e.in_reply_to) : null;
    if (e.in_reply_to && !target) throw new Error('in_reply_to must name a known event');
    if (e.kind === 'fix' && !target.tags?.includes('correction')) throw new Error('a fix record must answer a correction');
    if ((tags.includes('approval') || tags.includes('rejection')) && e.in_reply_to && !target.tags?.includes('fix')) throw new Error('an owner reaction must answer a fix');
    const safeRef = e.ref == null ? null : redactSecrets(e.ref).text.slice(0, 200);
    const metadataRedacted = e.ref != null && safeRef !== String(e.ref).slice(0, 200);
    const id = idOf(tenant, at, text, String(e.id ?? ''), String(priorEvents.length));
    const rec = { id, at, source: e.source, ref: safeRef, in_reply_to: e.in_reply_to ?? null, tags, text: text.slice(0, 500), ...((redacted || metadataRedacted) ? { redacted: true } : {}) };
    appendFileSync(eventsPath, JSON.stringify(rec) + '\n');
    let outcome = 'logged';
    const subject = subjectOf(text);
    const gated = AUTHORITY.test(text);

    if (tags.includes('fix')) { mem.chains[e.in_reply_to] = { ...(mem.chains[e.in_reply_to] || {}), fix: id, fix_at: at }; outcome = 'fix-linked'; }
    if ((tags.includes('approval') || tags.includes('rejection')) && e.in_reply_to) {
      const chain = Object.entries(mem.chains).find(([, c]) => c.fix === e.in_reply_to);
      if (chain) { chain[1].reaction = tags.includes('approval') ? 'approved' : 'rejected'; chain[1].reaction_id = id; chain[1].reaction_at = at; outcome = 'reaction-linked'; }
    }
    if (tags.includes('verbosity:shorter') || tags.includes('verbosity:longer')) { mem.verbosity.push({ at, want: tags.find((x) => x.startsWith('verbosity:')).slice(10), source: id }); mem.verbosity = mem.verbosity.slice(-50); outcome = 'verbosity'; }

    if (tags.includes('explicit') && subject) {
      if (redacted) outcome = refuse(subject, rec, 'contained secret material');
      else if (gated) outcome = refuse(subject, rec, AUTH_WHY);
      else {
        const prev = mem.preferences[subject];
        mem.preferences[subject] = { statement: rec.text, polarity: polarityOf(text), at, source: id, sources: [snap(rec)], kind: 'explicit',
          history: prev ? [...(prev.history || []), { statement: prev.statement, polarity: prev.polarity, at: prev.at, source: prev.source, superseded_at: at }] : [] };
        delete mem.candidates[subject];
        outcome = prev ? (prev.statement === rec.text ? 'preference-confirmed' : 'preference-superseded') : 'preference-recorded';
      }
    } else if (tags.includes('correction') && subject) {
      if (e.in_reply_to || safeRef) mem.chains[id] = { correction: id, correction_at: at, about: safeRef ?? e.in_reply_to };
      const c = (mem.counts.correction[subject] ||= { n: 0, sources: [] }); c.n += 1; c.sources.push(snap(rec));
      outcome = 'correction';
      if (c.n >= CORRECTION_REPEAT_THRESHOLD && !mem.preferences[subject]) {
        if (gated || redacted) outcome = refuse(subject, rec, redacted ? 'contained secret material' : AUTH_WHY);
        else { mem.candidates[subject] = { statement: rec.text, reason: `same correction ${c.n}×`, at, sources: [...c.sources] }; outcome = 'candidate'; }
      }
    } else if (tags.includes('request') && subject) {
      const c = (mem.counts.request[subject] ||= { n: 0, sources: [] }); c.n += 1; c.sources.push(snap(rec));
      if (c.n >= REQUEST_REPEAT_THRESHOLD && !mem.preferences[subject]) {
        if (gated || redacted) outcome = refuse(subject, rec, redacted ? 'contained secret material' : AUTH_WHY);
        else { mem.candidates[subject] = { statement: rec.text, reason: `same request ${c.n}×`, at, sources: [...c.sources] }; outcome = 'candidate'; }
      }
    }
    for (const p of Array.isArray(e.people) ? e.people.slice(0, 20) : []) {
      const rawName = String(p?.name ?? '').trim().slice(0, 80);
      const rawGroup = String(p?.group ?? '').trim().slice(0, 60);
      const safeName = redactSecrets(rawName), safeGroup = redactSecrets(rawGroup);
      // Credential-shaped metadata is not a usable identity. Do not create an index entry whose name or group had
      // to be redacted, and never persist the original metadata value.
      if (!rawName || safeName.redacted || safeGroup.redacted) continue;
      const name = safeName.text;
      const entry = (mem.people[norm(name)] ||= { name, groups: [], first_seen: at, sources: [] });
      if (safeGroup.text && !entry.groups.includes(safeGroup.text)) entry.groups.push(safeGroup.text);
      entry.last_seen = at; entry.sources = [...entry.sources, id].slice(-10);
    }
    note(at, `[${tags.join(',')}] ${outcome} (source ${id})`); // ids and tags only: no raw text in daily notes
    save();
    return { id, tags, outcome };
  }

  /** The owner confirms (or declines) a candidate. Only the owner's explicit yes makes it standing, and the authority
   *  rule is re-checked at that moment too. */
  function decideCandidate(subject, { approve, by, at = now() }) {
    const c = mem.candidates[subject]; if (!c) return null;
    if (by !== 'owner') throw new Error('only the owner confirms a standing preference');
    delete mem.candidates[subject];
    if (approve && AUTHORITY.test(c.statement)) { mem.refused[subject] = { text: c.statement, at, source: c.sources.at(-1)?.id, sources: c.sources, why: AUTH_WHY }; save(); return { refused: subject, why: AUTH_WHY }; }
    if (approve) mem.preferences[subject] = { statement: c.statement, polarity: polarityOf(c.statement), at, source: c.sources.at(-1)?.id, sources: c.sources, kind: 'confirmed-candidate', history: [] };
    save(); return approve ? mem.preferences[subject] : { declined: subject };
  }

  /** "Where did you learn that?" → the exact source events behind a preference, candidate or refusal. */
  function whereLearned(query) {
    const q = tokens(query); if (!q.size) return null;
    for (const [kind, bucket] of [['preference', mem.preferences], ['candidate', mem.candidates], ['refused', mem.refused]]) {
      const hit = Object.entries(bucket).find(([k]) => covers(k, q)); if (!hit) continue;
      return { kind, subject: hit[0], learned_from: hit[1].sources ?? [], superseded: hit[1].history ?? [] };
    }
    return null;
  }

  /** Nightly local synthesis, read at session start. Deterministic: same memory → same file. */
  function synthesize(date = day(now())) {
    const lines = [`# Kingmaker alignment synthesis — ${date} (${tenant})`, '', 'Learned preferences shape how I present work. They never change what I may do: every approval and gate stands.', ''];
    const prefs = Object.entries(mem.preferences).sort(([a], [b]) => a.localeCompare(b));
    lines.push('## Standing preferences', ...(prefs.length ? prefs.map(([, p]) => `- ${p.statement} — ${p.polarity}, since ${day(p.at)} [source ${p.source}]${p.history?.length ? ` (supersedes ${p.history.length} earlier)` : ''}`) : ['- none yet']), '');
    const cands = Object.values(mem.candidates);
    lines.push('## Candidates waiting for the owner', ...(cands.length ? cands.map((c) => `- ${c.statement} — ${c.reason} [sources ${c.sources.map((x) => x.id).join(', ')}]`) : ['- none']), '');
    const refused = Object.values(mem.refused);
    if (refused.length) lines.push('## Refused (would have changed authority)', ...refused.map((r) => `- ${r.text} — ${r.why} [source ${r.source}]`), '');
    const recent = mem.verbosity.slice(-5);
    if (recent.length) lines.push('## Verbosity', `- latest: ${recent.at(-1).want} (${recent.length} recent signals) [source ${recent.at(-1).source}]`, '');
    const chains = Object.values(mem.chains).filter((c) => c.correction);
    if (chains.length) lines.push('## Corrections → fix → owner reaction', ...chains.map((c) => `- ${c.correction} → ${c.fix ?? 'no fix yet'} → ${c.reaction ?? 'no reaction yet'}`), '');
    const people = Object.values(mem.people);
    if (people.length) lines.push('## People and groups', ...people.map((p) => `- ${p.name}${p.groups.length ? ` (${p.groups.join(', ')})` : ''} — last seen ${day(p.last_seen)}`), '');
    const file = join(root, 'alignment', `${date}.md`);
    atomic(file, lines.join('\n'));
    return file;
  }

  /** What a new session reads first: the latest synthesis (or null). */
  function startupBrief() {
    const files = readdirSync(join(root, 'alignment')).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort();
    return files.length ? { date: files.at(-1).slice(0, 10), text: readFileSync(join(root, 'alignment', files.at(-1)), 'utf8') } : null;
  }

  /** Deletion: forget a subject everywhere: memory, counts, chains, people refs, verbosity, events, daily notes and
   *  syntheses. Matches whole words (every word of the query), never a substring; a query under 3 letters is refused. */
  function forget(query) {
    const q = tokens(query);
    if (!q.size || norm(query).length < 3) throw new Error('forget needs a specific subject (3+ letters)');
    const goneIds = new Set(events().filter((ev) => covers(ev.text, q)).map((ev) => ev.id));
    let n = 0;
    for (const bucket of [mem.preferences, mem.candidates, mem.refused, mem.counts.request, mem.counts.correction]) {
      for (const [k, v] of Object.entries(bucket)) {
        if (covers(k, q)) { (v.sources || []).forEach((x) => goneIds.add(x.id ?? x)); if (v.source) goneIds.add(v.source); delete bucket[k]; n++; }
      }
    }
    for (const [k, c] of Object.entries(mem.chains)) if ([k, c.correction, c.fix, c.reaction_id].some((x) => goneIds.has(x))) delete mem.chains[k];
    mem.verbosity = mem.verbosity.filter((v) => !goneIds.has(v.source));
    for (const [key, p] of Object.entries(mem.people)) {
      const matchingPerson = covers(p.name, q) || p.groups.some((group) => covers(group, q));
      p.sources = p.sources.filter((id) => !goneIds.has(id));
      if (matchingPerson || !p.sources.length) { delete mem.people[key]; n++; }
    }
    writeEvents(events().filter((ev) => !goneIds.has(ev.id)));
    for (const dir of ['daily', 'alignment']) for (const f of readdirSync(join(root, dir)).filter((x) => x.endsWith('.md'))) {
      const file = join(root, dir, f), body = readFileSync(file, 'utf8');
      const kept = body.split('\n').filter((line) => ![...goneIds].some((id) => line.includes(id)) && !covers(line, q)).join('\n');
      if (kept !== body) atomic(file, kept);
    }
    save(); return n;
  }

  /** Retention: drop raw events and daily notes older than the window. Curated claims keep their own short
   *  provenance snapshot, so where-learned answers survive. */
  function enforceRetention(at = now()) {
    const cutoff = new Date(new Date(at).getTime() - retentionDays * 86400000).toISOString();
    const all = events(), kept = all.filter((ev) => ev.at >= cutoff);
    writeEvents(kept);
    const keptIds = new Set(kept.map((ev) => ev.id));
    for (const bucket of [mem.counts.request, mem.counts.correction]) {
      for (const [subject, count] of Object.entries(bucket)) {
        count.sources = (count.sources || []).filter((source) => keptIds.has(source.id ?? source));
        if (!count.sources.length) delete bucket[subject];
        else count.n = count.sources.length;
      }
    }
    for (const f of readdirSync(join(root, 'daily')).filter((x) => /^\d{4}-\d{2}-\d{2}\.md$/.test(x))) if (f.slice(0, 10) < cutoff.slice(0, 10)) rmSync(join(root, 'daily', f));
    save();
    return all.length - kept.length;
  }

  return { ingest, decideCandidate, whereLearned, synthesize, startupBrief, forget, enforceRetention, memory: () => structuredClone(mem) };
}
