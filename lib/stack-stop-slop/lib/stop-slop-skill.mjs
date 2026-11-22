/**
 * stop-slop/lib/stop-slop-skill.mjs (kingmaker-stack)
 *
 * The pin record + copy verifier for Stop Slop (hardikpandya/
 * stop-slop, MIT) — a content SKILL absorbed for the twice-daily
 * blog rotation's anti-slop pass. The upstream repo is prose only
 * (SKILL.md + references/*.md + LICENSE; no code, no scripts, no
 * network shape — problem scan 2026-10-20 found nothing to buff),
 * so the whole governed surface is this: the absorbed copy is the
 * intake clone's copy, pinned by commit and by per-file sha256,
 * and a staged copy that differs from the pins is not the audited
 * skill and is refused. Skill documents are instructions an agent
 * follows — a drifted copy is a different instruction set.
 *
 * The skill files themselves are NOT vendored into this tree; the
 * operator stages the pinned copy into the skill tree at intake,
 * and verifySkillCopy() is the check that staging must pass.
 */

import { createHash } from 'node:crypto';
import { refused } from '../../lib/governance.mjs';

export const STOP_SLOP_PIN = Object.freeze({
  repo: 'hardikpandya/stop-slop',
  license: 'MIT',
  commit: '8da1f030185bdfe8471220585162991eaeb970e9',
  commitDate: null, // last push 2026-03-17 per intake; static prose does not rot
  kind: 'agent-skill (SKILL.md + references)',
  skillFiles: Object.freeze({
    'SKILL.md': '7432a1d9ebdd42b27666da8458af252edf549f723fb14bcd4791425103930310',
    'references/examples.md': '49c592899eb4457f95d0767e15e3143569e2cef50f2927c3174e62432984cd3d',
    'references/phrases.md': '4ca1b7e97123b5c67eff3dc97e5e977332e0b24021265c1553888a93ec33fa93',
    'references/structures.md': 'ffbf1316c7fb5aaf552de005609a64a9639b546ecd76bfb0e482864d5bbe6f58',
  }),
});

function sha256(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex');
}

/**
 * Verify a staged skill copy (map of repo-relative path → contents)
 * against the intake pins. Every pinned file must be present and
 * byte-identical; extra files are ignored.
 */
export function verifySkillCopy(files) {
  if (!files || typeof files !== 'object') return refused('skill copy: a path→contents map is required');
  for (const [path, expected] of Object.entries(STOP_SLOP_PIN.skillFiles)) {
    if (!(path in files)) return refused(`skill copy: '${path}' missing from the staged copy`);
    if (sha256(files[path]) !== expected) {
      return refused(`skill copy: '${path}' differs from the intake pin — the staged copy is not the audited skill`);
    }
  }
  return { ok: true, pinned: Object.keys(STOP_SLOP_PIN.skillFiles).length };
}
