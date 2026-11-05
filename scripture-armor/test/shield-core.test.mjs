// Shield layer core suites — B1 (retention ledger + lane adapters), B2
// (attempts feed), B3 (corpus aggregator), B5 (spot registry), B6 units
// (diagnosis, generation ops, gate self-scan + monotonicity).
// Adapted from the Phase 1 build's checks (armor-shield-builder-build/
// checks/phase1-core.mjs) to the integrated product tree.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ledger from '../shield-ledger.mjs';
import * as collect from '../shield-collect.mjs';
import * as attempts from '../shield-attempts.mjs';
import * as agg from '../shield-aggregator.mjs';
import * as registry from '../shield-registry.mjs';
import * as gen from '../shield-generator.mjs';
import * as gate from '../shield-gate.mjs';
import * as loop from '../shield-loop.mjs';
import * as harness from '../shield-review-harness.mjs';
import * as ev from '../shield-eval.mjs';
import { DEFAULT_POLICY } from '../scan.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARMOR_DIR = path.join(HERE, '..');
const scratch = [];
function tempDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'shield-core-'));
  scratch.push(d);
  return d;
}
test.after(() => { for (const d of scratch) fs.rmSync(d, { recursive: true, force: true }); });

// ---------- B1 ----------
test('B1: ledger appends are hash-chained and verify', () => {
  const id = tempDir();
  const e1 = ledger.emitBeacon(id, { event: 'beacon', canary: 'c1', reason_class: 'signature-invalid' });
  const v = ledger.verifyChain(ledger.readLedger(id).entries);
  assert.ok(v.ok && e1.seq === 0);
});

test('B1: append onto a tampered ledger refuses (poisoned testimony is quarantined)', () => {
  const id = tempDir();
  ledger.emitBeacon(id, { event: 'beacon', canary: 'c1', reason_class: 'signature-invalid' });
  const f = ledger.ledgerPath(id);
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('signature-invalid', 'signature-XXXXXXX'));
  assert.throws(() => ledger.emitBeacon(id, { event: 'beacon', canary: 'c2', reason_class: 'x' }));
});

test('B1: upload lane — file-review record lands in the ledger before the workspace is destroyed', () => {
  const id = tempDir();
  const state = tempDir();
  const artifact = fs.readFileSync(path.join(ARMOR_DIR, 'scan.mjs'));
  const before = ledger.readLedger(id).entries.length;
  const review = harness.reviewArtifact(artifact, 'scan.mjs',
    ev.configFromGenerated(ev.loadGenerated(state), DEFAULT_POLICY), { ledgerIdentityDir: id });
  const after = ledger.readLedger(id).entries;
  assert.equal(after.length, before + 1);
  assert.equal(after.at(-1).record.schema, 'scripture-armor.file-review/1');
  assert.equal(review.isolation.workspaceDestroyedOnReturn, true);
  assert.equal(review.isolation.originalRemoved, false);
  assert.ok(fs.existsSync(path.join(ARMOR_DIR, 'scan.mjs')), 'original intact');
});

test('B1: repository lane retains the info band for the ledger only', () => {
  const id = tempDir();
  const synthetic = { type: 'file', path: 'x.mjs', sha256: 'ab'.repeat(32), findings: [
    { rule: 'littlebrother-enrichment', severity: 'info', basis: 'littlebrother-enrichment', location: 'domain: x', detail: 'enrichment' },
    { rule: 'src-eval-call', severity: 'high', basis: 'pattern', location: 'x.mjs:1', detail: 'eval', excerpt: 'eval(x)' }] };
  collect.collectRepoFileRecord(id, synthetic, 'job-synthetic');
  const kept = ledger.readLedger(id).entries.at(-1).record.findings;
  assert.equal(kept.length, 2, 'ledger keeps info+high');
  assert.equal(collect.shippedCorpusView(synthetic).length, 1, 'shipped corpus filter would store only 1');
});

test('B1: device flush + beacon mirror + activation emission; chain verifies', (t) => {
  const id = tempDir();
  collect.collectDeviceFindings(id, { findings: [{ rule: 'device-x', severity: 'low', path: '/tmp/a' }], counters: { checked: 10, findings: 1 } }, 'device-1');
  const beaconFile = path.join(agg.armorHome(), 'beacon.log');
  if (!fs.existsSync(beaconFile)) { t.skip('live beacon.log absent on this host'); return; }
  const liveEvents = fs.readFileSync(beaconFile, 'utf8').split('\n').filter((l) => l.trim()).length;
  const nb = collect.mirrorBeacon(id);
  assert.equal(nb, liveEvents, 'mirror is faithful to the live beacon log, whatever its current count');
  const actEntry = ledger.emitActivation(id, { canary: 'probe', id: 'act-probe', destroyed: true, outcome: 'completed' }, 'probe');
  assert.equal(actEntry.record.destroyed, true);
  assert.ok(ledger.verifyChain(ledger.readLedger(id).entries).ok);
});

// ---------- B2 ----------
const SRC = { kind: 'local', channel: 'requester', socket: '/tmp/vaultd.sock' };
test('B2: 30 identical refusals fold to one entry with count 30; feed shape matches the v2 contract', () => {
  const dir = tempDir();
  const feed = attempts.openAttemptsFeed(dir);
  for (let i = 0; i < 30; i++) feed.recordAttempt({ canary: 'c9', reason_class: 'replay-consumed', source: SRC });
  const doc = feed.attemptsFeed({});
  assert.equal(doc.total, 1);
  assert.equal(doc.attempts[0].count, 30);
  assert.equal(doc.attempts[0].class, 'replay');
  assert.ok(doc.ok === true && doc.schema === 'scripture-armor.attempts/1' && doc.window_ms === 600000 && doc.cap === 500);
});

test('B2: entries persist across re-open', () => {
  const dir = tempDir();
  const feed = attempts.openAttemptsFeed(dir);
  for (let i = 0; i < 30; i++) feed.recordAttempt({ canary: 'c9', reason_class: 'replay-consumed', source: SRC });
  const feed2 = attempts.openAttemptsFeed(dir);
  assert.equal(feed2.attemptsFeed({}).total, 1);
  assert.equal(feed2.entries()[0].count, 30);
});

test('B2: fold window honored — a second occurrence after the window opens a new entry', async () => {
  const dir = tempDir();
  const feed = attempts.openAttemptsFeed(dir, { windowMs: 1 });
  feed.recordAttempt({ canary: 'c1', reason_class: 'expired', source: SRC });
  await new Promise((r) => setTimeout(r, 5));
  feed.recordAttempt({ canary: 'c1', reason_class: 'expired', source: SRC });
  assert.equal(feed.attemptsFeed({}).total, 2);
});

test('B2: retention cap enforced; family vocabulary matches v2', () => {
  const dir = tempDir();
  const feed = attempts.openAttemptsFeed(dir, { cap: 5 });
  for (let i = 0; i < 8; i++) feed.recordAttempt({ canary: 'c' + i, reason_class: 'never-issued', source: SRC });
  assert.equal(feed.attemptsFeed({}).total, 5);
  assert.equal(attempts.attemptFamily('scan-critical'), 'policy-hold');
  assert.equal(attempts.attemptFamily('hash-mismatch'), 'tamper-evidence');
  assert.equal(attempts.attemptFamily('register-revoked'), 'revoked');
  assert.equal(attempts.attemptFamily('weird-new'), 'other');
});

// ---------- B3 ----------
test('B3: aggregator totals match independently computed ground truth over the same stores', async (t) => {
  const roots = agg.defaultCorpusRoots();
  if (!roots.length || !fs.existsSync(path.join(agg.armorHome(), 'registry.json'))) { t.skip('evidence stores absent on this host'); return; }
  const id = tempDir();
  ledger.emitBeacon(id, { event: 'beacon', canary: 'seed', reason_class: 'signature-invalid' });
  const index = await agg.buildIndex(id);
  // Independent ground truth: per-job findings as recorded in each
  // store's own index.json (a different recorded form than the JSONL
  // recount the aggregator performs), and the live beacon log's lines.
  // The corpus is live and grows; fidelity, not a frozen census, is the
  // invariant. (Inventory census at spec time: 31 jobs / 10,590 findings
  // / 35 beacon events — the aggregator matched it then and must match
  // the stores now.)
  let truthJobs = 0, truthFindings = 0;
  for (const dir of agg.findReportDirs(roots)) {
    let idx;
    try { idx = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8')); } catch { continue; }
    truthJobs += idx.length;
    truthFindings += idx.reduce((n, j) => n + (j.findings || 0), 0);
  }
  assert.equal(index.totals.jobs, truthJobs, 'job count faithful');
  assert.equal(index.totals.findings, truthFindings, 'findings recount matches the stores\u2019 own index sums');
  assert.ok(index.totals.files > 0);
  const reg = JSON.parse(fs.readFileSync(path.join(agg.armorHome(), 'registry.json'), 'utf8'));
  const regEntries = Object.values(reg.entries || {});
  assert.equal(index.linkage.registryTotal, regEntries.length);
  assert.equal(index.linkage.registryScan, regEntries.filter((e) => e.scan).length);
  assert.ok(index.linkage.issuedTotal > 0 && index.linkage.issuedScan > 0);
  const liveBeacon = fs.readFileSync(path.join(agg.armorHome(), 'beacon.log'), 'utf8').split('\n').filter((l) => l.trim()).length;
  assert.equal(index.beacon.events.length, liveBeacon);
  assert.equal(index.beacon.foreign.length, 0, 'all beacon events are fixtures; zero foreign');
  assert.equal(index.ledger.ok, true, 'chain-valid ledger testimony is queryable');
});

// ---------- B5 ----------
test('B5: register + address a layer at a spot; invalid surface rejected', () => {
  const state = tempDir();
  const spot = { lane: 'upload', stage: 'rea', surface: 'rea-rules' };
  registry.registerLayer(state, spot, { layer_id: 'L1', shape: 'rea-rule', cycle_id: 'cy1',
    prior_state: { genRules: [], policyDeltas: [], scanRoots: [], profiles: [] } });
  assert.equal(registry.layersAt(state, spot).length, 1);
  assert.ok(registry.validSpot(spot));
  assert.ok(!registry.validSpot({ lane: 'upload', stage: 'rea', surface: 'nope' }));
});

test('B5: tampered prior-state snapshot is detected; rollback restores and deactivates', () => {
  const state = tempDir();
  const spot = { lane: 'upload', stage: 'rea', surface: 'rea-rules' };
  const entry = registry.registerLayer(state, spot, { layer_id: 'L1', shape: 'rea-rule', cycle_id: 'cy1',
    prior_state: { genRules: [], policyDeltas: [], scanRoots: [], profiles: [] } });
  const tampered = JSON.parse(JSON.stringify(entry));
  tampered.prior_state.genRules.push({ id: 'evil' });
  assert.equal(registry.verifySnapshot(tampered).ok, false);
  assert.equal(registry.verifySnapshot(entry).ok, true);
  const rb = registry.rollbackLayer(state, spot, 'L1');
  assert.ok(rb.ok);
  assert.equal(registry.layersAt(state, spot).length, 0);
});

// ---------- B6 units ----------
test('B6: diagnosis mapping (incl. second-cycle promotion to reject)', () => {
  const spot = { lane: 'upload', stage: 'rea', surface: 'rea-rules' };
  assert.equal(loop.diagnose({ type: 'recurrence', rule: 'r', spot }).response, 'promote-recurring-signature');
  assert.equal(loop.diagnose({ type: 'recurrence-after-deployment', rule: 'r', spot }).first_cycle_severity, 'reject');
  assert.equal(loop.diagnose({ type: 'attempts-recurrence', class: 'replay', reason_class: 'replay-consumed', spot }).response, 'threshold-tighten');
});

test('B6: recurring-signature promotion extracts the attack idiom, not the benign trigger', async (t) => {
  const roots = agg.defaultCorpusRoots();
  if (!roots.length) { t.skip('evidence corpus absent on this host'); return; }
  const index = await agg.buildIndex(tempDir());
  const benignPool = [];
  for (const [, cl] of index.clusters.get('src-child-process') || []) benignPool.push(...cl.excerpts);
  const famA = ["const a=require('child_process'); a['exe'+'cSync'](p0);",
    "const bb=require('child_process'); bb['exe'+'cSync'](payload);",
    "let c=require('child_process'); c['exe'+'cSync'](x + y);",
    "var d=require('child_process'); d['exe'+'cSync'](Buffer.from(z));"];
  const cand = gen.promotionCandidate({ cycle_id: 'cyc-test-0001', rule: 'src-child-process',
    instances: famA.map((excerpt, i) => ({ rule: 'src-child-process', excerpt, target: 't' + i })),
    benignExcerpts: benignPool, severity: 'sandbox',
    spot: { lane: 'upload', stage: 'rea', surface: 'rea-rules' }, diagnosis: {} });
  assert.ok(cand, 'candidate generated');
  const re = new RegExp(cand.layers[0].rule.patterns[0].source, 'i');
  assert.ok(re.test("const q=require('child_process'); q['exe'+'cFile'](w);"), 'matches held-out suffix variant');
  assert.ok(!re.test("const cp = require('child_process'); cp.execSync('ls');"), 'does not match a plain benign require+execSync line');
});

test('B6: profile synthesis via the shipped sandboxProfile; threshold tightening', () => {
  const spot = { lane: 'upload', stage: 'rea', surface: 'rea-rules' };
  const prof = gen.profileCandidate({ cycle_id: 'cyc-test-0002', spot,
    reaFindings: [{ fix: 'network', kind: 'telemetry' }, { fix: 'files', kind: 'credentials' }], diagnosis: {}, provenance: {} });
  assert.ok(prof.layers[0].profile.includes('(deny network-outbound)'));
  assert.ok(prof.layers[0].deny_rules >= 4);
  const thr = gen.thresholdCandidate({ cycle_id: 'cyc-test-0003',
    spot: { lane: 'activation', stage: 'verdict', surface: 'attempts-thresholds' },
    policy: DEFAULT_POLICY, path: 'airlock.max_violations', diagnosis: {}, provenance: {} });
  assert.equal(thr.layers[0].delta.from, 3);
  assert.equal(thr.layers[0].delta.to, 1);
});

test('B6 gate legs: self-scan passes a clean bundle and refuses a hostile one; monotonicity refuses loosening', async () => {
  const ss = gate.checkSelfScan({ cycle_id: 'cyc-x', layers: [{ shape: 'policy-delta', delta: { path: 'airlock.max_violations', from: 3, to: 1 } }] });
  assert.equal(ss.pass, true, `clean bundle self-scan verdict=${ss.verdict}`);
  const evilBundle = { layers: [{ shape: 'rea-rule', rule: { id: 'x', patterns: [{ source: 'eval\\(x\\)' }], note: "eval(input()); os.system('id')" } }] };
  const ssBad = gate.checkSelfScan(evilBundle);
  assert.equal(ssBad.pass, false, `hostile bundle self-scans ${ssBad.verdict} -> refused`);
  const state = tempDir();
  const monoBad1 = gate.checkMonotonicity({ layers: [{ shape: 'policy-delta', delta: { path: 'cell.scratch_mb', from: 256, to: 512 } }] },
    ev.loadGenerated(state), DEFAULT_POLICY);
  const monoBad2 = gate.checkMonotonicity({ layers: [{ shape: 'rea-rule', rule: { id: 'remote_code.pipe', severity: 'sandbox', fix: 'exec', patterns: [/x/, /y/] } }] },
    ev.loadGenerated(state), DEFAULT_POLICY);
  const monoOk = gate.checkMonotonicity({ layers: [{ shape: 'policy-delta', delta: { path: 'airlock.max_violations', from: 3, to: 1 } }] },
    ev.loadGenerated(state), DEFAULT_POLICY);
  assert.equal(monoBad1.pass, false, 'loosening delta refused');
  assert.equal(monoBad2.pass, false, 'shipped-rule downgrade refused');
  assert.equal(monoOk.pass, true, 'tightening delta passes');
});
