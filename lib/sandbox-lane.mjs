/**
 * Kingmaker — the sandbox lane (Part C of the metered rework, owner ruling
 * 2026-11-14 01:44: "no GGUF limit").
 *
 * The delivery lanes, in order: resident → metered-stream → SANDBOX →
 * off-device escalation as the last resort. The sandbox is Kingmaker's own
 * Linux sandbox on the device: when Kingmaker powers it, that is
 * device-level control, and device-level control includes Docker. A model
 * larger than the device's whole memory is therefore not a local
 * impossibility and never was: it executes LOCALLY inside a container
 * under Kingmaker's Docker control, its file memory-mapped from the
 * sandbox model store and its pages cycled by the kernel under the
 * container's memory ceiling (page cache first, the disk-backed swap
 * allowance second) instead of held resident by the host runner.
 *
 * The shapes here are the tree's own, composed — nothing invented:
 *   - the runner is the tree's local model runner, Ollama
 *     (lib/model-hosts.mjs: DEFAULT_LOCAL_URL http://127.0.0.1:11434,
 *     /api/generate), in its official container image;
 *   - the execution descriptor mirrors the registry shape the Brain
 *     Library's docker-image-tar lane already records
 *     (lib/brain-library-fetch.mjs: { type: 'docker-run', command:
 *     'docker', args: ['run', '--rm', image], image }), and the image
 *     reaches the device through that same lane — hash-verified before
 *     any docker invocation, adopted in place when already present;
 *   - the model itself arrives exactly as every delivered model does: in
 *     MAX_PORTION_BYTES pin-verified portions through
 *     lib/brain-library-access.mjs, assembled into the sandbox model
 *     store BEFORE the container starts. No unverified byte is ever
 *     served.
 *
 * Planning is pure; the one probe is injected-fakeable and mirrors the
 * fetch lane's fail-closed Docker semantics (a missing CLI or a dead
 * daemon makes the lane ABSENT with its reason named — never an error
 * thrown into a run, never a silent assumption that the lane exists).
 */

import { spawn } from 'node:child_process';
import { MAX_PORTION_BYTES } from './brain-library-access.mjs';

/** The tree's local runner (Ollama, lib/model-hosts.mjs) as its official container image. */
export const SANDBOX_RUNNER_IMAGE = 'ollama/ollama';

/** The sandbox runner's loopback port: beside the host Ollama's 11434
 *  (lib/model-hosts.mjs) and the SystemOne seat's 11435 (lib/systemone-server.mjs),
 *  so all three can stand on one device. The runner is a model host like any
 *  other once it answers — lib/model-hosts.mjs speaks to it by URL. */
export const SANDBOX_RUNNER_PORT = 11436;

/** Where the sandbox model store mounts inside the runner container (OLLAMA_MODELS). */
export const SANDBOX_MODELS_TARGET = '/models';

/** The one sandbox runner's container name on a device. Models swap through
 *  the store, not through containers — one runner, like the host's one Ollama. */
export const SANDBOX_CONTAINER_NAME = 'kingmaker-sandbox';

/**
 * Pure: normalize a device's sandbox posture from whatever shape the caller
 * measured it in (a probe result, a boolean, a declared posture, nothing).
 * Returns { available, declined, reason } — declined is a posture CHOICE
 * (the owner or the device profile says no sandbox), absent is a missing
 * prerequisite; the escalation text keeps the two distinct because they
 * are distinct facts. A declined posture is never available.
 */
export function normalizeSandboxPosture(input) {
  if (input == null) {
    return { available: false, declined: false, reason: 'no sandbox posture was measured for this device' };
  }
  if (typeof input === 'boolean') {
    return input
      ? { available: true, declined: false, reason: 'the sandbox lane is present in the measured device posture' }
      : { available: false, declined: false, reason: 'the sandbox lane is absent from the measured device posture' };
  }
  const declined = input.declined === true;
  const available = !declined && input.available === true;
  const reason = typeof input.reason === 'string' && input.reason
    ? input.reason
    : declined
      ? 'the sandbox lane is declined in this device\'s posture'
      : available
        ? 'the sandbox lane is present in the measured device posture'
        : 'the sandbox lane is absent from the measured device posture';
  return { available, declined, reason };
}

/**
 * Pure: the concrete sandbox execution plan for one model on one device.
 *
 * model:         the model tag/name (record-keeping only — the runner is
 *                model-agnostic; the model rides in the store).
 * weightsBytes:  the model's delivered size in bytes (portions + the
 *                paging allowance are sized from it; unknown → the
 *                allowance falls back to one device-memory).
 * ramBytes:      the device's whole memory in bytes — the container's
 *                memory ceiling.
 *
 * Paging posture: the container's cgroup RAM ceiling is the device's
 * whole memory; its memory-swap ceiling is that plus a disk-backed
 * allowance sized to the model, so the model's full page set can cycle
 * through swap and fault back instead of the run dying at the ceiling.
 * The runner memory-maps the model file from the mounted store, so pages
 * fault in on demand and are evicted under pressure (page cache first,
 * swap second): execution is paged, not resident. That — not a bigger
 * device — is what serves an over-memory model locally.
 */
export function buildSandboxPlan({ model = null, weightsBytes = null, ramBytes = null } = {}) {
  if (!Number.isFinite(ramBytes) || ramBytes <= 0) return null;
  const weights = Number.isFinite(weightsBytes) && weightsBytes > 0 ? weightsBytes : null;
  const portions = weights == null ? null : Math.max(1, Math.ceil(weights / MAX_PORTION_BYTES));
  const memoryBytes = Math.round(ramBytes);
  const swapAllowanceBytes = weights ?? memoryBytes;
  const memorySwapBytes = memoryBytes + swapAllowanceBytes;
  const endpoint = `http://127.0.0.1:${SANDBOX_RUNNER_PORT}`;
  return {
    runner: { image: SANDBOX_RUNNER_IMAGE, kind: 'ollama', endpoint },
    execution: {
      type: 'docker-run',
      command: 'docker',
      args: [
        'run', '--rm', '--name', SANDBOX_CONTAINER_NAME,
        '--publish', `127.0.0.1:${SANDBOX_RUNNER_PORT}:11434`,
        '--memory', String(memoryBytes),
        '--memory-swap', String(memorySwapBytes),
        '--env', `OLLAMA_MODELS=${SANDBOX_MODELS_TARGET}`,
        SANDBOX_RUNNER_IMAGE,
      ],
      image: SANDBOX_RUNNER_IMAGE,
    },
    bind: { sourceRole: 'sandbox-model-store', target: SANDBOX_MODELS_TARGET, readOnly: true },
    paging: {
      memoryBytes,
      memorySwapBytes,
      swapAllowanceBytes,
      posture: 'the runner memory-maps the model file from the mounted sandbox store; pages fault in on demand and are evicted under the container\'s memory ceiling (page cache first, the disk-backed swap allowance second) — execution is paged, not resident',
    },
    feed: {
      portions,
      portionBytes: MAX_PORTION_BYTES,
      verifiedBeforeStart: true,
      detail: `the model arrives in ${portions ?? '?'} pin-verified portion(s) of ${MAX_PORTION_BYTES} bytes through lib/brain-library-access.mjs, assembled into the sandbox model store before the container starts; no unverified byte is served`,
    },
    model,
  };
}

/** Run the docker CLI once, bounded — the fetch lane's runDocker shape, kept local. */
function runDockerOnce(dockerBin, args, { timeoutMs = 5000 } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(dockerBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } }, timeoutMs);
    child.stdout.on('data', (d) => { stdout = (stdout + d).slice(-2048); });
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2048); });
    child.on('error', (e) => { clearTimeout(timer); rejectPromise(e); });
    child.on('close', (code) => { clearTimeout(timer); resolvePromise({ code: code ?? 1, stdout, stderr }); });
  });
}

/**
 * Measure this device's sandbox posture. KINGMAKER_SANDBOX=off is the
 * owner's decline switch — a choice, reported as one. Otherwise the probe
 * asks Docker itself, with lib/brain-library-fetch.mjs's fail-closed
 * readings: a missing CLI or a silent daemon means the lane is absent,
 * with the reason named. The probe never throws for an absent lane.
 */
export async function probeSandboxPosture({ env = process.env, dockerBin = env.DOCKER_BIN ?? 'docker', run = runDockerOnce } = {}) {
  if (env.KINGMAKER_SANDBOX === 'off') {
    return { available: false, declined: true, reason: 'declined by this device\'s posture (KINGMAKER_SANDBOX=off)' };
  }
  let r;
  try {
    r = await run(dockerBin, ['info', '--format', '{{.ServerVersion}}']);
  } catch (e) {
    if (e?.code === 'ENOENT') {
      return { available: false, declined: false, reason: `the docker CLI ("${dockerBin}") was not found on PATH — the sandbox lane runs under Docker, which Kingmaker controls on its own devices` };
    }
    throw e;
  }
  if (r.code !== 0 || /cannot connect to the docker daemon|is the docker daemon running/i.test(r.stderr || '')) {
    const detail = (r.stderr || '').trim().slice(0, 140);
    return { available: false, declined: false, reason: `the Docker daemon is not answering${detail ? ` (${detail})` : ''} — the sandbox lane needs the daemon up under Kingmaker's control` };
  }
  const version = (r.stdout || '').trim();
  return { available: true, declined: false, reason: `Docker answers on this device${version ? ` (server ${version})` : ''} — the sandbox lane is in this device's posture` };
}
