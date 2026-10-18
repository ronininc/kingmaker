// lib/instructions.mjs — "How should Kingmaker behave?" and "Guardrails" (Customize → Interaction): the owner teaching
// Kingmaker how to think and what it must and must not do, at the core of every lane. Like ChatGPT's custom instructions,
// but with no limit the owner could reach (the owner, 2026-10-15: "something riddiculous like 10 million").
//
// Two files in the data folder (0600), written by the bar, which then sends "instructions reload": the engine reads them
// once at the first turn and again only after an edit (the owner: "read once if theres a new edit logged otherwise thats
// a waste"). Any language, plain words or code.
//   guardrails.md    — every turn carries all of it (to GUARD_BUDGET; past that, the parts that bear on the turn).
//   instructions.md  — all of it when it fits TURN_BUDGET; otherwise its opening plus the sections that bear on the turn.
//   language         — "auto" (answer in the language the owner used; this Mac's language when it's unclear) or one
//                      language to always answer in (Customize → Language).
//   operating-sop.csv — the business's operating SOP, one workflow per row (header row first: any columns; a
//                      `workflow`/`name`/`process`/`title` column names the row). Kept on the owner's install, never in
//                      this repo. Every turn carries the list of workflow names; the rows that bear on the turn ride
//                      with it, to SOP_BUDGET. Read with the others, at the first turn and on "instructions reload".
// Ten million characters is far more than any model can read at once, hence the selection. A section is a Markdown
// heading's block or a paragraph; relevance is the words (or, for scripts without spaces, the character pairs) it shares
// with the turn.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const MAX_CHARS = 10_000_000;
export const TURN_BUDGET = 6000;     // characters of instructions ahead of a turn (about 1,500 tokens)
export const GUARD_BUDGET = 8000;    // characters of guardrails ahead of a turn
export const SOP_BUDGET = 5000;      // characters of operating-SOP rows ahead of a turn (the list of names rides besides)
const CORE = 1500;                   // the opening of the instructions always rides along

const STOP = new Set('about above after again also always another because been before being below between both could does doing down during each from further have having here hers herself himself into itself just more most myself never only other ought ours ourselves over same shall should some such than that their theirs them themselves then there these they this those through under until very want were what when where which while whom with would your yours yourself yourselves please make sure kingmaker the and for you are can how our was has its but did get got out'.split(' '));
/** Terms of any language: words of letters/digits (3+), and character pairs for scripts written without spaces. */
export function terms(s) {
  const out = new Set();
  for (const m of String(s).toLowerCase().normalize('NFKC').match(/[\p{L}\p{N}][\p{L}\p{N}\p{M}'_-]*/gu) || []) {
    const w = m.replace(/['_-]+$/, ''); // 'find leads' quotes its last word: leads, not leads'
    if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u.test(w)) {
      const cs = [...w]; for (let i = 0; i + 1 < cs.length; i++) out.add(cs[i] + cs[i + 1]); if (cs.length === 1) out.add(w);
    } else if ([...w].length >= 3 && !STOP.has(w)) out.add(w);
  }
  return out;
}

/** Sections: a Markdown heading starts one; otherwise a blank line ends one. Long ones are cut at ~2,000 characters. */
export function split(text) {
  const out = []; let cur = [], at = 0, pos = 0;
  const flush = () => { const body = cur.join('\n').trim(); if (body) out.push({ at, body, terms: terms(body) }); cur = []; };
  for (const line of text.split('\n')) {
    if (/^#{1,6}\s/.test(line) || (!line.trim() && cur.length && !/^#{1,6}\s/.test(cur[0]))) { flush(); at = pos; }
    if (line.trim() || cur.length) cur.push(line);
    if (cur.join('\n').length > 2000) { flush(); at = pos; }
    pos += line.length + 1;
  }
  flush();
  return weigh(out);
}
/** How rare each term is: a word in a few sections says more about them than one in thousands. */
function weigh(out) {
  const df = new Map(); for (const sec of out) for (const w of sec.terms) df.set(w, (df.get(w) || 0) + 1);
  for (const sec of out) { let n = 0; for (const w of sec.terms) n += Math.log(1 + out.length / df.get(w)); sec.norm = Math.sqrt(n + 1); }
  out.idf = (w) => Math.log(1 + out.length / (df.get(w) || out.length));
  return out;
}

/** CSV (RFC 4180: quoted fields, "" inside quotes, newlines inside quotes) → rows of cells. */
export function parseCsv(text) {
  const rows = []; let row = [], cell = '', quoted = false;
  const s = String(text).replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') quoted = false; else cell += c;
    } else if (c === '"' && !cell) quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && s[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim()));
}

/** The SOP's rows as sections (a "## name" heading, then "Column: value" lines) and the list of their names. */
export function sopFromCsv(text) {
  const [head = [], ...body] = parseCsv(text);
  const cols = head.map((h) => h.trim());
  const nameAt = Math.max(0, cols.findIndex((h) => /^(workflow|name|process|title)$/i.test(h)));
  const idAt = cols.findIndex((h) => /^(id|sop[ _-]?id)$/i.test(h));
  const rows = body.map((r) => {
    const name = [idAt >= 0 && idAt !== nameAt ? r[idAt]?.trim() : '', r[nameAt]?.trim()].filter(Boolean).join(' ') || 'Workflow';
    const lines = cols.map((h, i) => (i === nameAt || i === idAt || !r[i]?.trim() ? '' : `${h || `Column ${i + 1}`}: ${r[i].trim()}`)).filter(Boolean);
    return { name, head: terms(r[nameAt] || ''), body: [`## ${name}`, ...lines].join('\n') };
  });
  // One section per row, whatever its length, so a long workflow is never cut away from its name.
  let at = 0;
  const sections = weigh(rows.map((r) => { const s = { at, body: r.body, terms: terms(r.body), head: r.head }; at += r.body.length + 2; return s; }));
  return { names: rows.map((r) => r.name), text: rows.map((r) => r.body).join('\n\n'), sections };
}

const read = (file) => { try { return existsSync(file) ? readFileSync(file, 'utf8').replace(/\r/g, '').slice(0, MAX_CHARS).trim() : ''; } catch { return ''; } };
let cache = null;
/** Read them all now (the first turn, and after each edit the bar reports). */
export function reloadInstructions(stateDir) {
  const text = read(join(stateDir, 'instructions.md')), guard = read(join(stateDir, 'guardrails.md'));
  const language = read(join(stateDir, 'language')).split('\n')[0].slice(0, 60).trim() || 'auto';
  const sop = sopFromCsv(read(join(stateDir, 'operating-sop.csv')));
  cache = { stateDir, text, guard, language, sections: text.length > TURN_BUDGET ? split(text) : [], guardSections: guard.length > GUARD_BUDGET ? split(guard) : [],
    sop };
  return { chars: text.length, guardrailChars: guard.length, language, sopRows: sop.names.length };
}
const load = (stateDir) => { if (!cache || cache.stateDir !== stateDir) reloadInstructions(stateDir); return cache; };

const HEAD_WEIGHT = 3; // a turn word in an SOP row's own name counts three times one in its body
/** The sections that share the most (and rarest) terms with the turn, in the owner's own order, within `room`. */
function relevant(sections, want, room, after = 0) {
  const picked = sections.filter((s) => s.at >= after)
    .map((s) => { let hit = 0; for (const w of want) if (s.terms.has(w)) hit += sections.idf(w) * (s.head?.has(w) ? HEAD_WEIGHT : 1); return { ...s, score: hit / s.norm }; })
    .filter((s) => s.score > 0).sort((a, b) => b.score - a.score);
  const keep = [];
  for (const s of picked) { if (room < 200) break; if (s.body.length + 2 > room) continue; keep.push(s); room -= s.body.length + 2; }
  return keep.sort((a, b) => a.at - b.at).map((s) => s.body);
}

/** The instructions for one turn. */
export function instructionsFor(stateDir, turnText, budget = TURN_BUDGET) {
  const { text, sections } = load(stateDir);
  if (!text || text.length <= budget) return text || '';
  const core = text.slice(0, CORE).replace(/\s+\S*$/, '');
  return [core, ...relevant(sections, terms(turnText), budget - core.length, core.length)].join('\n\n');
}
/** The guardrails for one turn: all of them, unless they're longer than GUARD_BUDGET. */
export function guardrailsFor(stateDir, turnText, budget = GUARD_BUDGET) {
  const { guard, guardSections } = load(stateDir);
  if (!guard || guard.length <= budget) return guard || '';
  return relevant(guardSections, terms(turnText), budget).join('\n\n') || guard.slice(0, budget);
}

const SOP_HEAD = "The owner's operating SOP (how this business works; for work it covers, follow its steps, owners and gates)";
/** The names of every workflow on file, to about 2,000 characters (then how many more). */
const sopList = (names) => {
  let out = 'Workflows on file: ', n = 0;
  for (const name of names) { if (out.length + name.length > 1960) break; out += (n++ ? '; ' : '') + name; }
  return n < names.length ? `${out}; and ${names.length - n} more` : out;
};
/** The SOP for one turn: the list of its workflows, and the rows that bear on the turn (all of them when they fit). */
export function sopFor(stateDir, turnText, budget = SOP_BUDGET) {
  const { sop } = load(stateDir);
  if (!sop.names.length) return '';
  const rows = sop.text.length <= budget ? sop.text : relevant(sop.sections, terms(turnText), budget).join('\n\n');
  return [sopList(sop.names), rows].filter(Boolean).join('\n\n');
}

/** This Mac's language, by name ("English", "Español"…). */
export function macLanguage() {
  try { const tag = Intl.DateTimeFormat().resolvedOptions().locale || 'en'; return new Intl.DisplayNames([tag], { type: 'language' }).of(tag.split('-')[0]) || 'English'; } catch { return 'English'; }
}
/** The language line: a fixed language always; "auto" only where asked (a local model's brief), since the brains
 *  already answer in the language they're addressed in. */
export function languageLine(stateDir, { auto = false } = {}) {
  const { language } = load(stateDir);
  if (language && language !== 'auto') return `Always answer in ${language}, whatever language the owner writes or speaks in.`;
  return auto ? `Answer in the language the owner used in this turn; switch with them the moment they switch. When it's unclear, use ${macLanguage()}.` : '';
}

/** The block that goes ahead of a turn (or into a local model's system brief); '' when the owner has set nothing. */
export function conductFor(stateDir, turnText, { brief = false } = {}) {
  const g = guardrailsFor(stateDir, turnText), i = instructionsFor(stateDir, turnText), l = languageLine(stateDir, { auto: brief });
  const s = sopFor(stateDir, turnText);
  return [
    l,
    g && `The owner's guardrails (hard rules: always keep them, whatever else this turn asks):\n${g}`,
    i && `How the owner wants you to behave and think (their standing instructions):\n${i}`,
    s && `${SOP_HEAD}:\n${s}`,
  ].filter(Boolean).join('\n\n');
}
/**
 * The same block split for a local model (after OpenHuman's cacheable prefix, 2026-10-15): `stable` is its system
 * message and stays the same turn after turn while the owner's settings do, so Ollama reuses what it already read of it
 * instead of reading it again (on an 8 GB Mac that reading is the slow part); `turn` rides ahead of this turn's words and
 * holds only what was picked FOR them: the sections of instructions or guardrails too long to carry whole.
 */
export function conductParts(stateDir, turnText, { brief = true } = {}) {
  const { text, guard, sections, guardSections, sop } = load(stateDir);
  const l = languageLine(stateDir, { auto: brief });
  const guardWhole = guard.length <= GUARD_BUDGET, textWhole = text.length <= TURN_BUDGET;
  const core = textWhole ? text : text.slice(0, CORE).replace(/\s+\S*$/, '');
  const g = guardWhole ? '' : (relevant(guardSections, terms(turnText), GUARD_BUDGET).join('\n\n') || guard.slice(0, GUARD_BUDGET));
  const i = textWhole ? '' : relevant(sections, terms(turnText), TURN_BUDGET - core.length, core.length).join('\n\n');
  const sopWhole = sop.text.length <= SOP_BUDGET;
  const s = sop.names.length ? (sopWhole ? [sopList(sop.names), sop.text].join('\n\n') : sopList(sop.names)) : '';
  const sRows = sop.names.length && !sopWhole ? relevant(sop.sections, terms(turnText), SOP_BUDGET).join('\n\n') : '';
  return {
    stable: [l, guardWhole && guard && `The owner's guardrails (hard rules: always keep them, whatever else this turn asks):\n${guard}`,
      core && `How the owner wants you to behave and think (their standing instructions):\n${core}`,
      s && `${SOP_HEAD}:\n${s}`].filter(Boolean).join('\n\n'),
    turn: [g && `The owner's guardrails that bear on this turn (hard rules: always keep them):\n${g}`,
      i && `More of the owner's standing instructions, for this turn:\n${i}`,
      sRows && `The operating-SOP workflows that bear on this turn:\n${sRows}`].filter(Boolean).join('\n\n'),
  };
}

/** The turn with the owner's guardrails and instructions ahead of it. */
export function withInstructions(stateDir, turnText, framed = turnText) {
  const c = conductFor(stateDir, turnText);
  return c ? `${c}\n\n${framed}` : framed;
}
