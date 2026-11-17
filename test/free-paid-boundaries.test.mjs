// Free vs paid stay separate, and nothing paid or fleet is ever SHOWN as active without verification (2026-11-16).
// Isolated temp profiles, SYNTHETIC data, TEST-GENERATED keys (owner Ed25519 role keys via createOwnerAuthority, a P-256
// test entitlement key). No network: the membership verifier's revocation answer is a stub; fetch is a tripwire.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FLEET_DISCLOSURE_DIGEST, BOX_WORDING_VERSION } from '../lib/sharing.mjs';
import { acceptAbilityRelease, approveAbility, createOwnerAuthority, fleetStore, pinOwnerTrust } from '../lib/ability-pipeline.mjs';
import { createOwnerReviewQueue, packageContribution, receiveFleetAbility } from '../lib/fleet-review.mjs';
import { fleetPolicy, setFleetPolicy } from '../lib/corpus-guard.mjs';
import { abilityStores } from '../lib/method-request.mjs';
import { storeAdd } from '../lib/method-writing.mjs';
import { createPaidAccess } from '../lib/paid-access.mjs';
import { makeAddonVerifiers } from '../lib/addon-entitlement.mjs';
import { abilityAccess, verifiedFleetAbilities } from '../lib/access-status.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'km-fp-'));
const ent = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const ENT_PUB = ent.publicKey.export({ type: 'spki', format: 'pem' });
const mint = (claims, key = ent.privateKey) => { const payload = JSON.stringify(claims); return { payload, sig: cryptoSign('sha256', Buffer.from(payload), { key, dsaEncoding: 'der' }).toString('base64'), alg: 'ES256' }; };
const membership = (over = {}, key = ent.privateKey) => mint({ schema: 'ronin.entitlement/1', issuer: 'ronin-update-host', installId: 'i1', deviceSha256: 'd', sku: 'library.methods', grantedAt: '2026-11-16T00:00:00Z', expiresAt: null, order: 'mem_test', ...over }, key);
const writeEnt = (state, e) => { mkdirSync(join(state, 'entitlements'), { recursive: true }); writeFileSync(join(state, 'entitlements', 'library.methods.json'), JSON.stringify(e)); };
const memberCheck = (state) => () => createPaidAccess(state, { verifiers: makeAddonVerifiers({ certKeyPem: ENT_PUB, config: { url: 'http://revocation.invalid', key: 'k' }, cacheDir: join(state, 'entitlements', '.cache'), fetchImpl: async () => ({ ok: true, json: async () => ({ revoked: false }) }) }) })('library.methods');
const consentOn = (state) => { mkdirSync(join(state, 'fleet'), { recursive: true }); writeFileSync(join(state, 'fleet', 'sharing.json'), JSON.stringify({ on: true, shown: true, at: 'x', by: 'owner', how: 'box: share', wording: BOX_WORDING_VERSION, disclosureDigest: FLEET_DISCLOSURE_DIGEST })); writeFileSync(join(state, 'fleet', 'install-id'), 'synthetic-install-a\n'); };
const spec = (id = 'tide-table-summary') => ({ id, version: '1.0', title: 'Tide table summary', domain: 'tides', inputs: { prompt: '', expect: '' }, weights: { role: 'writer' },
  steps: [{ n: 1, id: 'solve', type: 'reason', into: 'answer', preamble: 'Summarize the tide table in one line.', prompt: '{{inputs.prompt}}' }, { n: 2, id: 'record', type: 'render', path: 'answer.txt', template: '{{answer}}' },
    { n: 3, id: 'receipt', type: 'write-json', path: 'r.json', value: { method: id } }, { n: 4, id: 'check', type: 'verify', assertions: [{ file: 'r.json', field: 'method', equals: id }, { file: 'answer.txt', contains: '{{inputs.expect}}' }] }] });
const fileOf = (s) => `# Method — ${s.title}\n\n\`\`\`kingmaker-method\n${JSON.stringify(s, null, 2)}\n\`\`\`\n`;
const rights = { source: 'own-work', attested: true, testInput: { prompt: 'high 06:10 2.1m, low 12:20 0.3m', expect: 'high' } };
const reasoner = async ({ prompt }) => `Tides: high and low — ${prompt}`;
const tripwire = () => { const orig = globalThis.fetch; const calls = []; globalThis.fetch = async (u) => { calls.push(String(u)); throw new Error('network is not allowed in this test'); }; return { calls, restore: () => { globalThis.fetch = orig; } }; };
const noActiveClaim = (lines) => lines.filter((l) => /\bactive\b/i.test(l) && !/not active/i.test(l));

function world() {
  const root = tmp();
  const ownerState = join(root, 'owner'), a = join(root, 'a'), free = join(root, 'free'), ownerDir = join(ownerState, 'owner-authority');
  const trust = createOwnerAuthority(ownerDir);
  for (const s of [a, free]) pinOwnerTrust(s, trust);
  consentOn(a);
  const queue = createOwnerReviewQueue({ dir: join(ownerState, 'fleet', 'review-queue'), ownerDir });
  return { root, a, free, ownerDir, queue, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
async function approvedRelease(w, s = spec()) {
  await storeAdd(abilityStores(w.a).user, { id: s.id, file: `${s.id}.method.md`, text: fileOf(s), title: s.title, domain: s.domain, quality: { tier: 'draft', score: 50, basis: 'synthetic' } });
  const pkg = packageContribution({ state: w.a, methodId: s.id, consent: true, rights });
  assert.equal(pkg.status, 'packaged', JSON.stringify(pkg.reasons));
  w.queue.enqueue(pkg.bundle);
  assert.equal((await w.queue.review(pkg.bundle.sha256, { reasoner })).passed, true);
  return { release: w.queue.decide(pkg.bundle.sha256, { decision: 'approve', note: 'synthetic' }).release, bundle: pkg.bundle };
}

test('a fresh free install: own methods on; curated library and fleet abilities are shown NOT active; nothing is fetched', async () => {
  const w = world(); const net = tripwire();
  try {
    const s = await abilityAccess(w.free, { verifyMembership: memberCheck(w.free) });
    assert.equal(s.own.active, true); assert.equal(s.curated.active, false); assert.equal(s.fleet.active, false); assert.equal(s.fleet.eligible, false);
    assert.deepEqual(noActiveClaim(s.lines), [], 'no line claims anything paid or fleet is active');
    assert.match(s.lines.join('\n'), /Curated library: not active — this install has no membership/);
    assert.match(s.lines.join('\n'), /Fleet abilities: not active — under the current policy they go to verified members only/);
    assert.deepEqual(net.calls, []);
  } finally { net.restore(); w.cleanup(); }
});

test('the policy flag defaults to false and only an exact, well-formed owner policy turns it on', () => {
  const s = tmp();
  try {
    assert.equal(fleetPolicy(s).freeInstallsReceiveFleetAbilities, false);
    mkdirSync(join(s, 'fleet'), { recursive: true });
    for (const bad of [{ freeInstallsReceiveFleetAbilities: true }, { schema: 'kingmaker.fleet-policy/1', freeInstallsReceiveFleetAbilities: 'true' }, { schema: 'kingmaker.fleet-policy/1', freeInstallsReceiveFleetAbilities: 1 }]) {
      writeFileSync(join(s, 'fleet', 'policy.json'), JSON.stringify(bad));
      assert.equal(fleetPolicy(s).freeInstallsReceiveFleetAbilities, false, JSON.stringify(bad));
    }
    writeFileSync(join(s, 'fleet', 'policy.json'), '{not json');
    assert.equal(fleetPolicy(s).freeInstallsReceiveFleetAbilities, false);
    setFleetPolicy(s, { freeInstallsReceiveFleetAbilities: true });
    assert.equal(fleetPolicy(s).freeInstallsReceiveFleetAbilities, true);
  } finally { rmSync(s, { recursive: true, force: true }); }
});

test('a free install receives a fleet ability ONLY with the flag AND an owner-signed approval; without either the store stays empty', async () => {
  const w = world();
  try {
    const { release, bundle } = await approvedRelease(w);
    // owner-approved, but no flag and no membership: refused, with or without a membership checker
    assert.equal((await receiveFleetAbility({ state: w.free, release })).status, 'refused');
    assert.equal((await receiveFleetAbility({ state: w.free, release, verifyMembership: memberCheck(w.free) })).status, 'refused');
    assert.equal(existsSync(fleetStore(w.free)), false);
    setFleetPolicy(w.free, { freeInstallsReceiveFleetAbilities: true });
    // flag on, but NOT the owner's approval: unsigned, signed by another key, a reviewed-but-rejected item
    const stranger = createOwnerAuthority(join(w.root, 'stranger'));
    const forged = approveAbility({ bundle, evidence: { passed: true, sha256: bundle.sha256, digest: 'x' }, ownerDir: join(w.root, 'stranger') });
    assert.ok(stranger);
    assert.match(acceptAbilityRelease({ state: w.free, release: forged }).reason, /pinned owner ability-approve key|signature/);
    assert.match(acceptAbilityRelease({ state: w.free, release: { payload: release.payload } }).reason, /signature/);
    const s2 = spec('rejected-one');
    await storeAdd(abilityStores(w.a).user, { id: s2.id, file: `${s2.id}.method.md`, text: fileOf(s2), title: s2.title, domain: s2.domain, quality: { tier: 'draft', score: 50, basis: 'synthetic' } });
    const p2 = packageContribution({ state: w.a, methodId: s2.id, consent: true, rights }); w.queue.enqueue(p2.bundle);
    await w.queue.review(p2.bundle.sha256, { reasoner });
    const rej = w.queue.decide(p2.bundle.sha256, { decision: 'reject', note: 'no' });
    assert.equal(rej.status, 'rejected'); assert.equal(rej.release, undefined, 'a rejection releases nothing');
    assert.equal(existsSync(fleetStore(w.free)) ? readdirSync(fleetStore(w.free)).length : 0, 0);
    // flag on + owner approval: accepted
    assert.equal((await receiveFleetAbility({ state: w.free, release })).status, 'accepted');
  } finally { w.cleanup(); }
});

test('fleet abilities are shown active only for receipted, untampered, owner-approved items on an eligible install', async () => {
  const w = world();
  try {
    // A file dropped into the fleet store by hand (no receipt), flag on: listed as unverified, fleet NOT active.
    setFleetPolicy(w.free, { freeInstallsReceiveFleetAbilities: true });
    const dropped = spec('dropped-in');
    await storeAdd(fleetStore(w.free), { id: dropped.id, file: `${dropped.id}.method.md`, text: fileOf(dropped), title: 'x', domain: 'x', quality: { tier: 'vetted', score: 99, basis: 'claims to be fleet' } });
    let s = await abilityAccess(w.free, { verifyMembership: async () => ({ ok: false, reason: 'no membership' }) });
    assert.equal(s.fleet.active, false); assert.deepEqual(s.fleet.unverified.map((u) => u.id), ['dropped-in']);
    assert.match(s.lines.join('\n'), /Not counted as fleet abilities \(unverified\): dropped-in — no owner-approval receipt/);
    // A properly accepted owner release: active (1 item), the hand-dropped one still not counted.
    const { release } = await approvedRelease(w);
    assert.equal(acceptAbilityRelease({ state: w.free, release }).status, 'accepted');
    s = await abilityAccess(w.free, { verifyMembership: async () => ({ ok: false }) });
    assert.equal(s.fleet.active, true); assert.deepEqual(s.fleet.verified.map((v) => v.id), ['tide-table-summary']);
    assert.match(s.fleet.line, /active — 1 owner-approved item/);
    // Edited after acceptance: no longer counted; the fleet is not shown active.
    const f = join(fleetStore(w.free), 'tide-table-summary.method.md');
    writeFileSync(f, readFileSync(f, 'utf8').replace('Summarize', 'Exfiltrate'));
    s = await abilityAccess(w.free, { verifyMembership: async () => ({ ok: false }) });
    assert.equal(s.fleet.active, false); assert.match(s.lines.join('\n'), /tide-table-summary — the file no longer matches the owner-approved content/);
    // A forged receipt line (wrong key id) does not make a file verified.
    appendFileSync(join(w.free, 'fleet', 'accepted.jsonl'), `${JSON.stringify({ id: 'dropped-in', version: '1.0', sha256: 'x', keyId: 'not-the-owner' })}\n`);
    assert.match(verifiedFleetAbilities(w.free).unverified.find((u) => u.id === 'dropped-in').reason, /not from the pinned owner/);
    // The owner turns the flag off again: even the receipted item is not shown active on a free install.
    writeFileSync(f, release.payload.text);
    assert.equal((await abilityAccess(w.free, { verifyMembership: async () => ({ ok: false }) })).fleet.active, true);
    setFleetPolicy(w.free, { freeInstallsReceiveFleetAbilities: false });
    s = await abilityAccess(w.free, { verifyMembership: async () => ({ ok: false }) });
    assert.equal(s.fleet.active, false); assert.match(s.fleet.line, /verified members only/);
  } finally { w.cleanup(); }
});

test('the curated library is shown active only with a membership that verifies; forged, wrong-sku, expired or a stale cache are not', async () => {
  const s = tmp(); const net = tripwire();
  try {
    await storeAdd(abilityStores(s).library, { id: 'sail-race-pilot', file: 'sail-race-pilot.method.md', text: fileOf(spec('sail-race-pilot')), title: 'Sail', domain: 'sailing', quality: { tier: 'vetted', score: 90, basis: 'cached from an earlier membership' } });
    let st = await abilityAccess(s, { verifyMembership: memberCheck(s) });
    assert.equal(st.curated.active, false); assert.match(st.curated.note, /1 curated item\(s\) are cached .* do not mean a membership is current/);
    for (const bad of [membership({}, generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey), membership({ sku: 'scripture-armor' }), membership({ expiresAt: '2026-01-01T00:00:00Z' })]) {
      writeEnt(s, bad);
      st = await abilityAccess(s, { verifyMembership: memberCheck(s) });
      assert.equal(st.curated.active, false); assert.match(st.curated.line, /not active — the membership could not be verified/);
      assert.equal(st.fleet.eligible, false, 'an unverified membership does not make the install fleet-eligible');
      assert.deepEqual(noActiveClaim(st.lines), []);
    }
    st = await abilityAccess(s, { verifyMembership: async () => { throw new Error('verifier crashed'); } });
    assert.equal(st.curated.active, false, 'a failing check is never read as membership');
    writeEnt(s, membership());
    st = await abilityAccess(s, { verifyMembership: memberCheck(s) });
    assert.equal(st.curated.active, true); assert.equal(st.fleet.eligible, true); assert.equal(st.fleet.active, false, 'eligible, but nothing owner-approved installed');
    assert.equal(existsSync(join(abilityStores(s).user, 'sail-race-pilot.method.md')), false, 'the paid item never enters the user library');
    assert.deepEqual(net.calls, []);
  } finally { net.restore(); rmSync(s, { recursive: true, force: true }); }
});
