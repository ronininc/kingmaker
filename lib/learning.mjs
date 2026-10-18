// lib/learning.mjs — Kingmaker's learning switch (Ronin's personal-assistant build, part 1: the personalization memory,
// lib/personalization.mjs). Clean-room: no OpenJarvis code (non-commercial license), only Kingmaker's own memory.
//
// ON BY DEFAULT (owner, 2026-10-15: "learning on … by default … it needs to be able to learn, period"). Only the owner's
// own "learning off" (typed in the bar or said) turns it off, and that turn writes the consent record; "learning on" turns
// it back on. KINGMAKER_LEARNING=off turns it off for a whole install. While on, every owner turn is offered to the memory; it learns HOW the
// owner wants work done, never WHAT Kingmaker may do (the store refuses anything that would widen authority, and redacts
// secrets).
//   • A repeated request or correction becomes a candidate: Kingmaker asks once; only the owner's "keep that" makes it
//     standing ("drop that" declines).
//   • Standing preferences shape how the local models answer (brief()) and are exported for the CRM dock (crm-export.json),
//     which files them in the team's shared memory so the agents read them. Only confirmed preferences leave this Mac:
//     never raw turns, candidates or refusals. "learning off" stops learning and empties the export.
//   • The owner's words: "learning on" / "learning off", "what have you learned" (/memory), "where did you learn …",
//     "forget what you learned about …".
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { openPersonalization } from './personalization.mjs';

const atomic = (file, body) => { writeFileSync(file + '.tmp', body); renameSync(file + '.tmp', file); };
const readJson = (file, fallback) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; } };

/** Pure: is this turn plainly English? (Latin letters only, and not reading as Spanish.) The offer is worded in English,
 *  so a turn in another language never gets it. */
export function plainEnglish(text) {
  const t = String(text || '');
  if (/[^\u0000-\u024f\s\p{P}\p{S}\p{N}]/u.test(t)) return false;          // another script (Japanese, Arabic, Cyrillic…)
  if (/[ñ¿¡áéíóú]/i.test(t)) return false;
  const words = t.toLowerCase().match(/[a-z]+/g) || [];
  const es = words.filter((w) => /^(el|la|los|las|una?|de|del|con|en|es|para|por|que|sobre|escribe|hazlo|quiero|dame)$/.test(w)).length;
  return es < 2;
}

/** Pure: the owner's learning words, or null. */
export function learningWords(text) {
  const t = String(text || '').trim().replace(/[.!?]+$/, '');
  let m;
  if ((m = /^(?:learning|learn) (on|off)$/i.exec(t))) return { op: m[1].toLowerCase() };
  if (/^\/?memory$|^what (have|did) you learn(ed)?( about me)?$/i.test(t)) return { op: 'summary' };
  if ((m = /^where did you learn( that| about)?\s*(.*)$/i.exec(t))) return { op: 'where', q: m[2].trim() };
  if ((m = /^(?:\/forget|forget what you learned about)\s+(.+)$/i.exec(t))) return { op: 'forget', q: m[1].trim() };
  if (/^(yes,?\s+)?keep (that|it)( as a standing preference)?$/i.test(t)) return { op: 'keep' };
  if (/^(no,?\s+)?(drop|don'?t keep) (that|it)$/i.test(t)) return { op: 'drop' };
  return null;
}

/** This install's learning store: 'owner', unless the install already learned under an earlier tenant an add-on names. */
export function defaultTenant(state, exists = existsSync, legacy = []) {
  return ['owner', ...legacy].find((t) => exists(join(state, 'personalization', t))) ?? 'owner';
}

export function openLearning({ state, tenant = defaultTenant(state), env = process.env, now = () => new Date().toISOString(), log = () => {} }) {
  const root = join(state, 'personalization', tenant);
  const consentPath = join(root, 'consent.json'), exportPath = join(root, 'crm-export.json');
  // On unless the owner said "learning off" (a consent record with on:false), or the install turned it off.
  const enabled = () => env.KINGMAKER_LEARNING !== 'off' && readJson(consentPath, { on: true }).on !== false;
  // Until the owner has said either way, the first question about keeping something says learning is on and how to stop it.
  const byDefault = () => !existsSync(consentPath);
  let store = null, asking = null; // asking: the candidate subject Kingmaker last asked about
  const open = () => (store ||= (mkdirSync(root, { recursive: true }), openPersonalization({ root, tenant, now })));

  const exportForCrm = () => {
    if (!existsSync(root)) return;
    const prefs = enabled() ? Object.entries(open().memory().preferences).map(([subject, p]) => ({ subject, statement: p.statement, polarity: p.polarity, at: p.at })) : [];
    atomic(exportPath, JSON.stringify({ tenant, on: enabled(), updated_at: now(), preferences: prefs }, null, 1));
  };
  const daily = () => {
    const today = now().slice(0, 10);
    if (existsSync(join(root, 'alignment', `${today}.md`))) return;
    try { open().enforceRetention(); open().synthesize(today); } catch (e) { log('learning_synthesis_failed', { error: String(e?.message || e) }); }
  };
  if (enabled()) { daily(); exportForCrm(); }

  // THE OFFER, rationed (soak 2026-10-15: "keep that?" after nearly every turn read as spam): each subject is offered at
  // most once ever, at most one offer a day, and never on a turn that isn't plainly English (the offer is worded in
  // English). Candidates still gather quietly; "what have you learned" lists them.
  const offersPath = join(root, 'offers.json');
  const mayOffer = (subject, text) => {
    const o = readJson(offersPath, { lastAt: null, asked: {} });
    if (o.asked?.[subject]) return false;
    if (o.lastAt && Date.parse(now()) - Date.parse(o.lastAt) < 24 * 3600_000) return false;
    return plainEnglish(text);
  };
  const markOffered = (subject) => {
    const o = readJson(offersPath, { lastAt: null, asked: {} });
    o.lastAt = now(); o.asked = { ...(o.asked || {}), [subject]: o.lastAt };
    atomic(offersPath, JSON.stringify(o, null, 1));
  };
  /** Offer one owner turn to the memory (only when the owner has it on). Returns a line to say when a new candidate wants
   *  the owner's word (rationed: mayOffer), else null. */
  function learn(text, source) {
    if (!enabled() || !String(text || '').trim()) return null;
    try {
      const r = open().ingest({ tenant, consent: true, actor: 'owner', source, text: String(text).slice(0, 2000), at: now() });
      daily();
      if (/^preference-/.test(r.outcome)) exportForCrm();
      log('learning_learned', { tags: r.tags, outcome: r.outcome }); // tags and outcome only, never the text
      if (r.outcome === 'candidate') {
        const [subject, c] = Object.entries(open().memory().candidates).sort(([, a], [, b]) => String(b.at).localeCompare(String(a.at)))[0] || [];
        if (subject && mayOffer(subject, text)) {
          asking = subject; markOffered(subject);
          const notice = byDefault() ? ' (Learning is on by default. Say "learning off" to stop it.)' : '';
          return `I've noticed this ${c.reason.replace(/×$/, ' times')}: "${c.statement.slice(0, 160)}". Want me to keep that as a standing preference? Say "keep that" or "drop that".${notice}`;
        }
      }
    } catch (e) { log('learning_ingest_refused', { error: String(e?.message || e).slice(0, 200) }); }
    return null;
  }

  /** The owner's learning words (called only with the owner's own typed or spoken turn). Returns the answer, or null. */
  function handle(text, how = 'typed') {
    const w = learningWords(text); if (!w) return null;
    if (w.op === 'on' || w.op === 'off') {
      mkdirSync(root, { recursive: true });
      atomic(consentPath, JSON.stringify({ on: w.op === 'on', at: now(), by: 'owner', how: `${how}: "learning ${w.op}"` }, null, 1));
      exportForCrm();
      return w.op === 'on' ? 'Learning is on. I learn how you like things done, never what I may do, and I ask before keeping anything.' : 'Learning is off, and so is sharing what I learn. To erase what I learned here too, say "forget what you learned about …".';
    }
    if (!existsSync(root)) return 'Learning is off: say "learning on" to let me learn how you like things done.';
    const mem = open().memory();
    if (w.op === 'summary') {
      const prefs = Object.values(mem.preferences), cands = Object.values(mem.candidates);
      if (!prefs.length && !cands.length) return `Nothing learned yet${enabled() ? '' : ' (learning is off)'}. I learn from what you repeat or correct, and ask before keeping it.`;
      return [prefs.length ? `Standing: ${prefs.map((p) => p.statement).join(' · ')}` : '', cands.length ? `Waiting for your word: ${cands.map((c) => c.statement).join(' · ')}` : ''].filter(Boolean).join('\n');
    }
    if (w.op === 'where') {
      const hit = open().whereLearned(w.q || asking || '');
      if (!hit) return 'I have nothing learned about that.';
      return `That's a ${hit.kind}, from ${hit.learned_from.length} thing${hit.learned_from.length === 1 ? '' : 's'} you said: ${hit.learned_from.slice(-3).map((s) => `${String(s.at).slice(0, 10)} (${s.source}) "${String(s.text).slice(0, 80)}"`).join('; ')}.`;
    }
    if (w.op === 'forget') {
      try { const n = open().forget(w.q); exportForCrm(); return n ? `Forgotten: everything I learned about ${w.q}.` : `I had nothing learned about ${w.q}.`; } catch (e) { return String(e.message); }
    }
    if (w.op === 'keep' || w.op === 'drop') {
      if (!asking || !mem.candidates[asking]) return null; // not answering a learning question: let the turn through
      const r = open().decideCandidate(asking, { approve: w.op === 'keep', by: 'owner', at: now() }); asking = null; exportForCrm();
      if (r?.refused) return `I can't keep that one: ${r.why}.`;
      return w.op === 'keep' ? `Kept: ${r.statement}` : 'Dropped.';
    }
    return null;
  }

  /** The standing preferences as prompt lines for the local models ('' when there are none or learning is off). */
  const brief = () => {
    if (!enabled()) return '';
    const prefs = Object.values(open().memory().preferences).slice(-12);
    return prefs.length ? `The owner's standing preferences (how to present work; they never change what you may do):\n${prefs.map((p) => `- ${p.statement}`).join('\n')}` : '';
  };

  /** The kept preferences ({statement, polarity}) for community sharing, which maps them to closed kinds on this Mac (the
   *  words never leave). Empty while learning is off. */
  function kept() {
    if (!enabled()) return [];
    try { return Object.values(open().memory().preferences || {}).map((p) => ({ statement: String(p.statement || ''), polarity: p.polarity })); } catch { return []; }
  }
  return { learn, handle, brief, enabled, kept, exportPath, root };
}
