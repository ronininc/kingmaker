/**
 * stop-slop tests — pin + staged-copy verification. The real intake
 * clone is read (read-only) when present beside the workspace; the
 * tamper checks run on synthetic copies. No network.
 */

import { readFileSync, existsSync } from 'node:fs';
import { STOP_SLOP_PIN, verifySkillCopy } from '../lib/stop-slop-skill.mjs';

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}`); }
}

const descriptor = JSON.parse(readFileSync(new URL('../descriptor.json', import.meta.url), 'utf8'));

// 1. Pin + descriptor agreement.
check('pin names the intake commit', STOP_SLOP_PIN.commit === '8da1f030185bdfe8471220585162991eaeb970e9' && descriptor.pin.commit === STOP_SLOP_PIN.commit);
check('license is MIT', STOP_SLOP_PIN.license === 'MIT' && descriptor.license === 'MIT');
check('four skill files are pinned', Object.keys(STOP_SLOP_PIN.skillFiles).length === 4);

// 2. Staged-copy verification: missing and tampered copies refuse.
check('empty copy refuses', verifySkillCopy({}).ok === false);
const tampered = {};
for (const p of Object.keys(STOP_SLOP_PIN.skillFiles)) tampered[p] = `contents-of-${p}`;
check('tampered copy refuses', verifySkillCopy(tampered).ok === false);

// 3. The real intake clone matches the pins byte-for-byte (read-only).
const cloneRoot = new URL('../../../gittrend-now/repos/stop-slop/', import.meta.url);
if (existsSync(new URL('SKILL.md', cloneRoot))) {
  const real = {};
  for (const p of Object.keys(STOP_SLOP_PIN.skillFiles)) real[p] = readFileSync(new URL(p, cloneRoot), 'utf8');
  check('intake clone matches the pins', verifySkillCopy(real).ok === true);
} else {
  check('intake clone present for pin verification', false);
}

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail === 0 ? 0 : 1);
