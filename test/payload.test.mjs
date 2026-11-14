// The free Kingmaker as ONE file (lib/payload.mjs, scripts/build-payload.mjs): everything it runs travels together, and an
// install that lost any of it says so plainly at start instead of crashing while it loads (0.2.6's red icon).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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

test('the unpacked payload includes and loads the exact native armor runtime closure', { timeout: 120_000 }, () => {
  const files = payloadFiles(ROOT).filter((f) => f.startsWith('scripture-armor/'));
  assert.deepEqual(files, ['scripture-armor/LICENSE', 'scripture-armor/armor.mjs', 'scripture-armor/refit-net.mjs', 'scripture-armor/scan.mjs']);
  const dir = unpack();
  try {
    const url = pathToFileURL(join(dir, 'lib/armor-native.mjs')).href;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', `const m = await import(${JSON.stringify(url)}); if (typeof m.armor.createIdentity !== 'function' || typeof m.Flow !== 'function' || typeof m.openFlow !== 'function') process.exit(1);`], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  } finally { rmSync(join(dir, '..'), { recursive: true, force: true }); }
});

test('armor vault, state, sealed bundles, app files and paid add-ons cannot enter through the runtime allowlist', () => {
  const root = mkdtempSync(join(tmpdir(), 'km-payload-boundary-'));
  try {
    for (const part of PAYLOAD_PARTS) {
      const target = join(root, part); mkdirSync(dirname(target), { recursive: true });
      if (statSync(join(ROOT, part)).isDirectory()) mkdirSync(target, { recursive: true });
      else writeFileSync(target, 'public fixture');
    }
    const excluded = ['scripture-armor/vault/owner-key.json', 'scripture-armor/state/identity.json', 'scripture-armor/sealed-bundle.json', 'scripture-armor/issuer.secret.json', 'scripture-armor/Scripture Armor.app/Contents/MacOS/armor', 'addons/paid-addon/index.mjs'];
    for (const name of excluded) { const p = join(root, name); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, 'excluded fixture'); }
    const files = payloadFiles(root);
    for (const name of excluded) assert.ok(!files.includes(name), name);
    assert.equal(files.filter((f) => f.startsWith('scripture-armor/')).length, 4);
    assert.ok(!PAYLOAD_PARTS.includes('scripture-armor'), 'the full tree must never become a payload part');
  } finally { rmSync(root, { recursive: true, force: true }); }
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
