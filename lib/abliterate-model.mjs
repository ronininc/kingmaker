/**
 * Local Heretic compatibility entrypoint. Upstream: https://github.com/p-e-w/heretic.
 * The old port's command/output contract is not a reviewed Heretic 2.x integration.
 * Requests/provenance can be inspected, but execution stays quarantined until a
 * pinned tool, licensed local input, owner-confirmed job and resource-bound runner
 * are integrated with Kingmaker's real intent/evidence/authorization/audit path.
 * Hosted provider weights are never accessible or modified through this interface.
 */
import { isAbsolute, resolve } from 'node:path';
export const HERETIC_UPSTREAM = 'https://github.com/p-e-w/heretic';
export function createAbliterationRequest({ baseWeightsPath, expectedSha256, outputPath, sessionId, founderTap }) {
  if (!founderTap) throw new Error('abliterate-model: no founder tap — refused');
  if (!isAbsolute(String(baseWeightsPath || '')) || !isAbsolute(String(outputPath || '')) || /^https?:/i.test(String(baseWeightsPath))) throw new Error('Heretic requires local weight and output paths; hosted APIs do not expose their weights.');
  if (!/^[a-f0-9]{64}$/i.test(String(expectedSha256 || ''))) throw new Error('A valid local weight content hash is required.');
  if (resolve(baseWeightsPath) === resolve(outputPath)) throw new Error('The original local weights cannot be overwritten.');
  return Object.freeze({ baseWeightsPath, expectedSha256: expectedSha256.toLowerCase(), outputPath, sessionId });
}
export async function verifyProvenance(request, { hashFile }) {
  const actual = String(await hashFile(request.baseWeightsPath)).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(actual) || actual !== request.expectedSha256) return { ok: false, reason: 'Local input content hash did not match; no provenance established.' };
  // Content equality alone does not establish publisher authenticity or license permission.
  return { ok: true, sha256: actual, scope: 'content-hash-only; publisher/license review still required' };
}
/** Fail closed: a settings tap or unverified port cannot authorize arbitrary Python execution or auto-adoption. */
export async function runAbliteration(_request, { auditAppend = null } = {}) {
  const result = Object.freeze({ ok: false, status: 'GATED', code: 'HERETIC_RUNNER_REVIEW_REQUIRED', source: HERETIC_UPSTREAM,
    reason: 'A pinned, reviewed Heretic 2.x local runner with licensed input, owner-confirmed job and hardware/resource gates is not integrated. No process ran, output was produced, or model was pinned.' });
  if (auditAppend) await auditAppend({ actor: 'kingmaker', action: 'heretic-run-gated', meta: { code: result.code, source: HERETIC_UPSTREAM, executed: false, adopted: false } });
  return result;
}
