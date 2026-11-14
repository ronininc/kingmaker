// Tests for scripts/release-gate.mjs — the staged release gate.
// Run: node test/release-gate.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createReadStream, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildManifest, splitStream } from '../lib/release-manifest.mjs';
import { decideSignature, treeHash, verifyStagedRelease } from '../scripts/release-gate.mjs';

const PIN = '4C75DB94DFBE6CA6F87EFA56A5C5F0D6C9244AD1';
let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed += 1; console.log(`  ok - ${name}`); };

function makeApp(dir, { engineText = 'engine-v1' } = {}) {
  const app = join(dir, 'Kingmaker.app');
  mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true });
  mkdirSync(join(app, 'Contents', 'Resources'), { recursive: true });
  writeFileSync(join(app, 'Contents', 'MacOS', 'KingmakerEngine'), engineText);
  writeFileSync(join(app, 'Contents', 'Resources', 'payload-note.txt'), 'payload');
  symlinkSync('MacOS/KingmakerEngine', join(app, 'Contents', 'engine-link'));
  return app;
}

async function makeRelease(appDir, outDir, { partSize = 700 } = {}) {
  const parent = dirname(appDir);
  const tgz = join(outDir, 'app.tar.gz');
  const r = spawnSync('tar', ['-czf', tgz, '-C', parent, 'Kingmaker.app'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const split = await splitStream(createReadStream(tgz), { partSize, outDir, archive: 'Kingmaker-9.9.9.tar.gz' });
  const manifest = buildManifest({
    version: '9.9.9', tag: 'v9.9.9',
    app: { bundleId: 'com.ronininc.solghost', version: '9.9.9' },
    archive: { name: 'Kingmaker-9.9.9.tar.gz', size: split.size, sha256: split.sha256 },
    parts: split.parts, partSize,
    launcher: { name: 'Ronin Launcher.app', format: 'zip', required: true, version: '0.3.1', archive: 'Ronin-Launcher.zip', sha256: 'a'.repeat(64), size: 123 },
  });
  return { manifest, split };
}

const rootProbe = { strictOk: true, requirementText: `designated => identifier "com.ronininc.solghost" and certificate root = H"${PIN}"`, detailsText: 'Authority=Kingmaker Release' };
const leafProbe = { strictOk: true, requirementText: `designated => identifier "com.ronininc.solghost" and certificate leaf = H"${PIN}"`, detailsText: 'Authority=Kingmaker Release' };

/* decideSignature — the installer's own test, replicated */
{
  ok('root-form requirement passes (the self-signed phrasing)', decideSignature(rootProbe, PIN).ok);
  ok('leaf-form requirement passes', decideSignature(leafProbe, PIN).ok);
  const wrong = decideSignature({ ...rootProbe, requirementText: `certificate root = H"${'B'.repeat(40)}"` }, PIN);
  ok('wrong signer refused', !wrong.ok && wrong.problems.some((p) => p.includes('not the pinned')));
  const adhoc = decideSignature({ ...rootProbe, detailsText: 'Signature=adhoc' }, PIN);
  ok('adhoc refused', !adhoc.ok && adhoc.problems.some((p) => p.includes('ad-hoc')));
  const noProbe = decideSignature(null, PIN);
  ok('missing probe refuses (fail-closed)', !noProbe.ok);
  const strictFail = decideSignature({ ...rootProbe, strictOk: false }, PIN);
  ok('strict verify failure refused', !strictFail.ok);
}

/* treeHash determinism */
{
  const d = mkdtempSync(join(tmpdir(), 'gate-tree-'));
  const app = makeApp(d);
  const h1 = treeHash(app).hash;
  const h2 = treeHash(app).hash;
  ok('treeHash is deterministic', h1 === h2);
}

/* Full gate — happy path, then the 0.4.2 failure shape */
{
  const d = mkdtempSync(join(tmpdir(), 'gate-full-'));
  const srcParent = join(d, 'src'); mkdirSync(srcParent, { recursive: true });
  const app = makeApp(srcParent);
  const relDir = join(d, 'release'); mkdirSync(relDir, { recursive: true });
  const { manifest } = await makeRelease(app, relDir);

  const good = await verifyStagedRelease({ manifest, partsDir: relDir, sourceApp: app, stageDir: join(d, 'stage1'), pin: PIN, probe: rootProbe });
  ok('staged release passes end to end', good.ok === true && good.problems.length === 0);

  // The 0.4.2 shape: the archive was built from a DIFFERENT app than the one inspected.
  const otherParent = join(d, 'other'); mkdirSync(otherParent, { recursive: true });
  const otherApp = makeApp(otherParent, { engineText: 'engine-v2-STALE' });
  const stale = await verifyStagedRelease({ manifest, partsDir: relDir, sourceApp: otherApp, stageDir: join(d, 'stage2'), pin: PIN, probe: rootProbe });
  ok('stale payload refused', stale.ok === false && stale.problems.some((p) => p.includes('KingmakerEngine')));

  // Wrong signer on the staged app.
  const wrongSig = await verifyStagedRelease({ manifest, partsDir: relDir, sourceApp: app, stageDir: join(d, 'stage3'), pin: PIN, probe: { ...rootProbe, requirementText: `certificate leaf = H"${'C'.repeat(40)}"` } });
  ok('wrong signer refused at the gate', wrongSig.ok === false);

  // A corrupted part never reaches extraction.
  const part0 = join(relDir, manifest.parts[0].name);
  const bytes = readFileSync(part0); bytes[10] ^= 0xff; writeFileSync(part0, bytes);
  const corrupt = await verifyStagedRelease({ manifest, partsDir: relDir, sourceApp: app, stageDir: join(d, 'stage4'), pin: PIN, probe: rootProbe });
  ok('corrupted part refused by verifyParts', corrupt.ok === false && corrupt.checks.parts.ok === false);
}

console.log(`release-gate: ${passed} checks passed`);
