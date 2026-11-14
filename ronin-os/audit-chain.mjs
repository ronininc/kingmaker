// audit-chain.mjs — append-only hash-chained audit log (the reflex layer's pattern, generalized).
// Each entry: { seq, at, kind, body, prev, hash } where hash = sha256(prev + canonical(entry-without-hash)).
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs';

const canon = (v) => JSON.stringify(v, Object.keys(v ?? {}).sort());
function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
}
export function entryHash(e) {
  const { hash, ...rest } = e;
  return createHash('sha256').update(`${e.prev}\n${canonical(rest)}`).digest('hex');
}
export class AuditChain {
  constructor(path) { this.path = path; if (!existsSync(path)) writeFileSync(path, ''); }
  entries() {
    const t = readFileSync(this.path, 'utf8').trim();
    return t ? t.split('\n').map((l) => JSON.parse(l)) : [];
  }
  append(kind, body, at = new Date()) {
    const es = this.entries();
    const prev = es.length ? es[es.length - 1].hash : 'GENESIS';
    const e = { seq: es.length + 1, at: at.toISOString(), kind, body, prev };
    e.hash = entryHash(e);
    appendFileSync(this.path, `${JSON.stringify(e)}\n`);
    return e;
  }
  verify() {
    const es = this.entries(); let prev = 'GENESIS';
    for (const e of es) { if (e.prev !== prev) return { ok: false, at: e.seq, why: 'prev mismatch' }; if (entryHash(e) !== e.hash) return { ok: false, at: e.seq, why: 'hash mismatch' }; prev = e.hash; }
    return { ok: true, entries: es.length };
  }
}
