import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSignedAppDestination, DESTINATION_MANIFEST_SCHEMA as V2, DESTINATION_POLICY_SCHEMA as POLICY } from '../lib/release-macos-destination.mjs';
import { MANIFEST_SCHEMA as V1, manifestProblems } from '../lib/release-manifest.mjs';
const version = '4.5.3', id = 'com.ronininc.solghost', team = 'ABCDEFGHIJ';
const apple = { lane: 'developer-id', expectedVersion: version, expectedTeam: team };
const legacy = { lane: 'legacy', expectedVersion: version, legacyLeaf: 'a'.repeat(40) };
const sha = 'b'.repeat(64), commit = 'c'.repeat(40), dockCommit = 'd'.repeat(40), repo = 'ronininc/Kingmaker', dockRepo = 'ronininc/ronin-launcher';
const signature = 'simulated-detached-signature';
function fixture({schema = V2, change = () => {}} = {}) {
  const m = {
    schema, product: 'Kingmaker', version, tag: 'v' + version, repo,
    app: { name: 'Kingmaker.app', bundleId: id, version, sha256: sha, size: 12 },
    engine: { sha256: sha },
    parts: [{ name: 'Kingmaker-' + version + '.tar.gz.part01', sha256: sha, size: 12 }],
    launcher: { name: 'Ronin Launcher.app', archive: 'Ronin-Launcher-0.3.19-arm64.zip', format: 'zip', required: true,
      sha256: sha, size: 5, sourceRepo: dockRepo, sourceCommit: dockCommit, version: '0.3.19' },
    issuance: { tree: { repo, commit, version }, installer: { repo, commit, version },
      launcher: { repo: dockRepo, commit: dockCommit, version: '0.3.19' } },
    ...(schema === V2 ? { destinationSigning: { schema: POLICY, lane: 'developer-id', teamId: team, bundleId: id, version } } : {}),
  };
  change(m);
  const bytes = Buffer.from(JSON.stringify(m));
  let calls = 0;
  const verify = (input, sig) => { calls++; return bytes.equals(input) && sig === signature; };
  return { m, bytes, verify, calls: () => calls };
}
function parse(f, expected = apple, sig = signature) { return parseSignedAppDestination(f.bytes, sig, expected, { verify: f.verify }); }

test('V2 validates the independently selected policy and is refused by the unchanged V1 manifest validator', () => {
  const f = fixture();
  assert.match(manifestProblems(f.m).join(' '), /schema is kingmaker\.release\/2, not kingmaker\.release\/1/);
  const got = parse(f);
  assert.equal(got.lane, 'developer-id');
  assert.match(got.requirement, /identifier "com\.ronininc\.solghost" and anchor apple generic/);
  assert.match(got.requirement, /subject\.OU\] = "ABCDEFGHIJ"/);
  assert.equal(f.calls(), 1);
});

test('no policy reads from unverified bytes, missing signature, changed bytes or incorrect signature', () => {
  const f = fixture();
  assert.throws(() => parse(f, apple, ''), /valid signature/);
  assert.equal(f.calls(), 0);
  assert.throws(() => parse(f, apple, 'wrong'), /valid signature/);
  assert.throws(() => parseSignedAppDestination(Buffer.concat([f.bytes, Buffer.from(' ')]), signature, apple, { verify: f.verify }), /valid signature/);
  assert.throws(() => parseSignedAppDestination(Buffer.from('malformed JSON'), signature, apple, { verify: () => false }), /valid signature/);
});

test('wrong version, destination bundle, Team and arbitrary fallback stay rejected even when authenticated', () => {
  for (const change of [
    m => { m.destinationSigning.teamId = 'ZZZZZZZZZZ'; },
    m => { m.destinationSigning.bundleId = 'com.other.app'; },
    m => { m.destinationSigning.version = '4.5.2'; },
    m => { m.destinationSigning.lane = 'legacy'; },
    m => { m.destinationSigning.fallback = { lane: 'legacy' }; },
    m => { m.destinationSigning.requirement = 'always'; },
    m => { delete m.destinationSigning; },
    m => { m.app.bundleId = 'com.other.app'; },
    m => { m.app.version = '4.5.2'; },
    m => { m.tag = 'v4.5.2'; },
    m => { m.engine.sha256 = 'unbound'; },
    m => { m.parts[0].sha256 = 'unbound'; },
    m => { m.issuance.launcher.commit = commit; },
    m => { delete m.issuance; },
  ]) assert.throws(() => parse(fixture({ change })));
  assert.throws(() => parse(fixture(), { ...apple, expectedTeam: 'ZZZZZZZZZZ' }), /Apple Team/);
  assert.throws(() => parse(fixture(), { ...apple, expectedVersion: '4.5.4' }), /exact selected/);
});

test('genuine legacy shape remains usable only by explicit legacy selection; no downgrade or policy smuggling', () => {
  const f = fixture({ schema: V1 });
  assert.deepEqual(manifestProblems(f.m), []);
  assert.match(parse(f, legacy).requirement, /certificate leaf = H"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"/);
  assert.throws(() => parse(f, apple), /schema does not match/);
  assert.throws(() => parse(fixture(), legacy), /schema does not match/);
  const smuggled = fixture({ schema: V1, change: m => { m.destinationSigning = fixture().m.destinationSigning; } });
  assert.throws(() => parse(smuggled, legacy), /cannot carry a destination signer policy/);
});
