import assert from 'node:assert/strict';
import test from 'node:test';
import { WEIGHT_HUNTER_REFERENCES, selectWeightHunterReferences } from '../lib/weight-hunter-references.mjs';
import { planForge } from '../lib/weight-hunter-forge.mjs';
import { planTaskRuntime } from '../lib/capability-fabric.mjs';
import { buildLibrary, referenceSelectableAs } from '../lib/brain-library.mjs';
import { canonicalJson, sha256Hex } from '../lib/hash-util.mjs';
const ids = (context) => context.references.map((entry) => entry.id);
test('eight unique pinned sources are immutable with document hashes and no authority', () => {
  assert.equal(WEIGHT_HUNTER_REFERENCES.length, 8);
  assert.equal(new Set(WEIGHT_HUNTER_REFERENCES.map(e => e.id)).size, 8);
  for (const e of WEIGHT_HUNTER_REFERENCES) {
    assert.match(e.commit, /^[a-f0-9]{40}$/);
    assert.match(e.tree, /^[a-f0-9]{40}$/);
    assert.match(e.documentation.sha256, /^[a-f0-9]{64}$/);
    assert.equal(e.executionAllowed, false);
    assert.ok(e.documentation.url.includes(`/blob/${e.commit}/README.md`));
    assert.throws(() => { e.executionAllowed = true; }, TypeError);
  }
});
test('task-specific selection does not activate irrelevant sources', () => {
  const routing = ids(selectWeightHunterReferences({ task: 'Calibrate a cheaper model router for latency' }));
  assert.ok(routing.includes('withmartian--routerbench'));
  assert.ok(routing.includes('lm-sys--routellm'));
  assert.ok(!routing.includes('princeton-nlp--intercode'));
  const coding = ids(selectWeightHunterReferences({ task: 'Evaluate interactive Bash and SQL coding' }));
  assert.ok(coding.includes('princeton-nlp--intercode'));
  assert.ok(coding.includes('lmarena--arena-hard-auto'));
  assert.ok(!coding.includes('lm-sys--routellm'));
  assert.deepEqual(ids(selectWeightHunterReferences({ task: 'Write a birthday greeting' })), []);
});
test('random labels and deprecated evaluation never become acceptance evidence', () => {
  const context = selectWeightHunterReferences({ task: 'benchmark models with teacher consensus', strategy: 'distill' });
  assert.ok(ids(context).includes('yuchenlin--llm-blender'));
  assert.ok(ids(context).includes('lmarena--arena-rank'));
  assert.ok(context.references.every(e => e.evidenceEligible));
  assert.equal(context.exclusions.length, 2);
  assert.ok(context.exclusions.some(e => /random correctness/.test(e.reason)));
  assert.ok(context.exclusions.some(e => /deprecat/.test(e.reason)));
  const { contextSha256, ...body } = context;
  assert.equal(contextSha256, sha256Hex(canonicalJson(body)));
});
test('forge and runtime builders bind task context without expanding capabilities', () => {
  const donor = { id: 'fixture-a', sha256: 'a'.repeat(64), baseModel: 'fixture', license: 'MIT', architecture: { family: 'fixture', hiddenSize: 16, layers: 1 }, tokenizer: { sha256: 'b'.repeat(64) } };
  const plan = planForge({ task: 'Train a SQL coding model', donors: [donor, { ...donor, id: 'fixture-b' }], strategy: 'distill', target: { family: 'fixture', parameterBudgetB: 1, license: 'MIT' } });
  assert.ok(ids(plan.referenceContext).includes('princeton-nlp--intercode'));
  assert.ok(ids(plan.referenceContext).includes('yuchenlin--llm-blender'));
  const { planHash, ...body } = plan;
  assert.equal(planHash, sha256Hex(canonicalJson(body)));
  assert.equal(plan.gates.ownerApprovalRequired, true);
  const component = { id: 'fixture-component', sha256: 'c'.repeat(64), capabilities: ['network'] };
  const runtime = planTaskRuntime({ task: 'Calibrate routing', components: [component], launcherPins: new Map([[component.id, component.sha256]]) });
  assert.ok(ids(runtime.referenceContext).includes('lm-sys--routellm'));
  assert.deepEqual(runtime.components[0].grantedCapabilities, []);
  assert.equal(runtime.referenceContext.authorityGranted, false);
  assert.equal(runtime.referenceContext.assessment.concurrency, 1);
});
test('Brain Library builder retains sources as inert hash-bound references', () => {
  const library = buildLibrary({ now: '2026-11-04T00:00:00.000Z' });
  for (const e of WEIGHT_HUNTER_REFERENCES) {
    const ref = library.references.find(r => r.id === e.id);
    assert.ok(ref);
    assert.equal(ref.contentSha256, sha256Hex(ref.content));
    assert.equal(ref.executionDisabled, true);
    assert.deepEqual(ref.capabilities, []);
    for (const lane of ['model', 'tool', 'skill', 'prompt']) assert.equal(referenceSelectableAs(ref, lane), false);
    for (const field of ['licenseNoticeSha256', 'riskReportSha256']) assert.match(ref.provenance[field], /^[a-f0-9]{64}$/);
  }
});
