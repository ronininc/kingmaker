/**
 * triage tests — the DO NOT USE verdict, enforced. No weights are
 * downloaded or even referenced by path; the records are paper only.
 */

import { readFileSync } from 'node:fs';
import { validateTriageRecord, clearanceGaps, assertUsable } from '../lib/triage.mjs';

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}`); }
}
function throws(fn) { try { fn(); return false; } catch { return true; } }

const mimo = JSON.parse(readFileSync(new URL('../mimo-v26-distill-qwen-9b.json', import.meta.url), 'utf8'));
const hymt = JSON.parse(readFileSync(new URL('../hy-mt2.json', import.meta.url), 'utf8'));

// 1. Both records are well-formed UNVERIFIED intake paper.
check('MiMo record validates', validateTriageRecord(mimo).ok === true);
check('Hy-MT2 record validates', validateTriageRecord(hymt).ok === true);
check('both are UNVERIFIED with DO NOT USE verdicts',
  mimo.status === 'UNVERIFIED' && hymt.status === 'UNVERIFIED' &&
  mimo.verdict === 'DO NOT USE until cleared' && hymt.verdict === 'DO NOT USE until cleared');
check('hash fields are empty (recorded at intake, not from captions)', mimo.hashes.sha256 === null && hymt.hashes.sha256 === null);
check('license claims are labeled unverified', mimo.licenseClaim.verified === false && hymt.licenseClaim.verified === false && mimo.licenseClaim.licenseClass === 'unknown');
check('MiMo claim is recorded AS a claim (caption MIT)', mimo.licenseClaim.claimed === 'MIT' && /caption/.test(mimo.licenseClaim.claimSource));

// 2. The gate refuses both, and says why.
check('assertUsable throws for MiMo', throws(() => assertUsable(mimo)));
check('assertUsable throws for Hy-MT2', throws(() => assertUsable(hymt)));
const gaps = clearanceGaps(mimo);
check('gaps name the missing work (license, hash, scan, authority, status)',
  gaps.some((g) => /license/.test(g)) && gaps.some((g) => /sha256/.test(g)) &&
  gaps.some((g) => /scan/.test(g)) && gaps.some((g) => /authority/.test(g)) && gaps.some((g) => /status/.test(g)));

// 3. Status-string forgery does not clear a record.
const forged = { ...mimo, status: 'CLEARED', verdict: 'fine, ship it' };
check('flipping status alone still throws', throws(() => assertUsable(forged)));

// 4. A genuinely cleared record passes — proving the gate opens on
//    evidence, not on a hard-coded no. (Synthetic record; no real
//    model is cleared by this test.)
const cleared = {
  ...mimo,
  status: 'CLEARED',
  verdict: 'cleared for intake',
  licenseClaim: { claimed: 'MIT', claimSource: 'source repo LICENSE', verified: true, licenseClass: 'clear' },
  hashes: { sha256: 'd'.repeat(64) },
  scanPassed: true,
  clearance: { requires: mimo.clearance.requires, clearedBy: 'founder', clearedAt: '2026-10-20T00:00:00Z' },
};
check('a fully-evidenced record clears the gate', assertUsable(cleared) === true && clearanceGaps(cleared).length === 0);

// 5. Malformed paper is caught.
check('UNVERIFIED record carrying a hash is malformed', validateTriageRecord({ ...mimo, hashes: { sha256: 'e'.repeat(64) } }).ok === false);
check('UNVERIFIED record with a soft verdict is malformed', validateTriageRecord({ ...mimo, verdict: 'probably fine' }).ok === false);

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail === 0 ? 0 : 1);
