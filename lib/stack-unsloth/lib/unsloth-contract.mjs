/**
 * unsloth/lib/unsloth-contract.mjs (kingmaker-stack)
 *
 * The governed training-lane contract for Unsloth (unslothai/unsloth).
 * Split licensing drives the shape (verified from the repo's own files,
 * 2026-10-20, HEAD c280b6f):
 *
 *   - CORE package: Apache-2.0 (LICENSE file; pyproject license field;
 *     README dual-license statement). The core is what this contract
 *     governs: local fine-tuning of Robbie's corpus on his hardware.
 *   - STUDIO UI: AGPL-3.0 (COPYING; studio/LICENSE.AGPL-3.0; install.sh
 *     SPDX header). AGPL is never absorbed — Studio is registered
 *     EXTERNAL-ONLY here, and this contract's only Studio job is to pin
 *     its launch posture: loopback bind, no Cloudflare quick tunnel.
 *     Upstream ships both a 0.0.0.0 bind option and a public-tunnel
 *     helper (studio/backend/cloudflare_tunnel.py); neither survives
 *     this contract — a caller value that widens either is refused,
 *     never merged.
 *
 * Training runs are governed actions: the job descriptor requires the
 * corpus sha256 going in and the model sha256 coming out (an output
 * hash equal to the input hash means nothing was trained — refused,
 * the AngelSlim rule). Running a job requires the founder tap; the
 * runner is injected, so this layer never trains anything itself.
 * Model/dataset downloads are the lane's only egress, declared as an
 * allowlist (Hugging Face Hub) and checked before any transport.
 *
 * Upstream core carries range pins (floors + exclusions), not lock
 * pins — validateVersionPins refuses any non-exact requirement, so
 * intake freezes exact versions before a run is buildable. Upstream's
 * documented Studio install is a curl|sh one-liner; governed installs
 * use a pinned source checkout only (INSTALLER_POSTURE below is data).
 */

import { refused, createTapGate, createEgressGuard } from '../../lib/governance.mjs';

export const UNSLOTH_PIN = Object.freeze({
  repo: 'unslothai/unsloth',
  commit: 'c280b6f7d044c359f3255e818e3e3cfc37d1f39f',
  commitDate: '2026-10-20',
  coreLicense: 'Apache-2.0',
  studioLicense: 'AGPL-3.0',
  studioPosture: 'external-only',
});

export const INSTALLER_POSTURE = Object.freeze({
  method: 'pinned source checkout at UNSLOTH_PIN.commit',
  forbidden: Object.freeze(['curl|sh installer from unsloth.ai', 'pip install of an unpinned range']),
});

/** Hosts a training job may reach to fetch base models / datasets. */
export const TRAINING_EGRESS_HOSTS = Object.freeze(['huggingface.co', '*.huggingface.co']);

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * Intake pin discipline: every requirement value must be an EXACT pin
 * ('1.2.3' or '==1.2.3'). Ranges ('>=', '~=', '<', '*', bare names)
 * refuse — upstream floors are careful, but a governed lane freezes.
 */
export function validateVersionPins(requirements) {
  if (!requirements || typeof requirements !== 'object' || Array.isArray(requirements)) {
    return refused('version pins: a requirements map is required');
  }
  const names = Object.keys(requirements);
  if (names.length === 0) return refused('version pins: empty map — nothing pinned');
  for (const name of names) {
    const v = String(requirements[name]).trim();
    const exact = v.startsWith('==') ? v.slice(2) : v;
    if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(exact) || /[><~*]/.test(v)) {
      return refused(`version pins: '${name}' is '${v}' — not an exact pin; freeze it at intake`);
    }
  }
  return { ok: true, pinned: Object.freeze({ ...requirements }) };
}

/**
 * Build a training job descriptor. Refuses without a corpus hash —
 * an unhashed corpus is not a governed input.
 */
export function buildTrainingJob({ corpusSha256, corpusRows, baseModel, method = 'lora', egressHosts = TRAINING_EGRESS_HOSTS } = {}) {
  if (!corpusSha256 || !HEX64.test(String(corpusSha256))) {
    return refused('training job: corpusSha256 (64-hex) is required — the corpus is hashed in, always');
  }
  if (!baseModel || typeof baseModel !== 'string') {
    return refused('training job: baseModel is required');
  }
  return {
    ok: true,
    job: Object.freeze({
      kind: 'unsloth-finetune',
      engine: Object.freeze({ repo: UNSLOTH_PIN.repo, commit: UNSLOTH_PIN.commit, license: UNSLOTH_PIN.coreLicense }),
      corpusSha256: String(corpusSha256),
      corpusRows: Number.isInteger(corpusRows) ? corpusRows : null,
      baseModel,
      method,
      egressHosts: Object.freeze([...egressHosts]),
    }),
  };
}

/** Pre-flight egress check for a model/dataset URL against the job's declared hosts. */
export function checkDownload(job, rawUrl, auditLog = null) {
  const guard = createEgressGuard({ allow: job?.egressHosts ?? [], auditLog, actor: 'unsloth-contract' });
  return guard.check(rawUrl);
}

/**
 * Accept a training result. The result model must be hashed, and its
 * hash must differ from the corpus hash — equal hashes mean the
 * "trained model" is the input wearing a new name.
 */
export function acceptTrainingResult(job, { modelSha256 } = {}) {
  if (!job || job.kind !== 'unsloth-finetune') return refused('training result: not a governed unsloth job');
  if (!modelSha256 || !HEX64.test(String(modelSha256))) {
    return refused('training result: modelSha256 (64-hex) is required — the model is hashed out, always');
  }
  if (String(modelSha256) === job.corpusSha256) {
    return refused('training result: model hash equals corpus hash — no training happened');
  }
  return { ok: true, record: Object.freeze({ job, modelSha256: String(modelSha256) }) };
}

/**
 * Run a job: founder-tap-gated, runner injected. A valid tap with no
 * runner wired returns a stub record (the LittleBrother methods-full
 * pattern — executing a real training run is a founder act performed
 * by wiring the runner, not by this contract).
 */
export async function runTraining(job, { tapToken, verifyTap, runner, auditLog } = {}) {
  const log = (action, detail, meta = {}) => { if (auditLog) auditLog.append({ actor: 'unsloth-contract', action, detail, meta }); };
  if (!job || job.kind !== 'unsloth-finetune') {
    const r = refused('training run: not a governed unsloth job');
    log('training.refused', r.reason);
    return r;
  }
  const gate = createTapGate(verifyTap);
  const blocked = await gate(tapToken);
  if (blocked) {
    log('training.refused', blocked.reason, { baseModel: job.baseModel });
    return blocked;
  }
  if (typeof runner !== 'function') {
    log('training.stub', 'tap verified; no runner wired — stub record only', { baseModel: job.baseModel });
    return { ok: true, stub: true, job };
  }
  const out = await runner(job);
  log('training.ran', `baseModel=${job.baseModel}`, { baseModel: job.baseModel });
  return { ok: true, stub: false, job, output: out };
}

/**
 * Studio (AGPL, EXTERNAL-ONLY) launch posture. The governed record
 * pins loopback + no tunnel; any caller attempt to widen the bind or
 * enable the tunnel is refused outright — pins are not defaults.
 */
export const STUDIO_ENV_PIN = Object.freeze({
  HF_HUB_DISABLE_TELEMETRY: '1',
});

export function buildStudioLaunchConfig({ host = '127.0.0.1', tunnel = false, env = {} } = {}) {
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    return refused(`studio launch: host '${host}' refused — the external Studio registration is loopback-pinned`);
  }
  if (tunnel === true) {
    return refused('studio launch: public tunnel refused — the Cloudflare quick-tunnel never opens under governance');
  }
  for (const [k, v] of Object.entries(env ?? {})) {
    if (k in STUDIO_ENV_PIN && String(v) !== STUDIO_ENV_PIN[k]) {
      return refused(`studio launch: env ${k}=${v} refused — pinned to ${STUDIO_ENV_PIN[k]}, config cannot unpin it`);
    }
  }
  return {
    ok: true,
    config: Object.freeze({
      external: true,
      license: UNSLOTH_PIN.studioLicense,
      host: '127.0.0.1',
      tunnel: false,
      env: Object.freeze({ ...env, ...STUDIO_ENV_PIN }),
    }),
  };
}
