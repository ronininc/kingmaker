/**
 * lazy-frames/lib/lazy-frames-triage.mjs (kingmaker-stack)
 *
 * The Cage triage record for Lazy Frames (cosmicstack-labs/lazy-frames)
 * — status: DO NOT USE. Paper only.
 *
 * Why it sits in triage (verified 2026-10-20, HEAD a1ae532): the repo
 * DECLARES MIT — root package.json carries "license": "MIT" and the
 * README's License section reads "MIT © CosmicStack Labs" — but the
 * repo contains NO LICENSE FILE and no license text anywhere (repo
 * root, packages/, plugins/, skill/ all searched). A declared SPDX id
 * is a claim, not a grant; there are no terms to read, so there is
 * nothing to absorb under. The day a LICENSE file lands, this record
 * can clear — through a founder tap with the license file's sha256
 * recorded (clearTriage below), never silently.
 *
 * Two further findings are pre-registered so the flip, when it comes,
 * is already governed:
 *
 *   - REMOTE SKILL URL. The skill's advertised distribution is a live
 *     URL (skill/SKILL.md frontmatter: lazy-frames.cosmicstack.ai/
 *     skill.md). An agent fetching its instructions from a mutable
 *     remote document is an untrusted-input surface. guardSkillSource
 *     refuses every remote skill fetch; the governed copy is the
 *     IN-REPO skill, pinned below by sha256 (SKILL_PINS — computed
 *     from the intake clone, 2026-10-20). checkSkillPins verifies a
 *     staged copy against them.
 *   - CAPTURE EGRESS. Capture drives headless Chrome to whatever URL
 *     it is handed (packages/capture/src/capture.ts) — egress by
 *     design. The post-triage contract is pre-written (declared hosts
 *     + founder tap outside them) but INERT: buildRenderJob /
 *     buildCaptureJob refuse while triage stands, whatever they are
 *     handed.
 *
 * The upstream posture is otherwise strong (plugin registry with
 * per-project fingerprint locks and approvals; no telemetry found; no
 * install scripts; lockfile-pinned deps) — none of it matters until
 * the license text exists.
 */

import { createHash } from 'node:crypto';
import { refused, createTapGate } from '../../lib/governance.mjs';

export const LAZY_FRAMES_TRIAGE = Object.freeze({
  id: 'lazy-frames',
  repo: 'cosmicstack-labs/lazy-frames',
  commit: 'a1ae5329ffa8814420f3185f0c61cc81a6018fab',
  commitDate: '2026-08-19',
  status: 'DO NOT USE',
  declaredLicense: 'MIT (declared in package.json + README; NO LICENSE file or license text in repo)',
  licenseTextPresent: false,
  reason: 'license declared but grant text absent — unverifiable license is triage, not absorb',
});

/** sha256 of the in-repo skill documents at the intake commit. */
export const SKILL_PINS = Object.freeze({
  'skill/SKILL.md': '6fd24b264dff3c577b74a88f93521bbe27ac980404e458df29eafc3ae8f62136',
  'skill/references/cli.md': '0a8a62b74934486f5f8bb34c199330fb76ba8f86b6b8851709b4e2832b3f1a2b',
  'skill/references/gates.md': '8eccecae6a961504aabdc6ad858df21970261036c228701031c9b1fec0aab55b',
  'skill/references/scene-types.md': 'a817c43836ee9df7d1db92418506fde9af3341cb5170f798ec2f00166017f598',
  'skill/references/spec-format.md': 'e61c0fafdd673d4c6cc2484ef6367d4653fee2fa495f88856fc40192a59c62ec',
  'skill/references/workflows.md': '15588683e0ba6d44e96a1e5af1a8c99e69cc3ff91802e4d03382efd4be8ea3bb',
});

const REMOTE_SKILL_HOSTS = Object.freeze(['lazy-frames.cosmicstack.ai', 'cosmicstack.ai']);

function sha256(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex');
}

/**
 * Validate a triage record. Refuses any drift toward use: a status
 * other than DO NOT USE, or licenseTextPresent flipped without the
 * clearing ceremony having run.
 */
export function validateTriageRecord(d) {
  const problems = [];
  if (!d || typeof d !== 'object') return { ok: false, problems: ['triage record missing'] };
  if (d.id !== 'lazy-frames') problems.push("id must be 'lazy-frames'");
  if (d.status !== 'DO NOT USE') problems.push("status must read 'DO NOT USE' while the record is in triage");
  if (d.licenseTextPresent !== false) problems.push('licenseTextPresent must be false — no LICENSE file exists in the repo');
  return { ok: problems.length === 0, problems };
}

/** The tripwire: every job shape refuses while triage stands. */
export function buildRenderJob(_spec) {
  return refused(`lazy-frames is in Cage triage (DO NOT USE): ${LAZY_FRAMES_TRIAGE.reason}`);
}

export function buildCaptureJob(_url) {
  return refused(`lazy-frames is in Cage triage (DO NOT USE): ${LAZY_FRAMES_TRIAGE.reason}`);
}

/**
 * Tripwire for skill acquisition: a remote skill URL is refused
 * outright — governed skill documents are pinned local copies, never
 * fetched live instructions. Local paths pass.
 */
export function guardSkillSource(source) {
  const s = String(source ?? '');
  if (/^https?:\/\//i.test(s)) {
    let host = '';
    try { host = new URL(s).hostname; } catch { /* fall through to refusal */ }
    return refused(`skill source '${s}' refused — remote skill documents are never fetched; use the pinned in-repo copy${REMOTE_SKILL_HOSTS.includes(host) ? ` (host ${host} is the upstream's live skill URL)` : ''}`);
  }
  return { ok: true, source: s };
}

/**
 * Verify staged skill files against the intake pins. Input: a map of
 * repo-relative path → file contents. Every pinned file must be
 * present and byte-identical; extra files are ignored.
 */
export function checkSkillPins(files) {
  if (!files || typeof files !== 'object') return refused('skill pins: a path→contents map is required');
  for (const [path, expected] of Object.entries(SKILL_PINS)) {
    if (!(path in files)) return refused(`skill pins: '${path}' missing from the staged copy`);
    if (sha256(files[path]) !== expected) {
      return refused(`skill pins: '${path}' differs from the intake pin — the staged copy is not the audited skill`);
    }
  }
  return { ok: true, pinned: Object.keys(SKILL_PINS).length };
}

/**
 * Clear the triage — a founder act with three requirements, all
 * enforced: the founder tap, a LICENSE file now present (its sha256
 * recorded in the new record), and a license NAME read from that
 * file. Returns the cleared registration shell; anything less
 * refuses and the record stands.
 */
export async function clearTriage({ tapToken, verifyTap, licenseFileSha256, licenseName } = {}) {
  const gate = createTapGate(verifyTap);
  const blocked = await gate(tapToken);
  if (blocked) return blocked;
  if (!licenseFileSha256 || !/^[0-9a-f]{64}$/.test(String(licenseFileSha256))) {
    return refused('clear triage: the LICENSE file\'s sha256 is required — the grant text is recorded, not asserted');
  }
  if (!licenseName || typeof licenseName !== 'string') {
    return refused('clear triage: licenseName, read from the LICENSE file itself, is required');
  }
  return {
    ok: true,
    cleared: Object.freeze({
      id: 'lazy-frames',
      repo: LAZY_FRAMES_TRIAGE.repo,
      commit: LAZY_FRAMES_TRIAGE.commit,
      status: 'CLEARED — governed absorb may proceed',
      license: licenseName,
      licenseFileSha256: String(licenseFileSha256),
      skillPins: SKILL_PINS,
    }),
  };
}
