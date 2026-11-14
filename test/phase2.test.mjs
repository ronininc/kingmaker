// Tests for the Phase 2 release line: deterministic archive, mirror v2, installer plan.
// Run: node test/phase2.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDeterministicArchive, normalizationArgs, tarFlavor } from '../lib/deterministic-archive.mjs';
import { mirrorRelease } from '../scripts/mirror-v2.mjs';
import { planInstaller, verifyInstallerBundle } from '../scripts/installer-plan.mjs';

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed += 1; console.log(`  ok - ${name}`); };

/* ---------------- deterministic archive ---------------- */
{
  ok('tar flavor detection', tarFlavor('tar (GNU tar) 1.34') === 'gnu' && tarFlavor('bsdtar 3.5.3 - libarchive 3.5.3') === 'bsd');
  assert.throws(() => normalizationArgs('unknown'), /cannot normalize/); passed += 1; console.log('  ok - unknown tar flavor refuses');

  const d = mkdtempSync(join(tmpdir(), 'detarch-'));
  const mk = (sub, order) => {
    const app = join(d, sub, 'Kingmaker.app');
    mkdirSync(join(app, 'Contents'), { recursive: true });
    for (const name of order) writeFileSync(join(app, 'Contents', name), `content-${name}`);
    // wildly different mtimes per build
    const t = sub === 'a' ? new Date('2020-01-01') : new Date('2026-06-06');
    spawnSync('touch', ['-d', t.toISOString(), join(app, 'Contents', 'one.txt'), join(app, 'Contents', 'two.txt')]);
    return app;
  };
  const appA = mk('a', ['one.txt', 'two.txt']);
  const appB = mk('b', ['two.txt', 'one.txt']);
  const a1 = await createDeterministicArchive({ dir: appA, outFile: join(d, 'a1.tgz') });
  const a2 = await createDeterministicArchive({ dir: appA, outFile: join(d, 'a2.tgz') });
  const b1 = await createDeterministicArchive({ dir: appB, outFile: join(d, 'b1.tgz') });
  ok('same tree, two runs → identical sha256', a1.sha256 === a2.sha256);
  ok('different mtimes + creation order → identical sha256', a1.sha256 === b1.sha256);
  const ex = join(d, 'ex'); mkdirSync(ex);
  spawnSync('tar', ['-xzf', join(d, 'a1.tgz'), '-C', ex]);
  ok('archive round-trips the tree', readFileSync(join(ex, 'Kingmaker.app', 'Contents', 'one.txt'), 'utf8') === 'content-one.txt');
}

/* ---------------- mirror v2 ---------------- */
{
  const sha = (s) => { let h = 0; return s; };
  const { createHash } = await import('node:crypto');
  const H = (buf) => createHash('sha256').update(buf).digest('hex');
  const objects = [];
  const d = mkdtempSync(join(tmpdir(), 'mirror-'));
  for (let i = 1; i <= 10; i += 1) {
    const name = `part${String(i).padStart(2, '0')}`;
    const file = join(d, name); const bytes = Buffer.from(`payload-${name}`);
    writeFileSync(file, bytes);
    objects.push({ key: `v9/${name}`, file, sha256: H(bytes), size: bytes.length });
  }
  // In-memory transport with the 0.4.2 fault: part08's first put dies with a 502.
  const store = new Map(); const ops = [];
  let part08Failed = false;
  const transport = {
    async put(key, file) {
      ops.push(`put ${key}`);
      if (key.endsWith('part08') && !part08Failed) { part08Failed = true; throw new Error('wrangler: HTTP 502 Bad Gateway'); }
      store.set(key, readFileSync(file));
    },
    async head(key) { const b = store.get(key); return b ? { sha256: H(b), size: b.length } : null; },
    async putText(key, text) { ops.push(`putText ${key}`); store.set(key, Buffer.from(text)); },
    async getText(key) { const b = store.get(key); return b ? b.toString('utf8') : null; },
  };
  const latest = { key: 'latest.json', text: '{"version":"9"}' };
  const fast = { backoffMs: 1, sleep: async () => {} };

  const run1 = await mirrorRelease({ objects, latest, transport, maxAttempts: 1, ...fast });
  ok('run 1 (502 at part08, no retries left) is incomplete', run1.ok === false);
  ok('run 1 did NOT flip latest.json', !store.has('latest.json') && run1.flipped === false);
  ok('run 1 uploaded everything but the failed part, and names it', run1.uploaded.length === 9 && run1.failed[0].key === 'v9/part08');

  const run2 = await mirrorRelease({ objects, latest, transport, ...fast });
  ok('run 2 completes', run2.ok === true && run2.flipped === true);
  ok('run 2 resumed: verified parts skipped, only the missing one uploaded', run2.skipped.length === 9 && run2.uploaded.length === 1);
  ok('latest.json put was the LAST write op', ops.filter((o) => o.startsWith('put')).pop() === 'putText latest.json');
  ok('latest.json content is the new pointer', store.get('latest.json').toString('utf8') === latest.text);

  const run3 = await mirrorRelease({ objects, latest, transport, ...fast });
  ok('run 3 is a no-op verify (all skipped)', run3.ok === true && run3.uploaded.length === 0 && run3.skipped.length === 10);

  // Permanent corruption: remote bytes for part03 are wrong and put is sabotaged.
  store.set('v9/part03', Buffer.from('tampered'));
  const badTransport = { ...transport, async put() { throw new Error('HTTP 403 forbidden'); } };
  const run4 = await mirrorRelease({ objects, latest, transport: badTransport, maxAttempts: 2, ...fast });
  ok('permanent failure → no flip, failure named', run4.ok === false && run4.failed[0].key === 'v9/part03');
}

/* ---------------- installer plan ---------------- */
{
  const manifest = { version: '9.9.9', tag: 'v9.9.9' };
  const manifestText = JSON.stringify(manifest);
  const sources = {
    'installer/engine.sh': Buffer.from('#!/bin/sh\necho engine'),
    'installer/Resources/InstallerIcon.icns': Buffer.from('icns'),
    'installer/Resources/RoninCrest.png': Buffer.from('png'),
    'TERMS.md': Buffer.from('terms'), 'LICENSE': Buffer.from('license'),
    'COMMERCIAL-LICENSE.md': Buffer.from('commercial'), 'THIRD_PARTY_NOTICES.md': Buffer.from('notices'),
    'lib/kingmaker-release-public.pem': Buffer.from('pem'),
    'lib/release-identity.json': Buffer.from('{"sha1":"4C75"}'),
  };
  const fileBytes = (src) => { const b = sources[src]; if (!b) throw new Error(`no fixture for ${src}`); return b; };
  const p1 = planInstaller({ manifest, manifestText, manifestSig: Buffer.from('sig'), pin: { sha1: '4C75DB94' }, fileBytes });
  const p2 = planInstaller({ manifest, manifestText: Buffer.from(manifestText), manifestSig: Buffer.from('sig'), pin: { sha1: '4C75DB94' }, fileBytes });
  ok('plan is deterministic (same inputs → same hash)', p1.planHash === p2.planHash);
  ok('signed plan records signed: true', p1.signed === true);
  const unsigned = planInstaller({ manifest, manifestText, pin: null, fileBytes });
  ok('unsigned plan differs and says so', unsigned.signed === false && unsigned.planHash !== p1.planHash);

  const bundle = new Map();
  for (const f of p1.files) { try { bundle.set(f.path, fileBytes(f.source)); } catch { /* manifest/sig/pin handled below */ } }
  bundle.set('Contents/Resources/kingmaker-manifest.json', Buffer.from(manifestText));
  bundle.set('Contents/Resources/kingmaker-manifest.json.sig', Buffer.from('sig'));
  bundle.set('Contents/Resources/release-identity.json', sources['lib/release-identity.json']);
  bundle.set('Contents/MacOS/Kingmaker Installer', Buffer.from('binary'));
  bundle.set('Contents/Info.plist', Buffer.from('plist'));
  bundle.set('Contents/PkgInfo', Buffer.from('APPL????'));
  const read = (p) => bundle.get(p) ?? null;
  const list = () => [...bundle.keys()];
  const good = verifyInstallerBundle({ plan: p1, read, list });
  ok('a bundle matching the plan verifies', good.ok === true);
  bundle.set('Contents/Resources/engine.sh', Buffer.from('tampered engine'));
  const bad = verifyInstallerBundle({ plan: p1, read, list });
  ok('tampered engine.sh fails the plan check', bad.ok === false && bad.problems.some((x) => x.includes('engine.sh')));
  bundle.set('Contents/Resources/engine.sh', sources['installer/engine.sh']);
  bundle.set('Contents/Resources/sneaky.txt', Buffer.from('x'));
  const extra = verifyInstallerBundle({ plan: p1, read, list });
  ok('unplanned extra file is reported', extra.ok === false && extra.problems.some((x) => x.includes('sneaky')));
}

console.log(`phase2: ${passed} checks passed`);
