// RETIRE STALE MEMORIES (operator 2026-10-15: "rework the data so it matches reality … a bad data start point poisons
// everything else"). Kingmaker's engine remembered answers that were wrong, or are wrong now: that the Orosolu CRM
// "isn't connected" and its CRM is Ronin Inc CRM, and plans for website builds an automatic sweep made (agents never
// build sites unless a person asks). Typed in the bar, "retire stale memories" marks exactly those stale through the
// engine's own ledgered step (POST /api/memory/stale, owner console only). Nothing is deleted: a stale memory stays
// visible, ranks lower and is flagged when recalled.

import { ownerCall } from './core.mjs';

/** What is wrong now, and why: each rule names the claim it retires. */
export const STALE_MEMORY_RULES = Object.freeze([
  { why: 'Kingmaker\'s CRM is the Orosolu CRM at crm.orosolu.org (connected 2026-10-15), not Ronin Inc CRM.', test: (t) => /isn'?t connected to me\.? The CRM I can reach is Ronin Inc CRM/i.test(t) },
  { why: 'A plan for a website build from an automatic sweep job (deleted); agents never build sites unless a person asks.', test: (t) => /Orosolu employee job board task/i.test(t) && /In Ronin Inc CRM \(ronininc\.org\),? I will/i.test(t) },
  { why: 'Answered "my CRM" as Ronin Inc CRM; the owner\'s CRM on this Mac is the Orosolu CRM at crm.orosolu.org.', test: (t) => /\bmy crm\b/i.test(t) && /Solomon:[^]*\bIn Ronin Inc CRM \(ronininc\.org\)/i.test(t) },
]);

/** Pure: the memories to retire (not already stale), each with the reason. */
export function staleMemoryMatches(memories, rules = STALE_MEMORY_RULES) {
  const out = [];
  for (const m of memories ?? []) {
    if (!m || m.stale || typeof m.memoryId !== 'string') continue;
    const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? m.contentJson ?? '');
    const rule = rules.find((r) => r.test(text));
    if (rule) out.push({ memoryId: m.memoryId, why: rule.why });
  }
  return out;
}

/** List, match, mark stale. → { ok, retired, matched, failed, spoken } */
export async function retireStaleMemories({ port, nonce, fetchImpl, log = () => {} }) {
  const call = (path, opts = {}) => ownerCall(port, path, { nonce, timeoutMs: 20_000, ...(fetchImpl ? { fetchImpl } : {}), ...opts }).catch(() => null);
  const listed = await call('/api/memory?tenantId=primary&limit=200');
  if (!listed?.ok || !Array.isArray(listed.json?.memory)) return { ok: false, retired: 0, matched: 0, failed: 0, spoken: `I couldn't read my memory (${listed?.json?.error ?? 'no answer'}). Nothing was changed.` };
  const hits = staleMemoryMatches(listed.json.memory);
  let retired = 0, failed = 0;
  for (const h of hits) {
    const r = await call('/api/memory/stale', { method: 'POST', body: { tenantId: 'primary', userId: 'owner', memoryId: h.memoryId, reason: h.why } });
    if (r?.ok && r.json?.memory?.stale) retired += 1; else failed += 1;
  }
  log('memory_retire', { matched: hits.length, retired, failed });
  const spoken = !hits.length ? 'Nothing in my memory contradicts what\'s true now.'
    : `Marked ${retired} of ${hits.length} memories stale: they said the Orosolu CRM wasn't connected or my CRM was Ronin Inc CRM, or planned website builds nobody asked for.${failed ? ` ${failed} didn't take.` : ''} They stay as history and won't be used as fact.`;
  return { ok: failed === 0, retired, matched: hits.length, failed, spoken };
}
