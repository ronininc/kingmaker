// Tests for scripts/promote.mjs (the promotion door) and lib/release-platforms.mjs
// (the per-platform release shape), plus the manifest/installer-plan wiring.
// Run: node tests/promotion.test.mjs
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildManifest, manifestProblems } from '../lib/release-manifest.mjs';
import { buildLatest, latestProblems, platformObjects, platformsProblems } from '../lib/release-platforms.mjs';
import { planPlatforms } from '../scripts/installer-plan.mjs';
import { blobSha, isCarryableText, parseSuiteCounts, promote, proveComponents } from '../scripts/promote.mjs';

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed += 1; console.log(`  ok - ${name}`); };
const H = (c) => c.repeat(64);

/* ---------------- blobs + carryability ---------------- */
{
  ok('blobSha matches git (the Pro Git "hello" vector)', blobSha(Buffer.from('hello\n')) === 'ce013625030ba8dba906f756967f9e9ca394464a');
  ok('utf-8 text is carryable', isCarryableText(Buffer.from('héllo wörld\n')));
  ok('NUL bytes are not carryable', !isCarryableText(Buffer.from([0x7f, 0x00, 0x01])));
  ok('invalid utf-8 is not carryable', !isCarryableText(Buffer.from([0xff, 0xfe, 0x41])));
  ok('suite counts parse (fraction)', JSON.stringify(parseSuiteCounts('13/13 checks passed')) === JSON.stringify({ passed: 13, total: 13 }));
  ok('suite counts parse (bare)', JSON.stringify(parseSuiteCounts('darkweb-ts-port: 18 checks passed')) === JSON.stringify({ passed: 18, total: 18 }));
  ok('suite counts: no count → null', parseSuiteCounts('everything is fine') === null);
}

/* ---------------- fixture components ---------------- */
function makeTree() {
  const root = mkdtempSync(join(tmpdir(), 'promote-'));
  const comp = (name, suite) => {
    mkdirSync(join(root, name, 'lib'), { recursive: true });
    writeFileSync(join(root, name, 'lib', 'thing.mjs'), `// ${name}\nexport const x = 1;\n`);
    if (suite) {
      mkdirSync(join(root, name, 'tests'), { recursive: true });
      writeFileSync(join(root, name, 'tests', 'run-tests.mjs'), suite);
    }
  };
  comp('comp-good', `console.log('comp-good: 3/3 checks passed');\n`);
  comp('comp-broken', `console.log('comp-broken: 1/2 checks passed');\nprocess.exit(1);\n`);
  comp('comp-nosuite', null);
  // a binary riding inside the good component — excludable, never silent
  writeFileSync(join(root, 'comp-good', 'lib', 'blob.bin'), Buffer.from([0x00, 0x01, 0x02, 0xff]));
  return root;
}

function fakeGh(remote) {
  const calls = { push: 0, pr: 0, branch: 0 };
  return {
    calls,
    async remoteBlob(path) { return remote.has(path) ? blobSha(remote.get(path)) : null; },
    async branchHead() { return null; },
    async createBranch() { calls.branch += 1; },
    async pushFiles() { calls.push += 1; return { commit: 'c'.repeat(40) }; },
    async createPullRequest() { calls.pr += 1; return { url: 'https://github.com/ronininc/kingmaker/pull/99', number: 99 }; },
  };
}

/* ---------------- the proof gate ---------------- */
{
  const root = makeTree();
  const good = proveComponents({ root, components: [{ path: 'comp-good' }] });
  ok('a green suite proves', good.ok && good.results[0].counts.passed === 3);
  const broken = proveComponents({ root, components: [{ path: 'comp-broken' }] });
  ok('a red suite does not prove', !broken.ok && broken.results[0].ok === false);
  const nosuite = proveComponents({ root, components: [{ path: 'comp-nosuite' }] });
  ok('no suite = unproven = refused', !nosuite.ok && nosuite.results[0].entry === null);
}

/* ---------------- promotion: happy path, dry run, and the refusal ---------------- */
{
  const root = makeTree();
  const thingBytes = readFileSync(join(root, 'comp-good', 'lib', 'thing.mjs'));
  const suiteBytes = readFileSync(join(root, 'comp-good', 'tests', 'run-tests.mjs'));
  // public main already carries the suite file byte-identical; the lib file is new there
  const remote = new Map([['comp-good/tests/run-tests.mjs', suiteBytes]]);
  const gh = fakeGh(remote);
  const stage = join(root, 'stage');
  const v = await promote({ root, version: '0.5.0', components: [{ path: 'comp-good' }], branch: 'promote-0.5.0', stageDir: stage, dryRun: true, gh });
  ok('dry run succeeds on proof', v.ok && v.stage === 'staged');
  ok('delta is only what public main lacks', JSON.stringify(v.delta) === JSON.stringify(['comp-good/lib/thing.mjs']));
  ok('byte-identical file stays home', v.identical.includes('comp-good/tests/run-tests.mjs'));
  ok('the binary is excluded and named', v.excluded.length === 1 && v.excluded[0].path === 'comp-good/lib/blob.bin');
  ok('dry run pushes nothing', gh.calls.push === 0 && gh.calls.pr === 0);
  ok('proof manifest staged', existsSync(join(stage, 'proof-manifest.json')));
  const body = readFileSync(join(stage, 'pr-body.md'), 'utf8');
  ok('PR body carries the in-layout proof table', body.includes('| comp-good | tests/run-tests.mjs | PASS | 3/3 |'));
  ok('PR body names the excluded binary', body.includes('comp-good/lib/blob.bin'));
  ok('staged delta file matches the proven bytes', readFileSync(join(stage, 'comp-good', 'lib', 'thing.mjs')).equals(thingBytes));

  const gh2 = fakeGh(remote);
  const v2 = await promote({ root, version: '0.5.0', components: [{ path: 'comp-good' }], branch: 'promote-0.5.0', stageDir: join(root, 'stage2'), gh: gh2 });
  ok('a real run opens exactly one PR', v2.ok && v2.stage === 'pr' && gh2.calls.push === 1 && gh2.calls.pr === 1 && gh2.calls.branch === 1);

  // THE NEGATIVE TEST: a deliberately failing component is refused at the
  // proof gate — nothing staged for push, no branch, no PR.
  const gh3 = fakeGh(new Map());
  const v3 = await promote({ root, version: '0.5.0', components: [{ path: 'comp-broken' }], branch: 'promote-0.5.0', stageDir: join(root, 'stage3'), gh: gh3 });
  ok('NEGATIVE: a failing component is refused', !v3.ok && v3.stage === 'proof');
  ok('NEGATIVE: refusal pushes nothing and opens no PR', gh3.calls.push === 0 && gh3.calls.pr === 0 && gh3.calls.branch === 0);

  const v4 = await promote({ root, components: [{ path: 'comp-good' }], branch: 'x', stageDir: join(root, 'stage4'), dryRun: true, gh: fakeGh(new Map()) });
  ok('no version → refused (the version is the founder\'s call, never a default)', !v4.ok && v4.stage === 'input');
}

/* ---------------- the per-platform shape ---------------- */
{
  ok('placeholder with artifacts is a contradiction', platformsProblems({ macos: { status: 'ready', artifacts: [{ name: 'a', sha256: H('a'), size: 1 }], signature: 's' }, linux: { status: 'placeholder', artifacts: [{ name: 'b', sha256: H('b'), size: 1 }], signature: null } }).some((p) => p.includes('placeholder but carries')));
  ok('ready without a signature is refused', platformsProblems({ macos: { status: 'ready', artifacts: [{ name: 'a', sha256: H('a'), size: 1 }], signature: null } }).some((p) => p.includes('no signature')));
  ok('an unknown platform is refused', platformsProblems({ plan9: { status: 'placeholder', artifacts: [], signature: null }, macos: { status: 'ready', artifacts: [{ name: 'a', sha256: H('a'), size: 1 }], signature: 's' } }).some((p) => p.includes('unknown platform')));
  ok('macos missing is a problem; linux/windows may be absent', platformsProblems({ linux: { status: 'placeholder', artifacts: [], signature: null } }).some((p) => p.includes('platforms.macos is missing')));

  const parts = [{ name: 'Kingmaker-0.5.0.tar.gz.part01', size: 10, sha256: H('a') }, { name: 'Kingmaker-0.5.0.tar.gz.part02', size: 5, sha256: H('b') }];
  const manifest = { version: '0.5.0', tag: 'v0.5.0', engine: { sha256: H('e') }, app: { archive: 'Kingmaker-0.5.0.tar.gz' }, parts, platforms: { linux: { status: 'placeholder', artifacts: [], signature: null } } };
  const latest = buildLatest({ manifest });
  ok('latest keeps the legacy top level exactly', latest.version === '0.5.0' && latest.tag === 'v0.5.0' && latest.engineSha256 === H('e') && latest.archive === 'Kingmaker-0.5.0.tar.gz');
  ok('latest gains the platforms map; macos synthesized from the parts', latest.platforms.macos.status === 'ready' && latest.platforms.macos.artifacts.length === 2 && latest.platforms.linux.status === 'placeholder');
  ok('a pre-platforms latest.json still validates (backward compat)', latestProblems({ version: '0.4.2', tag: 'v0.4.2', engineSha256: null, archive: null }).length === 0);
  ok('the built latest validates', latestProblems(latest).length === 0);

  const objs = platformObjects({ version: '0.5.0', platforms: { macos: latest.platforms.macos, linux: { status: 'ready', artifacts: [{ name: 'kingmaker-linux.tar.gz', sha256: H('c'), size: 7 }], signature: 'v0.5.0/linux.sig' }, windows: { status: 'placeholder', artifacts: [], signature: null } }, dir: '/rel' });
  ok('platform objects: only ready non-mac artifacts, platform-keyed', objs.length === 1 && objs[0].key === 'v0.5.0/linux/kingmaker-linux.tar.gz' && objs[0].file === '/rel/linux/kingmaker-linux.tar.gz');
}

/* ---------------- manifest + installer-plan wiring ---------------- */
{
  const launcher = { name: 'Ronin Launcher.app', format: 'zip', required: true, version: '0.3.1', archive: 'Ronin-Launcher.zip', sha256: H('d'), size: 123 };
  const base = { version: '0.5.0', tag: 'v0.5.0', app: { bundleId: 'com.ronininc.solghost', version: '0.5.0' }, archive: { name: 'Kingmaker-0.5.0.tar.gz', size: 15, sha256: H('f') }, parts: [{ name: 'Kingmaker-0.5.0.tar.gz.part01', size: 10, sha256: H('a') }, { name: 'Kingmaker-0.5.0.tar.gz.part02', size: 5, sha256: H('b') }], partSize: 100, launcher };
  const m = buildManifest({ ...base, platforms: { linux: { status: 'placeholder', artifacts: [], signature: null }, windows: { status: 'placeholder', artifacts: [], signature: null } } });
  ok('buildManifest carries platforms; macos IS the parts', m.platforms.macos.artifacts.length === 2 && m.platforms.linux.status === 'placeholder' && manifestProblems(m).length === 0);
  assert.throws(() => buildManifest({ ...base, platforms: { linux: { status: 'ready', artifacts: [{ name: 'x', sha256: H('c'), size: 1 }], signature: null } } }), /no signature/); passed += 1; console.log('  ok - buildManifest refuses a ready platform with no signature');
  const drifted = JSON.parse(JSON.stringify(m));
  drifted.platforms.macos.artifacts[0].sha256 = H('9');
  ok('a macos platform set that disagrees with the parts is refused', manifestProblems(drifted).some((p) => p.includes('disagrees with the part')));

  const plan0 = planPlatforms(base);
  ok('planPlatforms: pre-platforms manifest synthesizes macos, no problems', plan0.declared === false && plan0.problems.length === 0 && plan0.platforms.macos.artifacts.length === 2);
  const plan1 = planPlatforms(m);
  ok('planPlatforms: declared platforms recorded', plan1.declared === true && plan1.platforms.linux.status === 'placeholder' && plan1.problems.length === 0);
  ok('planPlatforms: drifted macos set is a problem', planPlatforms(drifted).problems.some((p) => p.includes('disagrees')));
}

console.log(`promotion: ${passed} checks passed`);
