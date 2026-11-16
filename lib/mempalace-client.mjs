// lib/mempalace-client.mjs — Kingmaker's method and context retrieval through the EXISTING MemPalace in the Solomon
// engine (2026-11-16): the engine's governed /api/memory contract (POST / to remember, GET /retrieve to recall: "ranks
// locally embedded semantic matches first, falling back to deterministic lexical term overlap"), called with the owner
// launch nonce and an explicit tenant (the engine refuses a shared tenant). No second MemPalace: this file only speaks
// the engine's API.
//
// Method index: each conductable method is remembered once as project_memory in project "kingmaker-methods", tagged
// method:<id> and sha:<sha12>; a changed method is re-remembered and the old record is marked stale through the engine's
// own /stale route (stale records stay visible, per the engine's ledger rules). Retrieval returns method ids in
// MemPalace's ranking; the execution loop hands the top of that list to Jev.
import { ownerCall } from './client.mjs';

export const METHOD_PROJECT = 'kingmaker-methods';

export function createMemPalaceClient({ port, nonce, tenantId = 'primary', userId = 'kingmaker', call = ownerCall } = {}) {
  const q = (o) => Object.entries({ tenantId, ...o }).filter(([, v]) => v != null).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const ok = (r, what) => { if (!r?.ok || r.json?.ok === false) throw new Error(`MemPalace ${what} failed: ${r?.status ?? ''} ${r?.json?.error ?? ''} ${r?.json?.message ?? ''}`.trim()); return r.json; };
  return {
    async remember({ content, type = 'project_memory', projectId = 'default', source = 'kingmaker', tags = [], confidence = 0.8 }) {
      return ok(await call(port, `/api/memory?${q({})}`, { nonce, method: 'POST', body: { tenantId, userId, projectId, type, content, source, tags, confidence } }), 'remember').memory;
    },
    async list({ projectId, type, limit = 200 } = {}) { return ok(await call(port, `/api/memory?${q({ projectId, type, limit })}`, { nonce }), 'list').memory; },
    async retrieve(query, { projectId, limit = 10 } = {}) { return ok(await call(port, `/api/memory/retrieve?${q({ query, projectId, limit })}`, { nonce }), 'retrieve').results; },
    async stale(memoryId, reason) { return ok(await call(port, `/api/memory/stale?${q({})}`, { nonce, method: 'POST', body: { tenantId, userId, memoryId, reason } }), 'stale'); },
  };
}

const tagOf = (m, p) => (m?.tags ?? m?.content?.tags ?? []).find((t) => String(t).startsWith(p))?.slice(p.length) ?? null;
const recordsOf = (x) => (Array.isArray(x) ? x : x?.records ?? x?.items ?? x?.results ?? []);

/** Remember every conductable method (id, title, domain, a short digest of what it does). Idempotent by sha. */
export async function indexMethodsInMemPalace(client, methods, { describe = (m) => '' } = {}) {
  const existing = recordsOf(await client.list({ projectId: METHOD_PROJECT, type: 'project_memory' }));
  const have = new Map(existing.filter((r) => r.status !== 'stale' && !r.stale).map((r) => [tagOf(r, 'method:'), r]));
  const out = { added: [], unchanged: [], replaced: [] };
  for (const m of methods) {
    const sha = String(m.sha256 ?? '').slice(0, 12);
    const prior = have.get(m.id);
    if (prior && tagOf(prior, 'sha:') === sha) { out.unchanged.push(m.id); continue; }
    await client.remember({ projectId: METHOD_PROJECT, source: 'kingmaker-method-index', tags: ['kingmaker-method', `method:${m.id}`, `sha:${sha}`],
      content: { text: `${m.title}. Domain: ${m.domain ?? 'general'}. ${describe(m)}`.slice(0, 1200), methodId: m.id, title: m.title, domain: m.domain ?? null, version: m.version ?? null } });
    const priorId = prior?.memoryId ?? prior?.id;
    if (priorId) { await client.stale(priorId, `method ${m.id} changed (sha ${sha})`); out.replaced.push(m.id); } else out.added.push(m.id);
  }
  return out;
}

/** A candidate retriever for the execution loop: MemPalace's ranking of methods for this request. */
export function memPalaceMethodRetriever(client, { limit = 7 } = {}) {
  return async (request) => {
    // The engine matches whole terms: split punctuation so "results.json" offers "json".
    const query = String(request).replace(/[^\p{L}\p{N}\s]+/gu, ' ').replace(/\s+/g, ' ').trim();
    const results = recordsOf(await client.retrieve(query, { projectId: METHOD_PROJECT, limit: limit * 2 }));
    const ids = []; for (const r of results) { const id = r?.memory?.content?.methodId ?? r?.content?.methodId ?? tagOf(r?.memory ?? r, 'method:'); if (id && !ids.includes(id)) ids.push(id); }
    return { ids: ids.slice(0, limit), query, raw: results.slice(0, limit).map((r) => ({ id: r?.memory?.content?.methodId ?? r?.content?.methodId ?? null, score: r?.score ?? null, mode: r?.retrievalMode ?? null, matched: r?.matchedTerms ?? null })) };
  };
}
