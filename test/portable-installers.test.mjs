import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildPayload } from '../scripts/build-payload.mjs';
import { buildPortableInstallers } from '../scripts/build-portable-installers.mjs';

test('portable Linux and Windows bundles preserve one verified payload and platform launchers', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'kingmaker-portable-test-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const payload = buildPayload({ out: join(root, 'payload') });
  const artifacts = buildPortableInstallers({ payload: payload.tar, out: join(root, 'out'), version: payload.version });
  assert.deepEqual(artifacts.map((x) => x.platform), ['linux', 'windows']);
  for (const artifact of artifacts) { assert.match(artifact.sha256, /^[a-f0-9]{64}$/); assert.ok(artifact.size > 0); }
  const linux = execFileSync('tar', ['-tf', join(root, 'out', artifacts[0].name)], { encoding: 'utf8' });
  assert.match(linux, /\/kingmaker\n/); assert.match(linux, /\/sol-ghost\/payload\.json\n/);
  const windows = execFileSync('unzip', ['-Z1', join(root, 'out', artifacts[1].name)], { encoding: 'utf8' });
  assert.match(windows, /\/kingmaker\.cmd\n/); assert.match(windows, /\/sol-ghost\/payload\.json\n/);
  const metadata = JSON.parse(readFileSync(join(root, 'out', 'portable-artifacts.json')));
  assert.equal(metadata.status, 'native-acceptance-pending'); assert.equal(metadata.version, payload.version);
});
