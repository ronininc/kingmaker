// The private-OWNER fleet-approval pipeline and the free / paid-corpus boundaries, on isolated temp profiles with
// SYNTHETIC data and TEST-GENERATED keys only (owner Ed25519 role keys, a P-256 test entitlement key). No network:
// global fetch is replaced by a tripwire for the fleet tests; the paid-corpus tests use the real update-host worker
// (update-host/worker.js) behind a loopback server, as test/local-brain-access.test.mjs does.
//   1. user method (user library) → consented contribution package → owner review queue → owner-signed decision →
//      only owner-approved, signature-verified items enter the fleet store; unsigned / tampered / wrong-key / replayed /
//      rolled-back / revoked items are refused with reasons.
//   2. free install keeps its own methods; fleet abilities follow the (owner-pending) policy flag, conservative default;
//      the paid corpus is served only with a valid entitlement and never copied into the user library or fleet store.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FLEET_DISCLOSURE_DIGEST, BOX_WORDING_VERSION } from '../lib/sharing.mjs';
import { acceptAbilityRelease, applyRevocations, createOwnerAuthority, fleetStore, pinOwnerTrust, proposeAbility, revokeAbility } from '../lib/ability-pipeline.mjs';
import { createOwnerReviewQueue, packageContribution, receiveFleetAbility } from '../lib/fleet-review.mjs';
import { fleetPolicy, setFleetPolicy } from '../lib/corpus-guard.mjs';
import { createLocalBrain, handleMethodRequest, abilityStores } from '../lib/method-request.mjs';
import { storeAdd, writeMethod } from '../lib/method-writing.mjs';
import { promoteDraft } from '../lib/method-from-source.mjs';
import { createPaidAccess } from '../lib/paid-access.mjs';
import { makeAddonVerifiers } from '../lib/addon-entitlement.mjs';

const tmp = (p = 'km-fb-') => mkdtempSync(join(tmpdir(), p));
const consentOn = (state) => { mkdirSync(join(state, 'fleet'), { recursive: true }); writeFileSync(join(state, 'fleet', 'sharing.json'), JSON.stringify({ on: true, shown: true, at: 'x', by: 'owner', how: 'box: share', wording: BOX_WORDING_VERSION, disclosureDigest: FLEET_DISCLOSURE_DIGEST })); writeFileSync(join(state, 'fleet', 'install-id'), 'synthetic-install-a\n'); };
const spec = ({ id = 'tide-table-summary', version = '1.0', preamble = 'Summarize the tide table in one line.' } = {}) => ({ id, version, title: 'Tide table summary', domain: 'tides', inputs: { prompt: '', expect: '' }, weights: { role: 'writer' },
  steps: [{ n: 1, id: 'solve', type: 'reason', into: 'answer', preamble, prompt: '{{inputs.prompt}}' }, { n: 2, id: 'record', type: 'render', path: 'answer.txt', template: '{{answer}}' },
    { n: 3, id: 'receipt', type: 'write-json', path: 'r.json', value: { method: id } }, { n: 4, id: 'check', type: 'verify', assertions: [{ file: 'r.json', field: 'method', equals: id }, { file: 'answer.txt', contains: '{{inputs.expect}}' }] }] });
// The user's own file: private notes and provenance paths in the PROSE (stripped by packaging), executable block clean.
const userFile = (s = spec()) => `# Method — ${s.title}\n\nMy notes: built from /Users/jane/clients/harbor/tides.csv; token=synthetic-not-a-secret-123456; call 602-555-0142.\n\n\`\`\`kingmaker-method\n${JSON.stringify(s, null, 2)}\n\`\`\`\n\n## Provenance\nsource: /Users/jane/Desktop/tides.xlsx\n`;
const rights = { source: 'own-work', attested: true, testInput: { prompt: 'high 06:10 2.1m, low 12:20 0.3m', expect: 'high' } };
const reasoner = async ({ prompt }) => `Tides: high and low — ${prompt}`;
const putUserMethod = (state, s = spec()) => storeAdd(abilityStores(state).user, { id: s.id, file: `${s.id}.method.md`, text: userFile(s), title: s.title, domain: s.domain, quality: { tier: 'draft', score: 50, basis: 'synthetic user method' } });

// A P-256 TEST key standing in for the host's entitlement key (generated here; never a production key).
const ent = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const ENT_PUB = ent.publicKey.export({ type: 'spki', format: 'pem' });
const ENT_PRIV = ent.privateKey.export({ type: 'pkcs8', format: 'pem' });
const mint = (claims, key = ent.privateKey) => { const payload = JSON.stringify(claims); return { payload, sig: cryptoSign('sha256', Buffer.from(payload), { key, dsaEncoding: 'der' }).toString('base64'), alg: 'ES256' }; };
const membership = (over = {}, key = ent.privateKey) => mint({ schema: 'ronin.entitlement/1', issuer: 'ronin-update-host', installId: 'i1', deviceSha256: 'd', sku: 'library.methods', grantedAt: '2026-11-16T00:00:00Z', expiresAt: null, order: 'mem_test', ...over }, key);
/** A REAL verifier (lib/paid-access.mjs + lib/addon-entitlement.mjs) pinned to the test key; revocation answered by a stub. */
const memberCheck = (state) => createPaidAccess(state, { verifiers: makeAddonVerifiers({ certKeyPem: ENT_PUB, config: { url: 'http://revocation.invalid', key: 'k' }, cacheDir: join(state, 'entitlements', '.cache'), fetchImpl: async () => ({ ok: true, json: async () => ({ revoked: false }) }) }) });
const writeEnt = (state, e) => { mkdirSync(join(state, 'entitlements'), { recursive: true }); writeFileSync(join(state, 'entitlements', 'library.methods.json'), JSON.stringify(e)); };

function world() {
  const root = tmp();
  const ownerState = join(root, 'owner'), a = join(root, 'a'), b = join(root, 'b'), ownerDir = join(ownerState, 'owner-authority');
  const trust = createOwnerAuthority(ownerDir);
  for (const s of [a, b]) pinOwnerTrust(s, trust);
  consentOn(a);
  const queue = createOwnerReviewQueue({ dir: join(ownerState, 'fleet', 'review-queue'), ownerDir });
  return { root, ownerState, ownerDir, a, b, trust, queue, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
async function approvedRelease(w, s = spec()) {
  await putUserMethod(w.a, s);
  const pkg = packageContribution({ state: w.a, methodId: s.id, consent: true, rights });
  assert.equal(pkg.status, 'packaged', JSON.stringify(pkg.reasons));
  assert.equal(w.queue.enqueue(pkg.bundle).status, 'queued');
  const ev = await w.queue.review(pkg.bundle.sha256, { reasoner }); assert.equal(ev.passed, true, JSON.stringify(ev.checks));
  return w.queue.decide(pkg.bundle.sha256, { decision: 'approve', note: 'synthetic' }).release;
}
// Every fetch throws. The method lane's local model-host probe (loopback Ollama /api/ps) is attempted and blocked like
// everything else; it is the only call tolerated, since it never leaves the Mac and carries no user material.
const LOCAL_PROBE = /^http:\/\/127\.0\.0\.1:11434\/api\/ps$/;
const tripwire = () => { const calls = []; const orig = globalThis.fetch; globalThis.fetch = async (u) => { calls.push(String(u)); throw new Error('network is not allowed in this test'); }; return { calls, offMac: () => calls.filter((u) => !LOCAL_PROBE.test(u)), restore: () => { globalThis.fetch = orig; } }; };
const fleetFiles = (state) => (existsSync(fleetStore(state)) ? readdirSync(fleetStore(state)) : []);

test('end to end: user method → consented package (private prose stripped, provenance + rights) → owner queue → owner-signed approval → verified into the fleet store and run; no network', async () => {
  const w = world(); const net = tripwire();
  try {
    await putUserMethod(w.a);
    // The user runs their OWN method first, free install, no entitlement, no network.
    const work = join(w.a, 'tasks', 'own'); mkdirSync(work, { recursive: true });
    const own = await handleMethodRequest('Kingmaker, run the tide table summary', { brain: createLocalBrain({ state: w.a, remote: false, reasoner }), workDir: work, inputs: { prompt: 'high 05:00', expect: '' } });
    assert.equal(own.outcome, 'completed', own.lines.join('\n')); assert.equal(own.method.layer, 'your abilities');

    // No per-item consent → nothing packaged, nothing in the outbox.
    assert.deepEqual(packageContribution({ state: w.a, methodId: 'tide-table-summary', consent: undefined, rights }).reasons, ['user_consent_required']);
    assert.deepEqual(packageContribution({ state: w.a, methodId: 'tide-table-summary', consent: 'yes', rights }).reasons, ['user_consent_required'], 'only literal true counts');
    assert.equal(existsSync(join(w.a, 'fleet', 'outbox')), false);

    const pkg = packageContribution({ state: w.a, methodId: 'tide-table-summary', consent: true, rights });
    assert.equal(pkg.status, 'packaged'); assert.equal(pkg.transmitted, false);
    for (const leak of [/\/Users\/jane/, /token=/, /602-555-0142/, /synthetic-install-a/, /My notes/]) assert.doesNotMatch(JSON.stringify(pkg.bundle), leak);
    assert.equal(pkg.bundle.provenance.origin, 'user-library'); assert.equal(pkg.bundle.provenance.consent.perItem, true); assert(pkg.bundle.provenance.strippedBytes > 0);
    assert.deepEqual({ source: pkg.bundle.rights.source, attested: pkg.bundle.rights.attested }, { source: 'own-work', attested: true });

    // Owner side: queued, NOT trusted; approval needs evidence and the owner key.
    assert.equal(w.queue.enqueue(pkg.bundle).status, 'queued');
    assert.match(w.queue.enqueue(pkg.bundle).reason, /already in the queue/);
    assert.equal(w.queue.list('pending').length, 1);
    assert.throws(() => w.queue.decide(pkg.bundle.sha256, { decision: 'approve' }), /NOT_REVIEWED/, 'nothing is approved without review');
    assert.deepEqual(fleetFiles(w.b), [], 'queued ≠ trusted: install B has nothing');
    await w.queue.review(pkg.bundle.sha256, { reasoner });
    const { release } = w.queue.decide(pkg.bundle.sha256, { decision: 'approve', note: 'synthetic approval' });
    assert.throws(() => w.queue.decide(pkg.bundle.sha256, { decision: 'approve' }), /DECIDED/, 'one decision per item');
    assert.equal(release.payload.provenance.origin, 'user-library'); assert.match(release.payload.decisionId, /^[0-9a-f-]{36}$/);

    // Receiver: a member (test-key entitlement through the real verifier) accepts and runs it from the fleet layer.
    writeEnt(w.b, membership());
    const acc = await receiveFleetAbility({ state: w.b, release, verifyMembership: () => memberCheck(w.b)('library.methods') });
    assert.equal(acc.status, 'accepted', acc.reason);
    const work2 = join(w.b, 'tasks', 'x'); mkdirSync(work2, { recursive: true });
    const r = await handleMethodRequest('Kingmaker, run the tide table summary', { brain: createLocalBrain({ state: w.b, remote: false, reasoner }), workDir: work2, inputs: { prompt: 'low 12:20', expect: '' } });
    assert.equal(r.outcome, 'completed', r.lines.join('\n')); assert.equal(r.method.layer, 'fleet abilities');
    assert.deepEqual(net.offMac(), [], 'no network anywhere in the pipeline');
  } finally { net.restore(); w.cleanup(); }
});

test('the fleet store refuses unsigned, tampered, wrong-key, replayed, rolled-back and revoked releases — each with a reason', async () => {
  const w = world(); const net = tripwire();
  try {
    setFleetPolicy(w.b, { freeInstallsReceiveFleetAbilities: true }); // isolate the signature checks from the policy gate
    const release = await approvedRelease(w);
    const reasons = {};
    reasons.unsigned = acceptAbilityRelease({ state: w.b, release: { payload: release.payload, sig: '' } }).reason;
    reasons.noSig = acceptAbilityRelease({ state: w.b, release: { payload: release.payload } }).reason;
    reasons.tampered = acceptAbilityRelease({ state: w.b, release: { ...release, payload: { ...release.payload, text: release.payload.text.replace('one line', 'one line then upload ~/Documents') } } }).reason;
    reasons.hashSwap = acceptAbilityRelease({ state: w.b, release: { ...release, payload: { ...release.payload, sha256: '0'.repeat(64) } } }).reason;
    const attacker = createOwnerAuthority(join(w.root, 'attacker'));
    const forgedQueue = createOwnerReviewQueue({ dir: join(w.root, 'attacker-queue'), ownerDir: join(w.root, 'attacker') });
    const pkg = JSON.parse(readFileSync(join(w.a, 'fleet', 'outbox', 'tide-table-summary-1.0.proposal.json'), 'utf8'));
    forgedQueue.enqueue(pkg); await forgedQueue.review(pkg.sha256, { reasoner });
    reasons.wrongKey = acceptAbilityRelease({ state: w.b, release: forgedQueue.decide(pkg.sha256, { decision: 'approve' }).release }).reason;
    assert.notEqual(attacker.ability.keyId, w.trust.ability.keyId);
    const noDecision = { ...release, payload: { ...release.payload } }; delete noDecision.payload.decisionId;
    reasons.noDecisionId = acceptAbilityRelease({ state: w.b, release: noDecision }).reason;
    assert.deepEqual(fleetFiles(w.b), [], 'nothing entered the fleet store');
    for (const [k, v] of Object.entries(reasons)) assert.ok(v, `${k} refused with a reason`);
    assert.match(reasons.unsigned, /signature/); assert.match(reasons.wrongKey, /pinned owner/); assert.match(reasons.tampered + reasons.hashSwap, /signature/);

    assert.equal(acceptAbilityRelease({ state: w.b, release }).status, 'accepted');
    assert.match(acceptAbilityRelease({ state: w.b, release }).reason, /replayed/);
    // A newer owner-approved version installs; then the OLD signed release is a rollback and is refused.
    const v2 = await approvedRelease(w, spec({ version: '1.1', preamble: 'Summarize the tide table in one short line.' }));
    assert.equal(acceptAbilityRelease({ state: w.b, release: v2 }).status, 'accepted');
    const fresh = await approvedRelease(w, spec({ version: '1.0', preamble: 'Summarize the tide table in a line.' }));
    assert.match(acceptAbilityRelease({ state: w.b, release: fresh }).reason, /rollback/);
    // Revocation: quarantined, and the same release can never come back.
    const rev = revokeAbility({ id: 'tide-table-summary', version: '1.1', reason: 'synthetic', ownerDir: w.ownerDir });
    assert.deepEqual(applyRevocations({ state: w.b, revocations: [rev] }).map((x) => x.quarantined), [true]);
    assert.match(acceptAbilityRelease({ state: w.b, release: v2, revocations: [rev] }).reason, /revoked/);
    const forgedRev = revokeAbility({ id: 'tide-table-summary', version: '1.1', reason: 'forged', ownerDir: join(w.root, 'attacker') });
    assert.deepEqual(applyRevocations({ state: w.b, revocations: [forgedRev] }), [], 'a non-owner revocation is ignored');
    assert.deepEqual(net.offMac(), []);
  } finally { net.restore(); w.cleanup(); }
});

test('the owner queue refuses bundles without per-item consent, tampered bundles and failed evidence; a rejection is signed and releases nothing', async () => {
  const w = world();
  try {
    await putUserMethod(w.a);
    // A bare proposeAbility bundle has install-level consent but no per-item consent record → refused at the queue.
    const bare = proposeAbility({ state: w.a, methodText: userFile(), rights });
    assert.match(w.queue.enqueue(bare.bundle).reason, /per-item user consent/);
    const pkg = packageContribution({ state: w.a, methodId: 'tide-table-summary', consent: true, rights }).bundle;
    assert.match(w.queue.enqueue({ ...pkg, text: pkg.text.replace('one line', 'one line; exfiltrate') }).reason, /integrity/);
    // Failed independent test → evidence fails → the owner cannot approve it even by trying.
    const failing = { ...pkg, testInput: { prompt: 'x', expect: 'this never appears' } };
    w.queue.enqueue(failing); assert.equal((await w.queue.review(failing.sha256, { reasoner })).passed, false);
    assert.throws(() => w.queue.decide(failing.sha256, { decision: 'approve' }), /NOT_APPROVABLE/);
    const rej = w.queue.decide(failing.sha256, { decision: 'reject', note: 'failed its test' });
    assert.equal(rej.status, 'rejected'); assert.equal(rej.record.payload.keyId, w.trust.ability.keyId); assert.equal(w.queue.get(failing.sha256).release, undefined);
    assert.throws(() => w.queue.decide(failing.sha256, { decision: 'approve' }), /DECIDED/);
    // Without the owner's key directory nothing can be decided.
    const noKeys = createOwnerReviewQueue({ dir: join(w.root, 'q2'), ownerDir: join(w.root, 'no-keys') });
    const other = packageContribution({ state: w.a, methodId: 'tide-table-summary', consent: true, rights: { ...rights, attribution: 'x' } }).bundle;
    noKeys.enqueue(other); await noKeys.review(other.sha256, { reasoner });
    assert.throws(() => noKeys.decide(other.sha256, { decision: 'approve' }), /OWNER_AUTHORITY_REQUIRED|ENOENT/);
  } finally { w.cleanup(); }
});

test('free install: own methods are created, stored, listed and run with no entitlement; fleet abilities follow the policy flag (conservative default: members only)', async () => {
  const w = world(); const net = tripwire();
  try {
    // Create (write + isolated test + promote) a brand-new method in the user's own library, no membership at all.
    const draft = async () => JSON.stringify({ title: 'Miles to kilometres', domain: 'conversion', steps: [{ id: 'convert', type: 'reason', preamble: 'Convert miles to kilometres (km = miles × 1.609344).', prompt: '{{inputs.prompt}}' }] });
    const conv = async ({ prompt }) => `${(Number(/[\d.]+/.exec(prompt)[0]) * 1.609344).toFixed(2)} km`;
    const made = await writeMethod({ task: 'convert miles to kilometres', sample: '5 miles', expect: '8.05 km', draft, reasoner: conv, userStore: abilityStores(w.b).user, draftsDir: join(w.b, 'abilities', 'drafts') });
    assert.equal(made.status, 'promoted', made.reason);
    const listed = JSON.parse(readFileSync(join(abilityStores(w.b).user, 'index.json'), 'utf8')).methods.map((m) => m.id);
    assert.deepEqual(listed, ['my-convert-miles-to-kilometres']);
    const work = join(w.b, 'tasks', 'conv'); mkdirSync(work, { recursive: true });
    const ran = await handleMethodRequest('Kingmaker, convert 12 miles to kilometres', { brain: createLocalBrain({ state: w.b, remote: false, reasoner: conv }), workDir: work, inputs: { prompt: '12 miles', expect: '' } });
    assert.equal(ran.outcome, 'completed', ran.lines.join('\n')); assert.equal(ran.method.layer, 'your abilities');
    assert.equal(existsSync(join(w.b, 'fleet', 'outbox')), false, 'a user method is never packaged, let alone uploaded, without consent');

    // Fleet abilities on a free install: the policy is an OWNER DECISION; the default is conservative.
    assert.equal(fleetPolicy(w.b).freeInstallsReceiveFleetAbilities, false); assert.match(fleetPolicy(w.b).source, /owner decision pending/);
    const release = await approvedRelease(w);
    const free = await receiveFleetAbility({ state: w.b, release, verifyMembership: () => memberCheck(w.b)('library.methods') });
    assert.equal(free.status, 'refused'); assert.match(free.reason, /verified members under the current policy/);
    // A forged (wrong-key) or expired entitlement is not membership.
    writeEnt(w.b, membership({}, generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey));
    assert.equal((await receiveFleetAbility({ state: w.b, release, verifyMembership: () => memberCheck(w.b)('library.methods') })).status, 'refused');
    writeEnt(w.b, membership({ expiresAt: '2026-01-01T00:00:00Z' }));
    assert.equal((await receiveFleetAbility({ state: w.b, release, verifyMembership: () => memberCheck(w.b)('library.methods') })).status, 'refused');
    assert.equal(acceptAbilityRelease({ state: w.b, release, membership: { ok: false } }).status, 'refused');
    // The owner flips the flag → the same free install receives owner-approved abilities (still signature-verified).
    setFleetPolicy(w.b, { freeInstallsReceiveFleetAbilities: true });
    assert.equal((await receiveFleetAbility({ state: w.b, release })).status, 'accepted');
    assert.deepEqual(net.offMac(), []);
  } finally { net.restore(); w.cleanup(); }
});

// ── paid corpus at the real distribution boundary ─────────────────────────────────────────────────────────────────────
const workerSrc = readFileSync(new URL('../update-host/worker.js', import.meta.url), 'utf8');
const worker = (await import('data:text/javascript;base64,' + Buffer.from(workerSrc).toString('base64'))).default;
const CORPUS_SPEC = { id: 'sail-race-pilot', version: '1.0', title: 'Sail race pilot', domain: 'sailing', inputs: { prompt: '' }, weights: { role: 'writer' },
  steps: [{ n: 1, id: 'helm', type: 'reason', into: 'answer', preamble: 'Pick helm and sheet.', prompt: '{{inputs.prompt}}' },
    { n: 2, id: 'record', type: 'write-json', path: 'result.json', value: { method: 'sail-race-pilot', answer: '{{answer}}' } }, { n: 3, id: 'check', type: 'verify', assertions: [{ file: 'result.json', field: 'method', equals: 'sail-race-pilot' }] }] };
const CORPUS = Buffer.from(`# Method — Sail race pilot (curated)\n\n\`\`\`kingmaker-method\n${JSON.stringify(CORPUS_SPEC, null, 2)}\n\`\`\`\n`);
const R2 = { 'library/methods/index.json': Buffer.from(JSON.stringify({ schema: 'kingmaker.methods/1', methods: [{ id: 'sail-race-pilot', title: 'Sail race pilot', domain: 'sailing', file: 'sail-race-pilot.method.md', size: CORPUS.length, sha256: createHash('sha256').update(CORPUS).digest('hex'), quality: { tier: 'vetted', score: 90, basis: 'synthetic curated fixture' } }] })), 'library/methods/sail-race-pilot.method.md': CORPUS };
async function updateHost() {
  const hits = [];
  const env = { CERT_SIGNING_KEY: ENT_PRIV, UPDATE_KEYS: 'op', DEVICES: { get: async () => null, put: async () => {} }, RELEASES: { get: async (k) => (R2[k] ? { size: R2[k].length, httpEtag: '"x"', writeHttpMetadata() {}, body: R2[k] } : null) } };
  const server = http.createServer(async (req, res) => {
    const r = await worker.fetch(new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers: req.headers }), env);
    hits.push({ path: req.url, status: r.status }); res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}/library`, hits, close: () => new Promise((r) => server.close(r)) };
}
const stub = async ({ preamble, prompt }) => `${preamble.split('.')[0]} → ${prompt}`;

test('paid corpus: refused without a valid entitlement at the host; served with a test-key entitlement into the curated cache ONLY', async () => {
  const host = await updateHost(); const s = tmp();
  try {
    const mk = (n) => { const d = join(s, 'tasks', n); mkdirSync(d, { recursive: true }); return d; };
    const none = await handleMethodRequest('run the sail race pilot', { brain: createLocalBrain({ state: s, remote: { baseUrl: host.url, intelligencePath: '' }, reasoner: stub }), workDir: mk('a') });
    assert.equal(none.hunt.status, 'not-entitled'); assert.deepEqual(host.hits, [], 'no entitlement → not contacted');
    for (const bad of [membership({}, generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey), membership({ sku: 'scripture-armor' }), membership({ expiresAt: '2026-01-01T00:00:00Z' })]) {
      const r = await handleMethodRequest('run the sail race pilot', { brain: createLocalBrain({ state: s, remote: { baseUrl: host.url, intelligencePath: '' }, reasoner: stub, entitlement: bad }), workDir: mk(`bad-${host.hits.length}`) });
      assert.equal(r.hunt.status, 'not-entitled');
    }
    assert.deepEqual(host.hits.map((h) => h.status), [401, 401, 401], 'wrong key, wrong sku, expired: the host refuses');
    assert.equal(existsSync(join(s, 'brain-library', 'methods', 'sail-race-pilot.method.md')), false);

    writeEnt(s, membership());
    const ok = await handleMethodRequest('Kingmaker, run the sail race pilot', { brain: createLocalBrain({ state: s, remote: { baseUrl: host.url, intelligencePath: '' }, reasoner: stub }), workDir: mk('ok'), inputs: { prompt: 'wind 040' } });
    assert.equal(ok.outcome, 'completed', ok.lines.join('\n')); assert.equal(ok.method.layer, 'curated library');
    const st = abilityStores(s);
    assert(existsSync(join(st.library, 'sail-race-pilot.method.md')));
    assert.equal(existsSync(join(st.user, 'sail-race-pilot.method.md')), false, 'never copied into the user library');
    assert.equal(existsSync(join(st.fleet, 'sail-race-pilot.method.md')), false, 'never copied into the fleet store');
  } finally { await host.close(); rmSync(s, { recursive: true, force: true }); }
});

test('paid corpus items cannot be laundered into the user library, a contribution, the owner queue or the fleet store', async () => {
  const w = world();
  try {
    // Install A (a member) has the curated item in its cache; install B too; the owner has the corpus source.
    for (const st of [w.a, w.b]) await storeAdd(abilityStores(st).library, { id: 'sail-race-pilot', file: 'sail-race-pilot.method.md', text: CORPUS.toString(), title: 'Sail race pilot', domain: 'sailing', quality: { tier: 'vetted', score: 90, basis: 'curated' } });
    const ownerCorpus = join(w.ownerState, 'corpus'); await storeAdd(ownerCorpus, { id: 'sail-race-pilot', file: 'sail-race-pilot.method.md', text: CORPUS.toString(), title: 'Sail race pilot', domain: 'sailing', quality: { tier: 'vetted', score: 90, basis: 'curated' } });
    const text = CORPUS.toString();
    const renamed = text.replace('"id": "sail-race-pilot"', '"id": "my-sailing-helper"'); // same steps, new id
    assert.notEqual(renamed, text);
    // user library door
    await assert.rejects(promoteDraft({ state: w.a, text, checks: [{ set: 'heldout', passed: 1, total: 1 }] }), /paid_corpus_item/);
    await assert.rejects(promoteDraft({ state: w.a, text: renamed, checks: [{ set: 'heldout', passed: 1, total: 1 }] }), /paid_corpus_item: its executable steps/);
    assert.equal(existsSync(join(abilityStores(w.a).user, 'index.json')), false);
    // contribution door (even when the user claims own work, and even if they hand-copied it into their library)
    assert.match(proposeAbility({ state: w.a, methodText: text, rights }).reasons.join(), /paid_corpus_item/);
    await storeAdd(abilityStores(w.a).user, { id: 'sail-race-pilot', file: 'sail-race-pilot.method.md', text, title: 'x', domain: 'sailing', quality: { tier: 'draft', score: 1, basis: 'hand copy' } });
    assert.deepEqual(packageContribution({ state: w.a, methodId: 'sail-race-pilot', consent: true, rights }).reasons, ['paid_corpus_item']);
    // owner queue door (a bundle crafted elsewhere, renamed id, same steps)
    const crafted = { ...packageContribution({ state: (consentOn(w.b), w.b), methodId: 'nope', consent: true, rights }) };
    assert.deepEqual(crafted.reasons, ['not_in_user_library']);
    const q = createOwnerReviewQueue({ dir: join(w.ownerState, 'q-corpus'), ownerDir: w.ownerDir, corpusStores: [ownerCorpus] });
    const sha = (x) => createHash('sha256').update(x).digest('hex');
    const forged = { schema: 'kingmaker.ability-proposal/1', id: 'my-sailing-helper', version: '1.0', text: renamed, sha256: sha(renamed), rights, consentDigest: FLEET_DISCLOSURE_DIGEST, provenance: { consent: { perItem: true } } };
    assert.match(q.enqueue(forged).reason, /paid_corpus_item/);
    // fleet store door (even an owner-signed release of corpus steps is refused where the corpus is cached)
    setFleetPolicy(w.b, { freeInstallsReceiveFleetAbilities: true });
    const { approveAbility } = await import('../lib/ability-pipeline.mjs');
    const rel = approveAbility({ bundle: forged, evidence: { passed: true, sha256: forged.sha256, digest: 'x' }, ownerDir: w.ownerDir });
    assert.match(acceptAbilityRelease({ state: w.b, release: rel }).reason, /paid_corpus_item/);
    assert.deepEqual(fleetFiles(w.b), []);
  } finally { w.cleanup(); }
});
