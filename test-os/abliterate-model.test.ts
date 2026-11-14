// Tests for the abliterate-model method and pin registry.
// These tests never invoke the heretic binary — subprocess execution is
// verified by code inspection, not by running abliteration in CI.

import {
  createEmptyPinRegistry,
  pinModelVersion,
  resolvePinnedModel,
  revokeModelPin,
} from '../contracts/model-pin-registry';
import { abliterateModel, resolveModelForInference } from '../runtime/abliterate-model';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  console.log(`  ok: ${msg}`);
}

async function testPinRegistry(): Promise<void> {
  console.log('pin registry:');
  let reg = createEmptyPinRegistry();

  // No pin -> unresolvable. Kingmaker must refuse unpinned weights.
  assert(resolvePinnedModel(reg, 'qwen3-27b-abliterated') === null, 'unpinned modelId resolves to null');

  reg = pinModelVersion(reg, {
    modelId: 'qwen3-27b-abliterated',
    pinnedSha256: 'aaa111',
    baseModelSha256: 'base999',
    baseModelSource: 'Qwen/Qwen3-27B',
    pinnedAt: '2026-10-16T00:00:00Z',
    pinnedBy: 'FOUNDER',
    tapReference: 'tap-001',
    engagementJustification: 'pen-test engagement 7',
    hardwareDesignation: 'spark-01',
    toolVersion: 'heretic-llm 1.4.0',
  });

  const pin = resolvePinnedModel(reg, 'qwen3-27b-abliterated');
  assert(pin !== null && pin.pinnedSha256 === 'aaa111', 'active pin resolves');

  // Pinning a new version supersedes the old one — exactly one ACTIVE pin.
  reg = pinModelVersion(reg, {
    modelId: 'qwen3-27b-abliterated',
    pinnedSha256: 'bbb222',
    baseModelSha256: 'base999',
    baseModelSource: 'Qwen/Qwen3-27B',
    pinnedAt: '2026-10-17T00:00:00Z',
    pinnedBy: 'FOUNDER',
    tapReference: 'tap-002',
    engagementJustification: 'pen-test engagement 8',
    hardwareDesignation: 'spark-01',
    toolVersion: 'heretic-llm 1.4.0',
  });
  const pin2 = resolvePinnedModel(reg, 'qwen3-27b-abliterated');
  assert(pin2 !== null && pin2.pinnedSha256 === 'bbb222', 'new pin supersedes old');
  const activeCount = reg.pins.filter(
    (p) => p.modelId === 'qwen3-27b-abliterated' && p.status === 'ACTIVE',
  ).length;
  assert(activeCount === 1, 'exactly one ACTIVE pin per modelId');

  // Revocation makes the model unloadable.
  reg = revokeModelPin(reg, 'qwen3-27b-abliterated');
  assert(resolvePinnedModel(reg, 'qwen3-27b-abliterated') === null, 'revoked pin resolves to null');
}

async function testTapGate(): Promise<void> {
  console.log('tap gate:');
  const reg = createEmptyPinRegistry();

  // Non-founder authority is refused before anything is touched.
  const denied = await abliterateModel(
    {
      modelPath: '/nonexistent/weights.bin',
      expectedBaseSha256: 'x',
      baseModelSource: 'Qwen/Qwen3-27B',
      modelId: 'qwen3-27b-abliterated',
      engagementJustification: 'test',
      tapReference: 'tap-003',
      hardwareDesignation: 'spark-01',
      outputPath: '/tmp/out.bin',
      requesterAuthority: 'OPERATOR',
      toolVersion: 'heretic-llm 1.4.0',
    },
    reg,
  );
  assert(!denied.ok, 'non-founder request refused');
  assert(denied.reasonPlain.includes('FOUNDER'), 'refusal names the required authority');

  // Missing tap reference is refused.
  const noTap = await abliterateModel(
    {
      modelPath: '/nonexistent/weights.bin',
      expectedBaseSha256: 'x',
      baseModelSource: 'Qwen/Qwen3-27B',
      modelId: 'qwen3-27b-abliterated',
      engagementJustification: 'test',
      tapReference: '',
      hardwareDesignation: 'spark-01',
      outputPath: '/tmp/out.bin',
      requesterAuthority: 'FOUNDER',
      toolVersion: 'heretic-llm 1.4.0',
    },
    reg,
  );
  assert(!noTap.ok, 'missing tap reference refused');
}

async function testInferenceGate(): Promise<void> {
  console.log('inference gate + spine inheritance:');
  const reg = createEmptyPinRegistry();

  // Unpinned model refused under every spine.
  for (const spine of ['custom', 'kingmaker-x-heretic'] as const) {
    const blocked = resolveModelForInference(reg, 'qwen3-27b-abliterated', spine);
    assert(!blocked.ok, `unpinned model refused under spine "${spine}"`);
  }

  // Pin a NON-abliterated model.
  let reg2 = pinModelVersion(createEmptyPinRegistry(), {
    modelId: 'qwen3-27b',
    pinnedSha256: 'ccc333',
    baseModelSha256: 'base999',
    baseModelSource: 'Qwen/Qwen3-27B',
    pinnedAt: '2026-10-16T00:00:00Z',
    pinnedBy: 'FOUNDER',
    tapReference: 'tap-004',
    engagementJustification: 'general use',
    hardwareDesignation: 'spark-01',
    toolVersion: 'n/a',
  });

  // custom spine: pinned non-abliterated loads fine.
  const customOk = resolveModelForInference(reg2, 'qwen3-27b', 'custom');
  assert(customOk.ok, 'pinned non-abliterated model loads under custom spine');

  // kingmaker-x-heretic spine: pinned but NOT abliterated is refused.
  // The spine cascades down — the model cannot override it.
  const hxBlocked = resolveModelForInference(reg2, 'qwen3-27b', 'kingmaker-x-heretic');
  assert(!hxBlocked.ok, 'non-abliterated model refused under kingmaker-x-heretic spine');
  assert(
    hxBlocked.reasonPlain.includes('requires abliterated'),
    'refusal names the abliteration requirement',
  );

  // kingmaker-x-heretic spine: pinned ABLITERATED model loads.
  reg2 = pinModelVersion(reg2, {
    modelId: 'qwen3-27b-abliterated',
    pinnedSha256: 'ddd444',
    baseModelSha256: 'base999',
    baseModelSource: 'Qwen/Qwen3-27B',
    pinnedAt: '2026-10-16T00:00:00Z',
    pinnedBy: 'FOUNDER',
    tapReference: 'tap-005',
    engagementJustification: 'pen-test engagement 9',
    hardwareDesignation: 'spark-01',
    toolVersion: 'heretic-llm 1.4.0',
  });
  const hxOk = resolveModelForInference(reg2, 'qwen3-27b-abliterated', 'kingmaker-x-heretic');
  assert(hxOk.ok, 'pinned abliterated model loads under kingmaker-x-heretic spine');
  assert(
    hxOk.reasonPlain.includes('tap required per session'),
    'powerhouse mode names the per-session tap',
  );
}

async function main(): Promise<void> {
  await testPinRegistry();
  await testTapGate();
  await testInferenceGate();
  console.log('\nAll abliterate-model tests passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
