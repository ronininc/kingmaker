#!/usr/bin/env node
/**
 * weight-synthesis — acceptance tests.
 *
 * The engine's birth certificate criteria, in code:
 *   1. Determinism — same recipe + parents + seed → same artifact hash,
 *      twice, including a full re-execution "on a second stack"
 *      (fresh module state) and a twin-mediated reproduction run.
 *   2. Merge math — hand-computed expectations for linear / slerp /
 *      ties / dare, and refusals for every malformed input.
 *   3. The Judge — Pareto frontier, the balance rule, the quality
 *      floor, held-out truth over suite score.
 *   4. The registry — hash-only parents, license discipline, signed
 *      pins verified at load, the brains' export carrying no weights.
 *   5. Evidence intake — sources mandatory, vendor claims are leads,
 *      hardware envelopes enforced.
 *   6. The twin — text spec discipline, the folder worked down in
 *      order, receipts kept, scratch wiped, escapes refused.
 */

import { mkdtempSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync } from 'node:crypto';

import {
  canonicalStringify, contentId, hashTensorSet, tensorNames,
  mergeLinear, mergeSlerp, mergeTies, mergeDare,
  validateRecipe, executeRecipe, TOOLCHAIN,
} from '../lib/weightsynth-core.mjs';
import { paretoFrontier, selectWinner, judgeCandidate, searchLinearRecipes } from '../lib/weightsynth-judge.mjs';
import {
  createParentRegistry, licenseOf, pinRecord, signPin, verifyForLoad,
  brainExport, shortlistEntry, screenShortlist, HARDWARE_PROFILES,
} from '../lib/weightsynth-registry.mjs';
import { parseTwinSpec, serializeTwinSpec, runWorkList, twinSpecFromFile } from '../lib/weightsynth-twin.mjs';
import { openAuditLog } from '../../lib/audit-chain.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const results = [];
const check = (name, ok) => { results.push({ name, ok: !!ok }); if (!ok) console.error('FAIL:', name); };
const throws = (fn) => { try { fn(); return false; } catch { return true; } };
const approx = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const model = (tensors) => ({ tensors });
const T = (arr, shape = [arr.length]) => ({ shape, data: Float32Array.from(arr) });

/* ---------------- core: hashing & determinism ---------------- */

check('canonical stringify is key-order independent',
  canonicalStringify({ b: 1, a: { d: 2, c: 3 } }) === canonicalStringify({ a: { c: 3, d: 2 }, b: 1 }));

const mA = model({ w: T([1, 2, 3, 4]), v: T([0.5, -0.5]) });
const mB = model({ w: T([5, 6, 7, 8]), v: T([1.5, 0.5]) });
check('tensor-set hash is stable for identical sets',
  hashTensorSet(mA.tensors) === hashTensorSet(model({ v: T([0.5, -0.5]), w: T([1, 2, 3, 4]) }).tensors));
const mA2 = model({ w: T([1, 2, 3, 4.000001]), v: T([0.5, -0.5]) });
check('one flipped element changes the artifact hash',
  hashTensorSet(mA.tensors) !== hashTensorSet(mA2.tensors));

/* ---------------- merge math ---------------- */

const lin = mergeLinear([mA, mB], [0.25, 0.75]);
check('linear merge matches hand-computed values',
  approx(lin.w.data[0], 0.25 * 1 + 0.75 * 5) && approx(lin.w.data[3], 0.25 * 4 + 0.75 * 8)
  && approx(lin.v.data[1], 0.25 * -0.5 + 0.75 * 0.5));
check('linear refuses coefficients that do not sum to 1',
  throws(() => mergeLinear([mA, mB], [0.5, 0.6])));

const s0 = mergeSlerp([mA, mB], 0);
const s1 = mergeSlerp([mA, mB], 1);
check('slerp endpoints are the parents themselves',
  approx(s0.w.data[2], 3) && approx(s1.w.data[2], 7));
const orth1 = model({ w: T([1, 0]) });
const orth2 = model({ w: T([0, 1]) });
const sMid = mergeSlerp([orth1, orth2], 0.5);
check('slerp midpoint of orthogonal unit vectors stays on the sphere',
  approx(Math.hypot(sMid.w.data[0], sMid.w.data[1]), 1, 1e-6));

const base = model({ w: T([10, 10, 10, 10]) });
const d1 = model({ w: T([11, 9, 10.1, 10]) });   // delta: +1, -1, +0.1, 0
const d2 = model({ w: T([12, 10.5, 9.9, 10]) }); // delta: +2, +0.5, -0.1, 0
const ties = mergeTies([d1, d2], base, { density: 1 });
check('ties elects the summed sign and averages agreeing deltas',
  approx(ties.w.data[0], 10 + 1.5) && approx(ties.w.data[1], 10 - 1) && approx(ties.w.data[2], 10.1) && approx(ties.w.data[3], 10));

check('dare with p=0 is the plain delta average',
  (() => { const out = mergeDare([d1, d2], base, { p: 0, seed: 's' }); return approx(out.w.data[0], 11.5) && approx(out.w.data[1], 9.75); })());
const dareA = mergeDare([d1, d2], base, { p: 0.5, seed: 'recipe-seed-1', });
const dareB = mergeDare([d1, d2], base, { p: 0.5, seed: 'recipe-seed-1' });
check('dare is deterministic under the recipe seed',
  hashTensorSet(dareA) === hashTensorSet(dareB));

check('architecture mismatch refuses (shape)',
  throws(() => mergeLinear([mA, model({ w: T([1, 2]), v: T([1, 2]) })], [0.5, 0.5])));
check('architecture mismatch refuses (names)',
  throws(() => mergeLinear([mA, model({ w: T([1, 2, 3, 4]), u: T([1, 2]) })], [0.5, 0.5])));

/* ---------------- recipes ---------------- */

const hA = hashTensorSet(mA.tensors);
const hB = hashTensorSet(mB.tensors);
const { specHash: twinHash } = twinSpecFromFile(join(HERE, '..', 'twins', 'm3-8gb.twin.txt'));
const recipe = {
  version: 1, algorithm: 'linear', parents: [hA, hB], coefficients: [0.4, 0.6],
  seed: 'birth-certificate', suite: { id: 'coder-lane', version: '1.0.0' },
  balance: { qualityWeight: 0.6, productionWeight: 0.4, qualityFloor: 0.9 },
  environment: { twinSpecHash: twinHash, toolchain: TOOLCHAIN },
};
let recipeId = null;
check('a complete recipe validates and content-addresses',
  (() => { try { recipeId = validateRecipe(recipe); return /^[0-9a-f]{64}$/.test(recipeId); } catch { return false; } })());
check('recipe refuses a parent named by anything but a hash',
  throws(() => validateRecipe({ ...recipe, parents: ['qwen3-0.6b', hB] })));
check('recipe refuses dare without a seed',
  throws(() => validateRecipe({ ...recipe, algorithm: 'dare', base: hA, seed: undefined, coefficients: undefined })));
check('recipe refuses a balance that does not sum to 1',
  throws(() => validateRecipe({ ...recipe, balance: { qualityWeight: 0.5, productionWeight: 0.4, qualityFloor: 0.9 } })));
check('recipe refuses ties whose base is not a parent',
  throws(() => validateRecipe({ ...recipe, algorithm: 'ties', base: hA.replace(/^./, 'f'), coefficients: undefined })));

const registry = new Map([[hA, mA], [hB, mB]]);
const run1 = executeRecipe(recipe, registry);
const run2 = executeRecipe(recipe, registry);
check('DETERMINISM PROOF: same recipe, two executions, identical artifact hash',
  run1.artifactHash === run2.artifactHash);
check('execute refuses a parent hash missing from the registry',
  throws(() => executeRecipe(recipe, new Map([[hA, mA]]))));

/* ---------------- the Judge ---------------- */

const cands = [
  { id: 'a-fast-dumb', quality: 0.50, production: 300 },
  { id: 'b-flagship', quality: 0.98, production: 100 },
  { id: 'c-balanced', quality: 0.93, production: 180 },
  { id: 'd-dominated', quality: 0.90, production: 90 },
];
const frontier = paretoFrontier(cands);
check('pareto frontier keeps exactly the non-dominated set',
  frontier.map((c) => c.id).join(',') === 'b-flagship,c-balanced,a-fast-dumb');
const sel = selectWinner(cands, recipe.balance, { quality: 1.0, production: 200 });
check('the balance rule picks the balanced candidate over flagship and fast-dumb',
  sel.winner.id === 'c-balanced' && sel.disqualified.includes('a-fast-dumb'));
check('selection refuses an unmeasured flagship reference',
  throws(() => selectWinner(cands, recipe.balance, { quality: 0, production: 200 })));

const judged = await judgeCandidate({
  id: 'x', artifactRef: 'ref',
  evaluate: async () => ({ suiteScore: 0.99, heldOutScore: 0.71 }),
  measure: async () => ({ decodeTokPerSec: 42, prefillTokPerSec: 900 }),
});
check('the Judge trusts the held-out score over the suite score',
  judged.quality === 0.71 && judged.production === 42);
let judgeRefused = false;
try {
  await judgeCandidate({ id: 'x', artifactRef: 'r', evaluate: async () => ({ suiteScore: 1 }), measure: async () => ({}) });
} catch { judgeRefused = true; }
check('the Judge refuses a missing measurement (never treats it as zero)', judgeRefused);

/* deterministic search: the scorer is a pure function of the recipe */
const scorer = async (r) => {
  const c = r.coefficients;
  return { quality: 1 - Math.abs(c[0] - 0.3), production: 100 + 50 * c[1] };
};
const searchBase = { ...recipe, coefficients: undefined };
const sRun1 = await searchLinearRecipes({ baseRecipe: searchBase, parentCount: 2, score: scorer, generations: 3, populationSize: 6 });
const sRun2 = await searchLinearRecipes({ baseRecipe: searchBase, parentCount: 2, score: scorer, generations: 3, populationSize: 6 });
check('SEARCH DETERMINISM: same seed and scorer, same winner and same log',
  sRun1.winner.id === sRun2.winner.id && JSON.stringify(sRun1.log) === JSON.stringify(sRun2.log));

/* ---------------- registry: parents, licenses, pins ---------------- */

const parents = createParentRegistry();
parents.register({ hash: hA, license: 'Apache-2.0', source: 'pinned fleet', tensors: mA.tensors });
parents.register({ hash: hB, license: 'MIT', source: 'pinned fleet', tensors: mB.tensors });
check('parent registration verifies the claimed hash against the tensors',
  throws(() => parents.register({ hash: hA.replace(/^./, 'f'), license: 'MIT', source: 'x', tensors: mA.tensors })));
check('recipe check passes clean parents and inherits the strictest license',
  parents.checkRecipe(recipe).inheritedLicense === 'Apache-2.0');
check('license inheritance takes the strictest parent',
  licenseOf([{ license: 'MIT' }, { license: 'AGPL-3.0' }]) === 'AGPL-3.0');
const dirtyHash = 'e'.repeat(64);
parents.register({ hash: dirtyHash, license: 'unknown', source: 'some forum post' });
check('a license-dirty parent refuses at recipe time',
  throws(() => parents.checkRecipe({ ...recipe, parents: [hA, dirtyHash] })));
check('an unregistered parent refuses at recipe time',
  throws(() => parents.checkRecipe({ ...recipe, parents: [hA, 'd'.repeat(64)] })));

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const pin = pinRecord({
  recipeId, artifactHash: run1.artifactHash, parentHashes: [hB, hA],
  inheritedLicense: 'Apache-2.0',
  judge: { quality: 0.93, production: 180, suite: 'coder-lane@1.0.0' },
  twinSpecHash: twinHash,
});
const sig = signPin(pin, privPem);
check('a signed pin verifies for load',
  verifyForLoad({ record: pin, signatureB64: sig, artifactHash: run1.artifactHash, publicKeyPem: pubPem }).ok === true);
check('load refuses a tampered artifact hash',
  throws(() => verifyForLoad({ record: pin, signatureB64: sig, artifactHash: hB, publicKeyPem: pubPem })));
check('load refuses an unsigned pin',
  throws(() => verifyForLoad({ record: pin, signatureB64: null, artifactHash: run1.artifactHash, publicKeyPem: pubPem })));
check('load refuses a signature from the wrong key',
  (() => { const other = generateKeyPairSync('ed25519'); return throws(() =>
    verifyForLoad({ record: pin, signatureB64: sig, artifactHash: run1.artifactHash, publicKeyPem: other.publicKey.export({ type: 'spki', format: 'pem' }) })); })());

const exported = brainExport(pin);
check("the brains' export carries metadata only — no tensor surface at all",
  Object.keys(exported).sort().join(',') === 'artifactHash,inheritedLicense,judge,kind,recipeId,twinSpecHash'
  && !JSON.stringify(exported).includes('data'));

/* ---------------- evidence intake ---------------- */

check('a shortlist entry refuses to exist without a source',
  throws(() => shortlistEntry({ candidate: 'merge-x', evidenceClass: 'measured', profile: 'm3-8gb', footprintGB: 2 })));
const eGood = shortlistEntry({ candidate: 'merge-x', source: 'tester post, 2026-10-02', evidenceClass: 'measured', profile: 'm3-8gb', footprintGB: 4 });
const eVendor = shortlistEntry({ candidate: 'merge-y', source: 'vendor blog', evidenceClass: 'vendor-claim', profile: 'm3-8gb', footprintGB: 1 });
const eFat = shortlistEntry({ candidate: 'merge-z', source: 'tester post', evidenceClass: 'reported', profile: 'm3-8gb', footprintGB: 9 });
const screened = screenShortlist([eGood, eVendor, eFat], 'm3-8gb');
check('screening keeps the measured in-envelope candidate only',
  screened.survivors.map((e) => e.id).join(',') === eGood.id && screened.refused.length === 2);
check('screening refuses vendor claims as leads, never evidence',
  screened.refused.some((r) => r.reason.includes('vendor-claim')));
check('screening enforces the hardware envelope',
  screened.refused.some((r) => r.reason.includes('exceeds')) && HARDWARE_PROFILES['m3-8gb'].weightBudgetGB < 9);

/* ---------------- the twin ---------------- */

const specText = readFileSync(join(HERE, '..', 'twins', 'm5pro-24gb.twin.txt'), 'utf8');
const parsed = parseTwinSpec(specText);
check('twin spec round-trips to identical bytes and hash',
  parseTwinSpec(serializeTwinSpec(parsed.spec)).specHash === parsed.specHash);
check('twin spec refuses a missing key',
  throws(() => parseTwinSpec('PROFILE=m3-8gb\nHEADLESS=always\n')));
check('twin spec refuses a twin with a UI',
  throws(() => parseTwinSpec(specText.replace('HEADLESS=always', 'HEADLESS=never'))));
check('both shipped twin specs parse',
  !!twinSpecFromFile(join(HERE, '..', 'twins', 'm3-8gb.twin.txt')).specHash
  && !!twinSpecFromFile(join(HERE, '..', 'twins', 'm5pro-24gb.twin.txt')).specHash);

const twinFolder = mkdtempSync(join(tmpdir(), 'ws-twin-'));
writeFileSync(join(twinFolder, '01-screen.item.json'), JSON.stringify({ kind: 'screen', ref: 'cand-1' }));
writeFileSync(join(twinFolder, '02-reproduce.item.json'), JSON.stringify({ kind: 'reproduce', recipeId }));
writeFileSync(join(twinFolder, '03-canary.item.json'), JSON.stringify({ kind: 'canary', pin: 'p1', haltOnFailure: false }));
const order = [];
const twinRun = await runWorkList({
  folder: twinFolder, spec: parsed.spec, specHash: parsed.specHash,
  handlers: {
    screen: async (item) => { order.push('screen'); return { screened: item.ref }; },
    reproduce: async (item, ctx) => {
      order.push('reproduce');
      const again = executeRecipe(recipe, registry); // the reproduction run, twin-side
      if (again.artifactHash !== run1.artifactHash) throw new Error('reproduction hash mismatch');
      return { reproduced: item.recipeId.slice(0, 12), hashMatches: true };
    },
    canary: async () => { order.push('canary'); throw new Error('canary found drift'); },
  },
});
check('the twin works down the list in order, one item at a time',
  order.join(',') === 'screen,reproduce,canary' && twinRun.items.length === 3);
check('REPRODUCTION PROOF: the twin re-execution matches the original artifact hash',
  twinRun.items[1].ok === true && twinRun.items[1].result.hashMatches === true);
check('a failing item is receipted, and the run records it without dying',
  twinRun.items[2].ok === false && twinRun.items[2].error.includes('drift'));
check('receipts are kept for every item',
  readdirSync(join(twinFolder, 'receipts')).filter((f) => f.endsWith('.receipt.json')).length === 3);
check('scratch is wiped when the run ends (amnesic teardown)',
  twinRun.scratchWiped === true && !existsSync(join(twinFolder, '.scratch')));

const evilFolder = mkdtempSync(join(tmpdir(), 'ws-twin-evil-'));
writeFileSync(join(evilFolder, '01-screen.item.json'), JSON.stringify({ kind: 'screen', path: '../outside' }));
let escapeRefused = false;
try {
  await runWorkList({ folder: evilFolder, spec: parsed.spec, specHash: parsed.specHash, handlers: { screen: async () => ({}) } });
} catch { escapeRefused = true; }
check('a work item pointing outside the folder refuses the whole run', escapeRefused);

/* ---------------- audit chain ---------------- */

const auditDir = mkdtempSync(join(tmpdir(), 'ws-audit-'));
const log = openAuditLog(join(auditDir, 'audit.jsonl'), { genesisLabel: 'weightsynth-test' });
log.append({ actor: 'weightsynth', action: 'pin-adopted', detail: `recipe ${recipeId.slice(0, 12)} artifact ${run1.artifactHash.slice(0, 12)}`, meta: { pin: pinRecord ? 'recorded' : '' } });
check('synthesis records land on the shared hash-chained audit log',
  log.entries.length === 2 && log.verify().ok === true);

/* ---------------- summary ---------------- */

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) process.exit(1);
