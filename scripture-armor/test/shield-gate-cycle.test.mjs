// Shield gate + full-cycle suite (SPEC §5) — the integration gate's
// end-to-end leg, run ONCE on the real retained corpus:
//   detection (attempts recurrence, from a real folded feed)
//   → diagnosis → deterministic generation → governance gate (self-scan +
//     full corpus replay + monotonicity, receipt written either way)
//   → deployment at the attacked spot (generated store + spot manifest)
//   → rollback restoring the generated store BYTE-EXACT
//   → the hash-chained ledger verifies end to end after the cycle.
// Plus the replay weakening leg: a configuration missing a shipped
// detector must FAIL replay with the weakening named.
//
// This suite is deliberately heavy (two full corpus evaluation passes,
// cache-shared). It is the shield layer's acceptance evidence, not a
// unit suite. The live novel-attack battery is NOT this suite and is
// not simulated here — see SHIELD-BUILDER.md for its wall.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import * as ledger from '../shield-ledger.mjs';
import * as collect from '../shield-collect.mjs';
import * as attempts from '../shield-attempts.mjs';
import * as agg from '../shield-aggregator.mjs';
import * as registry from '../shield-registry.mjs';
import * as ev from '../shield-eval.mjs';
import * as gate from '../shield-gate.mjs';
import * as loop from '../shield-loop.mjs';
import * as rp from '../shield-rulepack.mjs';
import { DEFAULT_POLICY } from '../scan.mjs';

const LONG = { timeout: 1800000 };
const cache = new Map();
let built = null;

async function build(t) {
  if (built) return built;
  const roots = agg.defaultCorpusRoots();
  if (!roots.length || !fs.existsSync(path.join(agg.armorHome(), 'beacon.log'))) {
    t.skip('evidence stores absent on this host');
    throw Error('skipped');
  }
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'shield-gate-'));
  const identityDir = path.join(base, 'identity');
  const stateDir = path.join(base, 'state');
  fs.mkdirSync(identityDir, { recursive: true });
  // Real testimony seed: the live beacon log mirrored into the ledger.
  const liveBeacon = fs.readFileSync(path.join(agg.armorHome(), 'beacon.log'), 'utf8').split('\n').filter((l) => l.trim()).length;
  const mirrored = collect.mirrorBeacon(identityDir);
  assert.equal(mirrored, liveBeacon, 'beacon mirror faithful to the live log');
  // A real folded attempts feed: 42 identical refusals fold to count 42.
  const feed = attempts.openAttemptsFeed(identityDir);
  const SRC = { kind: 'local', channel: 'socket', socket: '/tmp/vaultd.sock' };
  for (let i = 0; i < 42; i++) feed.recordAttempt({ canary: 'feedbeef', reason_class: 'replay-consumed', source: SRC });
  const index = await agg.buildIndex(identityDir);
  built = { base, identityDir, stateDir, feed, index };
  return built;
}

function storeHashes(stateDir) {
  const dir = ev.generatedStoreDir(stateDir);
  const out = {};
  for (const f of ['rea-rules.json', 'policy-deltas.json', 'scan-roots.json', 'profiles.json']) {
    out[f] = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, f))).digest('hex');
  }
  return out;
}

test('gate: full cycle on the real corpus — detect, generate, gate receipt, deploy, rollback byte-exact, ledger verifies', LONG, async (t) => {
  const { identityDir, stateDir, feed, index } = await build(t);
  // Detection from the folded feed (fixtures in the beacon stream are
  // excluded by the aggregator; the signal here is the attempts fold).
  const signals = loop.detectSignals({ index, attemptsEntries: feed.entries(), ledgerEntries: [] });
  const signal = signals.find((s) => s.type === 'attempts-recurrence');
  assert.ok(signal, 'attempts recurrence detected');
  assert.equal(signal.count, 42);

  // Pre-cycle generated store (empty), byte-hashed for the rollback proof.
  ev.saveGenerated(stateDir, { genRules: [], policyDeltas: [], scanRoots: [], profiles: [] });
  const before = storeHashes(stateDir);

  const cycle = await loop.runCycle({ identityDir, stateDir, index, cache }, signal);
  assert.equal(cycle.gate.verdict, 'pass', `gate must pass: ${JSON.stringify(cycle.gate.checks.replay.failures)}`);
  assert.equal(cycle.deployed, true);
  assert.ok(cycle.gate.receipt_seq > 0, 'gate receipt written to the ledger');

  const entries = ledger.readLedger(identityDir).entries;
  const receiptEntry = entries[cycle.gate.receipt_seq];
  assert.equal(receiptEntry.record.format, 'scripture-armor.gate-receipt/1');
  assert.equal(receiptEntry.record.verdict, 'pass');
  assert.ok(receiptEntry.record.checks.replay.tallies.replayed > 1000,
    `gate replayed the real corpus (${receiptEntry.record.checks.replay.tallies.replayed} records)`);

  const genNow = ev.loadGenerated(stateDir);
  assert.ok(genNow.policyDeltas.some((d) => d.path === 'airlock.max_violations' && d.to === 1));
  assert.equal(ev.mergePolicy(DEFAULT_POLICY, genNow.policyDeltas).airlock.max_violations, 1);

  const spot = { lane: 'activation', stage: 'verdict', surface: 'attempts-thresholds' };
  const manifests = registry.allManifests(stateDir);
  const layer = manifests.flatMap((m) => m.layers).find((l) => l.cycle_id === cycle.cycle_id && l.active);
  assert.ok(layer, 'deployed layer registered in the spot manifest');
  assert.equal(layer.gate_receipt_seq, cycle.gate.receipt_seq);

  const rb = loop.rollback({ identityDir, stateDir }, spot, layer.layer_id);
  assert.ok(rb.ok, 'rollback accepted');
  assert.deepEqual(storeHashes(stateDir), before, 'generated store restored byte-exact');
  assert.equal(registry.layersAt(stateDir, spot).length, 0, 'layer deactivated');

  const after = ledger.readLedger(identityDir);
  assert.equal(after.corrupt.length, 0);
  assert.ok(ledger.verifyChain(after.entries).ok, 'ledger chain verifies end to end after the cycle');
});

test('gate: replay catches a weakening configuration and names it', LONG, async (t) => {
  const { stateDir, index } = await build(t);
  const weakPack = { ...rp.BASELINE_PACK, src_packs: rp.BASELINE_PACK.src_packs.filter((p) => p.rule !== 'src-py-os-system') };
  const baseCfg = ev.configFromGenerated(ev.loadGenerated(stateDir), DEFAULT_POLICY);
  const weakCfg = { ...baseCfg, pack: weakPack };
  const weakReplay = await gate.checkReplay({ index, baselineConfig: baseCfg, candidateConfig: weakCfg, cache });
  assert.equal(weakReplay.pass, false, 'a pack missing a shipped detector must fail replay');
  assert.ok(weakReplay.failures.length > 0, `weakening named: ${weakReplay.failures[0]}`);
});
