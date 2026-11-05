import assert from 'node:assert/strict';
import test from 'node:test';

import { issuanceProblems, launcherProblems } from '../lib/release-manifest.mjs';

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
