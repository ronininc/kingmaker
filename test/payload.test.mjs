// The free Kingmaker as ONE file (lib/payload.mjs, scripts/build-payload.mjs): everything it runs travels together, and an
// install that lost any of it says so plainly at start instead of crashing while it loads (0.2.6's red icon).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPayload, ESSENTIAL, PAYLOAD_PARTS, payloadFiles, payloadProblem } from '../lib/payload.mjs';
import { buildPayload, provePayload } from '../scripts/build-payload.mjs';
import { FORK_DIR } from '../lib/fork.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
let built;
const payload = () => (built ??= buildPayload({ out: mkdtempSync(join(tmpdir(), 'km-payload-')) }));
const unpack = () => { const d = mkdtempSync(join(tmpdir(), 'km-unpacked-')); execFileSync('tar', ['-xf', payload().tar, '-C', d]); return join(d, 'sol-ghost'); };
const start = (dir, args = ['version']) => spawnSync(process.execPath, [join(dir, 'lib', 'kingmaker.mjs'), ...args], { encoding: 'utf8', env: { ...process.env, KINGMAKER_ADDONS: 'off' } });

test('the payload is every part of the free Kingmaker, in one file, and nothing paid', { timeout: 120_000 }, () => {
  const files = payloadFiles(ROOT);
  for (const part of ['lib/', 'bin/', 'vendor/fleet/', 'vendor/office/', 'catalog/', 'core/skills/']) assert.ok(files.some((f) => f.startsWith(part)), part);
  assert.ok(!files.some((f) => new RegExp(`^(addons|${FORK_DIR}|test|scripts|docs)/`).test(f)), 'no add-ons, engine source, tests, scripts or docs');
  assert.ok(!PAYLOAD_PARTS.includes('addons'));
  const p = payload();
  assert.match(readFileSync(`${p.tar}.sha256`, 'utf8'), /^[0-9a-f]{64} {2}kingmaker-payload\.tar\n$/);
  assert.equal(provePayload(p.tar).version, JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version);
});

test('unpacked whole it starts; with a folder missing it refuses, names what is missing, and exits 78', { timeout: 120_000 }, () => {
  const dir = unpack();
  try {
    assert.equal(checkPayload(dir, { deep: true }).ok, true);
    assert.equal(start(dir).status, 0);
    rmSync(join(dir, 'vendor'), { recursive: true, force: true });   // exactly what 0.2.6 lost
    const r = start(dir);
    assert.equal(r.status, 78);
    assert.match(r.stderr, /This Kingmaker is incomplete: \d+ of its files are missing \(vendor: vendor\//);
    assert.match(r.stderr, /Reinstall it/);
    assert.doesNotMatch(r.stderr, /ERR_MODULE_NOT_FOUND/, 'never the loader\'s crash');
  } finally { rmSync(join(dir, '..'), { recursive: true, force: true }); }
});

test('a changed file is caught by the deep check (kingmaker doctor); a checkout without a list checks its essentials', () => {
  const r = { ok: false, missing: [], changed: ['lib/cli.mjs'] };
  assert.match(payloadProblem(r), /1 changed since the release \(lib\/cli\.mjs\)/);
  assert.equal(payloadProblem({ ok: true, missing: [], changed: [] }), null);
  const here = checkPayload(ROOT);
  assert.equal(here.listed, false); assert.equal(here.ok, true); assert.equal(here.checked, ESSENTIAL.length);
});

test('inside an app, a missing or broken payload list is never taken for a checkout', { timeout: 120_000 }, () => {
  const app = join(mkdtempSync(join(tmpdir(), 'km-app-')), 'Kingmaker.app', 'Contents', 'Resources');
  mkdirSync(app, { recursive: true });
  const dir = join(app, 'sol-ghost');
  cpSync(unpack(), dir, { recursive: true });
  assert.equal(checkPayload(dir).ok, true, 'whole, with its list');
  rmSync(join(dir, 'payload.json'));
  const r = checkPayload(dir);
  assert.equal(r.ok, false); assert.deepEqual(r.missing, ['payload.json'], 'the essentials alone never pass in an app');
  assert.match(payloadProblem(r), /incomplete/);
  assert.equal(start(dir).status, 78, 'and the app refuses to start, by name');
  assert.ok(PAYLOAD_PARTS.includes('assets'), 'the release packager needs assets/ in the app');
});

test('the payload keeps relative symlinks relative (an absolute one breaks the signed app on every other Mac)', async () => {
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync, readlinkSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { buildPayload, PAYLOAD_TAR } = await import('../scripts/build-payload.mjs');
  const out = mkdtempSync(join(tmpdir(), 'km-payload-sym-'));
  buildPayload({ out });
  const x = mkdtempSync(join(tmpdir(), 'km-payload-x-'));
  execFileSync('tar', ['-xf', join(out, PAYLOAD_TAR), '-C', x]);
  assert.equal(readlinkSync(join(x, 'sol-ghost', 'bin', 'sol-ghost')), 'kingmaker');
});
