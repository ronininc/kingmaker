import assert from 'node:assert/strict';
import test from 'node:test';

import { buildManifest, issuanceProblems, launcherProblems, manifestProblems, shipProblems } from '../lib/release-manifest.mjs';

const sha = 'a'.repeat(40);
const otherSha = 'b'.repeat(40);
const launcher = {
  name: 'Ronin Launcher.app', bundleId: 'org.ronininc.launcher', version: '0.3.14',
  archive: 'Ronin-Launcher-0.3.14-arm64.zip', format: 'zip', url: null,
  size: 123, sha256: 'c'.repeat(64), required: true,
  sourceRepo: 'ronininc/ronin-launcher', sourceCommit: otherSha,
};

test('release issuance binds a separately maintained Launcher repository and commit', () => {
  assert.deepEqual(launcherProblems(launcher, { required: true }), []);
  assert.deepEqual(issuanceProblems({
    version: '4.4.2',
    issuance: {
      tree: { repo: 'ronininc/Kingmaker', commit: sha, version: '4.4.2' },
      installer: { repo: 'ronininc/Kingmaker', commit: sha, version: '4.4.2' },
      launcher: { repo: launcher.sourceRepo, commit: launcher.sourceCommit, version: launcher.version },
    },
  }, { required: true }), []);
});

test('Launcher provenance cannot be omitted or reduced to an archive hash', () => {
  assert.deepEqual(launcherProblems({ ...launcher, sourceRepo: undefined }, { required: true }), ['launcher.sourceRepo must be owner/name']);
  assert.deepEqual(launcherProblems({ ...launcher, sourceCommit: 'short' }, { required: true }), ['launcher.sourceCommit is not a full commit SHA']);
});

test('installer provenance must still match the Kingmaker release tree', () => {
  const problems = issuanceProblems({
    version: '4.4.2',
    issuance: {
      tree: { repo: 'ronininc/Kingmaker', commit: sha, version: '4.4.2' },
      installer: { repo: 'ronininc/other', commit: otherSha, version: '4.4.2' },
      launcher: { repo: launcher.sourceRepo, commit: launcher.sourceCommit, version: launcher.version },
    },
  }, { required: true });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /installer was built from/);
});

 test('launcher issuance cannot disagree with the actual pinned artifact', () => {
   const m = {version:'4.4.2',launcher,issuance:{tree:{repo:'ronininc/Kingmaker',commit:sha,version:'4.4.2'},installer:{repo:'ronininc/Kingmaker',commit:sha,version:'4.4.2'},launcher:{repo:launcher.sourceRepo,commit:sha,version:launcher.version}}};
   assert.match(issuanceProblems(m,{required:true}).join(' '), /does not match/);
   m.issuance.launcher.commit=launcher.sourceCommit;
   assert.deepEqual(issuanceProblems(m,{required:true}), []);
 });

test('manifest construction preserves the exact separately pinned Launcher provenance', () => {
  const issuance = {
    tree: { repo: 'ronininc/Kingmaker', commit: sha, version: '4.4.2' },
    installer: { repo: 'ronininc/Kingmaker', commit: sha, version: '4.4.2' },
    launcher: { repo: launcher.sourceRepo, commit: launcher.sourceCommit, version: launcher.version },
  };
  const m = buildManifest({ version: '4.4.2', tag: 'v4.4.2',
    app: { bundleId: 'com.ronininc.solghost' },
    archive: { name: 'Kingmaker-4.4.2.tar.gz', size: 1, sha256: 'd'.repeat(64) },
    parts: [{ name: 'Kingmaker-4.4.2.tar.gz.part01', size: 1, sha256: 'd'.repeat(64) }],
    partSize: 1, launcher, issuance });
  assert.equal(m.launcher.sourceRepo, launcher.sourceRepo);
  assert.equal(m.launcher.sourceCommit, launcher.sourceCommit);
  assert.deepEqual(issuanceProblems(JSON.parse(JSON.stringify(m)), { required: true }), []);
  m.launcher.sourceCommit = sha;
  assert.match(issuanceProblems(m, { required: true }).join(' '), /does not match/);
});


test('explicit harness-only release needs no Launcher bytes but keeps the signing lane and release-tree provenance', () => {
  const version = '4.4.2', pin = 'd'.repeat(64);
  const tree = { repo: 'ronininc/Kingmaker', commit: sha, version };
  const args = {
    version, tag: 'v4.4.2', distribution: 'harness-only',
    app: { bundleId: 'com.ronininc.solghost' },
    archive: { name: 'Kingmaker-4.4.2.tar.gz', size: 1, sha256: pin },
    parts: [{ name: 'Kingmaker-4.4.2.tar.gz.part01', size: 1, sha256: pin }],
    partSize: 1, issuance: { tree, installer: {...tree} },
  };
  const m = buildManifest(args);
  assert.equal('launcher' in m, false);
  assert.equal('launcher' in m.issuance, false);
  assert.deepEqual(manifestProblems(m), []);
  const options = { pkgVersion: version, enroll: { url: 'https://example.test/enroll', code: 'fixture' } };
  assert.deepEqual(shipProblems(m, options), []);
  assert.match(shipProblems(m, {...options, pin: null, enroll: null}).join(' '), /no Kingmaker Release certificate.*no update enrollment/);
  assert.match(shipProblems({...m, distribution: undefined}, options).join(' '), /Launcher pin is not sound/);
  assert.match(manifestProblems({...m, issuance: undefined}).join(' '), /no issuance provenance/);
  assert.throws(() => buildManifest({...args, distribution: 'not-a-lane'}), /distribution is not supported/);
  assert.throws(() => buildManifest({...args, launcher}), /harness-only must not carry a Launcher pin/);
  assert.throws(() => buildManifest({...args, issuance: {...args.issuance, launcher: {...tree}}}), /harness-only must not claim Launcher issuance/);
  assert.throws(() => buildManifest({...args, issuance: {...args.issuance, installer: {...tree, commit: otherSha}}}), /installer was built from/);
});
