/**
 * humanizer/lib/humanizer-skill.mjs (kingmaker-stack)
 *
 * The pin record + copy verifier for Humanizer (blader/humanizer,
 * MIT, v3.1.0) — a content SKILL absorbed for the blog rotation's
 * edit pass, complementing Stop Slop (structure-first vs
 * tell-catalog rule sets; the rotation can run either or both).
 * Problem scan 2026-10-20 found nothing to buff: SKILL.md is
 * self-contained prose rules, and the repo's one script
 * (scripts/validate-package.py) is stdlib-only and local.
 *
 * The absorbed artifact is SKILL.md alone — the distribution
 * wrappers (.claude-plugin/, .cursor-plugin/, agents/openai.yaml)
 * are packaging for other hosts, not part of the registration.
 * The pin is commit + SKILL.md sha256, computed from the intake
 * clone; a staged copy that differs is refused, because a skill
 * document is an instruction set and drift is a different set.
 * The file itself is NOT vendored into this tree.
 */

import { createHash } from 'node:crypto';
import { refused } from '../../lib/governance.mjs';

export const HUMANIZER_PIN = Object.freeze({
  repo: 'blader/humanizer',
  license: 'MIT',
  version: '3.1.0',
  commit: '8c307f367c91bd974002f10f2be2965d642c13df',
  kind: 'agent-skill (SKILL.md)',
  skillFiles: Object.freeze({
    'SKILL.md': '0612f1dfb1672b0ea9b97e139bf1f06cabe98d8b27424fe8ff01e1fb4cc99cad',
  }),
});

function sha256(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex');
}

/**
 * Verify a staged skill copy (map of repo-relative path → contents)
 * against the intake pin. The pinned file must be present and
 * byte-identical; extra files are ignored.
 */
export function verifySkillCopy(files) {
  if (!files || typeof files !== 'object') return refused('skill copy: a path→contents map is required');
  for (const [path, expected] of Object.entries(HUMANIZER_PIN.skillFiles)) {
    if (!(path in files)) return refused(`skill copy: '${path}' missing from the staged copy`);
    if (sha256(files[path]) !== expected) {
      return refused(`skill copy: '${path}' differs from the intake pin — the staged copy is not the audited skill`);
    }
  }
  return { ok: true, pinned: Object.keys(HUMANIZER_PIN.skillFiles).length };
}
