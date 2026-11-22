/**
 * lib/memory-audit.mjs (router-phase2)
 *
 * Shared learning store with MANDATORY provenance and a hash-chained
 * audit trail for every write — the "memory with audit" build.
 *
 * Studied from RuFlow's memory layer (behavior spec §3, mapping §8 ADAPT)
 * and re-implemented clean-room with the fixes the spec demands:
 *   - provenance is REQUIRED on every write (upstream defaults it to
 *     `unknown`; here a write without provenance is rejected);
 *   - every write — and every revocation — is an entry in the hash-chained
 *     audit log, so a poisoned or stale pattern is traceable to who/what
 *     taught it, and revocable by that provenance;
 *   - entries carry a default TTL (upstream has none — entries replay
 *     forever); expired entries never rank;
 *   - confidence decays with age (upstream decays only patterns; here it
 *     applies to every entry, with a floor);
 *   - NO HNSW: the spec's own audit of the upstream shows it ties or
 *     loses to brute force below crossover — retrieval here is a simple
 *     ranked token scan, honest at Kingmaker's scale.
 *
 * $0 spend, local-only, no telemetry.
 */

export const PROVENANCE_KINDS = ['user_claim', 'agent_output', 'system_observation', 'tool_result'];

const DEFAULT_TTL_MS = 30 * 24 * 3_600_000; // 30 days — stale entries expire instead of replaying
const DEFAULT_HALF_LIFE_MS = 30 * 24 * 3_600_000; // confidence half-life
const DECAY_FLOOR = 0.1;
const DEFAULT_CONFIDENCE = 0.5;

function tokenize(text) {
  return new Set(String(text || '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3));
}

/** Overlap similarity: |A ∩ B| / |A ∪ B| over token sets. */
function overlap(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * Create the store. Required: auditLog (hash-chained, from audit-chain.mjs).
 * `now` is an injectable clock seam for tests.
 */
export function createMemoryStore({
  auditLog,
  now = () => Date.now(),
  ttlMs = DEFAULT_TTL_MS,
  halfLifeMs = DEFAULT_HALF_LIFE_MS,
} = {}) {
  if (!auditLog) throw new Error('memory-audit: an auditLog is required — writes without an audit trail are not shipped');

  const entries = new Map();
  let counter = 0;
  const actor = 'memory-store';
  const log = (action, detail, meta) => auditLog.append({ actor, action, detail, meta: meta ?? {} });

  /** Effective confidence: Laplace-smoothed counters, age-decayed, floored. */
  function effectiveConfidence(entry, at = now()) {
    const base = (entry.success + 1) / (entry.success + entry.failure + 2);
    const age = Math.max(0, at - entry.updatedAt);
    const decayed = base * Math.pow(0.5, age / halfLifeMs);
    return Math.max(DECAY_FLOOR, decayed);
  }

  /**
   * Store an entry. Provenance is mandatory — { kind, by, detail? }.
   * kind ∈ PROVENANCE_KINDS; `by` names who/what taught it.
   * A write without valid provenance is REJECTED (never lands, never ranked).
   */
  function store({ key = null, namespace = 'default', type = 'episodic', content, tags = [], provenance, confidence = DEFAULT_CONFIDENCE, expiresAt = null } = {}) {
    if (typeof content !== 'string' || content.trim() === '') {
      throw new Error('memory-audit: content is required and must be non-empty text');
    }
    if (!provenance || !PROVENANCE_KINDS.includes(provenance.kind) || typeof provenance.by !== 'string' || provenance.by.trim() === '') {
      throw new Error('memory-audit: provenance is mandatory — { kind: user_claim|agent_output|system_observation|tool_result, by: who/what taught it }');
    }
    if (confidence < 0 || confidence > 1) {
      throw new Error('memory-audit: confidence must be within [0, 1]');
    }
    const id = `mem-${++counter}`;
    const ts = now();
    const entry = {
      id, key, namespace, type, content, tags: [...tags],
      provenance: { kind: provenance.kind, by: provenance.by, detail: provenance.detail ?? '' , at: ts },
      success: 0, failure: 0,
      createdAt: ts, updatedAt: ts,
      expiresAt: expiresAt ?? ts + ttlMs,
      revoked: false, revokedReason: null,
    };
    entry.confidence = confidence;
    entries.set(id, entry);
    log('memory.write', `stored ${id} (${type}) in ${namespace} — taught by ${provenance.by} (${provenance.kind})`, {
      entryId: id, key, namespace, type, provenance: entry.provenance,
    });
    return { ok: true, entry: publicEntry(entry) };
  }

  function publicEntry(entry, score = null) {
    const view = {
      id: entry.id, key: entry.key, namespace: entry.namespace, type: entry.type,
      content: entry.content, tags: [...entry.tags], provenance: { ...entry.provenance },
      confidence: Math.round(effectiveConfidence(entry) * 1000) / 1000,
      baseConfidence: Math.round(((entry.success + 1) / (entry.success + entry.failure + 2)) * 1000) / 1000,
      success: entry.success, failure: entry.failure,
      createdAt: entry.createdAt, updatedAt: entry.updatedAt, expiresAt: entry.expiresAt,
    };
    if (score !== null) view.score = Math.round(score * 1000) / 1000;
    return view;
  }

  function isLive(entry, at = now()) {
    return !entry.revoked && entry.expiresAt > at;
  }

  /**
   * Ranked recall: simple scan (no HNSW — spec §8), scored by token
   * overlap × effective confidence × recency. Expired and revoked entries
   * never rank. `provenanceKind` / `by` filter when given.
   */
  function recall({ query = '', namespace = null, tags = null, provenanceKind = null, by = null, limit = 10 } = {}) {
    const qTokens = tokenize(query);
    const hits = [];
    for (const entry of entries.values()) {
      if (!isLive(entry)) continue;
      if (namespace && entry.namespace !== namespace) continue;
      if (provenanceKind && entry.provenance.kind !== provenanceKind) continue;
      if (by && entry.provenance.by !== by) continue;
      if (tags && tags.length > 0 && !tags.every((t) => entry.tags.includes(t))) continue;
      let sim = 1;
      if (query !== '') {
        const body = tokenize(entry.content + ' ' + entry.tags.join(' '));
        sim = overlap(qTokens, body);
        if (sim === 0) continue;
      }
      const conf = effectiveConfidence(entry);
      const recency = Math.pow(0.5, (now() - entry.updatedAt) / halfLifeMs);
      const score = sim * (0.5 + 0.5 * conf) * (0.5 + 0.5 * recency);
      hits.push({ entry, score });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, limit).map(({ entry, score }) => publicEntry(entry, score));
  }

  /** Reinforce (success) or penalize (failure) an entry's counters. */
  function reinforce(id, { success = true } = {}) {
    const entry = entries.get(id);
    if (!entry || entry.revoked) {
      return { ok: false, reason: 'unknown-or-revoked-entry' };
    }
    if (success) entry.success++; else entry.failure++;
    entry.updatedAt = now();
    return { ok: true, entry: publicEntry(entry) };
  }

  /**
   * Revoke entries by provenance — the poison response. Removes every
   * live entry taught `by` the given teacher and/or of the given
   * provenance kind. Revocation is itself audited per entry; the bytes
   * stay in the store (marked revoked) so the trail is reconstructable,
   * but they never rank again.
   */
  function revoke({ by = null, provenanceKind = null, reason = 'revoked' } = {}) {
    if (!by && !provenanceKind) {
      throw new Error('memory-audit: revoke requires a provenance selector (by and/or provenanceKind)');
    }
    const removed = [];
    for (const entry of entries.values()) {
      if (entry.revoked) continue;
      if (by && entry.provenance.by !== by) continue;
      if (provenanceKind && entry.provenance.kind !== provenanceKind) continue;
      entry.revoked = true;
      entry.revokedReason = reason;
      removed.push(entry.id);
      log('memory.revoke', `revoked ${entry.id} — taught by ${entry.provenance.by} (${entry.provenance.kind}): ${reason}`, {
        entryId: entry.id, provenance: entry.provenance, reason,
      });
    }
    return { ok: true, revoked: removed };
  }

  /** Sweep entries past their TTL; audits the sweep. */
  function sweepExpired() {
    let swept = 0;
    for (const entry of entries.values()) {
      if (!entry.revoked && entry.expiresAt <= now()) swept++;
    }
    if (swept > 0) log('memory.ttl-sweep', `${swept} entr${swept === 1 ? 'y' : 'ies'} past TTL excluded from recall`, { swept });
    return { ok: true, swept };
  }

  /** Count live entries, optionally by namespace. */
  function size({ namespace = null } = {}) {
    let n = 0;
    for (const entry of entries.values()) {
      if (isLive(entry) && (!namespace || entry.namespace === namespace)) n++;
    }
    return n;
  }

  return { store, recall, reinforce, revoke, sweepExpired, size, _entries: entries };
}
