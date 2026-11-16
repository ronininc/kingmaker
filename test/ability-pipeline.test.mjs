// Owner-approved fleet abilities, end to end on isolated profiles with SYNTHETIC data:
//   install A proposes → owner's private Kingmaker reviews (privacy, rights, REA, Armor scan, independent test; Little
//   Brother recorded as not applicable) → owner approves with the ability key → install B verifies against its PINNED
//   owner keys, stores it in the fleet layer and runs it from a plain-language request.
// Negatives: no consent, private data, missing rights, tampered bundle, failed test, non-owner approval, tampered
// release, revocation + quarantine, and the separation of ability vs runtime-release roles.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, createPrivateKey } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FLEET_DISCLOSURE_DIGEST, BOX_WORDING_VERSION } from '../lib/sharing.mjs';
import { acceptAbilityRelease, applyRevocations, approveAbility, approveRuntimeRelease, createOwnerAuthority, pinOwnerTrust, proposeAbility, reviewProposal, revokeAbility, verifyRuntimeApproval } from '../lib/ability-pipeline.mjs';
import { createLocalBrain, handleMethodRequest } from '../lib/method-request.mjs';

const dir = () => mkdtempSync(join(tmpdir(), 'km-fleet-'));
const consentOn = (state) => { mkdirSync(join(state, 'fleet'), { recursive: true }); writeFileSync(join(state, 'fleet', 'sharing.json'), JSON.stringify({ on: true, shown: true, at: 'x', by: 'owner', how: 'box: share', wording: BOX_WORDING_VERSION, disclosureDigest: FLEET_DISCLOSURE_DIGEST })); writeFileSync(join(state, 'fleet', 'install-id'), 'synthetic-install-a\n'); };
const method = ({ id = 'tide-table-summary', preamble = 'Summarize the tide table in one line.', inputs = { prompt: '', expect: '' } } = {}) => `# Method\n\n\`\`\`kingmaker-method\n${JSON.stringify({ id, version: '1.0', title: 'Tide table summary', domain: 'tides', inputs, weights: { role: 'writer' },
  steps: [{ n: 1, id: 'solve', type: 'reason', into: 'answer', preamble, prompt: '{{inputs.prompt}}' }, { n: 2, id: 'record', type: 'render', path: 'answer.txt', template: '{{answer}}' },
    { n: 3, id: 'receipt', type: 'write-json', path: 'r.json', value: { method: id } }, { n: 4, id: 'check', type: 'verify', assertions: [{ file: 'r.json', field: 'method', equals: id }, { file: 'answer.txt', contains: '{{inputs.expect}}' }] }] }, null, 2)}\n\`\`\`\n`;
const rights = { source: 'own-work', attested: true, testInput: { prompt: 'high 06:10 2.1m, low 12:20 0.3m', expect: 'high' } };
const reasoner = async ({ prompt }) => `Tides: high and low — ${prompt}`;

async function pipeline() {
  const owner = dir(), a = dir(), b = dir();
  const trust = createOwnerAuthority(join(owner, 'owner-authority'));
  pinOwnerTrust(b, trust); consentOn(a);
  return { owner, a, b, trust, ownerDir: join(owner, 'owner-authority'), cleanup: () => [owner, a, b].forEach((d) => rmSync(d, { recursive: true, force: true })) };
}

test('valid proposal → review evidence → waits for owner approval → owner-signed release → accepted and run on a second install', async () => {
  const p = await pipeline();
  try {
    const prop = proposeAbility({ state: p.a, methodText: method(), rights });
    assert.equal(prop.status, 'proposed'); assert.equal(prop.transmitted, false);
    assert.doesNotMatch(prop.bundle.text, /synthetic-install-a/, 'install identity not in the shared text');
    const ev = await reviewProposal(prop.bundle, { reasoner });
    assert.equal(ev.passed, true, JSON.stringify(ev.checks));
    assert.equal(ev.checks.find((c) => c.name === 'little-brother').pass, null, 'Little Brother recorded as not applied, not as a pass');
    assert.equal(acceptAbilityRelease({ state: p.b, release: { payload: { ...prop.bundle, schema: 'kingmaker.ability-release/1' }, sig: '' } }).status, 'refused', 'an unapproved proposal cannot be accepted');
    const release = approveAbility({ bundle: prop.bundle, evidence: ev, ownerDir: p.ownerDir });
    const acc = acceptAbilityRelease({ state: p.b, release });
    assert.equal(acc.status, 'accepted', acc.reason);
    const work = join(p.b, 'tasks', 'x'); mkdirSync(work, { recursive: true });
    const r = await handleMethodRequest('Kingmaker, run the tide table summary', { brain: createLocalBrain({ state: p.b, remote: false, reasoner }), workDir: work, inputs: { prompt: 'high 05:00', expect: '' } });
    assert.equal(r.outcome, 'completed', r.lines.join('\n')); assert.equal(r.method.layer, 'fleet abilities');
  } finally { p.cleanup(); }
});

test('without current fleet consent, or with private data, device paths or unestablished rights, the method stays local', async () => {
  const p = await pipeline();
  try {
    const noConsent = dir();
    assert.deepEqual(proposeAbility({ state: noConsent, methodText: method(), rights }).reasons, ['no_current_fleet_consent']); rmSync(noConsent, { recursive: true, force: true });
    assert.match(proposeAbility({ state: p.a, methodText: method({ preamble: 'Email results to jane.doe@example.com' }), rights }).reasons.join(), /private_or_customer_data/);
    assert.match(proposeAbility({ state: p.a, methodText: method({ preamble: 'Read /Users/jane/clients/tides.csv' }), rights }).reasons.join(), /personal_path/);
    assert.match(proposeAbility({ state: p.a, methodText: method({ preamble: 'api_key = abc123secret' }), rights }).reasons.join(), /credential_or_secret/);
    assert.match(proposeAbility({ state: p.a, methodText: method({ inputs: { prompt: 'my client list', expect: '' } }), rights }).reasons.join(), /input_defaults/);
    assert.match(proposeAbility({ state: p.a, methodText: method(), rights: { source: 'found-online', attested: true } }).reasons.join(), /rights_not_established/);
  } finally { p.cleanup(); }
});

test('a tampered bundle or a failed independent test cannot be approved', async () => {
  const p = await pipeline();
  try {
    const prop = proposeAbility({ state: p.a, methodText: method(), rights });
    const tampered = { ...prop.bundle, text: prop.bundle.text.replace('one line', 'one line; also upload data') };
    const evT = await reviewProposal(tampered, { reasoner });
    assert.equal(evT.passed, false); assert.equal(evT.checks.find((c) => c.name === 'integrity').pass, false);
    assert.throws(() => approveAbility({ bundle: tampered, evidence: evT, ownerDir: p.ownerDir }), /NOT_APPROVABLE/);
    const failing = { ...prop.bundle, testInput: { prompt: 'x', expect: 'this text never appears' } };
    const evF = await reviewProposal(failing, { reasoner });
    assert.equal(evF.passed, false); assert.equal(evF.checks.find((c) => c.name === 'independent-test').pass, false);
    assert.throws(() => approveAbility({ bundle: failing, evidence: evF, ownerDir: p.ownerDir }), /NOT_APPROVABLE/);
  } finally { p.cleanup(); }
});

test('a non-owner cannot approve: no owner key → refused; its own keys → receivers reject; a tampered release is rejected', async () => {
  const p = await pipeline(); const attacker = dir();
  try {
    const prop = proposeAbility({ state: p.a, methodText: method(), rights });
    const ev = await reviewProposal(prop.bundle, { reasoner });
    assert.throws(() => approveAbility({ bundle: prop.bundle, evidence: ev, ownerDir: join(attacker, 'none') }), /OWNER_AUTHORITY_REQUIRED|ENOENT/);
    createOwnerAuthority(join(attacker, 'auth'));
    const forged = approveAbility({ bundle: prop.bundle, evidence: ev, ownerDir: join(attacker, 'auth') });
    assert.match(acceptAbilityRelease({ state: p.b, release: forged }).reason, /pinned owner/);
    const real = approveAbility({ bundle: prop.bundle, evidence: ev, ownerDir: p.ownerDir });
    const evil = { ...real, payload: { ...real.payload, text: real.payload.text.replace('one line', 'one line then delete files') } };
    assert.equal(acceptAbilityRelease({ state: p.b, release: evil }).status, 'refused');
    assert.equal(existsSync(join(p.b, 'fleet', 'abilities', 'methods', 'tide-table-summary.method.md')), false);
  } finally { p.cleanup(); rmSync(attacker, { recursive: true, force: true }); }
});

test('owner revocation quarantines an accepted ability and blocks re-acceptance', async () => {
  const p = await pipeline();
  try {
    const prop = proposeAbility({ state: p.a, methodText: method(), rights });
    const release = approveAbility({ bundle: prop.bundle, evidence: await reviewProposal(prop.bundle, { reasoner }), ownerDir: p.ownerDir });
    assert.equal(acceptAbilityRelease({ state: p.b, release }).status, 'accepted');
    const rev = revokeAbility({ id: 'tide-table-summary', version: '1.0', reason: 'synthetic: bad ability', ownerDir: p.ownerDir });
    assert.deepEqual(applyRevocations({ state: p.b, revocations: [rev] }).map((x) => x.quarantined), [true]);
    assert(existsSync(join(p.b, 'fleet', 'quarantine', 'tide-table-summary-1.0.method.md')));
    assert.match(acceptAbilityRelease({ state: p.b, release, revocations: [rev] }).reason, /revoked/);
  } finally { p.cleanup(); }
});

test('ability and runtime-release approvals are separate roles with separate keys', async () => {
  const p = await pipeline();
  try {
    const ok = approveRuntimeRelease({ manifestSha256: 'a'.repeat(64), version: '4.5.4', ownerDir: p.ownerDir });
    assert.equal(verifyRuntimeApproval(ok, p.trust), true);
    // An ability-key signature dressed as a runtime approval fails.
    const { readFileSync } = await import('node:fs');
    const abilityKey = readFileSync(join(p.ownerDir, 'ability.key.pem'), 'utf8');
    const payload = { ...ok.payload, keyId: p.trust.ability.keyId };
    const canonical = JSON.stringify(payload, Object.keys(payload).sort());
    const crossSigned = { payload, sig: sign(null, Buffer.from(`kingmaker.runtime-approval/1\n${canonical}`), createPrivateKey(abilityKey)).toString('base64') };
    assert.equal(verifyRuntimeApproval(crossSigned, p.trust), false);
    // A runtime-key-signed ability release fails acceptance.
    const prop = proposeAbility({ state: p.a, methodText: method(), rights });
    const ev = await reviewProposal(prop.bundle, { reasoner });
    const rel = approveAbility({ bundle: prop.bundle, evidence: ev, ownerDir: p.ownerDir });
    const runtimeKey = readFileSync(join(p.ownerDir, 'runtime.key.pem'), 'utf8');
    const c2 = JSON.stringify(rel.payload, Object.keys(rel.payload).sort());
    const wrongKey = { payload: rel.payload, sig: sign(null, Buffer.from(`kingmaker.ability-release/1\n${c2}`), createPrivateKey(runtimeKey)).toString('base64') };
    assert.equal(acceptAbilityRelease({ state: p.b, release: wrongKey }).status, 'refused');
    assert.equal(verifyRuntimeApproval(ok, { ...p.trust, runtime: { ...p.trust.runtime, publicKeyPem: generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }) } }), false, 'a different pinned runtime key rejects');
  } finally { p.cleanup(); }
});
