/**
 * Update notification check — tests. No I/O, no network.
 * Run: node test/update-notify.test.mjs
 */
import assert from 'node:assert';
import { compareVersions, checkForUpdate } from '../lib/update-notify.mjs';

// 1. Version comparison is numeric, not lexicographic.
{
  assert.equal(compareVersions('0.4.0', '0.10.0'), -1);
  assert.equal(compareVersions('0.4.0', '0.4.0'), 0);
  assert.equal(compareVersions('1.0.0', '0.9.9'), 1);
  assert.equal(compareVersions('0.4', '0.4.0'), 0);
}

// 2. Newer manifest version → notify.
{
  const r = checkForUpdate({
    installedVersion: '0.3.0',
    manifest: { version: '0.4.0' },
  });
  assert.equal(r.notify, true);
  assert.equal(r.latestVersion, '0.4.0');
  assert.equal(r.reason, 'update-available');
}

// 3. Up to date → silent.
{
  const r = checkForUpdate({
    installedVersion: '0.4.0',
    manifest: { version: '0.4.0' },
  });
  assert.equal(r.notify, false);
  assert.equal(r.reason, 'up-to-date');
}

// 4. Already notified for this version → silent (no nagging).
{
  const r = checkForUpdate({
    installedVersion: '0.3.0',
    manifest: { version: '0.4.0' },
    lastNotifiedVersion: '0.4.0',
  });
  assert.equal(r.notify, false);
  assert.equal(r.reason, 'already-notified');
}

// 5. Manifest without a version → silent, never a guess.
{
  const r = checkForUpdate({ installedVersion: '0.3.0', manifest: {} });
  assert.equal(r.notify, false);
  assert.equal(r.reason, 'no-version-in-manifest');
}

// 6. Unknown installed version → silent.
{
  const r = checkForUpdate({ installedVersion: '', manifest: { version: '0.4.0' } });
  assert.equal(r.notify, false);
  assert.equal(r.reason, 'unknown-installed-version');
}

console.log('update-notify: 6/6 passed');
