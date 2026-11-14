/**
 * humanizer tests — pin + staged-copy verification. The real intake
 * clone is read (read-only) when present beside the workspace; the
 * tamper checks run on synthetic copies. No network.
 */

import { readFileSync, existsSync } from 'node:fs';
import { HUMANIZER_PIN, verifySkillCopy } from '../lib/humanizer-skill.mjs';

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}`); }
}

const descriptor = JSON.parse(readFileSync(new URL('../descriptor.json', import.meta.url), 'utf8'));

// 1. Pin + descriptor agreement.
check('pin names the intake commit', HUMANIZER_PIN.commit === '8c307f367c91bd974002f10f2be2965d642c13df' && descriptor.pin.commit === HUMANIZER_PIN.commit);
check('license is MIT, version 3.1.0', HUMANIZER_PIN.license === 'MIT' && HUMANIZER_PIN.version === '3.1.0' && descriptor.license === 'MIT');
check('the pin covers SKILL.md', typeof HUMANIZER_PIN.skillFiles['SKILL.md'] === 'string' && /^[0-9a-f]{64}$/.test(HUMANIZER_PIN.skillFiles['SKILL.md']));

// 2. Staged-copy verification: missing and tampered copies refuse.
check('empty copy refuses', verifySkillCopy({}).ok === false);
check('tampered copy refuses', verifySkillCopy({ 'SKILL.md': 'tampered instructions' }).ok === false);

// 3. The real intake clone matches the pin byte-for-byte (read-only).
const cloneSkill = new URL('../../../gittrend-now/repos/humanizer/SKILL.md', import.meta.url);
if (existsSync(cloneSkill)) {
  const real = { 'SKILL.md': readFileSync(cloneSkill, 'utf8') };
  check('intake clone matches the pin', verifySkillCopy(real).ok === true);
} else {
  check('intake clone present for pin verification', false);
}

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail === 0 ? 0 : 1);
