// daemon-transport.mjs — the one shared mapping from an identity dir to
// the vault daemon's transport endpoints. These checks inject the platform
// (no faked globals, no host dependence): POSIX must reproduce the
// historical layout byte-for-byte, and win32 must produce legal named-pipe
// endpoints while the owner FILES stay anchored on the identity dir.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  transportFor, daemonSocketFor, pipeNameFor, resolveEndpoint, isPipeEndpoint,
} from '../daemon-transport.mjs';

const POSIX_DIR = '/home/owner/.scripture-armor';
const WIN_DIR = 'C:\\Users\\owner\\.scripture-armor';
const WIN_DIR_BUNDLED = 'C:\\Users\\owner\\.kingmaker\\scripture-armor';

test('POSIX layout is byte-identical to the historical one', () => {
  for (const platform of ['linux', 'darwin']) {
    const t = transportFor(POSIX_DIR, platform);
    assert.equal(t.isPipe, false);
    assert.equal(t.socket, path.posix.join(POSIX_DIR, 'vaultd.sock'));
    assert.equal(t.ownerDir, path.posix.join(POSIX_DIR, 'owner'));
    assert.equal(t.ownerSocket, path.posix.join(POSIX_DIR, 'owner', 'vaultd.sock.owner'));
    assert.equal(t.ownerTokenPath, path.posix.join(POSIX_DIR, 'owner', 'vaultd.sock.owner.token'));
    assert.equal(t.ownerConfirmPath('abc123'), path.posix.join(POSIX_DIR, 'owner', 'vaultd.sock.confirm-abc123.json'));
    assert.equal(daemonSocketFor(POSIX_DIR, platform), t.socket);
  }
});

test('win32 endpoints are legal named pipes derived from the identity dir', () => {
  const t = transportFor(WIN_DIR, 'win32');
  assert.equal(t.isPipe, true);
  assert.match(t.socket, /^\\\\\.\\pipe\\scripture-armor-vaultd-[0-9a-f]{12}$/);
  assert.equal(t.ownerSocket, `${t.socket}.owner`);
  assert.equal(isPipeEndpoint(t.socket), true);
  assert.equal(isPipeEndpoint(t.ownerSocket), true);
  // Deterministic: the same dir names the same pipe on every call.
  assert.equal(pipeNameFor(WIN_DIR), t.socket);
  assert.equal(transportFor(WIN_DIR, 'win32').socket, t.socket);
});

test('win32 owner FILES stay on the identity dir — never derived from the pipe', () => {
  const t = transportFor(WIN_DIR, 'win32');
  assert.equal(t.ownerDir, path.win32.join(WIN_DIR, 'owner'));
  assert.equal(t.ownerTokenPath, path.win32.join(WIN_DIR, 'owner', 'vaultd.sock.owner.token'));
  assert.equal(t.ownerConfirmPath('abc123'), path.win32.join(WIN_DIR, 'owner', 'vaultd.sock.confirm-abc123.json'));
  for (const f of [t.ownerDir, t.ownerTokenPath, t.ownerConfirmPath('x')]) {
    assert.equal(isPipeEndpoint(f), false, f);
    assert.equal(f.includes('pipe'), false, f);
  }
});

test('per-product separation: different identity dirs name different pipes', () => {
  assert.notEqual(pipeNameFor(WIN_DIR), pipeNameFor(WIN_DIR_BUNDLED));
  assert.notEqual(transportFor(WIN_DIR, 'win32').socket, transportFor(WIN_DIR_BUNDLED, 'win32').socket);
});

test('win32 normalization: case and trailing separator do not rename the pipe', () => {
  assert.equal(pipeNameFor('C:\\Users\\Owner\\.scripture-armor\\'), pipeNameFor(WIN_DIR));
  assert.equal(pipeNameFor('c:\\users\\owner\\.scripture-armor'), pipeNameFor(WIN_DIR));
});

test('explicit endpoints: overrides stay the caller\u2019s word', () => {
  // No explicit value -> the platform default.
  assert.equal(resolveEndpoint(null, POSIX_DIR, 'linux'), daemonSocketFor(POSIX_DIR, 'linux'));
  assert.equal(resolveEndpoint('', WIN_DIR, 'win32'), daemonSocketFor(WIN_DIR, 'win32'));
  // POSIX: resolved, as the historical call sites did.
  assert.equal(resolveEndpoint('rel/vaultd.sock', POSIX_DIR, 'linux'), path.posix.resolve('rel/vaultd.sock'));
  assert.equal(resolveEndpoint('/tmp/custom.sock', POSIX_DIR, 'linux'), '/tmp/custom.sock');
  // win32: verbatim — path.resolve() would rewrite a pipe name into a
  // filesystem path; a filesystem override also passes through untouched.
  const pipe = '\\\\.\\pipe\\scripture-armor-vaultd-0123456789ab';
  assert.equal(resolveEndpoint(pipe, WIN_DIR, 'win32'), pipe);
  assert.equal(resolveEndpoint('D:\\custom\\vaultd.sock', WIN_DIR, 'win32'), 'D:\\custom\\vaultd.sock');
});

test('isPipeEndpoint recognizes only pipe names', () => {
  assert.equal(isPipeEndpoint('\\\\.\\pipe\\x'), true);
  assert.equal(isPipeEndpoint('\\\\?\\pipe\\x'), true);
  assert.equal(isPipeEndpoint('/home/owner/.scripture-armor/vaultd.sock'), false);
  assert.equal(isPipeEndpoint('C:\\Users\\owner\\.scripture-armor\\vaultd.sock'), false);
  assert.equal(isPipeEndpoint(null), false);
  assert.equal(isPipeEndpoint(undefined), false);
});
