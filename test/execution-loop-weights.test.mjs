// The weights selector (lib/execution-loop.mjs pickSmallestSufficient / resolveWeightsPick) under the
// metered doctrine (2026-11-14): the smallest model that meets the task's declared requirement wins —
// never the fastest, never a device-fit rejection. Device memory shapes only the delivery plan, in
// lane order: resident, metered-stream, then the SANDBOX lane (Part C, owner ruling 2026-11-14 01:44 —
// no GGUF limit: a model past the device's whole memory serves locally, containerized and paged,
// under Kingmaker's Docker control, when the sandbox is in the device's posture). Only when the
// sandbox lane is absent or declined does an over-memory pick escalate instead — a policy routing,
// never a refusal and never a device-incapacity claim.
import assert from 'node:assert/strict';
import test from 'node:test';
import { ESCALATION_LANES, pickSmallestSufficient, resolveWeightsPick } from '../lib/execution-loop.mjs';
import { executionLoopBeforeWeights } from '../lib/weight-hunter.mjs';

const records = [
  { model: 'slow', genTokS: 20, loadS: 1, sizeGb: 2, evalShare: 0.8, benchFile: 'bench_host.jsonl' },
  { model: 'fast-writer', genTokS: 40, loadS: 2, sizeGb: 2, evalShare: 0.9, benchFile: 'bench_host.jsonl' },
  { model: 'huge', genTokS: 90, loadS: 1, sizeGb: 20, evalShare: 0.9, benchFile: 'bench_host.jsonl' },
];
const device = { ramGb: 8, freeGb: 5 };

test('the smallest sufficient model wins; size ties break on measured speed, not the other way round', () => {
  const { pick, considered } = pickSmallestSufficient(records, { device });
  assert.equal(pick.model, 'fast-writer', 'slow and fast-writer are both 2 GB and sufficient: the faster measured one wins the tie');
  assert.equal(pick.verdict, 'picked');
  assert.equal(considered.find((c) => c.model === 'slow').verdict, 'sufficient');
  const hugeRow = considered.find((c) => c.model === 'huge');
  assert.equal(hugeRow.verdict, 'sufficient-not-served', 'a 20 GB model on an 8 GB device with no sandbox posture is sufficient but not served — it is not "rejected"');
  assert.match(hugeRow.reason, /sandbox lane/);
  assert.match(hugeRow.reason, /absent from/);
});

test('the eval-share floor is the task requirement, and an unmeasured model passes on measurement alone', () => {
  const { pick, considered } = pickSmallestSufficient(records, { requirement: { minEvalShare: 0.85 }, device });
  assert.equal(pick.model, 'fast-writer');
  assert.equal(considered.find((c) => c.model === 'slow').verdict, 'not-sufficient');
  assert.match(considered.find((c) => c.model === 'slow').reason, /evaluation share 0\.80 below the sufficiency floor 0\.85/);
  const unmeasured = pickSmallestSufficient([{ model: 'fresh', genTokS: 10, loadS: 1, sizeGb: 1, evalShare: null }], { requirement: { minEvalShare: 0.9 }, device });
  assert.equal(unmeasured.pick.model, 'fresh', 'no evaluation on record: judged on measurement alone (the standing rule)');
});

test('role and capability requirements screen on evidence, never on size', () => {
  const rs = [
    { model: 'writer-2b', genTokS: 30, loadS: 1, sizeGb: 2, evalShare: 0.9, roles: ['writer'], capabilities: ['tools'] },
    { model: 'vision-2b', genTokS: 30, loadS: 1, sizeGb: 2, evalShare: 0.9, roles: ['vision'], capabilities: ['vision'] },
  ];
  const w = pickSmallestSufficient(rs, { requirement: { role: 'writer' }, device });
  assert.equal(w.pick.model, 'writer-2b');
  assert.equal(w.considered.find((c) => c.model === 'vision-2b').verdict, 'not-sufficient');
  const v = pickSmallestSufficient(rs, { requirement: { role: 'vision', capabilities: ['vision'] }, device });
  assert.equal(v.pick.model, 'vision-2b');
  const none = pickSmallestSufficient(rs, { requirement: { role: 'coder' }, device });
  assert.equal(none.pick, null);
  assert.equal(none.escalate, null, 'nothing sufficient at all is a plain no-pick, not an escalation');
});

test('role evidence takes precedence: an evidenced larger model beats an unevidenced smaller one', () => {
  const mixed = [
    { model: 'tiny', genTokS: 300, loadS: 1, sizeGb: 0.6, evalShare: 0.9, benchFile: 'bench_host.jsonl' },
    { model: 'scribe', genTokS: 60, loadS: 4, sizeGb: 2.2, evalShare: 0.7, roles: ['writer'], benchFile: 'bench_host.jsonl' },
  ];
  const r = pickSmallestSufficient(mixed, { requirement: { role: 'writer' }, device });
  assert.equal(r.pick.model, 'scribe');
  assert.equal(r.pick.evidenced, true);
  assert.equal(r.considered.find((c) => c.model === 'tiny').verdict, 'not-sufficient');
});

test('the unevidenced fallback serves a role only when nothing is evidenced — and is labeled, never silent', () => {
  const raw = [
    { model: 'tiny', genTokS: 300, loadS: 1, sizeGb: 0.6, evalShare: 0.9, benchFile: 'bench_host.jsonl' },
    { model: 'mid', genTokS: 90, loadS: 3, sizeGb: 2, evalShare: 0.8, benchFile: 'bench_host.jsonl' },
  ];
  const r = pickSmallestSufficient(raw, { requirement: { role: 'writer' }, device });
  assert.equal(r.pick.model, 'tiny');
  assert.equal(r.pick.evidenced, false);
  assert.match(r.pick.reason, /unevidenced fallback pool/);
  assert.equal(r.considered.find((c) => c.model === 'mid').verdict, 'sufficient-unevidenced');
});

test('a tabled role is capability evidence for its own name', () => {
  const bare = [{ model: 'seer', genTokS: 30, loadS: 2, sizeGb: 1.6, evalShare: 0.7, roles: ['vision'], benchFile: 'bench_host.jsonl' }];
  const r = pickSmallestSufficient(bare, { requirement: { role: 'vision', capabilities: ['vision'] }, device });
  assert.equal(r.pick.model, 'seer', 'no capabilities list on the record: its vision role evidences the vision capability');
});

test('the delivery plan: resident when the pick fits the measured free memory, metered-stream in 1 MiB portions otherwise', () => {
  const resident = pickSmallestSufficient(records, { device }).pick;
  assert.equal(resident.delivery.strategy, 'resident');
  assert.equal(resident.delivery.portions, 2048, 'a 2 GiB model is 2048 pin-verified 1 MiB portions');
  assert.equal(resident.delivery.portionBytes, 1_048_576);
  const streamed = pickSmallestSufficient(records, { device: { ramGb: 8, freeGb: 1 } }).pick;
  assert.equal(streamed.model, 'fast-writer', 'tight free memory does not change the pick');
  assert.equal(streamed.delivery.strategy, 'metered-stream');
});

test('a requirement only an over-device model meets escalates through the existing lanes — it never refuses', async () => {
  const only = [{ model: 'huge', genTokS: 90, loadS: 1, sizeGb: 20, evalShare: 0.9, roles: ['writer'] }];
  const sel = pickSmallestSufficient(only, { requirement: { role: 'writer' }, device });
  assert.equal(sel.pick, null);
  assert.equal(sel.escalate.model, 'huge');
  assert.deepEqual(sel.escalate.lanes, [...ESCALATION_LANES]);
  assert.match(sel.escalate.reason, /not refused for its size/);
  assert.match(sel.escalate.reason, /sandbox lane/, 'the corrected reason names the sandbox lane as the local route it could not take');
  assert.match(sel.escalate.reason, /By policy/, 'the corrected reason frames escalation as a policy choice');
  assert.doesNotMatch(sel.escalate.reason, /materializes|cannot execute/, 'the superseded runner-materialization rationale is gone');
  const resolved = await resolveWeightsPick(only, { requirement: { role: 'writer' }, device, request: 'draft the long report' });
  assert.equal(resolved.model, undefined);
  assert.equal(resolved.escalate.model, 'huge', 'the loop receives the escalation shape, not a refusal');
});

test('Part C: with the sandbox in the device posture, an over-RAM model is picked and served through the sandbox lane', async () => {
  const only = [{ model: 'huge', genTokS: 90, loadS: 1, sizeGb: 20, evalShare: 0.9, roles: ['writer'] }];
  const sandboxDevice = { ramGb: 8, freeGb: 5, sandbox: { available: true } };
  const sel = pickSmallestSufficient(only, { requirement: { role: 'writer' }, device: sandboxDevice });
  assert.equal(sel.escalate, null, 'no escalation when the sandbox lane serves locally');
  assert.equal(sel.pick.model, 'huge');
  const d = sel.pick.delivery;
  assert.equal(d.strategy, 'sandbox');
  assert.equal(d.portions, 20480, 'a 20 GiB model is 20480 pin-verified 1 MiB portions, fed into the sandbox store');
  assert.equal(d.sandbox.runner.image, 'ollama/ollama');
  assert.equal(d.sandbox.runner.endpoint, 'http://127.0.0.1:11436');
  assert.equal(d.sandbox.execution.type, 'docker-run');
  assert.equal(d.sandbox.execution.image, 'ollama/ollama');
  assert.ok(d.sandbox.execution.args.includes('--memory'), 'the container carries a memory ceiling');
  assert.equal(d.sandbox.execution.args[d.sandbox.execution.args.indexOf('--memory') + 1], String(8 * 2 ** 30), 'the ceiling is the device RAM in bytes');
  assert.equal(d.sandbox.execution.args[d.sandbox.execution.args.indexOf('--memory-swap') + 1], String((8 + 20) * 2 ** 30), 'memory + weights = the disk-backed paging allowance');
  assert.equal(d.sandbox.bind.target, '/models');
  assert.equal(d.sandbox.bind.readOnly, true);
  assert.equal(d.sandbox.feed.portions, 20480);
  assert.equal(d.sandbox.feed.verifiedBeforeStart, true, 'every portion is pin-verified before the container starts (the fetch lane rule)');
  const resolved = await resolveWeightsPick(only, { requirement: { role: 'writer' }, device: sandboxDevice, request: 'draft the long report' });
  assert.equal(resolved.model, 'huge', 'the loop receives the sandbox pick, not an escalation');
  assert.equal(resolved.delivery.strategy, 'sandbox');
});

test('Part C: a declined sandbox posture escalates with the corrected, policy-framed reason', () => {
  const only = [{ model: 'huge', genTokS: 90, loadS: 1, sizeGb: 20, evalShare: 0.9, roles: ['writer'] }];
  const sel = pickSmallestSufficient(only, { requirement: { role: 'writer' }, device: { ramGb: 8, freeGb: 5, sandbox: { available: false, declined: true, reason: 'declined for this device (KINGMAKER_SANDBOX=off)' } } });
  assert.equal(sel.pick, null);
  assert.equal(sel.escalate.model, 'huge');
  assert.match(sel.escalate.reason, /declined in/);
  assert.match(sel.escalate.reason, /KINGMAKER_SANDBOX=off/, 'the posture reason is carried into the escalation');
  assert.match(sel.escalate.reason, /By policy/);
  const row = sel.considered.find((c) => c.model === 'huge');
  assert.equal(row.verdict, 'sufficient-not-served');
  assert.match(row.reason, /declined in/);
});

test('Part C: the sandbox lane never hijacks an in-memory pick — resident and metered-stream keep their order', () => {
  const withSandbox = { ramGb: 8, freeGb: 5, sandbox: { available: true } };
  const resident = pickSmallestSufficient(records, { device: withSandbox }).pick;
  assert.equal(resident.model, 'fast-writer');
  assert.equal(resident.delivery.strategy, 'resident', 'a pick that fits free memory stays resident even with the sandbox available');
  const streamed = pickSmallestSufficient(records, { device: { ramGb: 8, freeGb: 1, sandbox: { available: true } } }).pick;
  assert.equal(streamed.delivery.strategy, 'metered-stream', 'a pick that fits whole memory but not free memory stays metered-stream');
});

test('with no hunter the resolved pick is the selector pick', async () => {
  const plain = pickSmallestSufficient(records, { device });
  const resolved = await resolveWeightsPick(records, { device, request: 'draft a note' });
  assert.equal(resolved.model, plain.pick.model);
  assert.equal(resolved.genTokS, plain.pick.genTokS);
  assert.equal(resolved.verdict, 'picked');
  assert.equal(resolved.swap, undefined);
  assert.equal(resolved.delivery.strategy, 'resident');
});

test('an enabled hunter replaces the selector pick and a declined hunter does not', async () => {
  const library = {
    floor: { roles: { writer: 'fast-writer' } },
    models: [{
      tag: 'fast-writer', slug: 'fast-writer', kind: 'abliterated', roles: ['writer'], picks: [{ role: 'writer' }],
      bench: [{ file: 'm3.json', fits: true, tokS: 40, holdsGb: 2, tools: 95, route: 95, write: 95 }],
      weights: { sha256: 'b'.repeat(64), parts: [{ name: 'b', size: 1 }] },
    }],
  };
  let ensured = 0;
  const on = executionLoopBeforeWeights({
    calibration: { weightHunter: { on: true } },
    library, installed: ['fast-writer'], ensure: async () => { ensured += 1; },
  });
  const hunted = await resolveWeightsPick(records, { device, request: 'draft a note about the garden', beforeWeights: on });
  assert.equal(hunted.model, 'fast-writer');
  assert.equal(hunted.swap, false);
  assert.equal(hunted.genTokS, 40);
  assert.equal(ensured, 0, 'an installed hunted model is not fetched');
  const off = executionLoopBeforeWeights({ calibration: { weightHunter: { on: false } }, library });
  assert.equal(off, null);
  const same = await resolveWeightsPick(records, { device, request: 'draft a note', beforeWeights: off });
  assert.equal(same.model, 'fast-writer');
  assert.equal(same.swap, undefined);
  const broken = await resolveWeightsPick(records, {
    device,
    request: 'draft a note',
    beforeWeights: async () => { throw new Error('hunter failed'); },
  });
  assert.equal(broken.model, 'fast-writer');
  assert.equal(broken.swap, undefined);
});
