// B4 — Loadable detector rule packs (SPEC §4.1). The scan stage's detector
// core (SRC_PACKS, binary sink/category tables, verdict weights, tier
// thresholds) lives in versioned pack DATA (shield-packs/scan-rules-pack.json);
// scanWithPack() is the shipped scanSourceText algorithm driven by a pack
// instead of code constants. The baseline pack's rules_version is exactly
// 'scan-rules/1', so records produced under it are digest-identical to the
// shipped scanner's — proven in checks/b4-equivalence.mjs. A generated pack
// (baseline + loop-added source detectors) carries a bumped rules_version
// (scan-rules/1+gen.N) which joins the record's engine.rules field, keeping
// every record attributable to the exact rule set that produced it.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const BASELINE_PACK = JSON.parse(fs.readFileSync(path.join(HERE, 'shield-packs', 'scan-rules-pack.json'), 'utf8'));

const SEV_ORDER = ['info', 'low', 'medium', 'high', 'critical'];
const capSeverity = (sev, cap) => (SEV_ORDER.indexOf(sev) > SEV_ORDER.indexOf(cap) ? cap : sev);
const rxOf = (r) => new RegExp(r.source, r.flags ?? '');

function computeVerdictRisk(findings, confidence, weights) {
  const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const f of findings) counts[f.severity] = (counts[f.severity] || 0) + 1;
  let verdict;
  if (counts.critical > 0) verdict = 'critical';
  else if (counts.high > 0 || confidence === 'low') verdict = 'warn';
  else verdict = 'pass';
  let tier = 0;
  const drivers = [];
  const critRules = [...new Set(findings.filter((f) => f.severity === 'critical').map((f) => f.rule))];
  const highRules = [...new Set(findings.filter((f) => f.severity === 'high').map((f) => f.rule))];
  if (critRules.length) { tier = 2; drivers.push(...critRules); }
  else if (highRules.length) { tier = 1; drivers.push(...highRules); }
  else if (confidence === 'low') { tier = 1; drivers.push('static-analysis-limited'); }
  const score = Math.min(weights.cap,
    counts.critical * weights.critical + counts.high * weights.high + counts.medium * weights.medium + counts.low * weights.low);
  return { counts, verdict, risk: { score, tier, drivers } };
}

// The shipped scanSourceText, pack-driven. The co-occurrence and inventory
// blocks are algorithm, not detector tables, and are carried unchanged.
export function scanWithPack(text, name, targetSha, pack) {
  const started = new Date().toISOString();
  const t0 = Date.now();
  const findings = [];
  const lines = text.split('\n');
  findings.push({
    rule: 'source-lane-notice', severity: 'info', basis: 'pattern',
    location: name || '(source)',
    detail: 'pattern scan of source text — not binary analysis; absence of findings is absence of these patterns only',
  });
  for (const p of pack.src_packs) {
    const re = rxOf(p.re);
    lines.forEach((line, i) => {
      if (re.test(line)) {
        findings.push({
          rule: p.rule, severity: capSeverity(p.sev, 'high'), basis: 'pattern',
          location: `${name}:${i + 1}`, detail: p.detail,
          excerpt: line.trim().slice(0, 200),
        });
      }
    });
  }
  const hasNet = /(fetch\s*\(|axios|https?\.request|requests\.(post|put)|urllib|socket\.connect|curl\s|wget\s)/.test(text);
  const hasBulkRead = /(readFileSync|createReadStream|os\.environ|process\.env|glob\.|readdirSync|os\.walk)/.test(text);
  if (hasNet && hasBulkRead) {
    findings.push({
      rule: 'behavior-covert-exfiltration', severity: 'high', basis: 'pattern',
      location: name || '(source)',
      detail: 'outbound network channel co-occurs with bulk local data/environment access in one file [behavior: covert-exfiltration]',
    });
  }
  const base = path.basename(name || '');
  if (base === 'package.json') {
    try {
      const pkg = JSON.parse(text);
      const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      const names = Object.keys(deps);
      if (names.length) findings.push({
        rule: 'dependency-inventory', severity: 'info', basis: 'inventory',
        location: name, detail: `${names.length} declared dependencies (inventory only): ${names.slice(0, 40).join(', ')}`,
      });
      if (pkg.scripts && Object.keys(pkg.scripts).length) findings.push({
        rule: 'dependency-inventory', severity: 'info', basis: 'inventory',
        location: name, detail: `install/run scripts present: ${Object.keys(pkg.scripts).join(', ')} (inventory only)`,
      });
    } catch { /* unparseable manifest: no inventory, no invention */ }
  }
  if (base === 'requirements.txt') {
    const reqs = lines.map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    if (reqs.length) findings.push({
      rule: 'dependency-inventory', severity: 'info', basis: 'inventory',
      location: name, detail: `${reqs.length} declared requirements (inventory only)`,
    });
  }
  const PROMOTE = new Set(pack.composite.promote);
  const FAMILY = pack.composite.family;
  const eligible = [...new Set(findings
    .filter((f) => f.severity === 'high' && (PROMOTE.has(f.rule) || f.rule.startsWith('behavior-')))
    .map((f) => FAMILY[f.rule] || f.rule))];
  if (eligible.length >= 2) {
    findings.push({
      rule: 'source-composite-critical', severity: 'critical', basis: 'pattern-composite',
      location: name || '(source)',
      detail: `two independent high-severity code-execution/behavior patterns in one file (${eligible.join(' + ')}) — source-lane composite critical per SPEC §1.5`,
    });
  }
  const { counts, verdict, risk } = computeVerdictRisk(findings, 'full', pack.weights);
  return {
    format: 'scripture-armor-scan/1', target_sha256: targetSha, target_class: 'source',
    engine: { name: 'scripture-lexical', version: 'scripture-lexical/1', rules: pack.rules_version },
    started, duration_ms: Date.now() - t0, analysis_confidence: 'full',
    findings, counts, verdict, risk, override: null,
  };
}

// Canonical form for pack-produced records: byte-identical to the shipped
// canonicalScanRecord except the engine.rules field carries the pack's
// rules_version (SPEC §4.1: pack versions join the record's rules field).
export function canonicalPackRecord(rec) {
  const findings = (rec.findings || []).map((f) => ({
    rule: f.rule, severity: f.severity, basis: f.basis,
    location: f.location, detail: f.detail,
    ...(f.excerpt != null ? { excerpt: String(f.excerpt).slice(0, 400) } : {}),
  }));
  const ordered = {
    format: 'scripture-armor-scan/1',
    target_sha256: rec.target_sha256,
    target_class: rec.target_class,
    engine: { name: rec.engine.name, version: rec.engine.version, rules: rec.engine.rules },
    started: rec.started,
    duration_ms: rec.duration_ms,
    analysis_confidence: rec.analysis_confidence,
    findings,
    counts: rec.counts,
    verdict: rec.verdict,
    risk: { score: rec.risk.score, tier: rec.risk.tier, drivers: rec.risk.drivers },
    override: rec.override ?? null,
  };
  return JSON.stringify(ordered, null, 2);
}
export function packDigestOf(rec) {
  const timeless = { ...rec, started: null, duration_ms: null };
  return crypto.createHash('sha256').update(canonicalPackRecord(timeless), 'utf8').digest('hex');
}

// Derive a generated pack: baseline detectors + additional source packs
// (loop-generated scan-stage detectors), version bumped. Adding only —
// removing or altering a baseline detector is a loosening the gate refuses
// (SPEC §4 monotonicity), so this constructor cannot express it.
export function derivePack(base, extraSrcPacks, genN) {
  return {
    ...base,
    rules_version: `scan-rules/1+gen.${genN}`,
    base_rules: base.rules_version,
    src_packs: [...base.src_packs, ...extraSrcPacks],
    generated: { gen: genN, added_rules: extraSrcPacks.map((p) => p.rule) },
  };
}
