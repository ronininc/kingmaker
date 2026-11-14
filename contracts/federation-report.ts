// Kingmaker — Solomon→Kingmaker Federation Report schema + SANDBOX (v1)
//
// Solomon opens no connection to Kingmaker (the diode). Kingmaker PULLS Solomon's exposed read surface —
// an append-only outbox of SANITIZED reports — and every incoming report is treated as UNTRUSTED and
// SANDBOXED here before anything is ingested. A sanitized report carries ABILITIES and BLOCK intel only:
// identity/category/graduation and threat categories — NEVER skill source, code, or customer data. The
// sandbox's job is to REFUSE anything that violates that shape, so a compromised Solomon node cannot poison
// Kingmaker by uploading a weaponized "skill". There is no code to execute here — abilities are metadata —
// so sandboxing = strict schema validation + anomaly quarantine, never evaluation.

// ── The two sanitized report shapes Solomon emits ────────────────────────────
export type FederationSkillReport = {
  kind: 'skill';
  skillId: string;
  verdict: 'ALLOWED' | 'BLOCKED';
  categories: string[]; // limiter_break | report_suppression | dangerous_action
  sanitized: true;
};
export type FederationInventoryReport = {
  kind: 'federation';
  installationId: string;
  skills: Array<{ id: string; name: string; category: string; graduated: boolean }>;
  blockedCount: number;
  sanitized: true;
};
export type IncomingFederationReport = FederationSkillReport | FederationInventoryReport;

// ── What Kingmaker keeps after sandboxing ────────────────────────────────────
/** A staged ability — imported UNDER REVIEW; a governed step promotes it into the Vault (never auto-canon). */
export interface FederatedAbilityRecord {
  installationId: string;
  skillId: string;
  name: string;
  category: string;
  graduated: boolean;
  origin: 'SOLOMON_FEDERATED';
  status: 'STAGED_UNDER_REVIEW';
  customerDataIncluded: false;
  receivedAt: string;
}
/** Cross-installation threat intel from a BLOCKED-skill report. */
export interface ThreatIntelRecord {
  installationId: string;
  skillId: string;
  categories: string[];
  verdict: 'BLOCKED';
  receivedAt: string;
}

export type SandboxVerdict =
  | { ok: true; report: IncomingFederationReport }
  | { ok: false; reason: string };

// Keys that must NEVER appear in a sanitized report — payload leakage or prototype pollution.
const FORBIDDEN_KEYS = ['sourcetext', 'source', 'code', 'script', 'sql', 'payload', 'exec', 'command', 'cmd', 'bytes', 'blob', '__proto__', 'constructor', 'prototype'];
const MAX_STRING = 512;
const MAX_SKILLS = 4096;
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= MAX_STRING;
const idRe = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Deep-scan for any forbidden key (payload/pollution) at any depth. A hit is an immediate quarantine. */
function hasForbiddenKey(value: unknown, depth = 0): boolean {
  if (depth > 6 || value === null || typeof value !== 'object') return false;
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.includes(key.toLowerCase())) return true;
    if (hasForbiddenKey((value as Record<string, unknown>)[key], depth + 1)) return true;
  }
  return false;
}

/**
 * Sandbox one parsed report. Returns the typed report only if it is a well-formed SANITIZED report; any
 * anomaly (unknown kind, missing sanitized flag, a payload/pollution key, oversize, bad id) is refused.
 */
export function sandboxIncomingReport(raw: unknown): SandboxVerdict {
  if (raw === null || typeof raw !== 'object') return { ok: false, reason: 'not an object' };
  if (hasForbiddenKey(raw)) return { ok: false, reason: 'forbidden key present (payload/pollution) — a sanitized report carries no source/code/data' };
  const r = raw as Record<string, unknown>;
  if (r.sanitized !== true) return { ok: false, reason: 'missing sanitized:true — refuse any report not marked sanitized' };

  if (r.kind === 'skill') {
    if (!isStr(r.skillId) || !idRe.test(r.skillId)) return { ok: false, reason: 'bad skillId' };
    if (r.verdict !== 'ALLOWED' && r.verdict !== 'BLOCKED') return { ok: false, reason: 'bad verdict' };
    if (!Array.isArray(r.categories) || r.categories.length > 16 || !r.categories.every((c) => isStr(c))) return { ok: false, reason: 'bad categories' };
    return { ok: true, report: { kind: 'skill', skillId: r.skillId, verdict: r.verdict, categories: r.categories as string[], sanitized: true } };
  }

  if (r.kind === 'federation') {
    if (!isStr(r.installationId) || !idRe.test(r.installationId)) return { ok: false, reason: 'bad installationId' };
    if (typeof r.blockedCount !== 'number' || !Number.isFinite(r.blockedCount) || r.blockedCount < 0) return { ok: false, reason: 'bad blockedCount' };
    if (!Array.isArray(r.skills) || r.skills.length > MAX_SKILLS) return { ok: false, reason: 'bad skills array' };
    const skills: FederationInventoryReport['skills'] = [];
    for (const s of r.skills) {
      if (s === null || typeof s !== 'object') return { ok: false, reason: 'bad skill entry' };
      const e = s as Record<string, unknown>;
      if (!isStr(e.id) || !idRe.test(e.id) || !isStr(e.name) || !isStr(e.category) || typeof e.graduated !== 'boolean') return { ok: false, reason: 'bad skill fields' };
      skills.push({ id: e.id, name: e.name, category: e.category, graduated: e.graduated });
    }
    return { ok: true, report: { kind: 'federation', installationId: r.installationId, skills, blockedCount: r.blockedCount, sanitized: true } };
  }

  return { ok: false, reason: `unknown report kind: ${JSON.stringify(r.kind)}` };
}
