// The wake word, cemented at install (operator 2026-10-08: "the wake word is chosen on the install screen and
// cemented at install; to change it you delete and reinstall").
//
// Kingmaker Installer writes <data dir>/install.json once, read-only (0444), with the word typed on its screen
// (default "Kingmaker"), plus <data dir>/wake-word.txt ("Hey <word>"), which is how the engine's server learns its own
// name (assistant-identity.ts: the wake word IS the name). Nothing in Kingmaker offers to change either file.
//
// A Mac that ran Sol Ghost before there was an installer has no install.json: that is a LEGACY install. It wakes on
// the default word ("Kingmaker"), and also still on "ghost" ("hey ghost", "Sol Ghost, ..."), which the operator has
// been saying. Once a word is cemented, "ghost" no longer wakes it: only the cemented word and its mishearings do.
//
// The data dir is still ~/Library/Application Support/sol-ghost (it holds the vault and the knowledge index; never
// moved). Pure except the `read` default.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const INSTALL_CONFIG_FILE = 'install.json';
export const WAKE_PHRASE_FILE = 'wake-word.txt';
export const INSTALL_SCHEMA = 'kingmaker.install/1';
export const DEFAULT_WAKE_WORD = 'Kingmaker';
export const WAKE_WORD_RULE = '1 to 3 words, letters only';
// A wake word that is itself a command word would fight the commands it wakes ("yes", "cancel", "stop").
const RESERVED = new Set(['yes', 'no', 'cancel', 'stop', 'quit', 'exit', 'ok', 'okay', 'hey', 'hi', 'sleep', 'wake', 'wake up', 'mute', 'go', 'go ahead', 'confirm']);
const GREETINGS = ['hey', 'ok', 'okay', 'hi', 'yo'];

/**
 * Pure: is this a wake word Kingmaker can cement? 1–3 words of ASCII letters (2–20 each, 32 characters at most), not
 * a command word. The installer's screen, its engine (installer/engine.sh) and this check apply the same rule.
 * → { ok: true, word } (whitespace collapsed, the casing as typed) or { ok: false, reason }.
 */
export function validateWakeWord(raw) {
  const word = String(raw ?? '').trim().replace(/\s+/g, ' ');
  if (!word) return { ok: false, reason: 'Type a wake word (1 to 3 words, letters only).' };
  if (word.length > 32) return { ok: false, reason: 'Keep the wake word under 32 letters.' };
  const words = word.split(' ');
  if (words.length > 3) return { ok: false, reason: 'Use 1 to 3 words.' };
  if (!words.every((w) => /^[A-Za-z]+$/.test(w))) return { ok: false, reason: 'Letters only: no digits, punctuation or accents.' };
  if (words.some((w) => w.length < 2 || w.length > 20)) return { ok: false, reason: 'Each word needs 2 to 20 letters.' };
  if (RESERVED.has(word.toLowerCase())) return { ok: false, reason: `"${word}" is a command word; pick a name.` };
  return { ok: true, word };
}

/**
 * The cemented install, or why there is none. `state` = the data dir (paths.state).
 * → { cemented: true, wakeWord, release, cementedAt } | { cemented: false, reason: 'missing' | 'invalid', detail? }
 */
export function readInstallConfig(state, read = (p) => readFileSync(p, 'utf8')) {
  let raw;
  try { raw = read(join(state, INSTALL_CONFIG_FILE)); } catch { return { cemented: false, reason: 'missing' }; }
  let json;
  try { json = JSON.parse(raw); } catch { return { cemented: false, reason: 'invalid', detail: 'install.json is not JSON' }; }
  if (json?.schema !== INSTALL_SCHEMA) return { cemented: false, reason: 'invalid', detail: `unknown schema ${json?.schema ?? '(none)'}` };
  const checked = validateWakeWord(json.wakeWord);
  if (!checked.ok) return { cemented: false, reason: 'invalid', detail: checked.reason };
  return { cemented: true, wakeWord: checked.word, release: json.release ?? null, cementedAt: json.cementedAt ?? null };
}

/** Pure: the install.json the installer writes (the engine writes the same fields). */
export function installConfigJson({ wakeWord, release = null, cementedAt = new Date().toISOString(), installer = null }) {
  const checked = validateWakeWord(wakeWord);
  if (!checked.ok) throw new Error(checked.reason);
  return `${JSON.stringify({ schema: INSTALL_SCHEMA, product: 'Kingmaker', wakeWord: checked.word, cementedAt, release, installer, note: 'Cemented at install. To change the wake word, delete Kingmaker and install it again.' }, null, 2)}\n`;
}

const norm = (t) => String(t ?? '').toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, ' ').replace(/'/g, '').replace(/\s+/g, ' ').trim();
const letters = (t) => norm(t).replace(/\s+/g, '');
const VOWEL = /[aeiouy]/;

/**
 * Pure: a spelling key that folds the recogniser's usual slips for any word ("Kingmaker" → "kingmakr"): ph/f, ck/k,
 * c/k/s, q/k, z/s, x/ks, wh/w, doubled letters, and the soft endings ("-er", "-a", "-ah", "-or") a name often loses.
 */
export function foldSpelling(text) {
  let s = letters(text);
  s = s.replace(/ph/g, 'f').replace(/wh/g, 'w').replace(/ck/g, 'k').replace(/q/g, 'k').replace(/x/g, 'ks').replace(/z/g, 's');
  s = s.replace(/c(?=[eiy])/g, 's').replace(/c/g, 'k');
  s = s.replace(/(er|ar|or|ur|ah|re|a)$/, 'r');
  s = s.replace(/(.)\1+/g, '$1');
  return s;
}

/** Levenshtein distance, capped (returns cap + 1 once it is exceeded). Pure. */
export function editDistance(a, b, cap = 3) {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j += 1) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, cur[j]);
    }
    if (best > cap) return cap + 1;
    prev = cur;
  }
  return prev[b.length];
}

/**
 * Pure: does what was heard (one to four words, already split off the front) name the wake word? Spacing never
 * matters ("king maker" = "Kingmaker"), a plural or possessive is fine, and after folding the spelling one slip is
 * allowed for names of 6+ letters (two for 10+). Short names must match exactly, so "hey Al" is not "hey all".
 */
export function namesWakeWord(heard, word) {
  const a = letters(heard), t = letters(word);
  if (!a || !t) return false;
  if (a === t || a === `${t}s`) return true;
  if (t.length < 6) return false;
  const fa = foldSpelling(a.replace(/s$/, '')), ft = foldSpelling(t);
  if (fa === ft) return true;
  const allowed = t.length >= 10 ? 2 : 1;
  return editDistance(fa, ft, allowed) <= allowed;
}

/**
 * Pure: the wake word's forms. `phrases` are the exact forms (with "hey", "ok", "wake up"), `variants` the spellings a
 * recogniser commonly writes for it: spaced at its consonant clusters ("Kingmaker" → "king maker"), joined when it is
 * several words, and hyphenated. Matching itself (matchWakeWord) is space- and slip-tolerant beyond this list.
 */
export function wakeWordForms(word) {
  const name = norm(word);
  const joined = name.replace(/\s+/g, '');
  const variants = new Set([name, joined]);
  if (!name.includes(' ')) {
    for (let i = 3; i <= joined.length - 3; i += 1) {
      const [p, c, n] = [joined[i - 1], joined[i], joined[i + 1]];
      if (!VOWEL.test(p) && !VOWEL.test(c) && VOWEL.test(n)) variants.add(`${joined.slice(0, i)} ${joined.slice(i)}`);
    }
  }
  for (const v of [...variants]) if (v.includes(' ')) variants.add(v.replace(/ /g, '-'));
  const spoken = [...variants].filter((v) => !v.includes('-'));
  const phrases = new Set();
  for (const n of spoken) for (const p of [`hey ${n}`, `${n} wake up`, `wake up ${n}`, `ok ${n}`, `okay ${n}`, n]) phrases.add(p);
  return { name, joined, variants: [...variants], phrases: [...phrases].sort((x, y) => y.length - x.length) };
}

/**
 * Pure: {addressed, command} for a transcript and the wake word: an optional greeting ("hey", "ok") or "wake up", then
 * the name in one to four words (namesWakeWord), then an optional "wake up". The command is the rest, in its original
 * words. "King maker, open Notes." → { addressed: true, command: 'open Notes.' }.
 */
export function matchWakeWord(transcript, word) {
  const text = String(transcript ?? '').trim();
  const tokens = text.split(/\s+/).filter(Boolean);
  const plain = tokens.map((t) => norm(t));
  if (!tokens.length || !norm(word)) return { addressed: false, command: text };
  let start = 0;
  if (GREETINGS.includes(plain[0])) start = 1;
  else if (plain[0] === 'wake' && plain[1] === 'up') start = 2;
  for (let k = Math.min(4, tokens.length - start); k >= 1; k -= 1) {
    const heard = plain.slice(start, start + k).join(' ');
    if (!heard || !namesWakeWord(heard, word)) continue;
    let rest = start + k;
    if (plain[rest] === 'wake' && plain[rest + 1] === 'up') rest += 2;
    const command = tokens.slice(rest).join(' ').replace(/^[\s,.:;!?-]+/, '').trim();
    return { addressed: true, command };
  }
  return { addressed: false, command: text };
}
