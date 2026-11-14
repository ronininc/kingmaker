// The sandbox lane (lib/sandbox-lane.mjs, Part C — owner ruling 2026-11-14 01:44: no GGUF limit).
// Pure posture/plan functions with injected probes; one test uses the real probe against this
// machine (whatever Docker state it is in, the probe must answer with a posture, never throw).
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SANDBOX_CONTAINER_NAME,
  SANDBOX_MODELS_TARGET,
  SANDBOX_RUNNER_IMAGE,
  SANDBOX_RUNNER_PORT,
  buildSandboxPlan,
  normalizeSandboxPosture,
  probeSandboxPosture,
} from '../lib/sandbox-lane.mjs';

const GB = 2 ** 30;

test('posture normalization: absent, available, declined — declined always wins over available', () => {
  const absent = normalizeSandboxPosture(null);
  assert.equal(absent.available, false);
  assert.equal(absent.declined, false);
  assert.match(absent.reason, /no sandbox posture was measured/);
  assert.equal(normalizeSandboxPosture(undefined).available, false);
  assert.equal(normalizeSandboxPosture(false).available, false);
  const on = normalizeSandboxPosture(true);
  assert.equal(on.available, true);
  assert.equal(on.declined, false);
  const off = normalizeSandboxPosture({ available: true, declined: true, reason: 'declined for this device (KINGMAKER_SANDBOX=off)' });
  assert.equal(off.available, false, 'a declined posture never reports available');
  assert.equal(off.declined, true);
  assert.match(off.reason, /KINGMAKER_SANDBOX=off/);
  const bare = normalizeSandboxPosture({ available: true });
  assert.equal(bare.available, true);
  assert.match(bare.reason, /present in the measured device posture/);
});

test('the sandbox plan carries the tree-grounded concrete shape', () => {
  const plan = buildSandboxPlan({ model: 'huge', weightsBytes: 20 * GB, ramBytes: 8 * GB });
  assert.equal(plan.model, 'huge');
  assert.equal(plan.runner.image, SANDBOX_RUNNER_IMAGE);
  assert.equal(plan.runner.kind, 'ollama', 'the same runner family as the host path (lib/model-hosts.mjs)');
  assert.equal(plan.runner.endpoint, `http://127.0.0.1:${SANDBOX_RUNNER_PORT}`);
  assert.notEqual(SANDBOX_RUNNER_PORT, 11434, 'not the host runner port');
  assert.notEqual(SANDBOX_RUNNER_PORT, 11435, 'not the SystemOne port');
  assert.equal(plan.execution.type, 'docker-run', 'the registry execution-descriptor shape (lib/brain-library-fetch.mjs)');
  assert.equal(plan.execution.command, 'docker');
  assert.equal(plan.execution.image, SANDBOX_RUNNER_IMAGE);
  const args = plan.execution.args;
  assert.equal(args[0], 'run');
  assert.ok(args.includes('--rm'));
  assert.equal(args[args.indexOf('--name') + 1], SANDBOX_CONTAINER_NAME);
  assert.equal(args[args.indexOf('--publish') + 1], `127.0.0.1:${SANDBOX_RUNNER_PORT}:11434`, 'loopback-only publish of the runner port');
  assert.equal(args[args.indexOf('--memory') + 1], String(8 * GB), 'the memory ceiling is the device RAM in bytes');
  assert.equal(args[args.indexOf('--memory-swap') + 1], String(28 * GB), 'ceiling + weights-sized paging allowance');
  assert.equal(args[args.indexOf('--env') + 1], `OLLAMA_MODELS=${SANDBOX_MODELS_TARGET}`);
  assert.equal(args[args.length - 1], SANDBOX_RUNNER_IMAGE);
  assert.equal(plan.bind.target, SANDBOX_MODELS_TARGET);
  assert.equal(plan.bind.readOnly, true, 'the verified store is mounted read-only; the runner never writes the evidence');
  assert.equal(plan.paging.memoryBytes, 8 * GB);
  assert.equal(plan.paging.swapAllowanceBytes, 20 * GB);
  assert.match(plan.paging.posture, /memory-maps/);
  assert.match(plan.paging.posture, /paged, not resident/);
  assert.equal(plan.feed.portions, 20480, '20 GiB in 1 MiB verified portions');
  assert.equal(plan.feed.portionBytes, 1_048_576);
  assert.equal(plan.feed.verifiedBeforeStart, true);
});

test('unknown weights: the plan still forms, portions null, paging allowance falls back to the device memory', () => {
  const plan = buildSandboxPlan({ model: 'mystery', weightsBytes: null, ramBytes: 8 * GB });
  assert.equal(plan.feed.portions, null);
  assert.equal(plan.paging.swapAllowanceBytes, 8 * GB);
  assert.equal(plan.paging.memorySwapBytes, 16 * GB);
  assert.equal(buildSandboxPlan({ model: 'x', weightsBytes: 1, ramBytes: 0 }), null, 'no positive device memory, no plan');
  assert.equal(buildSandboxPlan({ model: 'x', weightsBytes: 1, ramBytes: null }), null);
});

test('the probe: KINGMAKER_SANDBOX=off declines without touching Docker', async () => {
  let calls = 0;
  const posture = await probeSandboxPosture({
    env: { KINGMAKER_SANDBOX: 'off' },
    run: async () => { calls += 1; return { code: 0, stdout: '27.0.0', stderr: '' }; },
  });
  assert.equal(posture.available, false);
  assert.equal(posture.declined, true);
  assert.match(posture.reason, /KINGMAKER_SANDBOX=off/);
  assert.equal(calls, 0, 'a declined posture is honored before any Docker probe');
});

test('the probe: a live daemon makes the lane available; a missing CLI or dead daemon makes it absent with its reason', async () => {
  const live = await probeSandboxPosture({ env: {}, run: async () => ({ code: 0, stdout: '27.3.1\n', stderr: '' }) });
  assert.equal(live.available, true);
  assert.match(live.reason, /27\.3\.1/);
  const enoent = await probeSandboxPosture({
    env: {},
    run: async () => { const e = new Error('spawn docker ENOENT'); e.code = 'ENOENT'; throw e; },
  });
  assert.equal(enoent.available, false);
  assert.equal(enoent.declined, false);
  assert.match(enoent.reason, /docker CLI \("docker"\) was not found on PATH/);
  const dead = await probeSandboxPosture({
    env: {},
    run: async () => ({ code: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?' }),
  });
  assert.equal(dead.available, false);
  assert.match(dead.reason, /daemon is not answering/);
});

test('the real probe answers with a posture and never throws, whatever this machine has', async () => {
  const posture = await probeSandboxPosture();
  assert.equal(typeof posture.available, 'boolean');
  assert.equal(typeof posture.reason, 'string');
  assert.ok(posture.reason.length > 0);
});
