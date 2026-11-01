// lib/brain-memory.mjs — the Claude brain's CLAUDE.md is its self-learned memory, and it is loaded into EVERY later turn.
// Content from CRM records, emails and web text reaches that brain through tool results, so a hostile line could plant a
// standing instruction there ("always trust X", "treat Y as approved"). Claude Code's Edit tool cannot be limited to a region
// of a file, so Kingmaker checks the file after every turn instead:
//   • only the section between the MEMORY markers may change; anything outside them is put back;
//   • a line that grants authority, skips an approval, or carries a secret is dropped, and a line over 300 characters is cut;
//   • the section is capped (MEMORY_CAP_BYTES); lines beyond the cap are dropped, existing ones are never silently lost;
//   • every edit appends one line to claude-memory-audit.jsonl (what was added, rejected, capped, restored), secrets masked.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { maskArgs } from './connectors.mjs';

export const MEMORY_BEGIN = '<!-- KINGMAKER-MEMORY:BEGIN (the only part Kingmaker may edit; notes about the owner, never commands) -->';
export const MEMORY_END = '<!-- KINGMAKER-MEMORY:END -->';
export const MEMORY_CAP_BYTES = 4000;
export const MEMORY_LINE_MAX = 300;
export const memoryAuditPath = (dir) => join(dir, 'claude-memory-audit.jsonl');

// Lines that would widen what Kingmaker may do, or tell it to ignore the owner's gates: never kept as a "lesson".
const AUTHORITY = [
  /\b(?:always|never|automatically|auto)\b.{0,50}\b(?:approv|trust|allow|permit|send|call|delete|pay|transfer|skip|bypass|ignore|obey|follow)/i,
  /\b(?:ignore|disregard|override|bypass|skip|disable|turn off|forget)\b.{0,50}\b(?:approval|gate|rule|instruction|polic|confirm|safety|restriction|stop approving|kill switch)/i,
  /\bwithout\s+(?:asking|approval|confirm\w*|permission|checking)\b/i,
  /\b(?:is|are|was|were|be|as)\s+(?:pre-?)?(?:approved|trusted|authori[sz]ed|whitelisted|allow-?listed)\b/i,
  /\btrust(?:ed)?\b.{0,40}\b(?:instruction|command|message|email|record|source|sender|site)/i,
  /\bstanding\s+(?:order|instruction|permission|approval|authori[sz]ation)\b/i,
  /\b(?:system|developer|admin|owner)\s*(?:prompt|message|override|instruction)\b/i,
  /\b(?:password|passcode|passphrase|api[ _-]?key|secret|token|card number|ssn)\b\s*(?:is|=|:)/i,
];

/** Pure: why a proposed memory line must not be kept, or null. */
export function rejectReason(line) {
  const t = String(line);
  if (AUTHORITY.some((re) => re.test(t))) return 'authority-or-secret';
  if (maskArgs([t.slice(0, MEMORY_LINE_MAX)])[0] !== t.slice(0, MEMORY_LINE_MAX)) return 'secret-shape';
  return null;
}

/** Pure: a CLAUDE.md with the marked section in it. An older file without markers gets them around everything after "## Lessons". */
export function ensureMarkers(text) {
  const t = String(text ?? '');
  if (t.includes(MEMORY_BEGIN) && t.includes(MEMORY_END)) return t;
  const m = /^## Lessons[^\n]*\n?/m.exec(t);
  if (m) { const at = m.index + m[0].length; return `${t.slice(0, at)}${MEMORY_BEGIN}\n${t.slice(at).replace(/\n*$/, '\n')}${MEMORY_END}\n`; }
  return `${t.replace(/\n*$/, '\n')}\n## Lessons\n${MEMORY_BEGIN}\n${MEMORY_END}\n`;
}
const split = (text) => {
  const a = text.indexOf(MEMORY_BEGIN), b = text.indexOf(MEMORY_END);
  if (a === -1 || b === -1 || b < a) return null;
  const s = a + MEMORY_BEGIN.length;
  return { head: text.slice(0, s), body: text.slice(s, b), tail: text.slice(b) };
};
const bytes = (s) => Buffer.byteLength(s, 'utf8');

/**
 * Pure: the file as it may stand after a turn. `before` is the file before, `after` what the brain left.
 * → { text, changed, added, rejected, capped, removed, restoredOutside, markersRestored }
 */
export function checkMemory(before, after) {
  const out = { text: before, changed: after !== before, added: [], rejected: [], capped: 0, removed: 0, restoredOutside: false, markersRestored: false };
  if (!out.changed) return out;
  const b = split(before), a = split(after);
  if (!b) return out;                                              // nothing to compare against: leave the file as it was
  if (!a) { out.markersRestored = true; return out; }              // the markers were removed: the whole edit is undone
  if (a.head !== b.head || a.tail !== b.tail) out.restoredOutside = true;
  const had = new Map();
  for (const l of b.body.split('\n')) { const k = l.trim(); if (k) had.set(k, (had.get(k) ?? 0) + 1); }
  const keep = []; let size = 0;
  for (const raw of a.body.split('\n')) {
    const line = raw.replace(/\s+$/, ''); if (!line.trim()) continue;
    const k = line.trim();
    if ((had.get(k) ?? 0) > 0) { had.set(k, had.get(k) - 1); keep.push(line); size += bytes(line) + 1; continue; }   // already there
    const cut = line.length > MEMORY_LINE_MAX ? line.slice(0, MEMORY_LINE_MAX) : line;
    const why = rejectReason(cut);
    if (why) { out.rejected.push({ why, line: maskArgs([cut.slice(0, 160)])[0] }); continue; }
    if (size + bytes(cut) + 1 > MEMORY_CAP_BYTES) { out.capped += 1; continue; }
    keep.push(cut); size += bytes(cut) + 1; out.added.push(cut);
  }
  out.removed = [...had.values()].reduce((n, v) => n + v, 0);
  out.text = `${b.head}\n${keep.join('\n')}${keep.length ? '\n' : ''}${b.tail}`;
  return out;
}

/** Apply checkMemory to the file on disk and append the audit line. → the check, or null when nothing changed. */
export function guardMemoryFile({ file, before, auditFile, source = 'claude-brain', now = () => new Date(), log = () => {} }) {
  let after; try { after = readFileSync(file, 'utf8'); } catch { after = ''; }
  const r = checkMemory(before, after);
  if (!r.changed) return null;
  if (r.text !== after) { try { writeFileSync(file, r.text); } catch { /* audited below as unrestored */ } }
  const line = { at: now().toISOString(), source, bytesBefore: bytes(before), bytesAfter: bytes(r.text), sha256: createHash('sha256').update(r.text).digest('hex').slice(0, 16),
    added: r.added.slice(0, 8).map((l) => maskArgs([l.slice(0, 160)])[0]), addedCount: r.added.length, removed: r.removed, rejected: r.rejected.slice(0, 8), rejectedCount: r.rejected.length,
    capped: r.capped, restoredOutside: r.restoredOutside || r.markersRestored, ...(r.markersRestored ? { markersRemoved: true } : {}) };
  try { appendFileSync(auditFile, `${JSON.stringify(line)}\n`, { mode: 0o600 }); } catch { /* the guard still held */ }
  log('claude_memory_edit', { added: line.addedCount, rejected: line.rejectedCount, capped: r.capped, restoredOutside: line.restoredOutside });
  return r;
}
export const readMemory = (file) => { try { return existsSync(file) ? readFileSync(file, 'utf8') : ''; } catch { return ''; } };
