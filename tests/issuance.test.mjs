// Tests for the ISSUANCE gate — manifest provenance (lib/release-manifest.mjs
// issuanceProblems) enforced at the staged release gate (scripts/release-gate.mjs).
//
// The 2026-10-21 acceptance lesson: the 4.2 acceptance run failed at the
// installer's signature check because the shipped 0.3.1 launcher ran the OLD
// installer — its trust pin belonged to the old release line — while the new
// installer existed only as source. A release is issuable only when the
// installer and launcher inside it were built from the release's own source
// tree (repo + commit), recorded in the manifest and checked here.
// Run: node tests/issuance.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createReadStream, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildManifest, issuanceProblems, splitStream } from '../lib/release-manifest.mjs';
import { verifyStagedRelease } from '../scripts/release-gate.mjs';

const PIN = '4C75DB94DFBE6CA6F87EFA56A5C5F0D6C9244AD1';
const TREE = 'a'.repeat(40);   // the release's own tree commit
const OTHER = 'b'.repeat(40);  // some other tree — the old line's
const REPO = 'ronininc/kingmaker-private';
let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed += 1; console.log(`  ok - ${name}`); };

const issuance = (over = {}) => ({
  tree: { repo: REPO, commit: TREE, version: '9.9.9' },
  installer: { repo: REPO, commit: TREE, version: '9.9.9' },
  launcher: { repo: REPO, commit: TREE, version: '0.3.1' },
  ...over,
});

function makeApp(dir) {
  const app = join(dir, 'Kingmaker.app');
  mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true });
  mkdirSync(join(app, 'Contents', 'Resources'), { recursive: true });
  writeFileSync(join(app, 'Contents', 'MacOS', 'KingmakerEngine'), 'engine-v1');
  writeFileSync(join(app, 'Contents', 'Resources', 'payload-note.txt'), 'payload');
  symlinkSync('MacOS/KingmakerEngine', join(app, 'Contents', 'engine-link'));
  return app;
}

async function makeRelease(appDir, outDir, iss, { attach = false } = {}) {
  const parent = dirname(appDir);
  const tgz = join(outDir, 'app.tar.gz');
  const r = spawnSync('tar', ['-czf', tgz, '-C', parent, 'Kingmaker.app'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const split = await splitStream(createReadStream(tgz), { partSize: 700, outDir, archive: 'Kingmaker-9.9.9.tar.gz' });
  const manifest = buildManifest({
    version: '9.9.9', tag: 'v9.9.9',
    app: { bundleId: 'com.ronininc.solghost', version: '9.9.9' },
    archive: { name: 'Kingmaker-9.9.9.tar.gz', size: split.size, sha256: split.sha256 },
    parts: split.parts, partSize: 700,
    launcher: { name: 'Ronin Launcher.app', format: 'zip', required: true, version: '0.3.1', archive: 'Ronin-Launcher.zip', sha256: 'a'.repeat(64), size: 123 },
    issuance: attach ? null : iss,
  });
  // `attach`: buildManifest itself refuses mismatched provenance (above), so
  // a mismatched manifest can only reach the gate from a builder that did
  // not validate — another release-parts vintage, a hand-carried manifest.
  // The gate is the second wall; attach the record the way such a manifest
  // would carry it and let the gate do its job.
  if (attach && iss) manifest.issuance = iss;
  return manifest;
}

const rootProbe = { strictOk: true, requirementText: `designated => identifier "com.ronininc.solghost" and certificate root = H"${PIN}"`, detailsText: 'Authority=Kingmaker Release' };

/* issuanceProblems — the pure check */
{
  ok('one tree for tree + installer + launcher is sound', issuanceProblems({ version: '9.9.9', issuance: issuance() }).length === 0);
  ok('an installer from another tree is named', issuanceProblems({ version: '9.9.9', issuance: issuance({ installer: { repo: REPO, commit: OTHER, version: '9.9.9' } }) }).some((p) => p.includes('the installer was built from')));
  ok('a launcher from another tree is named', issuanceProblems({ version: '9.9.9', issuance: issuance({ launcher: { repo: REPO, commit: OTHER, version: '0.3.1' } }) }).some((p) => p.includes('the launcher was built from')));
  ok('an installer stamped from another release is named', issuanceProblems({ version: '9.9.9', issuance: issuance({ installer: { repo: REPO, commit: TREE, version: '0.3.1' } }) }).some((p) => p.includes('not the release version')));
  ok('missing provenance is silent when not required (old manifests still read)', issuanceProblems({ version: '9.9.9' }).length === 0);
  ok('missing provenance refuses when required', issuanceProblems({ version: '9.9.9' }, { required: true }).some((p) => p.includes('cannot be marked issuable')));
  assert.throws(() => buildManifest({
    version: '9.9.9', tag: 'v9.9.9', app: { bundleId: 'com.ronininc.solghost' },
    archive: { name: 'Kingmaker-9.9.9.tar.gz', size: 1, sha256: 'a'.repeat(64) },
    parts: [{ name: 'p1', size: 1, sha256: 'a'.repeat(64) }], partSize: 700,
    launcher: { name: 'Ronin Launcher.app', format: 'zip', required: true, version: '0.3.1', archive: 'Ronin-Launcher.zip', sha256: 'a'.repeat(64), size: 123 },
    issuance: issuance({ launcher: { repo: REPO, commit: OTHER, version: '0.3.1' } }),
  }), /the launcher was built from/);
  passed += 1; console.log('  ok - buildManifest itself refuses mismatched provenance');
}

/* The gate — the same staged release, three provenance states */
{
  const d = mkdtempSync(join(tmpdir(), 'issuance-'));
  const srcParent = join(d, 'src'); mkdirSync(srcParent, { recursive: true });
  const app = makeApp(srcParent);
  const gate = async (iss, dir, opts = {}) => {
    const relDir = join(d, dir); mkdirSync(relDir, { recursive: true });
    const { attach = false, ...gateOpts } = opts;
    const manifest = await makeRelease(app, relDir, iss, { attach });
    return verifyStagedRelease({ manifest, partsDir: relDir, sourceApp: app, stageDir: join(d, `${dir}-stage`), pin: PIN, probe: rootProbe, ...gateOpts });
  };

  const good = await gate(issuance(), 'rel-good', { requireIssuance: true });
  ok('matching provenance passes the gate (issuance required)', good.ok === true && good.checks.issuance.problems.length === 0);

  // THE NEGATIVE TEST — the 2026-10-21 shape exactly: the release is fine,
  // the app is fine, the signature is fine — but the LAUNCHER inside it was
  // built from another tree (the old line). Not issuable.
  const stale = await gate(issuance({ launcher: { repo: REPO, commit: OTHER, version: '0.3.1' } }), 'rel-stale', { requireIssuance: true, attach: true });
  ok('NEGATIVE: a launcher built from another tree is refused at the gate', stale.ok === false && stale.problems.some((p) => p.includes('the launcher was built from')));
  ok('NEGATIVE: the refusal is on the paper, not the payload — the only problems name the provenance', stale.problems.every((p) => p.includes('the launcher was built from')) && stale.checks.signature === undefined);

  const staleInstaller = await gate(issuance({ installer: { repo: REPO, commit: OTHER, version: '9.9.9' } }), 'rel-stale-inst', { requireIssuance: true, attach: true });
  ok('NEGATIVE: an installer built from another tree is refused at the gate', staleInstaller.ok === false && staleInstaller.problems.some((p) => p.includes('the installer was built from')));

  const unrecorded = await gate(undefined, 'rel-unrecorded', { requireIssuance: true });
  ok('unrecorded provenance is refused when issuance is required', unrecorded.ok === false && unrecorded.problems.some((p) => p.includes('cannot be marked issuable')));

  const legacy = await gate(undefined, 'rel-legacy');
  ok('a pre-issuance release still passes when issuance is not required (backward compat)', legacy.ok === true && legacy.checks.issuance.recorded === false);
}

console.log(`issuance: ${passed} checks passed`);
