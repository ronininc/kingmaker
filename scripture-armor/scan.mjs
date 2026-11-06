#!/usr/bin/env node
// scan.mjs — Scripture Armor v2 Closure 1: the scan layer.
// Zero-dependency Node >= 22 (node: builtins only). Imported in-process by
// armor.mjs; also runnable standalone: `node scan.mjs <file> [--identity-dir <dir>]`
// prints the canonical verdict record as JSON.
//
// Doctrine (SPEC §1): nothing wraps unscanned. The deliverable is a
// VULNERABILITY REPORT — risk-scored findings mapped to the parts of the
// program they belong to — and armor weight is allocated from its risk
// score (tiers 0/1/2, §1.7). Two lanes:
//   binary — Ghidra headless (external subprocess, dumb exporter script;
//            ALL rules/severity live here, versioned as scan-rules/1)
//   source — built-in lexical pattern scan; severity capped at high;
//            a pattern scan is not binary analysis and the record says so
// Data (not code) records `not-applicable`: "we looked and it isn't code"
// is distinguishable from "we didn't look."
//
// Malware is defined by BEHAVIOR, never provenance (Addendum A.2): the
// rule tables classify remote activation, silent persistence, sensor
// access, covert exfiltration, and removal resistance. Signer, vendor,
// and installer are never exculpatory inputs anywhere in this file.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Detector rule pack (Shield-Builder B4) — the scan stage's detector core
// (source packs, content sniffs, binary sink/category tables, verdict
// weights, composite sets, tier defaults) lives in versioned DATA at
// shield-packs/scan-rules-pack.json, loaded here. The pack's
// rules_version IS the scan-rules lineage: it joins every record's
// engine.rules field, so each corpus record stays attributable to the
// exact rule set that produced it. A missing, corrupt, or
// version-mismatched pack is a hard failure at load — the scanner never
// runs on silently improvised detectors (fail closed).
// ---------------------------------------------------------------------------

export const RULE_PACK_PATH = path.join(HERE, 'shield-packs', 'scan-rules-pack.json');
export function loadRulePack(packPath = RULE_PACK_PATH) {
  const pack = JSON.parse(fs.readFileSync(packPath, 'utf8'));
  if (pack.format !== 'scripture-armor-rule-pack/1' || typeof pack.rules_version !== 'string') {
    throw Error(`invalid detector rule pack: ${packPath}`);
  }
  return pack;
}
export const RULE_PACK = loadRulePack();
export const SCAN_RULES_VERSION = RULE_PACK.rules_version;
const packRegExp = (r) => new RegExp(r.source, r.flags ?? '');

// ---------------------------------------------------------------------------
// Policy (SPEC §0.4) — policy.json in the identity store, owner-edited,
// absent = the defaults below. Re-read per operation.
// ---------------------------------------------------------------------------

export const DEFAULT_POLICY = {
  scan: {
    required_for: ['binary', 'source'],
    timeout_s: 600,
    repo_critical: 'refuse-all', // | 'refuse-file'
    max_age_days: null,
    ghidra_home: null,
    jdk_home: null,
    tiers: {
      1: { expiry_cap_hours: 168, reseal_hours: 720 },
      2: { expiry_cap_hours: 24, reseal_hours: 24, scan_max_age_hours: 24 },
    },
  },
  // Closure 2 (SPEC §2) — activation cells. Defaults from the spec:
  // scratch 256 MB, wall-clock 300 s, emission frame cap 16 MiB.
  cell: {
    min_class: 'hard', // binary-class default; tier params override per entry
    soft_for_source: true, // source-class activations may use SOFT without a downgrade tap
    scratch_mb: 256,
    max_seconds: 300,
    cpu_seconds: 60,
    max_emission_bytes: 16 * 1024 * 1024,
    max_emissions: 1000,
    lease_s: 30, // orphan-reap staleness window for cell markers
    repo_entry: null, // default entry relpath for repo activations
  },
  // Closure 4 (SPEC §4) — estate extension. The mesh listener exists
  // ONLY when mesh_listen is set (absent = v1 behavior exactly, no
  // listener). revocation_max_stale bounds how long this endpoint keeps
  // accepting new mesh registrations without a completed sync-registry
  // (default 24 h, per SPEC §4.5). tier3 names posture endpoints for the
  // estate descriptor (labels only — Tier 3 holds no keys, ever).
  // mesh_host optionally names (by address-book label) the endpoint
  // acting as the mesh server (Addendum B: host device as control
  // plane / exit / DNS); absent = this endpoint.
  estate: {
    mesh_listen: null, // "<ip>:<port>" — bind ONLY this address, never 0.0.0.0
    revocation_max_stale: 86400, // seconds
    tier3: [], // [{label, note?}]
    mesh_host: null, // address-book label of the mesh host, or null = self
  },
  // Closure 3 (SPEC §3.4) — docking airlock limits + dock profiles.
  airlock: {
    max_message_bytes: 1024 * 1024,
    max_session_bytes: 64 * 1024 * 1024,
    max_messages: 10000,
    idle_s: 300,
    max_violations: 3,
    profiles: {}, // {name: {classes: [...], plaintext_code: bool, serves: canary|null}}
  },
};

function mergePolicy(base, over) {
  const out = {
    scan: { ...base.scan, tiers: { 1: { ...base.scan.tiers[1] }, 2: { ...base.scan.tiers[2] } } },
    cell: { ...base.cell },
    airlock: { ...base.airlock, profiles: { ...base.airlock.profiles } },
    estate: { ...base.estate, tier3: [...(base.estate?.tier3 || [])] },
  };
  if (over && typeof over === 'object') {
    if (over.scan) {
      for (const [k, v] of Object.entries(over.scan)) {
        if (k === 'tiers' && v && typeof v === 'object') {
          for (const t of ['1', '2']) if (v[t]) Object.assign(out.scan.tiers[t], v[t]);
        } else out.scan[k] = v;
      }
    }
    if (over.cell && typeof over.cell === 'object') Object.assign(out.cell, over.cell);
    if (over.estate && typeof over.estate === 'object') {
      for (const [k, v] of Object.entries(over.estate)) {
        if (k === 'tier3' && Array.isArray(v)) out.estate.tier3 = v;
        else out.estate[k] = v;
      }
    }
    if (over.airlock && typeof over.airlock === 'object') {
      for (const [k, v] of Object.entries(over.airlock)) {
        if (k === 'profiles' && v && typeof v === 'object') Object.assign(out.airlock.profiles, v);
        else out.airlock[k] = v;
      }
    }
  }
  return out;
}

export function loadPolicy(storeDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(storeDir, 'policy.json'), 'utf8'));
    return mergePolicy(DEFAULT_POLICY, raw);
  } catch { return mergePolicy(DEFAULT_POLICY, null); }
}

// Tier parameters — the concrete "heavier" of SPEC §1.7.2, snapshotted
// into the registry (and the repo manifest) at wrap time so the daemon
// enforces numbers, not intentions.
export function tierParams(tier, policy) {
  const t = policy.scan.tiers[tier] || {};
  if (tier === 2) {
    return {
      expiry_cap_hours: t.expiry_cap_hours ?? RULE_PACK.tier_defaults[2].expiry_cap_hours,
      reseal_hours: t.reseal_hours ?? RULE_PACK.tier_defaults[2].reseal_hours,
      dual_approval: true,
      min_cell: 'hard',
      downgrade_allowed: false,
      egress: 'airlock-only',
      reverify: 'every-activation+freshness',
      scan_max_age_hours: t.scan_max_age_hours ?? RULE_PACK.tier_defaults[2].scan_max_age_hours,
      beacon_anomaly: true,
    };
  }
  if (tier === 1) {
    return {
      expiry_cap_hours: t.expiry_cap_hours ?? RULE_PACK.tier_defaults[1].expiry_cap_hours,
      reseal_hours: t.reseal_hours ?? RULE_PACK.tier_defaults[1].reseal_hours,
      dual_approval: false,
      min_cell: 'hard',
      downgrade_allowed: true,
      egress: 'peers+airlock',
      reverify: 'every-activation',
      scan_max_age_hours: null,
      beacon_anomaly: false,
    };
  }
  return {
    expiry_cap_hours: null,
    reseal_hours: null,
    dual_approval: false,
    min_cell: 'policy-default',
    downgrade_allowed: true,
    egress: 'any',
    reverify: 'registration+first',
    scan_max_age_hours: null,
    beacon_anomaly: false,
  };
}

// ---------------------------------------------------------------------------
// Classification (SPEC §1.3) — in this order: binary magic, source, data.
// ---------------------------------------------------------------------------

const SOURCE_EXTS = new Set([
  '.mjs', '.js', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.sh', '.bash', '.zsh',
  '.rb', '.pl', '.pm', '.php', '.c', '.h', '.cc', '.cpp', '.hpp', '.rs',
  '.go', '.java', '.kt', '.swift', '.lua', '.ps1', '.bat', '.cmd',
]);
const MANIFEST_NAMES = new Set(['package.json', 'requirements.txt', 'pipfile', 'gemfile', 'cargo.toml']);

export function classifyBuffer(buf, name = '') {
  const b = buf || Buffer.alloc(0);
  if (b.length >= 4) {
    if (b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46) return 'binary'; // ELF
    if (b[0] === 0x4d && b[1] === 0x5a) return 'binary'; // MZ / PE
    const m32 = b.readUInt32BE(0);
    if (m32 === 0xfeedface || m32 === 0xfeedfacf || m32 === 0xcefaedfe || m32 === 0xcffaedfe) return 'binary'; // Mach-O
    if (m32 === 0xcafebabe || m32 === 0xcafebabf) return 'binary'; // Mach-O fat
    if (b.subarray(0, 8).toString('latin1') === '!<arch>\n') return 'binary'; // ar archive
  }
  const base = path.basename(name || '');
  if (MANIFEST_NAMES.has(base.toLowerCase())) return 'source';
  const ext = path.extname(base).toLowerCase();
  if (SOURCE_EXTS.has(ext)) return 'source';
  // Shebang on an extensionless/unknown file still means source.
  if (b.length >= 2 && b[0] === 0x23 && b[1] === 0x21) return 'source';
  // Phase 4 (FIX 4): classify by CONTENT, not by the staged name. The
  // red team crossed the airlock with a shell payload staged as .mjs
  // (shell rules never ran) and with keyword-less Python staged as
  // data (no source rules ran at all). A text-looking buffer carrying
  // strong code signals IS source, whatever its name claims. Binary
  // formats are already excluded above or carry NUL bytes; prose does
  // not contain these tokens.
  if (!b.subarray(0, 8192).includes(0)) {
    const head = b.subarray(0, 16384).toString('utf8');
    if (SOURCE_SNIFFS.some((re) => re.test(head))) return 'source';
  }
  return 'data';
}

// Strong code signals for the content sniff (FIX 4). Deliberately
// token-shaped: interpreter calls, shell plumbing, module systems.
// B4: the sniff tables are rule-pack data (shield-packs/scan-rules-pack.json).
const SOURCE_SNIFFS = RULE_PACK.source_sniffs.map(packRegExp);

// ---------------------------------------------------------------------------
// Canonical verdict record (SPEC §0.3) — key order fixed as listed;
// digest = SHA-256 of the exact canonical bytes. The report package's
// plaintext IS this canonical form, so anyone can recompute the digest.
// ---------------------------------------------------------------------------

export function canonicalScanRecord(rec) {
  const findings = (rec.findings || []).map((f) => ({
    rule: f.rule, severity: f.severity, basis: f.basis,
    location: f.location, detail: f.detail,
    ...(f.excerpt != null ? { excerpt: String(f.excerpt).slice(0, 400) } : {}),
  }));
  const ordered = {
    format: 'scripture-armor-scan/1',
    target_sha256: rec.target_sha256,
    target_class: rec.target_class,
    engine: { name: rec.engine.name, version: rec.engine.version, rules: SCAN_RULES_VERSION },
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

export function scanDigestOf(rec) {
  // Phase 4 (FIX 5): the digest binds the FINDINGS, never the clock.
  // started/duration_ms are normalized out of the canonical form before
  // hashing, so a genuine re-scan of identical bytes reproduces the
  // bound digest exactly and the Tier-2 freshness gate can compare a
  // fresh scan against the digest sealed at wrap time. (The full record
  // — with its real timestamps — is what the report package seals; the
  // freshness gate reads `started` from that record.) Before this fix
  // the digest covered the timestamps, so no re-scan could ever match
  // and the freshness comparison was unreachable in both directions.
  const timeless = { ...rec, started: null, duration_ms: null };
  return crypto.createHash('sha256').update(canonicalScanRecord(timeless), 'utf8').digest('hex');
}

const SEV_ORDER = ['info', 'low', 'medium', 'high', 'critical'];
function capSeverity(sev, cap) {
  return SEV_ORDER.indexOf(sev) > SEV_ORDER.indexOf(cap) ? cap : sev;
}

function computeVerdictRisk(findings, confidence) {
  const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const f of findings) counts[f.severity] = (counts[f.severity] || 0) + 1;
  let verdict;
  if (counts.critical > 0) verdict = 'critical';
  else if (counts.high > 0 || confidence === 'low') verdict = 'warn';
  else verdict = 'pass';
  // Risk → tier (SPEC §1.7.1). Drivers name the rules that set the tier.
  let tier = 0;
  const drivers = [];
  const critRules = [...new Set(findings.filter((f) => f.severity === 'critical').map((f) => f.rule))];
  const highRules = [...new Set(findings.filter((f) => f.severity === 'high').map((f) => f.rule))];
  if (critRules.length) { tier = 2; drivers.push(...critRules); }
  else if (highRules.length) { tier = 1; drivers.push(...highRules); }
  else if (confidence === 'low') { tier = 1; drivers.push('static-analysis-limited'); }
  const W = RULE_PACK.weights;
  const score = Math.min(W.cap,
    counts.critical * W.critical + counts.high * W.high + counts.medium * W.medium + counts.low * W.low);
  return { counts, verdict, risk: { score, tier, drivers } };
}

// ---------------------------------------------------------------------------
// Source lane (SPEC §1.5) — lexical pattern packs. Severity capped at
// high; every finding basis 'pattern'. Behavior classes (Addendum A.2)
// ride as behavior-* rules; provenance is never an input.
// ---------------------------------------------------------------------------

// B4: the source detector packs are rule-pack data
// (shield-packs/scan-rules-pack.json), extracted mechanically from the
// tables this array used to hardcode; digest equivalence against the
// pre-refactor scanner is proven in test/shield-b4-equivalence.test.mjs.
const SRC_PACKS = RULE_PACK.src_packs.map((p) => ({ ...p, re: packRegExp(p.re) }));

function langOf(name) {
  const ext = path.extname(name || '').toLowerCase();
  if (['.mjs', '.js', '.cjs', '.ts', '.tsx', '.jsx'].includes(ext)) return 'js';
  if (['.sh', '.bash', '.zsh'].includes(ext)) return 'sh';
  if (ext === '.py') return 'py';
  return 'any';
}

export function scanSourceText(text, name, targetSha) {
  const started = new Date().toISOString();
  const t0 = Date.now();
  const findings = [];
  const lang = langOf(name);
  const lines = text.split('\n');
  const header = 'pattern scan of source text — not binary analysis; absence of findings is absence of these patterns only';
  findings.push({
    rule: 'source-lane-notice', severity: 'info', basis: 'pattern',
    location: name || '(source)', detail: header,
  });
  // Phase 4 (FIX 4): EVERY pack runs on EVERY source text. Language
  // packs are token-shaped (os.system( cannot appear in honest JS,
  // eval( is dangerous in both), so gating packs by the staged file's
  // claimed language only ever hid findings — the red team's shell
  // payload in .mjs clothing and keyword-less Python both crossed
  // because the packs that would have caught them never ran. `lang`
  // still labels the record; it no longer decides what is looked for.
  for (const pack of SRC_PACKS) {
    lines.forEach((line, i) => {
      if (pack.re.test(line)) {
        findings.push({
          rule: pack.rule, severity: capSeverity(pack.sev, 'high'), basis: 'pattern',
          location: `${name}:${i + 1}`, detail: pack.detail,
          excerpt: line.trim().slice(0, 200),
        });
      }
    });
  }
  // Covert-exfiltration co-occurrence (file-level): an outbound channel
  // plus bulk local data access in the same file.
  const hasNet = /(fetch\s*\(|axios|https?\.request|requests\.(post|put)|urllib|socket\.connect|curl\s|wget\s)/.test(text);
  const hasBulkRead = /(readFileSync|createReadStream|os\.environ|process\.env|glob\.|readdirSync|os\.walk)/.test(text);
  if (hasNet && hasBulkRead) {
    findings.push({
      rule: 'behavior-covert-exfiltration', severity: 'high', basis: 'pattern',
      location: name || '(source)',
      detail: 'outbound network channel co-occurs with bulk local data/environment access in one file [behavior: covert-exfiltration]',
    });
  }
  // Manifest inventory (SPEC §1.5): dependency lists are recorded, never judged.
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
  // Source-lane critical (SPEC §1.5): a single pattern proves little, so
  // no single source finding is critical — but TWO independent high
  // findings from the code-execution / behavior families in one file
  // compose into a critical. The composite is itself a finding, so the
  // sealed record shows exactly why.
  const PROMOTE = new Set(RULE_PACK.composite.promote);
  // With every pack running on every text (FIX 4), the same token can
  // fire its rule in two language packs (eval( is both src-eval-call
  // and src-py-eval-exec). The composite counts independent CONSTRUCTS,
  // so cross-language duplicates of one construct share a family and
  // count once — a lone eval( stays a single high (warn), exactly as
  // before; eval + os.system is two constructs and composes.
  const FAMILY = RULE_PACK.composite.family;
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
  const { counts, verdict, risk } = computeVerdictRisk(findings, 'full');
  return {
    format: 'scripture-armor-scan/1', target_sha256: targetSha, target_class: 'source',
    engine: { name: 'scripture-lexical', version: 'scripture-lexical/1', rules: SCAN_RULES_VERSION },
    started, duration_ms: Date.now() - t0, analysis_confidence: 'full',
    findings, counts, verdict, risk, override: null,
  };
}

// ---------------------------------------------------------------------------
// Binary lane (SPEC §1.4) — Ghidra headless + the dumb exporter.
// ---------------------------------------------------------------------------

// B4: the binary lane's sink/category tables are rule-pack data
// (shield-packs/scan-rules-pack.json). Dangerous-import categories are
// inventory basis; behavior classes per Addendum A.2 ride in the pack's
// behavior field; provenance is never consulted.
const EXEC_SINKS = new Set(RULE_PACK.binary.exec_sinks);
const UNBOUNDED_SINKS = new Set(RULE_PACK.binary.unbounded_sinks);
const IMPORT_CATEGORIES = RULE_PACK.binary.import_categories.map((c) => ({ ...c, names: new Set(c.names) }));
const INPUT_FNS = new Set(RULE_PACK.binary.input_fns);

// PLATFORM SEAM (packaging requirement, 2026-10-24): engine discovery
// tries, in order — owner policy, environment, a BUNDLED layout relative
// to this file (where per-platform installers will ship the engine:
// <app>/tools/ghidra_*, <app>/../tools/ghidra_*), then this development
// sandbox's ~/workspace/tools. The launcher and java binary names are
// the only platform-switched strings, isolated here.
const HEADLESS_NAME = process.platform === 'win32' ? 'analyzeHeadless.bat' : 'analyzeHeadless';
const JAVA_BIN = process.platform === 'win32' ? 'java.exe' : 'java';

function ghidraHomesIn(dir, acc) {
  try {
    for (const ent of fs.readdirSync(dir).sort().reverse()) {
      if (/^ghidra_/i.test(ent)) acc.push(path.join(dir, ent));
    }
  } catch {}
  return acc;
}

export function findGhidra(policy) {
  // An explicit policy pin is AUTHORITATIVE: if the operator pinned an
  // engine home and it is not a runnable Ghidra, the scan fails closed
  // (GHIDRA_NOT_FOUND) instead of silently substituting a different
  // engine the operator did not choose (SPEC §1.9 case 12).
  if (policy?.scan?.ghidra_home) {
    const headless = path.join(policy.scan.ghidra_home, 'support', HEADLESS_NAME);
    return fs.existsSync(headless) ? { home: policy.scan.ghidra_home, headless } : null;
  }
  const candidates = [];
  if (process.env.SCRIPTURE_GHIDRA_HOME) candidates.push(process.env.SCRIPTURE_GHIDRA_HOME);
  ghidraHomesIn(path.join(HERE, 'tools'), candidates);
  ghidraHomesIn(path.join(HERE, '..', 'tools'), candidates);
  ghidraHomesIn(path.join(os.homedir(), 'workspace', 'tools'), candidates);
  for (const home of candidates) {
    const headless = path.join(home, 'support', HEADLESS_NAME);
    if (fs.existsSync(headless)) return { home, headless };
  }
  return null;
}

export function findJdk(policy) {
  if (policy?.scan?.jdk_home) {
    return fs.existsSync(path.join(policy.scan.jdk_home, 'bin', JAVA_BIN)) ? policy.scan.jdk_home : null;
  }
  const candidates = [];
  if (process.env.JAVA_HOME) candidates.push(process.env.JAVA_HOME);
  // Ghidra 12.2 wants JDK 25 (application.java.min=25); older Ghidra
  // wanted 21. Probe both names — the engine check happens at launch.
  candidates.push(path.join(HERE, 'tools', 'jdk'));
  candidates.push(path.join(HERE, '..', 'tools', 'jdk25'));
  candidates.push(path.join(os.homedir(), 'workspace', 'tools', 'jdk25'));
  candidates.push(path.join(HERE, '..', 'tools', 'jdk21'));
  candidates.push(path.join(os.homedir(), 'workspace', 'tools', 'jdk21'));
  for (const home of candidates) {
    if (home && fs.existsSync(path.join(home, 'bin', JAVA_BIN))) return home;
  }
  return null;
}

function ghidraVersion(home) {
  try {
    const props = fs.readFileSync(path.join(home, 'Ghidra', 'application.properties'), 'utf8');
    const m = props.match(/application\.version=([^\r\n]+)/);
    if (m) return `ghidra ${m[1].trim()}`;
  } catch {}
  return `ghidra ${path.basename(home)}`;
}

function spawnWithTimeout(cmd, args, { timeoutMs, env, cwd }) {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '', timedOut = false;
    proc.stdout.on('data', (d) => { out += d; if (out.length > 4 * 1024 * 1024) out = out.slice(-4 * 1024 * 1024); });
    proc.stderr.on('data', (d) => { err += d; if (err.length > 4 * 1024 * 1024) err = err.slice(-4 * 1024 * 1024); });
    const timer = setTimeout(() => { timedOut = true; try { proc.kill('SIGKILL'); } catch {} }, timeoutMs);
    proc.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out, err: err + String(e), timedOut }); });
    proc.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err, timedOut }); });
  });
}

// Runs the exporter over a staged COPY of the target (the original is
// never handed to the JVM). Workdir lives under <store>/scan-work/<uuid>/
// (0700) and is wiped on every exit path — pass, fail, and timeout.
export async function runGhidraExporter(targetAbs, { policy, storeDir }) {
  const gh = findGhidra(policy);
  if (!gh) {
    const e = new Error('GHIDRA_NOT_FOUND: no Ghidra installation found (set scan.ghidra_home in policy.json or SCRIPTURE_GHIDRA_HOME) — binary scan fails closed');
    e.code = 'GHIDRA_NOT_FOUND';
    throw e;
  }
  const jdk = findJdk(policy);
  const workRoot = path.join(storeDir, 'scan-work');
  fs.mkdirSync(workRoot, { recursive: true, mode: 0o700 });
  const work = path.join(workRoot, crypto.randomUUID());
  fs.mkdirSync(work, { recursive: true, mode: 0o700 });
  const timeoutS = policy?.scan?.timeout_s ?? 600;
  try {
    const staged = path.join(work, 'target.bin');
    fs.copyFileSync(targetAbs, staged);
    // analyzeHeadless requires the project LOCATION directory to exist.
    fs.mkdirSync(path.join(work, 'proj'), { recursive: true });
    const obsPath = path.join(work, 'observations.json');
    const scriptDir = path.join(HERE, 'ghidra-scripts');
    const env = { ...process.env };
    if (jdk) env.JAVA_HOME = jdk;
    const res = await spawnWithTimeout(gh.headless, [
      path.join(work, 'proj'), 'ScanProj',
      '-import', staged,
      '-scriptPath', scriptDir,
      '-postScript', 'ScriptureScan.java', obsPath,
      '-deleteProject',
      '-analysisTimeoutPerFile', String(timeoutS),
    ], { timeoutMs: timeoutS * 1000, env, cwd: work });
    if (res.timedOut) {
      const e = new Error(`scan-timeout: Ghidra analysis exceeded ${timeoutS}s — verdict unscanned-engine-error`);
      e.code = 'ENGINE_TIMEOUT';
      throw e;
    }
    if (!fs.existsSync(obsPath)) {
      const tail = (res.err || res.out || '').trim().split('\n').slice(-6).join(' | ');
      const e = new Error(`GHIDRA_FAILED: exporter produced no observations (exit ${res.code}) ${tail}`);
      e.code = 'GHIDRA_FAILED';
      throw e;
    }
    const obs = JSON.parse(fs.readFileSync(obsPath, 'utf8'));
    if (obs?.format !== 'scripture-scan-obs/1' || !Number.isSafeInteger(obs.functions_count) || obs.functions_count < 0
      || !['imports', 'call_paths', 'sections'].every((key) => Array.isArray(obs[key]))
      || !Number.isSafeInteger(obs.decompile?.attempted) || !Number.isSafeInteger(obs.decompile?.failed)
      || obs.decompile.attempted < 0 || obs.decompile.failed < 0 || obs.decompile.failed > obs.decompile.attempted) {
      const error = new Error('GHIDRA_INVALID_OBSERVATIONS: exporter returned an incomplete or inconsistent analysis record; binary scan refused');
      error.code = 'GHIDRA_INVALID_OBSERVATIONS';
      throw error;
    }
    return { obs, engineVersion: ghidraVersion(gh.home), ghidraHome: gh.home };
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch {}
  }
}

// Normalize raw exporter observations into findings under scan-rules/1.
export function normalizeBinaryFindings(obs, targetSha, storeDir) {
  const findings = [];
  const push = (f) => findings.push(f);
  // exact-sample-hash: owner-curated list only; ships empty; no bundled intel.
  try {
    const list = fs.readFileSync(path.join(storeDir, 'badhashes.txt'), 'utf8')
      .split('\n').map((l) => l.trim().toLowerCase()).filter((l) => l && !l.startsWith('#'));
    if (list.includes(targetSha.toLowerCase())) {
      push({ rule: 'exact-sample-hash', severity: 'critical', basis: 'exact-hash', location: '(whole file)', detail: 'target SHA-256 appears in the owner-curated badhashes.txt' });
    }
  } catch {}
  let flaggedLibs = [];
  try {
    flaggedLibs = fs.readFileSync(path.join(storeDir, 'flagged-libraries.txt'), 'utf8')
      .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  } catch {}

  const imports = obs.imports || [];
  const importNames = new Set(imports.map((i) => i.name));
  for (const catDef of IMPORT_CATEGORIES) {
    for (const name of catDef.names) {
      if (importNames.has(name)) {
        push({
          rule: 'dangerous-import', severity: catDef.sev, basis: 'inventory',
          location: `import: ${name}`,
          detail: `${catDef.cat} capability present (import ${name})${catDef.behavior ? ` [behavior: ${catDef.behavior}]` : ''} — presence is a fact; reachability is scored separately`,
        });
      }
    }
  }
  // Sink reachability from the exporter's call-graph paths. (Deduped by
  // root+caller+sink: multiple BFS routes to the same call site are one
  // finding, and its severity takes the worst literal-ness seen.)
  const pathSeen = new Set();
  for (const p of obs.call_paths || []) {
    const pkey = `${p.from?.addr || p.from?.name}->${p.sink_site?.addr || p.via}->${p.sink}:${p.arg_literal === true ? 'lit' : 'nonlit'}`;
    if (pathSeen.has(pkey)) continue;
    pathSeen.add(pkey);
    const sink = p.sink;
    const fromName = p.from?.name || '(entry)';
    if (EXEC_SINKS.has(sink)) {
      if (p.arg_literal === true && p.argument_evidence === 'unique-call-text') {
        push({
          rule: 'sink-reachability', severity: 'low', basis: 'path-heuristic',
          location: `${fromName} -> ${sink}${p.sink_site?.addr ? ` @ ${p.sink_site.addr}` : ''}`,
          detail: `call path from ${fromName} to command-exec sink ${sink} with a compile-time literal argument`,
          ...(p.sink_site?.excerpt ? { excerpt: p.sink_site.excerpt } : {}),
        });
      } else {
        push({
          rule: 'sink-reachability', severity: p.arg_literal === false && p.argument_evidence === 'unique-call-text' ? 'critical' : 'high', basis: 'path-heuristic',
          location: `${fromName} -> ${sink}${p.sink_site?.addr ? ` @ ${p.sink_site.addr}` : ''}`,
          detail: p.arg_literal !== false || p.argument_evidence !== 'unique-call-text' ? `call path from ${fromName} to command-exec sink ${sink}; per-call argument evidence is UNKNOWN, so no literal safety claim is made` : `call path from ${fromName} (entry/input-touching) to command-exec sink ${sink}; decompiler excerpt at the sink shows a NON-literal argument — the classic command-injection shape (candidate: reachability is heuristic, argument control is not proven)`,
          ...(p.sink_site?.excerpt ? { excerpt: p.sink_site.excerpt } : {}),
        });
      }
    } else if (UNBOUNDED_SINKS.has(sink)) {
      push({
        rule: 'sink-reachability', severity: 'high', basis: 'path-heuristic',
        location: `${fromName} -> ${sink}${p.sink_site?.addr ? ` @ ${p.sink_site.addr}` : ''}`,
        detail: `call path from ${fromName} (entry/input-touching) to unbounded-copy sink ${sink} — overflow candidate; this rule cannot prove overflow`,
        ...(p.sink_site?.excerpt ? { excerpt: p.sink_site.excerpt } : {}),
      });
    }
  }
  // Direct call sites to unbounded-copy functions (any caller).
  const siteCounts = new Map();
  for (const s of obs.call_sites || []) {
    if (s.func === '(no-function)' || s.func === s.callee) continue; // PLT/GOT plumbing, not call sites
    if (UNBOUNDED_SINKS.has(s.callee)) {
      const key = `${s.func} -> ${s.callee}`;
      siteCounts.set(key, (siteCounts.get(key) || 0) + 1);
    }
  }
  for (const [key, n] of siteCounts) {
    push({
      rule: 'unbounded-copy-call', severity: 'medium', basis: 'pattern',
      location: key, detail: `${n} direct call site(s) to an unbounded-copy function without a length-checked variant in the same function — overflow candidate, labeled as such`,
    });
  }
  // Embedded endpoints (also behavior evidence: network-control surface).
  const epRe = /(https?:\/\/[^\s"'<>]+|\b(?:\d{1,3}\.){3}\d{1,3}\b(?::\d{1,5})?)/;
  let epCount = 0;
  for (const s of obs.strings || []) {
    if (epCount >= 20) break;
    const m = String(s.value || '').match(epRe);
    if (m) {
      epCount++;
      push({
        rule: 'embedded-endpoint', severity: 'info', basis: 'inventory',
        location: `string @ ${s.addr || '?'}`, detail: `embedded endpoint string: ${m[0].slice(0, 120)}`,
      });
    }
  }
  if (obs.fid_status === 'not-performed') push({
    rule: 'library-identification-status', severity: 'info', basis: 'inventory',
    location: '(whole file)', detail: 'Function-ID library matching was not performed; an empty match list is not evidence that no known library is present',
  });
  // Known-library matches from Function-ID names (exporter may supply).
  for (const f of obs.fid_matches || []) {
    const flagged = flaggedLibs.some((x) => String(f.name || '').toLowerCase().includes(x.toLowerCase()));
    push({
      rule: 'known-library', severity: flagged ? 'high' : 'info', basis: 'inventory',
      location: `function: ${f.name}`, detail: flagged
        ? `bundled library code matches the owner flag list (flagged-libraries.txt): ${f.name}`
        : `bundled library code identified by Function-ID: ${f.name}`,
    });
  }
  // Static-analysis limits → confidence cap (an opaque binary never earns pass).
  let confidence = 'full';
  const reasons = [];
  const upx = (obs.sections || []).find((s) => /^UPX\d/i.test(s.name || ''));
  if (upx) reasons.push(`packer section name ${upx.name} (UPX-class packing)`);
  const hotExec = (obs.sections || []).find((s) => s.exec && typeof s.entropy === 'number' && s.entropy >= 7.2);
  if (hotExec) reasons.push(`high-entropy executable region ${hotExec.name} (entropy ${hotExec.entropy.toFixed(2)})`);
  if (!Number.isSafeInteger(obs.functions_count) || obs.functions_count <= 0) {
    reasons.push('no analyzed functions were reported');
  }
  const coverage = obs.coverage;
  const coverageKeys = ['paths_total', 'paths_omitted', 'sites_total', 'sites_omitted', 'decompile_eligible', 'decompile_omitted'];
  if (!coverage || coverageKeys.some(k => !Number.isSafeInteger(coverage[k]) || coverage[k] < 0)
      || coverage.paths_total !== (obs.call_paths || []).length + coverage.paths_omitted
      || coverage.sites_total !== (obs.call_sites || []).length + coverage.sites_omitted) {
    reasons.push('missing or malformed observation coverage counters');
  } else if (coverage.paths_omitted || coverage.sites_omitted || coverage.decompile_omitted) {
    reasons.push(`observation caps omitted ${coverage.paths_omitted} paths, ${coverage.sites_omitted} sites, ${coverage.decompile_omitted} decompilations`);
  }
  if ((obs.call_paths || []).some(p => typeof p.arg_literal !== 'boolean' || p.argument_evidence !== 'unique-call-text')) reasons.push('per-call argument evidence is unknown or unsupported');
  const dec = obs.decompile || {};
  if (!Number.isSafeInteger(dec.attempted) || dec.attempted < 0 || !Number.isSafeInteger(dec.failed) || dec.failed < 0 || dec.failed > dec.attempted
      || (coverage && Number.isSafeInteger(coverage.decompile_eligible) && coverage.decompile_eligible !== dec.attempted + coverage.decompile_omitted)) reasons.push('missing or inconsistent decompiler coverage');
  if (dec.failed > 0) {
    reasons.push(`decompiler failed on ${dec.failed}/${dec.attempted} attempted functions; incomplete analysis cannot earn full confidence`);
  }
  if (reasons.length) {
    confidence = 'low';
    push({
      rule: 'static-analysis-limited', severity: 'info', basis: 'inventory',
      location: '(whole file)', detail: `static analysis is limited: ${reasons.join('; ')} — verdict capped at warn; an opaque binary cannot earn pass from a blind scan`,
    });
  }
  return { findings, confidence };
}

// UPX v10+ non-DOS pack-header layout/checksum, reviewed against pinned upstream
// src/packhead.cpp. This identifies packed-analysis limits, not malicious behavior.
export function upxMachOHeaderEvidence(bytes, fileSize = bytes.length) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 32) return null;
  const magic = bytes.readUInt32LE(0);
  if (![0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(magic)) return null;
  const formats = new Set([29, 32, 34, 37, 131, 139]);
  let cursor = 0;
  while ((cursor = bytes.indexOf('UPX!', cursor)) >= 0) {
    const at = cursor++;
    if (at + 32 > bytes.length) continue;
    const h = bytes.subarray(at, at + 32), version = h[4], format = h[5];
    if (version < 10 || version > 13 || !formats.has(format) || h[6] < 2 || h[6] > 14 || (h[7] & 15) < 1 || (h[7] & 15) > 10) continue;
    let checksum = 0; for (let i = 4; i < 31; i++) checksum += h[i];
    if (checksum % 251 !== h[31]) continue;
    const big = format >= 128;
    const uLen = big ? h.readUInt32BE(8) : h.readUInt32LE(16);
    const cLen = big ? h.readUInt32BE(12) : h.readUInt32LE(20);
    const original = big ? h.readUInt32BE(24) : h.readUInt32LE(24);
    if (uLen < 2 || cLen < 2 || cLen >= uLen || cLen > fileSize || original < uLen) continue;
    return { offset: at, version, format, compressedBytes: cLen, unpackedBytes: uLen, originalBytes: original };
  }
  return null;
}
function packedMachOEvidence(file) {
  const fd = fs.openSync(file, 'r');
  try { const size = fs.fstatSync(fd).size, bytes = Buffer.alloc(Math.min(size, 4 * 1024 * 1024));
    const count = fs.readSync(fd, bytes, 0, bytes.length, 0);
    return upxMachOHeaderEvidence(bytes.subarray(0, count), size);
  } finally { fs.closeSync(fd); }
}

export async function scanBinaryFile(targetAbs, { policy, storeDir, targetSha }) {
  const started = new Date().toISOString();
  const t0 = Date.now();
  const { obs, engineVersion } = await runGhidraExporter(targetAbs, { policy, storeDir });
  const normalized = normalizeBinaryFindings(obs, targetSha, storeDir);
  const findings = normalized.findings;
  const packed = packedMachOEvidence(targetAbs);
  let confidence = normalized.confidence;
  if (packed) {
    confidence = 'low';
    findings.push({ rule: 'static-analysis-limited', severity: 'info', basis: 'pattern', location: `UPX pack header @ ${packed.offset}`,
      detail: `checksum-valid UPX v${packed.version} Mach-O format ${packed.format} pack header (${packed.compressedBytes}/${packed.unpackedBytes} compressed/unpacked bytes); packed content is not unpacked or analyzed here — cannot earn pass from loader-stub analysis` });
  }
  const { counts, verdict, risk } = computeVerdictRisk(findings, confidence);
  return {
    format: 'scripture-armor-scan/1', target_sha256: targetSha, target_class: 'binary',
    engine: { name: 'ghidra-headless', version: engineVersion, rules: SCAN_RULES_VERSION },
    started, duration_ms: Date.now() - t0, analysis_confidence: confidence,
    findings, counts, verdict, risk, override: null,
  };
}

// Data lane: we looked, and it isn't code.
export function dataRecord(targetSha) {
  return {
    format: 'scripture-armor-scan/1', target_sha256: targetSha, target_class: 'data',
    engine: { name: 'none', version: 'none', rules: SCAN_RULES_VERSION },
    started: new Date().toISOString(), duration_ms: 0, analysis_confidence: 'full',
    findings: [], counts: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
    verdict: 'not-applicable', risk: { score: 0, tier: 0, drivers: [] }, override: null,
  };
}

// One entry point for callers: classify + scan a file on disk.
// Returns { cls, record|null } — record is null only when the caller
// explicitly declines scanning (data class under --no-scan semantics).
export async function scanFile(targetAbs, { policy, storeDir }) {
  const fd = fs.openSync(targetAbs, 'r');
  let head;
  try {
    const buf = Buffer.alloc(8192);
    const n = fs.readSync(fd, buf, 0, 8192, 0);
    head = buf.subarray(0, n);
  } finally { fs.closeSync(fd); }
  const cls = classifyBuffer(head, targetAbs);
  const sha = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const rs = fs.createReadStream(targetAbs);
    rs.on('data', (c) => sha.update(c));
    rs.on('end', resolve);
    rs.on('error', reject);
  });
  const targetSha = sha.digest('hex');
  if (cls === 'data') return { cls, record: dataRecord(targetSha) };
  if (cls === 'source') {
    const text = fs.readFileSync(targetAbs, 'utf8');
    return { cls, record: scanSourceText(text, path.basename(targetAbs), targetSha) };
  }
  return { cls, record: await scanBinaryFile(targetAbs, { policy, storeDir, targetSha }) };
}

// ---------------------------------------------------------------------------
// Standalone CLI — prints the canonical record (used by the battery and
// by the daemon's policy re-scan path; vaultd itself never imports this).
// ---------------------------------------------------------------------------

async function cliMain() {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  const idIdx = args.indexOf('--identity-dir');
  const storeDir = idIdx >= 0 ? path.resolve(args[idIdx + 1]) : path.join(os.homedir(), '.scripture-armor');
  if (!file) { console.error('usage: scan.mjs <file> [--identity-dir <dir>]'); process.exit(2); }
  const policy = loadPolicy(storeDir);
  try {
    const { record } = await scanFile(path.resolve(file), { policy, storeDir });
    console.log(canonicalScanRecord(record));
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  cliMain();
}
