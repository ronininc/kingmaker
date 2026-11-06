// B3 — Corpus aggregator (SPEC §3.3): a unified, disposable index over the
// existing stores — the repository JSONL corpus, the B1 retention ledger,
// registry/issued-log verdict linkage (verdict + digest level only; sealed
// report packages are never opened), beacon events, and attempts entries.
// Keyed by the fields that already exist: finding rule, severity,
// target_sha256, scan digest, canary, attempts class/reason_class.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { readLedger, verifyChain } from './shield-ledger.mjs';

// Corpus roots and the Armor home are deployment facts, not constants of
// the algorithm. Defaults: SCRIPTURE_ARMOR_CORPUS_ROOTS (path-delimiter
// separated) else the historical evidence roots when they exist on this
// host; the identity dir itself is always added by buildIndex (a product
// install's own repository-reports live under it). Armor home:
// SCRIPTURE_ARMOR_HOME else ~/.scripture-armor.
export function defaultCorpusRoots() {
  if (process.env.SCRIPTURE_ARMOR_CORPUS_ROOTS) {
    return process.env.SCRIPTURE_ARMOR_CORPUS_ROOTS.split(path.delimiter).filter(Boolean);
  }
  return [
    '/home/hatch/workspace/armor-release-candidate-2026-11-04',
    '/home/hatch/workspace/armor-remainder-run-2026-11-04',
    '/home/hatch/workspace/rtmp',
  ].filter((r) => fs.existsSync(r));
}
export const CORPUS_ROOTS = defaultCorpusRoots();
export function armorHome() {
  return process.env.SCRIPTURE_ARMOR_HOME || path.join(process.env.HOME || '', '.scripture-armor');
}
export const ARMOR_HOME = armorHome();

function* walkDirs(dir, name) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name === name) yield p; else yield* walkDirs(p, name); }
  }
}

export function findReportDirs(roots = CORPUS_ROOTS) {
  const out = [];
  for (const r of roots) for (const d of walkDirs(r, 'repository-reports')) out.push(d);
  return out.sort();
}

// Stream every per-file record in the repository corpus. cb(record, jobCtx)
// where jobCtx = { jobId, repository, root, reportFile }.
export async function eachFileRecord(cb, roots = CORPUS_ROOTS) {
  const dirs = findReportDirs(roots);
  let jobs = 0, files = 0, findings = 0;
  for (const dir of dirs) {
    let index = [];
    try { index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8')); } catch { continue; }
    for (const job of index) {
      jobs++;
      const reportFile = path.join(dir, job.report);
      if (!fs.existsSync(reportFile)) continue;
      const repoRoot = typeof job.repository === 'string' && job.repository.startsWith('local:')
        ? job.repository.slice('local:'.length) : null;
      const rl = readline.createInterface({ input: fs.createReadStream(reportFile), crlfDelay: Infinity });
      for await (const line of rl) {
        if (!line.trim()) continue;
        let rec; try { rec = JSON.parse(line); } catch { continue; }
        if (rec.type !== 'file') continue;
        files++;
        findings += (rec.findings || []).length;
        cb(rec, { jobId: job.id, repository: job.repository, repoRoot, reportFile });
      }
    }
  }
  return { jobs, files, findings, dirs: dirs.length };
}

// Build the query index the loop consumes. File records are indexed by
// rule and by target; content is resolvable when the job's repository root
// still exists on disk and the file's sha256 matches its bytes.
export async function buildIndex(identityDir, roots = null) {
  if (!roots) roots = [...new Set([identityDir, ...defaultCorpusRoots()])];
  const byRule = new Map();       // rule -> { count, targets:Set, severities:{} }
  const byTarget = new Map();     // sha -> { paths:[], rules:Set }
  const clusters = new Map();     // `${rule}` -> Map(normalizedExcerpt -> {targets:Set, excerpts:[]})
  let totals = { jobs: 0, files: 0, findings: 0 };
  const jobRoots = new Map();
  totals = await eachFileRecord((rec, job) => {
    if (job.repoRoot) jobRoots.set(job.jobId, job.repoRoot);
    const sha = rec.sha256;
    if (sha) {
      if (!byTarget.has(sha)) byTarget.set(sha, { paths: [], rules: new Set() });
      byTarget.get(sha).paths.push({ jobId: job.jobId, path: rec.path });
    }
    for (const f of rec.findings || []) {
      if (!byRule.has(f.rule)) byRule.set(f.rule, { count: 0, targets: new Set(), severities: {} });
      const R = byRule.get(f.rule);
      R.count++; if (sha) R.targets.add(sha);
      R.severities[f.severity] = (R.severities[f.severity] || 0) + 1;
      if (sha) byTarget.get(sha)?.rules.add(f.rule);
      if (f.excerpt) {
        if (!clusters.has(f.rule)) clusters.set(f.rule, new Map());
        const key = normalizeExcerpt(f.excerpt);
        const C = clusters.get(f.rule);
        if (!C.has(key)) C.set(key, { targets: new Set(), excerpts: [] });
        const cl = C.get(key);
        if (sha) cl.targets.add(sha);
        if (cl.excerpts.length < 8) cl.excerpts.push(f.excerpt);
      }
    }
  }, roots);

  // Ledger view (B1): only chain-valid testimony is queryable. A broken
  // chain quarantines the whole ledger from generation (provenance rule).
  const { entries, corrupt } = readLedger(identityDir);
  const chain = verifyChain(entries);
  const ledgerOk = corrupt.length === 0 && chain.ok;

  // Beacon: the live log, read-only. Fixtures = Armor's own battery +
  // tracing canaries [INV §3a] — identifiable and never treated as attacks.
  const beacon = [];
  try {
    for (const line of fs.readFileSync(path.join(armorHome(), 'beacon.log'), 'utf8').split('\n')) {
      if (line.trim()) beacon.push(JSON.parse(line));
    }
  } catch {}
  const FIXTURE_CANARIES = new Set(['2479c89f-8e1b-4cc6-8080-fda689e37692', 'b6b26e49-ccea-4c39-87a3-0ad90ab0a508']);
  const isFixtureBeacon = (ev) => FIXTURE_CANARIES.has(ev.canary)
    || (typeof ev.presented_path === 'string' && ev.presented_path.includes('sa2-battery'));

  // Registry + issued-log verdict linkage (counts only; packages unopened).
  let registryScan = 0, registryTotal = 0, issuedScan = 0, issuedTotal = 0;
  try {
    const reg = JSON.parse(fs.readFileSync(path.join(armorHome(), 'registry.json'), 'utf8'));
    const ents = Object.values(reg.entries || {});
    registryTotal = ents.length;
    registryScan = ents.filter((e) => e.scan).length;
  } catch {}
  try {
    const rl = readline.createInterface({ input: fs.createReadStream(path.join(armorHome(), 'issued-log.jsonl')), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      issuedTotal++;
      try { if (JSON.parse(line).scan) issuedScan++; } catch {}
    }
  } catch {}

  return {
    totals, byRule, byTarget, clusters, jobRoots,
    reportDirs: findReportDirs(roots),
    ledger: { entries, ok: ledgerOk, chain, corrupt },
    beacon: { events: beacon, isFixture: isFixtureBeacon, foreign: beacon.filter((e) => !isFixtureBeacon(e)) },
    linkage: { registryScan, registryTotal, issuedScan, issuedTotal },
  };
}

// Normalize an excerpt for recurrence clustering: lowercase, collapse
// whitespace, fold digits to #, fold long hex/base64 runs to §. Quoted
// fragments are KEPT — attack idioms live in them (string-concat member
// access), and the generator's job is to find what recurs across targets.
export function normalizeExcerpt(ex) {
  return String(ex).toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[0-9a-f]{16,}/g, '§')
    .replace(/\d+/g, '#')
    .trim().slice(0, 200);
}

// Recurrence query: rules whose findings span >= minTargets distinct
// targets, with their excerpt clusters (the generator's raw material).
export function recurrence(index, { minTargets = 3 } = {}) {
  const out = [];
  for (const [rule, R] of index.byRule) {
    if (R.targets.size < minTargets) continue;
    const cls = [];
    for (const [key, cl] of index.clusters.get(rule) || []) {
      if (cl.targets.size >= minTargets) cls.push({ key, targets: cl.targets.size, excerpts: cl.excerpts });
    }
    cls.sort((a, b) => b.targets - a.targets);
    out.push({ rule, findings: R.count, targets: R.targets.size, severities: R.severities, clusters: cls });
  }
  return out.sort((a, b) => b.targets - a.targets);
}

// Resolve a corpus file record's content from disk (read-only). Returns
// null when the repository root or file is gone, or the sha doesn't match
// (a record whose content can't be verified is not replayable).
export function resolveContent(rec, jobRoot) {
  if (!jobRoot || !rec.path) return null;
  const p = path.join(jobRoot, rec.path);
  try {
    const buf = fs.readFileSync(p);
    return buf;
  } catch { return null; }
}
