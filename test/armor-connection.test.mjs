// The authenticated, versioned connection to the separately installed Scripture Armor (lib/armor-connection.mjs).
// Fake installs are built in temp dirs (owner-pin path, platform 'linux'); the last test checks the real install when present.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ARMOR_CONTRACT, ArmorUnavailableError, connectArmor, importClosure, resetArmorConnection, verifyInstalledArmor } from '../lib/armor-connection.mjs';
import { ARMOR_SKIP } from './helpers/host-tool-skips.mjs';

const sha = (b) => createHash('sha256').update(b).digest('hex');
function fakeInstall({ version = '1.2.3', extra = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'km-armor-conn-'));
  const files = {
    'armor.mjs': `import './product-paths.mjs';\n${ARMOR_CONTRACT['armor.mjs'].map((n) => `export function ${n}() { return '${n}'; }`).join('\n')}\n`,
    'product-paths.mjs': 'export const P = 1;\n',
    'refit-net.mjs': "import './armor.mjs';\nexport class Flow {}\nexport function openFlow() { return 'flow'; }\n",
    'scan.mjs': 'export function scanSourceText() { return "scan"; }\n',
    ...extra,
  };
  for (const [p, c] of Object.entries(files)) { mkdirSync(join(root, p, '..'), { recursive: true }); writeFileSync(join(root, p), c); }
  const bundle = { schema: 'scripture-armor.standalone-bundle/1', version, product: 'standalone', files: Object.entries(files).map(([path, c]) => ({ path, sha256: sha(c) })) };
  writeFileSync(join(root, 'BUNDLE.json'), JSON.stringify(bundle));
  return { root, pin: sha(readFileSync(join(root, 'BUNDLE.json'))) };
}
const refusal = (fn, code) => assert.throws(fn, (e) => e instanceof ArmorUnavailableError && e.code === code, `expected ${code}`);
const linux = (env) => ({ env, platform: 'linux' });

test('missing install refuses with ARMOR_MISSING', () => {
  refusal(() => verifyInstalledArmor(linux({ KINGMAKER_ARMOR_HOME: join(tmpdir(), 'nope-no-armor'), HOME: tmpdir() })), 'ARMOR_MISSING');
});

test('an unsigned install is refused until the owner pins it; a correct pin authenticates', (t) => {
  const f = fakeInstall(); t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const home = mkdtempSync(join(tmpdir(), 'km-armor-home-')); t.after(() => rmSync(home, { recursive: true, force: true }));
  refusal(() => verifyInstalledArmor(linux({ KINGMAKER_ARMOR_HOME: f.root, HOME: home })), 'ARMOR_UNAUTHENTICATED');
  refusal(() => verifyInstalledArmor(linux({ KINGMAKER_ARMOR_HOME: f.root, HOME: home, KINGMAKER_ARMOR_PIN: 'a'.repeat(64) })), 'ARMOR_TAMPERED');
  const ok = verifyInstalledArmor(linux({ KINGMAKER_ARMOR_HOME: f.root, HOME: home, KINGMAKER_ARMOR_PIN: f.pin }));
  assert.equal(ok.auth.method, 'owner-pin'); assert.equal(ok.version, '1.2.3');
  assert.deepEqual(ok.files, ['armor.mjs', 'product-paths.mjs', 'refit-net.mjs', 'scan.mjs']);
  mkdirSync(join(home, '.kingmaker')); writeFileSync(join(home, '.kingmaker', 'armor-pin.json'), JSON.stringify({ bundleSha256: f.pin }));
  assert.equal(verifyInstalledArmor(linux({ KINGMAKER_ARMOR_HOME: f.root, HOME: home })).auth.method, 'owner-pin');
});

test('a changed module in the import closure (even a transitive one) is refused as tampered', (t) => {
  const f = fakeInstall(); t.after(() => rmSync(f.root, { recursive: true, force: true }));
  writeFileSync(join(f.root, 'product-paths.mjs'), 'export const P = 2; // swapped\n');
  refusal(() => verifyInstalledArmor(linux({ KINGMAKER_ARMOR_HOME: f.root, KINGMAKER_ARMOR_PIN: f.pin, HOME: tmpdir() })), 'ARMOR_TAMPERED');
});

test('an import escaping the install is refused; dynamic literal imports are part of the closure', (t) => {
  const f = fakeInstall({ extra: { 'scan.mjs': "export function scanSourceText() { return import('./finding.mjs'); }\n", 'finding.mjs': 'export const x = 1;\n' } });
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  assert.ok(importClosure(f.root, ['scan.mjs']).includes('finding.mjs'));
  writeFileSync(join(f.root, 'finding.mjs'), "import '../../etc/evil.mjs';\n");
  refusal(() => importClosure(f.root, ['scan.mjs']), 'ARMOR_TAMPERED');
});

test('an older Armor is incompatible', (t) => {
  const f = fakeInstall({ version: '1.2.2' }); t.after(() => rmSync(f.root, { recursive: true, force: true }));
  refusal(() => verifyInstalledArmor(linux({ KINGMAKER_ARMOR_HOME: f.root, KINGMAKER_ARMOR_PIN: f.pin, HOME: tmpdir() })), 'ARMOR_INCOMPATIBLE');
});

test('an app whose signature fails the pinned requirement is refused (codesign seam)', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'km-armor-app-')); t.after(() => rmSync(base, { recursive: true, force: true }));
  const res = join(base, 'Scripture Armor.app', 'Contents', 'Resources', 'armor'); mkdirSync(res, { recursive: true });
  const f = fakeInstall(); t.after(() => rmSync(f.root, { recursive: true, force: true }));
  for (const n of ['armor.mjs', 'product-paths.mjs', 'refit-net.mjs', 'scan.mjs', 'BUNDLE.json']) writeFileSync(join(res, n), readFileSync(join(f.root, n)));
  refusal(() => verifyInstalledArmor({ env: { KINGMAKER_ARMOR_HOME: res, HOME: tmpdir() }, platform: 'darwin', codesign: () => ({ ok: false, detail: 'not signed by the pinned team' }) }), 'ARMOR_UNAUTHENTICATED');
});

test('an install missing a contract export is incompatible, and the connection then stays refused', (t) => {
  const f = fakeInstall({ extra: { 'scan.mjs': 'export const nothing = 1;\n' } }); t.after(() => { rmSync(f.root, { recursive: true, force: true }); resetArmorConnection(); });
  resetArmorConnection();
  refusal(() => connectArmor(linux({ KINGMAKER_ARMOR_HOME: f.root, KINGMAKER_ARMOR_PIN: f.pin, HOME: tmpdir() })), 'ARMOR_INCOMPATIBLE');
  refusal(() => connectArmor(), 'ARMOR_INCOMPATIBLE');
});

test('the real installed Armor authenticates and mints hybrid identities', { skip: ARMOR_SKIP }, (t) => {
  resetArmorConnection();
  const c = connectArmor();
  assert.ok(['apple-codesign', 'owner-pin'].includes(c.info.auth.method));
  const dir = mkdtempSync(join(tmpdir(), 'km-armor-real-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const id = c.modules['armor.mjs'].createIdentity(join(dir, 'id'), 'connection-test');
  assert.ok(id.kemPub && id.mldsaPub, 'installed Armor identities must be hybrid');
});
