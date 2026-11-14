/**
 * lazy-frames triage tests — the tripwire only. Nothing renders,
 * nothing captures, no network: the record's job is to refuse.
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  LAZY_FRAMES_TRIAGE,
  SKILL_PINS,
  validateTriageRecord,
  buildRenderJob,
  buildCaptureJob,
  guardSkillSource,
  checkSkillPins,
  clearTriage,
} from '../lib/lazy-frames-triage.mjs';

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}`); }
}

const descriptor = JSON.parse(readFileSync(new URL('../descriptor.json', import.meta.url), 'utf8'));
const tap = async (t) => t === 'founder-token';
const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

// 1. The record itself.
check('status is DO NOT USE', LAZY_FRAMES_TRIAGE.status === 'DO NOT USE' && descriptor.posture.includes('DO NOT USE'));
check('license text recorded as absent', LAZY_FRAMES_TRIAGE.licenseTextPresent === false);
check('record validates', validateTriageRecord(LAZY_FRAMES_TRIAGE).ok === true);
check('drift toward use refuses validation', validateTriageRecord({ ...LAZY_FRAMES_TRIAGE, status: 'CLEARED' }).ok === false);
check('flipping licenseTextPresent refuses validation', validateTriageRecord({ ...LAZY_FRAMES_TRIAGE, licenseTextPresent: true }).ok === false);

// 2. The tripwire: every job shape refuses.
check('render job refused', buildRenderJob({ scenes: [] }).ok === false && /DO NOT USE/.test(buildRenderJob({}).reason));
check('capture job refused', buildCaptureJob('https://example.com').ok === false);

// 3. Skill source guard: remote instructions never fetched.
check('upstream live skill URL refused', guardSkillSource('https://lazy-frames.cosmicstack.ai/skill.md').ok === false);
check('any remote skill URL refused', guardSkillSource('https://example.com/skill.md').ok === false);
check('local pinned copy passes', guardSkillSource('repos/lazy-frames/skill/SKILL.md').ok === true);

// 4. Skill pins: a staged copy must be byte-identical to the audited
//    one — a missing or tampered file refuses.
check('missing pinned file refused', checkSkillPins({}).ok === false);
const tampered = {};
for (const p of Object.keys(SKILL_PINS)) tampered[p] = `contents-of-${p}`;
tampered['skill/SKILL.md'] = 'tampered instructions';
check('tampered skill file refused', checkSkillPins(tampered).ok === false);

// The real clone check: if the intake clone is staged beside this
// suite, its skill files must match the pins exactly.
import { existsSync } from 'node:fs';
const cloneSkill = new URL('../../../gittrend-now/repos/lazy-frames/skill/SKILL.md', import.meta.url);
if (existsSync(cloneSkill)) {
  const real = {};
  for (const p of Object.keys(SKILL_PINS)) {
    real[p] = readFileSync(new URL(`../../../gittrend-now/repos/lazy-frames/${p}`, import.meta.url), 'utf8');
  }
  check('intake clone skill files match the pins', checkSkillPins(real).ok === true);
  check('pin count is six skill documents', Object.keys(SKILL_PINS).length === 6 && sha(real['skill/SKILL.md']) === SKILL_PINS['skill/SKILL.md']);
} else {
  check('intake clone present for pin verification', false);
}

// 5. Clearing is a founder act with the license recorded.
check('clearing refuses without tap', (await clearTriage({ licenseFileSha256: 'c'.repeat(64), licenseName: 'MIT' })).ok === false);
check('clearing refuses bad tap', (await clearTriage({ tapToken: 'nope', verifyTap: tap, licenseFileSha256: 'c'.repeat(64), licenseName: 'MIT' })).ok === false);
check('clearing refuses without license hash', (await clearTriage({ tapToken: 'founder-token', verifyTap: tap, licenseName: 'MIT' })).ok === false);
check('clearing refuses without license name', (await clearTriage({ tapToken: 'founder-token', verifyTap: tap, licenseFileSha256: 'c'.repeat(64) })).ok === false);
const cleared = await clearTriage({ tapToken: 'founder-token', verifyTap: tap, licenseFileSha256: 'c'.repeat(64), licenseName: 'MIT' });
check('clearing succeeds with tap + license hash + name', cleared.ok === true && cleared.cleared.license === 'MIT' && cleared.cleared.skillPins === SKILL_PINS);
check('triage record itself is untouched by a hypothetical clear', LAZY_FRAMES_TRIAGE.status === 'DO NOT USE');

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail === 0 ? 0 : 1);
