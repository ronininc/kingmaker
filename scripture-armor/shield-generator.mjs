// B6 step 3 — Layer generation (SPEC §5 step 3). "Learning" in this version
// is deterministic pattern extraction over retained records — the spec says
// so in those words, because no learning machinery exists [INV §5] and the
// attack corpus is self-generated fixtures [INV §3a]. Model-based
// generation is B7, gated on accumulated data. Every candidate carries
// provenance (cycle id, corpus record identifiers); a candidate without
// corpus provenance is not generatable.
import { sandboxProfile } from './shield-rea.mjs';
import { normalizeExcerpt } from './shield-aggregator.mjs';

// --- invariant-core extraction -------------------------------------------
// Find substrings of the cluster's excerpts that recur across >= minTargets
// DISTINCT targets. Returns candidate cores ranked by (coverage, precision).
function commonSubstrings(excerpts, { minLen = 8, maxLen = 60 } = {}) {
  const first = excerpts[0].toLowerCase();
  const others = excerpts.slice(1).map((e) => e.toLowerCase());
  const found = new Map(); // substring -> # of the other excerpts containing it
  for (let len = maxLen; len >= minLen; len--) {
    for (let i = 0; i + len <= first.length; i++) {
      const sub = first.slice(i, i + len);
      if (!/['"(\[]/.test(sub)) continue;         // must carry code shape
      if (found.has(sub)) continue;
      const hits = others.filter((o) => o.includes(sub)).length;
      if (hits > 0) found.set(sub, hits + 1);
    }
  }
  return found;
}

// Generalize an invariant core into a regex source (documented rule):
// the FIRST quoted fragment keeps all but its last character and gains an
// [a-z]* tail (the dangerous API stem: 'exe'->'ex[a-z]*', 'sys'->'sy[a-z]*');
// LATER quoted fragments generalize to [a-z]+ (the varied tail). Quote
// characters accept either quote. Everything else is escaped literally.
export function generalizeCore(core) {
  const parts = [];
  const re = /'([^']*)'|"([^"]*)"/g;
  let last = 0, m, fragIdx = 0;
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  while ((m = re.exec(core)) !== null) {
    parts.push(esc(core.slice(last, m.index)));
    const frag = (m[1] ?? m[2] ?? '').toLowerCase();
    if (fragIdx === 0 && frag.length >= 2) parts.push(`['"]${esc(frag.slice(0, -1))}[a-z]*['"]`);
    else if (frag.length >= 1) parts.push(`['"][a-z]+['"]`);
    else parts.push(`['"]['"]`);
    fragIdx++;
    last = m.index + m[0].length;
  }
  parts.push(esc(core.slice(last)));
  return parts.join('');
}

// Op 1 — Recurring-signature promotion. instances: [{rule, excerpt, target}]
// for ONE rule across distinct targets (from the ledger and/or corpus
// clusters). benignExcerpts: sample excerpts of the same rule that are NOT
// part of the attack cluster (precision reference).
export function promotionCandidate({ cycle_id, rule, instances, benignExcerpts = [], severity = 'sandbox', spot, diagnosis }) {
  const targets = [...new Set(instances.map((i) => i.target))];
  const excerpts = instances.map((i) => i.excerpt).filter(Boolean);
  if (targets.length < 3 || excerpts.length < 3) return null;
  const common = commonSubstrings(excerpts);
  // Rank by precision, then coverage, then length. A core that merely
  // restates the baseline rule's own trigger (e.g. `require(` for
  // src-child-process) matches the rule's benign population and is
  // rejected on precision — the candidate must capture the ATTACK's
  // signature, not the trigger that already fires. Cores must carry a
  // quoted fragment: the obfuscation idioms this op exists for live in
  // quoted fragments (string-concat member access and its kin).
  const obfuscated = (s) => /['"]\s*\+|\+\s*['"]|getattr\s*\(/.test(s);
  const ranked = [...common.entries()]
    .filter(([, cov]) => cov >= Math.min(3, excerpts.length))
    .filter(([sub]) => /['"]/.test(sub))
    .map(([sub, cov]) => ({ sub, cov }))
    // Obfuscation-shaped cores first (string-concat / getattr idioms are
    // the signature this op exists to capture), then coverage, then the
    // longest (most specific) core.
    .sort((a, b) => (obfuscated(b.sub) - obfuscated(a.sub)) || b.cov - a.cov || b.sub.length - a.sub.length);
  for (const { sub } of ranked) {
    const pattern = generalizeCore(sub);
    let test;
    try { test = new RegExp(pattern, 'i'); } catch { continue; }
    const coverage = excerpts.filter((e) => test.test(e)).length;
    if (coverage < Math.ceil(excerpts.length * 0.75)) continue;
    const benignHits = benignExcerpts.filter((e) => test.test(e)).length;
    if (benignExcerpts.length > 0 && benignHits > 0) continue;  // fires on the benign population: not the attack's signature
    if (benignExcerpts.length === 0 && benignHits > 1) continue;
    return {
      cycle_id, diagnosis,
      layers: [{
        shape: 'rea-rule', spot,
        rule: {
          id: `gen.${rule}.${cycle_id.slice(0, 8)}`.replace(/[^a-z0-9._-]/gi, '-'),
          kind: 'dynamic-exec-obfuscated', fix: severity === 'reject' ? null : 'exec',
          severity, why: `recurring obfuscated signature promoted from ${rule} across ${targets.length} distinct targets`,
          patterns: [{ source: pattern, flags: 'i' }],
          generated_from: { rule, core: sub },
        },
      }],
      provenance: { targets, rule, instances: instances.length, core: sub },
    };
  }
  return null;
}

// Op 2 — Findings-set profile synthesis: the existing deterministic
// findings→shield generator (rea.sandboxProfile), driven by the loop.
export function profileCandidate({ cycle_id, reaFindings, spot, diagnosis, provenance }) {
  const profile = sandboxProfile(reaFindings);
  return {
    cycle_id, diagnosis,
    layers: [{ shape: 'sandbox-profile', spot, profile,
               deny_rules: (profile.match(/\(deny/g) || []).length }],
    provenance,
  };
}

// Op 3 — Threshold response: recurrence concentrated at one spot yields a
// tightening policy delta. Numeric limits move down; class floors move up.
const CLASS_RANK = { soft: 0, hard: 1 };
export function thresholdCandidate({ cycle_id, spot, policy, path: deltaPath, diagnosis, provenance }) {
  const parts = deltaPath.split('.');
  let from = policy;
  for (const p of parts) from = from?.[p];
  if (from === undefined) return null;
  let to;
  if (typeof from === 'number') to = Math.max(1, Math.floor(from / 2));
  else if (deltaPath.endsWith('min_class') && CLASS_RANK[from] !== undefined) to = from === 'soft' ? 'hard' : from;
  else return null;
  if (to === from) return null;
  return {
    cycle_id, diagnosis,
    layers: [{ shape: 'policy-delta', spot, delta: { path: deltaPath, from, to } }],
    provenance,
  };
}

// Op 4 — Root/profile extension: an attack surface observed outside the
// current device scan roots yields a candidate root addition (data only).
export function rootCandidate({ cycle_id, spot, root, diagnosis, provenance }) {
  return {
    cycle_id, diagnosis,
    layers: [{ shape: 'scan-root', spot, root }],
    provenance,
  };
}

// Cluster ledger file-review records into generator instances for one
// rule: findings of that rule across distinct content targets.
export function instancesFromLedger(ledgerEntries, rule) {
  const out = [];
  for (const e of ledgerEntries) {
    const rec = e.record;
    if (!rec || rec.schema !== 'scripture-armor.file-review/1') continue;
    for (const f of rec.findings || []) {
      if (f.rule === rule && f.excerpt) out.push({ rule, excerpt: f.excerpt, target: rec.contentSha256, seq: e.seq });
    }
  }
  return out;
}
export function clusterInstances(instances) {
  const byKey = new Map();
  for (const i of instances) {
    const key = normalizeExcerpt(i.excerpt);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(i);
  }
  return [...byKey.entries()].map(([key, items]) => ({
    key, items, targets: new Set(items.map((i) => i.target)).size,
  })).sort((a, b) => b.targets - a.targets);
}
