/**
 * angelslim/lib/angelslim-job.mjs
 *
 * The condense-lane registration for AngelSlim (Tencent/AngelSlim,
 * Apache-2.0): a model-compression toolkit (quantization families
 * FP8-Static/Dynamic, INT8-Dynamic, INT4-GPTQ/AWQ/GPTAQ, NVFP4 —
 * vocabulary from the upstream README's technical overview, fetched
 * 2026-10-20) folded in as a SPACE-cell-style workload, mirroring the
 * 4.1 cell pattern:
 *
 *   - The job is DATA: a descriptor { kind: 'angelslim-compress',
 *     modelIn, method, config, egress: deny-all } the cell governor
 *     accepts or refuses. The governor sits OUTSIDE the worker,
 *     exactly as the SPACE cell is shaped.
 *   - HASHED IN, HASHED OUT. A job cannot be built without the input
 *     model's sha256, and a result cannot be accepted without the
 *     output model's sha256. An unhashed artifact never enters the
 *     library — the same discipline as the model pin registry.
 *   - egress is DENY-ALL: weights and calibration data are local; a
 *     compression job has no legitimate network need.
 *   - The runner is a STUB behind the founder tap — the LittleBrother
 *     methods-full pattern exactly: no verifier → refuse; bad tap →
 *     refuse; valid tap → a stub record marked verified:false, with
 *     the executor NEVER invoked. Wiring the real AngelSlim runner is
 *     a founder act, the same class as wiring a live non-public source.
 */

import { fileURLToPath } from 'node:url';
import { openAuditLog } from '../../lib/audit-chain.mjs';
import { createTapGate, refused } from '../../lib/governance.mjs';

export const ANGELSLIM_KIND = 'angelslim-compress';
export const DENY_ALL_EGRESS = Object.freeze({ mode: 'deny-all', allow: Object.freeze([]) });

export const COMPRESSION_METHODS = Object.freeze([
  Object.freeze({ id: 'fp8-static', family: 'quantization', detail: 'FP8 static quantization' }),
  Object.freeze({ id: 'fp8-dynamic', family: 'quantization', detail: 'FP8 dynamic quantization' }),
  Object.freeze({ id: 'int8-dynamic', family: 'quantization', detail: 'INT8 dynamic quantization' }),
  Object.freeze({ id: 'int4-gptq', family: 'quantization', detail: 'INT4 GPTQ' }),
  Object.freeze({ id: 'int4-awq', family: 'quantization', detail: 'INT4 AWQ' }),
  Object.freeze({ id: 'nvfp4', family: 'quantization', detail: 'NVFP4 quantization' }),
]);

const SHA256_RE = /^[0-9a-f]{64}$/;

export function methodById(id) {
  return COMPRESSION_METHODS.find((m) => m.id === id) ?? null;
}

/**
 * Build a compression job descriptor. Throws on a malformed request
 * (a programming error); returns a refusal OBJECT on a governance
 * failure (unhashed input, unknown method) — the governor's verdicts
 * are data, not exceptions.
 */
export function buildCompressionJob({ jobId, modelIn, method, config = {} } = {}) {
  if (!jobId || typeof jobId !== 'string') throw new Error('angelslim: jobId is required');
  if (!modelIn || typeof modelIn.path !== 'string' || !modelIn.path) {
    throw new Error('angelslim: modelIn.path is required');
  }
  if (!SHA256_RE.test(modelIn.sha256 ?? '')) {
    return refused('angelslim: modelIn.sha256 must be a recorded 64-hex hash — unhashed models do not enter a compression job');
  }
  const m = methodById(method);
  if (!m) {
    return refused(`angelslim: unknown compression method '${method}' — registered: ${COMPRESSION_METHODS.map((x) => x.id).join(', ')}`);
  }
  return {
    ok: true,
    job: Object.freeze({
      kind: ANGELSLIM_KIND,
      jobId,
      template: 'kingmaker/angelslim-compress:latest',
      image: null, // pinned at Cage intake with the toolkit build
      spine: 'custom',
      modelIn: Object.freeze({ path: modelIn.path, sha256: modelIn.sha256 }),
      method: m.id,
      methodFamily: m.family,
      config: Object.freeze({ ...config }),
      egress: DENY_ALL_EGRESS,
      credentials: Object.freeze([]),
      expectedOutput: Object.freeze({ modelOut: Object.freeze({ path: null, sha256: null }) }),
    }),
  };
}

/**
 * Accept (or refuse) a finished job's output record. The output model
 * must arrive hashed; anything else does not enter the library.
 */
export function validateJobOutput(job, output) {
  if (!job || job.kind !== ANGELSLIM_KIND) return refused('angelslim: not an angelslim-compress job');
  if (!output?.modelOut?.path || !SHA256_RE.test(output.modelOut.sha256 ?? '')) {
    return refused('angelslim: output model must arrive with a path and a recorded sha256 — unhashed artifacts are refused');
  }
  if (output.modelOut.sha256 === job.modelIn.sha256) {
    return refused('angelslim: output hash equals input hash — no compression happened; refused');
  }
  return { ok: true, modelOut: { path: output.modelOut.path, sha256: output.modelOut.sha256 } };
}

/**
 * The stub runner. executor is accepted so the founder-act wiring has
 * a named place to land — and is NEVER called by the stub. The audit
 * distinguishes refusal entries (no tap / bad tap) from the stub-run
 * entry a valid tap produces.
 */
export function createAngelSlimRunner({ verifyTap = null, executor = null, auditLog = null, auditPath = null } = {}) {
  const audit = auditLog ?? openAuditLog(
    auditPath ?? fileURLToPath(new URL('../audit/angelslim-audit.jsonl', import.meta.url)),
    { genesisLabel: 'angelslim-runner-audit-genesis' }
  );
  const log = (action, detail, meta = {}) => audit.append({ actor: 'angelslim', action, detail, meta });
  const gate = createTapGate(verifyTap);
  void executor; // founder-act wiring point — the stub never invokes it

  async function run(job, { tapToken = null } = {}) {
    if (!job || job.kind !== ANGELSLIM_KIND) {
      const r = refused('angelslim: run requires an angelslim-compress job descriptor');
      log('run.refused', r.reason, {});
      return r;
    }
    const blocked = await gate(tapToken);
    if (blocked) {
      log('run.refused', blocked.reason, { jobId: job.jobId });
      return { ...blocked, reason: `angelslim: compression refused — ${blocked.reason}` };
    }
    log('run.stub', `job=${job.jobId} method=${job.method} — stub record only; live run is a founder act`, { jobId: job.jobId });
    return {
      ok: true,
      stub: true,
      jobId: job.jobId,
      method: job.method,
      modelIn: job.modelIn,
      modelOut: null,
      verified: false,
      note: 'stub runner: the tap was honored and the job recorded; executing AngelSlim is a founder act at live wiring',
    };
  }

  return Object.freeze({ run, auditPath: audit.path, verifyAudit: () => audit.verify() });
}
