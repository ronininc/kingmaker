/**
 * lib/abliterate-model.mjs
 *
 * PORTED from ronininc/kingmaker-os runtime/abliterate-model.ts
 * Source of truth: kingmaker-os. Do not edit here.
 *
 * Governed abliteration: strip refusal behavior from official base weights,
 * locally, under founder tap. Provenance hash-checked. heretic-llm runs via
 * subprocess ONLY — never imported, never linked (AGPL-3.0 boundary).
 * Output is auto-pinned to the registry.
 *
 * Status: UNTESTED live. Needs a GPU box + official base weights.
 * The heretic-llm Apple Silicon note applies: model.py imports bitsandbytes
 * unconditionally (CUDA-only) — try/except ImportError guard required.
 */

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

export function createAbliterationRequest({
  baseWeightsPath,
  expectedSha256,
  outputPath,
  sessionId,
  founderTap,
}) {
  if (!founderTap) {
    throw new Error('abliterate-model: no founder tap — refused');
  }
  if (!baseWeightsPath || !expectedSha256 || !outputPath) {
    throw new Error('abliterate-model: baseWeightsPath, expectedSha256, and outputPath are required');
  }
  return { baseWeightsPath, expectedSha256: expectedSha256.toLowerCase(), outputPath, sessionId };
}

/**
 * Verify provenance: hash the base weights file and compare.
 * Only official base weights pass. Anything else is refused.
 */
export async function verifyProvenance(request, { hashFile }) {
  const actual = (await hashFile(request.baseWeightsPath)).toLowerCase();
  if (actual !== request.expectedSha256) {
    return {
      ok: false,
      reason: `provenance check failed: expected ${request.expectedSha256.slice(0, 12)}..., got ${actual.slice(0, 12)}... — unofficial weights refused`,
    };
  }
  return { ok: true, sha256: actual };
}

/**
 * Run abliteration via heretic-llm as a SUBPROCESS.
 * Never import heretic-llm (AGPL-3.0). child_process.spawn only.
 * Resolves { ok: true, outputPath } or { ok: false, reason }.
 */
export function runAbliteration(request, { auditAppend = null, pinModel = null, registry = null } = {}) {
  return new Promise((resolve) => {
    const args = [
      '-m',
      'heretic',
      'abliterate',
      '--input',
      request.baseWeightsPath,
      '--output',
      request.outputPath,
    ];
    const child = spawn('python3', args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', (err) => {
      resolve({ ok: false, reason: `heretic subprocess failed to start: ${err.message}` });
    });
    child.on('close', (code) => {
      if (code !== 0) {
        resolve({ ok: false, reason: `heretic exited code ${code}: ${stderr.slice(0, 500)}` });
        return;
      }
      // Auto-pin the output.
      let pin = null;
      if (pinModel && registry) {
        try {
          const outHash = createHash('sha256').update(request.outputPath).digest('hex');
          pin = pinModel(registry, {
            name: `abliterated-${Date.now()}`,
            sha256: outHash,
            source: `heretic from ${request.baseWeightsPath}`,
            abliterated: true,
          });
        } catch (e) {
          // Pin failure does not invalidate the run, but it is recorded.
          if (auditAppend) {
            auditAppend({
              actor: 'system',
              action: 'abliterate-pin-failed',
              detail: e.message,
            });
          }
        }
      }
      if (auditAppend) {
        auditAppend({
          actor: 'founder',
          action: 'abliterate-complete',
          detail: `session=${request.sessionId} output=${request.outputPath} pin=${pin ? pin.pinId.slice(0, 12) : 'none'}`,
        });
      }
      resolve({ ok: true, outputPath: request.outputPath, pin });
    });
  });
}
