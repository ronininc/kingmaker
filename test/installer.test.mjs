// Kingmaker Installer: the release payload (parts ≤ 1.9 GB + manifest, every sha256 pinned), the install engine
// (installer/engine.sh) driven end to end against a local server, all-or-nothing staging, the cemented wake word,
// resumable downloads, and the private-repo token path. macOS only (codesign, plutil, bsdtar).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFixtureRelease, fakeTools, isDir, isFile, runEngine, serveRelease } from './fixtures/installer-fixtures.mjs';
import { spawnSync } from 'node:child_process';
import { buildManifest, launcherProblems, macosBelow, MAX_PART_BYTES, manifestProblems, MIN_MACOS, partName, shipProblems, splitStream, verifyParts } from '../lib/release-manifest.mjs';
import { installerModels, manifestPacks, plannedModels, registryManifestUrl, tailscalePin } from '../scripts/release-parts.mjs';
import { readInstallConfig } from '../lib/install-config.mjs';
import { Readable } from 'node:stream';

const mac = process.platform === 'darwin';
const opts = { skip: !mac && 'macOS only', timeout: 120_000 };

// One release for the whole file (the real release-parts script, over a small ad-hoc-signed Kingmaker.app).
let shared;
const release = async () => (shared ??= await buildFixtureRelease());

/** A hermetic world for one engine run: its own prefix, HOME, PATH (fake tools, no Homebrew) and Ollama URL. */
function world({ tools = {} } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'km-world-')));
  const home = join(root, 'real-home');
  mkdirSync(home, { recursive: true });
  const PATH = fakeTools(join(root, 'bin'), { 'xcode-select': 'echo /Library/Developer/CommandLineTools', ollama: 'exit 0', peekaboo: 'exit 0', sox: 'exit 0', 'python3.12': 'exit 0', brew: `echo "brew $*" >> "${join(root, 'brew.calls')}"`, ...tools });
  return { root, prefix: join(root, 'prefix'), home, env: { HOME: home, KINGMAKER_PATH: PATH, KINGMAKER_OLLAMA_URL: 'http://127.0.0.1:9/none' } };
}
const appIn = (w) => join(w.prefix, 'Applications', 'Kingmaker.app');
const dataIn = (w) => join(w.prefix, 'home', 'Library', 'Application Support', 'sol-ghost');
const cacheIn = (w, tag = 'v0.2.0') => join(w.prefix, 'home', 'Library', 'Caches', 'Kingmaker Installer', tag);

test('release parts: the archive splits into parts no bigger than asked, every sha256 pinned, re-read and verified', opts, async () => {
  const r = await release();
  const m = r.manifest;
  assert.deepEqual(manifestProblems(m), []);
  assert.ok(m.parts.length >= 3, `the fixture splits into ${m.parts.length} parts`);
  assert.ok(m.parts.every((p) => p.size <= 100_000) && m.parts.reduce((n, p) => n + p.size, 0) === m.app.size, 'each part ≤ the part size; they add up to the archive');
  assert.deepEqual(m.parts.map((p) => p.name), m.parts.map((_, i) => partName(m.app.archive, i, m.parts.length)));
  assert.equal(m.app.bundleId, 'com.ronininc.solghost');
  assert.equal(m.app.signing, 'ad-hoc');
  assert.deepEqual((await verifyParts(m, r.out)).problems, []);
  const sums = readFileSync(join(r.out, 'SHA256SUMS'), 'utf8').trim().split('\n');
  assert.equal(sums.length, m.parts.length + 2, 'SHA256SUMS lists every part, the Ronin Launcher zip and the manifest');
  assert.deepEqual(launcherProblems(m.launcher, { required: true }), [], 'the Ronin Launcher is pinned (required)');
  assert.ok(existsSync(join(r.out, m.launcher.archive)), 'its zip rides in the release folder');
  assert.ok(m.knowledge.corpora.length === 2 && m.knowledge.corpora.every((c) => c.id !== 'stackexchange'), 'only the confirmed corpora, read from the app\'s own bootstrap script');
  assert.equal(m.searxng.pin, '12f8b6515ca77c3c3bc1498584950ef5daca1433');
  assert.deepEqual(m.brew.map((b) => b.formula), ['openclaw/tap/peekaboo', 'sox', 'python@3.12']);
  assert.match(r.lines.join('\n'), /Not published\./, 'it never publishes; it prints the gh command');
});

test('manifest rules: 1.9 GB per part at most, the parts must add up, digests are sha256; a tampered part is caught', opts, async () => {
  assert.equal(MAX_PART_BYTES, 1_900_000_000);
  const r = await release();
  const big = structuredClone(r.manifest);
  big.parts[0].size = MAX_PART_BYTES + 1;
  assert.ok(manifestProblems(big).some((p) => /outside 1…1900000000/.test(p)));
  const short = structuredClone(r.manifest);
  short.parts.pop();
  assert.ok(manifestProblems(short).some((p) => /add up to/.test(p)));
  const copy = mkdtempSync(join(tmpdir(), 'km-tamper-'));
  for (const p of r.manifest.parts) writeFileSync(join(copy, p.name), readFileSync(join(r.out, p.name)));
  const bytes = readFileSync(join(copy, r.manifest.parts[1].name));
  bytes[10] ^= 1;
  writeFileSync(join(copy, r.manifest.parts[1].name), bytes);
  const check = await verifyParts(r.manifest, copy);
  assert.equal(check.ok, false);
  assert.match(check.problems.join(' '), /part02 sha256 .* does not match/);
  // A dry run streams the same bytes through the same hashes and writes nothing.
  const dry = await splitStream(Readable.from([Buffer.from('abcdefghij')]), { partSize: 4, outDir: null, archive: 'x.tar.gz' });
  assert.deepEqual(dry.parts.map((p) => [p.name, p.size]), [['x.tar.gz.part01', 4], ['x.tar.gz.part02', 4], ['x.tar.gz.part03', 2]]);
  assert.equal(dry.parts.some((p) => p.file), false);
  assert.throws(() => splitStream(Readable.from([]), { partSize: MAX_PART_BYTES + 1 }), /part size/);
});

test('release pins: the abliterated models plus the coder sized to the Mac; registry URLs', () => {
  const models = plannedModels();
  assert.ok(models.some((m) => m.name === 'huihui_ai/qwen3-abliterated:1.7b' && m.roles.includes('SOLOMON_OLLAMA_MODEL')));
  assert.deepEqual(models.filter((m) => /coder/.test(m.name)).map((m) => [m.name, m.maxMemGb ?? null, m.minMemGb ?? null]), [['huihui_ai/qwen2.5-coder-abliterate:1.5b', 16, null], ['huihui_ai/qwen2.5-coder-abliterate:7b', null, 16]]);
  assert.equal(registryManifestUrl('huihui_ai/qwen3-abliterated:0.6b'), 'https://registry.ollama.ai/v2/huihui_ai/qwen3-abliterated/manifests/0.6b');
  assert.equal(registryManifestUrl('qwen3'), 'https://registry.ollama.ai/v2/library/qwen3/manifests/latest');
  assert.equal(registryManifestUrl('hf.co/mradermacher/Huihui-granite-4.1-3b-abliterated-i1-GGUF:i1-Q4_K_M'), 'https://hf.co/v2/mradermacher/Huihui-granite-4.1-3b-abliterated-i1-GGUF/manifests/i1-Q4_K_M', 'hf.co models pin from Hugging Face');
});

test('profile packs: each pack model is pulled only for its packs, never twice, and the manifest lists every pack', () => {
  const all = installerModels();
  assert.equal(new Set(all.map((m) => m.name)).size, all.length, 'no model twice');
  for (const m of all.filter((x) => x.packs)) assert.match(m.packs, /^(8|16|24|32|48|64)(,(8|16|24|32|48|64))*$/);
  const packs = manifestPacks();
  assert.deepEqual(packs.map((p) => p.id), ['8', '16', '24', '32', '48', '64']);
  for (const p of packs) for (const m of p.models) assert.ok(all.some((x) => x.name === m.name), `${p.id}: ${m.name} is pulled`);
});

test('dry run into a temp prefix: downloads, verifies, unpacks, commits the app and the cemented wake word, touches nothing else', opts, async () => {
  const r = await release();
  const srv = await serveRelease(r.out);
  const w = world();
  try {
    const run = await runEngine(['--wake-word', 'Kingmaker', '--prefix', w.prefix, '--base-url', srv.url, '--manifest', r.manifestFile], w.env);
    assert.equal(run.code, 0, run.out);
    assert.equal(run.done?.dryRun, true);
    assert.equal(run.done?.launched, false, 'a dry run never launches anything');
    assert.ok(isFile(join(appIn(w), 'Contents', 'Info.plist')), 'Kingmaker.app is in the prefix');
    const config = readInstallConfig(dataIn(w));
    assert.equal(config.cemented, true);
    assert.equal(config.wakeWord, 'Kingmaker');
    assert.equal(config.release, 'v0.2.0');
    assert.equal(statSync(join(dataIn(w), 'install.json')).mode & 0o777, 0o444, 'install.json is read-only');
    assert.equal(readFileSync(join(dataIn(w), 'wake-word.txt'), 'utf8'), 'Hey Kingmaker\n', 'the engine learns its name from wake-word.txt');
    assert.equal(statSync(join(dataIn(w), 'wake-word.txt')).mode & 0o777, 0o444);
    const alias = join(w.prefix, 'home', 'Library', 'Application Support', 'Kingmaker');
    assert.ok(lstatSync(alias).isSymbolicLink() && readlinkSync(alias) === 'sol-ghost', 'the Kingmaker path is only a symlink to the sol-ghost data folder');
    assert.equal(existsSync(join(w.prefix, 'Applications', '.kingmaker-install')), false, 'no staging left behind');
    assert.equal(existsSync(join(cacheIn(w), 'parts')), false, 'the download cache is cleared after success');
    assert.deepEqual(readdirSync(w.home), [], 'the real HOME is never written in a dry run');
    const pcts = run.events.filter((e) => e.t === 'progress').map((e) => e.pct);
    assert.ok(pcts.every((p, i) => i === 0 || p >= pcts[i - 1] - 0.01) && pcts.at(-1) === 100, 'one progress bar, never going backwards, ending at 100');
    assert.match(run.out, /Would pull huihui_ai\/qwen3-abliterated:1\.7b/, 'the tools are only checked in a dry run');
    assert.match(run.out, /SearXNG: would: clone SearXNG/, 'SearXNG\'s installer ran in dry-run mode, under the app\'s own runtime');
    assert.match(run.out, /Would fetch 2 confirmed corpora/, 'the knowledge bootstrap ran in dry-run mode');
    assert.equal(srv.seen.filter((s) => s.url.includes('.part')).length, r.manifest.parts.length, 'each part fetched once');
    const inspect = await runEngine(['--inspect', '--prefix', w.prefix, '--manifest', r.manifestFile], w.env);
    const { memGb, chip, freeGb, recommendedPack, packs, ...facts } = JSON.parse(inspect.out);
    assert.deepEqual(facts, { installed: true, app: appIn(w), legacyApp: '', cemented: true, wakeWord: 'Kingmaker', release: 'v0.2.0', version: '0.2.0' });
    // The launcher's facts for the profile packs: this Mac's memory and the pack it should take.
    assert.ok(memGb >= 8 && typeof chip === 'string' && typeof freeGb === 'number' && Array.isArray(packs));
    assert.match(recommendedPack, /^(8|16|24|32|48|64)$/);
  } finally { await srv.close(); }
});

test('a part that does not match its sha256 fails the install: nothing is in place, the good parts are kept', opts, async () => {
  const r = await release();
  const bad = r.manifest.parts[1].name;
  const srv = await serveRelease(r.out, { corrupt: { [bad]: true } });
  const w = world();
  try {
    const run = await runEngine(['--wake-word', 'Kingmaker', '--prefix', w.prefix, '--base-url', srv.url, '--manifest', r.manifestFile], w.env);
    assert.equal(run.code, 1);
    assert.match(run.failed.message, new RegExp(`Part ${bad.replace(/\./g, '\\.')} did not download or did not match its sha256, twice`));
    assert.equal(run.failed.nothingInstalled, true);
    assert.equal(existsSync(appIn(w)), false, 'no Kingmaker.app');
    assert.equal(existsSync(join(dataIn(w), 'install.json')), false, 'no install.json');
    assert.equal(existsSync(join(w.prefix, 'Applications', '.kingmaker-install')), false, 'no staging');
    assert.ok(isFile(join(cacheIn(w), 'parts', r.manifest.parts[0].name)), 'the verified first part is kept for the next try');
    assert.equal(existsSync(join(cacheIn(w), 'parts', bad)), false, 'the bad part is not kept');
    assert.equal(srv.seen.filter((s) => s.url.endsWith(bad)).length, 2, 'retried once from scratch before giving up');
  } finally { await srv.close(); }
});

test('resumable: a download cut off mid-part resumes from where it stopped on the next press', opts, async () => {
  const r = await release();
  const part = r.manifest.parts[2];
  const srv = await serveRelease(r.out, { dropOnce: { [part.name]: 40_000 } });
  const w = world();
  try {
    const first = await runEngine(['--wake-word', 'Kingmaker', '--prefix', w.prefix, '--base-url', srv.url, '--manifest', r.manifestFile], w.env);
    const firstPartial = join(cacheIn(w), 'parts', `${part.name}.partial`);
    if (first.code === 0) {
      // curl resumed by itself inside the same run (its own retry): it must have asked for the rest by Range.
      assert.ok(srv.seen.some((s) => s.url.endsWith(part.name) && /^bytes=4\d{4}-$/.test(s.range ?? '')), 'resumed by Range within the run');
    } else {
      assert.equal(existsSync(appIn(w)), false, 'the cut-off run installed nothing');
      assert.ok(statSync(firstPartial).size >= 40_000, 'the partial part is kept');
      const before = srv.seen.length;
      const second = await runEngine(['--wake-word', 'Kingmaker', '--prefix', w.prefix, '--base-url', srv.url, '--manifest', r.manifestFile], w.env);
      assert.equal(second.code, 0, second.out);
      const again = srv.seen.slice(before);
      assert.ok(again.some((s) => s.url.endsWith(part.name) && /^bytes=\d+-$/.test(s.range ?? '') && Number(/\d+/.exec(s.range)[0]) >= 40_000), `the second run asked for the rest by Range: ${JSON.stringify(again.map((s) => [s.url, s.range]))}`);
      assert.equal(again.filter((s) => s.url.endsWith(r.manifest.parts[0].name)).length, 0, 'verified parts are not downloaded again');
    }
    assert.ok(isDir(appIn(w)), 'installed in the end');
  } finally { await srv.close(); }
});

test('all or nothing: a failure while moving into place puts everything back, including an old Sol Ghost.app and its data', opts, async () => {
  const r = await release();
  const srv = await serveRelease(r.out);
  try {
    for (const step of ['commit-app', 'commit-config', 'commit-done']) {
      const w = world();
      const legacy = join(w.prefix, 'Applications', 'Sol Ghost.app');
      mkdirSync(join(legacy, 'Contents'), { recursive: true });
      writeFileSync(join(legacy, 'Contents', 'marker'), 'old app');
      mkdirSync(join(dataIn(w), 'runtime'), { recursive: true });
      writeFileSync(join(dataIn(w), 'runtime', 'vault.db'), 'keys');
      const run = await runEngine(['--wake-word', 'Kingmaker', '--prefix', w.prefix, '--base-url', srv.url, '--manifest', r.manifestFile], { ...w.env, KINGMAKER_FAIL_AT: step });
      assert.equal(run.code, 1, `${step}: fails`);
      assert.equal(existsSync(appIn(w)), false, `${step}: no Kingmaker.app left in place`);
      assert.equal(readFileSync(join(legacy, 'Contents', 'marker'), 'utf8'), 'old app', `${step}: the old Sol Ghost.app is back where it was`);
      assert.equal(existsSync(join(dataIn(w), 'install.json')), false, `${step}: no install.json`);
      assert.equal(existsSync(join(dataIn(w), 'wake-word.txt')), false, `${step}: no wake-word.txt`);
      assert.equal(readFileSync(join(dataIn(w), 'runtime', 'vault.db'), 'utf8'), 'keys', `${step}: the data folder is untouched`);
      assert.equal(existsSync(join(w.prefix, 'home', 'Library', 'Application Support', 'Kingmaker')), false, `${step}: no alias symlink`);
      assert.equal(existsSync(join(w.prefix, 'Applications', '.kingmaker-install')), false, `${step}: no staging left`);
    }
    // And when it succeeds, the old Sol Ghost.app goes to the Trash (not deleted).
    const w = world();
    mkdirSync(join(w.prefix, 'Applications', 'Sol Ghost.app', 'Contents'), { recursive: true });
    const ok = await runEngine(['--wake-word', 'Kingmaker', '--prefix', w.prefix, '--base-url', srv.url, '--manifest', r.manifestFile], w.env);
    assert.equal(ok.code, 0, ok.out);
    assert.equal(existsSync(join(w.prefix, 'Applications', 'Sol Ghost.app')), false);
    assert.ok(readdirSync(join(w.prefix, 'home', '.Trash')).some((n) => /^Sol Ghost .*\.app$/.test(n)), 'the old app is in the Trash');
  } finally { await srv.close(); }
});

test('all or nothing: a failure before the commit (knowledge, models, unpack) leaves nothing in place', opts, async () => {
  const r = await release();
  const srv = await serveRelease(r.out);
  try {
    for (const step of ['unpack', 'models', 'knowledge']) {
      const w = world();
      const run = await runEngine(['--wake-word', 'Kingmaker', '--prefix', w.prefix, '--base-url', srv.url, '--manifest', r.manifestFile], { ...w.env, KINGMAKER_FAIL_AT: step });
      assert.equal(run.code, 1);
      assert.equal(existsSync(appIn(w)), false, `${step}: no app`);
      assert.equal(existsSync(join(dataIn(w), 'install.json')), false, `${step}: no config`);
      assert.equal(existsSync(join(w.prefix, 'Applications', '.kingmaker-install')), false, `${step}: the unpacked app in staging is removed`);
    }
  } finally { await srv.close(); }
});

test('cemented: an installed Kingmaker keeps its word; a different one is refused until Kingmaker is deleted', opts, async () => {
  const r = await release();
  const srv = await serveRelease(r.out);
  const w = world();
  const run = (word) => runEngine(['--wake-word', word, '--prefix', w.prefix, '--base-url', srv.url, '--manifest', r.manifestFile], w.env);
  try {
    assert.equal((await run('Jarvis')).code, 0);
    const first = readFileSync(join(dataIn(w), 'install.json'), 'utf8');
    const refused = await run('Kingmaker');
    assert.equal(refused.code, 1);
    assert.match(refused.failed.message, /installed with the wake word "Jarvis", cemented at install\. To change it, delete Kingmaker/);
    assert.ok(isDir(appIn(w)), 'the installed app is untouched by the refusal');
    const update = await run('jarvis');
    assert.equal(update.code, 0, 'the same word (any case) is an update');
    assert.match(update.out, /the wake word stays "Jarvis" \(cemented\)/);
    assert.equal(readFileSync(join(dataIn(w), 'install.json'), 'utf8'), first, 'an update never rewrites install.json');
    rmSync(appIn(w), { recursive: true, force: true }); // "delete Kingmaker"
    assert.equal((await run('Friday')).code, 0, 'deleted, then reinstalled: a new word');
    assert.equal(readInstallConfig(dataIn(w)).wakeWord, 'Friday');
  } finally { await srv.close(); }
});

test('the engine applies the same wake word rule as the install screen', opts, async () => {
  const r = await release();
  for (const bad of ['R2D2', 'yes', 'one two three four', 'José', '']) {
    const w = world();
    const run = await runEngine(['--wake-word', bad, '--prefix', w.prefix, '--base-url', 'http://127.0.0.1:9', '--manifest', r.manifestFile], w.env);
    assert.equal(run.code, 1, bad);
    assert.match(run.failed.message, /1 to 3 words, letters only/, bad);
    assert.equal(existsSync(appIn(w)), false);
  }
});

test('private repo: assets come through the GitHub API with a token (header file, never argv or URL); without one, a plain answer', opts, async () => {
  const r = await release();
  const token = 'ghp_fixtureTOKEN0123456789';
  const srv = await serveRelease(r.out, { github: { repo: 'ronininc/Kingmaker', tag: 'v0.2.0', token } });
  try {
    const w = world();
    const run = await runEngine(['--wake-word', 'Kingmaker', '--prefix', w.prefix, '--manifest', r.manifestFile], { ...w.env, KINGMAKER_GITHUB_API: `${srv.url}/api`, KINGMAKER_GITHUB_TOKEN: token });
    assert.equal(run.code, 0, run.out);
    const assetCalls = srv.seen.filter((s) => /\/releases\/assets\/\d+$/.test(s.url));
    assert.equal(assetCalls.length, r.manifest.parts.length + 1, 'every part and the Ronin Launcher zip');
    assert.ok(assetCalls.every((s) => s.auth === `Bearer ${token}` && s.accept === 'application/octet-stream' && !s.url.includes(token)));
    assert.equal(run.out.includes(token), false, 'the token is never printed');
    assert.equal(existsSync(join(cacheIn(w), '.auth-header')), false, 'the header file is removed');
    const w2 = world();
    const denied = await runEngine(['--wake-word', 'Kingmaker', '--prefix', w2.prefix, '--manifest', r.manifestFile], { ...w2.env, KINGMAKER_GITHUB_API: `${srv.url}/api`, KINGMAKER_GITHUB_TOKEN: 'wrong' });
    assert.equal(denied.code, 1);
    assert.match(denied.failed.message, /GitHub sign-in/);
  } finally { await srv.close(); }
});

test('with a Kingmaker Release certificate pinned, an app signed by anything else is never installed', opts, async () => {
  const r = await release();
  const srv = await serveRelease(r.out);
  const w = world();
  try {
    // The fixture app is ad hoc signed: no pin accepts it. (An update brings the pin from the installed Kingmaker.)
    const run = await runEngine(['--wake-word', 'Kingmaker', '--prefix', w.prefix, '--base-url', srv.url, '--manifest', r.manifestFile], { ...w.env, KINGMAKER_EXPECT_LEAF: 'A1B2C3D4E5F60718293A4B5C6D7E8F9012345678' });
    assert.notEqual(run.code, 0);
    assert.match(run.out, /not signed by Ronin Inc\.'s Kingmaker Release certificate, so it was not installed/);
    assert.equal(isFile(join(appIn(w), 'Contents', 'Info.plist')), false, 'nothing landed');
    // A malformed pin is no pin: it can't be used to wedge an install either way.
    const bad = await runEngine(['--wake-word', 'Kingmaker', '--prefix', w.prefix, '--base-url', srv.url, '--manifest', r.manifestFile], { ...w.env, KINGMAKER_EXPECT_LEAF: 'not-a-hash' });
    assert.equal(bad.code, 0, bad.out);
  } finally { await srv.close(); }
});

test('an installer ships only when it can: packs, the launcher, the macOS floor, this version, and update enrollment', opts, async () => {
  const r = await release(), m = r.manifest;
  const enroll = { url: 'https://updates.example.com', code: 'c0de' };
  assert.deepEqual(shipProblems(m, { pkgVersion: m.version, enroll }), [], 'a release-parts.mjs manifest of this version, with enrollment, ships');
  assert.equal(m.requires.macos, MIN_MACOS);
  const why = (change, opts2 = {}) => shipProblems({ ...structuredClone(m), ...change }, { pkgVersion: m.version, enroll, ...opts2 }).join(' | ');
  assert.match(why({ packs: [] }), /carries no packs/);
  assert.match(why({ launcher: null }), /Ronin Launcher pin is not sound/);
  assert.match(why({ requires: { macos: '13.0', arch: 'arm64' } }), /declares macOS 13\.0, below Kingmaker's floor of 14\.0/);
  assert.match(why({ brew: [{ formula: 'openclaw/tap/peekaboo', bin: 'peekaboo' }] }), /no minMacos/);
  assert.match(why({}, { pkgVersion: '9.9.9' }), /but this checkout is 9\.9\.9/);
  assert.match(why({}, { enroll: null }), /would never get an update/);
  assert.match(why({}, { enroll: { url: 'http://x', code: 'c' } }), /must be https/);
  assert.ok(macosBelow('13.6', '14.0') && !macosBelow('14.0', '14.0') && !macosBelow('15.1', '14.0') && macosBelow('14.0', '14.1'));
  // The build script refuses before it builds anything (no DMG, nothing in --out).
  const out = mkdtempSync(join(tmpdir(), 'km-ship-'));
  const b = spawnSync('/bin/sh', [new URL('../scripts/build-installer.sh', import.meta.url).pathname, '--manifest', r.manifestFile, '--out', out],
    { encoding: 'utf8', env: { ...process.env, KINGMAKER_ENROLL_URL: '', KINGMAKER_ENROLL_CODE: '' } });
  assert.equal(b.status, 3, b.stdout + b.stderr);
  assert.match(b.stderr, /never get an update/); assert.match(b.stderr, /no DMG was built/);
  assert.deepEqual(readdirSync(out), []);
});

test('a tool that needs a newer macOS than this Mac is left out, said plainly, and the install still finishes', opts, async () => {
  const r = await release();
  assert.equal(r.manifest.brew[0].minMacos, '15.0', 'Hands of Horus needs macOS 15');
  // This Mac is older than the tool needs: the manifest asks for macOS 99.
  // A copy: the fixture release is shared by every test here.
  const m = JSON.parse(readFileSync(r.manifestFile, 'utf8')); m.brew[0].minMacos = '99.0';
  const manifestFile = join(mkdtempSync(join(tmpdir(), 'km-newer-')), 'kingmaker-manifest.json'); writeFileSync(manifestFile, JSON.stringify(m));
  const installed = new Map(m.models.map((x) => [x.name, x.digest]));
  const ollama = (req, res) => {
    if (req.url === '/api/tags') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ models: [...installed].map(([name, digest]) => ({ name, digest })) })); }
    if (req.url === '/api/pull') {   // a pack's model this world hasn't got: pulled, unpinned
      let body = ''; req.on('data', (d) => { body += d; });
      req.on('end', () => { const { model } = JSON.parse(body); installed.set(model, 'c'.repeat(64)); res.end(`${JSON.stringify({ status: 'success' })}\n`); });
      return undefined;
    }
    res.statusCode = 404; return res.end();
  };
  const srv = await serveRelease(r.out, { ollama });
  try {
    const w = world();
    rmSync(join(w.root, 'bin', 'peekaboo'));
    const run = await runEngine(['--wake-word', 'Kingmaker', '--prefix', w.prefix, '--with-tools', '--base-url', srv.url, '--manifest', manifestFile], { ...w.env, KINGMAKER_OLLAMA_URL: srv.url });
    assert.equal(run.code, 0, run.out);
    assert.match(run.out, /Hands of Horus \(Peekaboo\) needs macOS 99\.0; this Mac has [\d.]+, so it's left out\. Kingmaker works without it/);
    const calls = existsSync(join(w.root, 'brew.calls')) ? readFileSync(join(w.root, 'brew.calls'), 'utf8') : '';
    assert.doesNotMatch(calls, /peekaboo/, 'never brewed');
  } finally { await srv.close(); }
});

test('with the tools live (fakes): missing models are pulled and must match their pinned digest; a missing formula is brewed', opts, async () => {
  const r = await release();
  const installed = new Map([['huihui_ai/qwen3-abliterated:1.7b', 'a'.repeat(64)]]);
  let serveDigest = (name) => r.manifest.models.find((m) => m.name === name)?.digest;
  const ollama = (req, res) => {
    if (req.url === '/api/tags') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ models: [...installed].map(([name, digest]) => ({ name, digest })) })); }
    if (req.url === '/api/pull') {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        const { model } = JSON.parse(body);
        res.write(`${JSON.stringify({ status: 'pulling manifest' })}\n`);
        res.write(`${JSON.stringify({ status: 'pulling abc', total: 100, completed: 50 })}\n`);
        res.write(`${JSON.stringify({ status: 'pulling abc', total: 100, completed: 100 })}\n`);
        installed.set(model, serveDigest(model));
        res.end(`${JSON.stringify({ status: 'success' })}\n`);
      });
      return undefined;
    }
    res.statusCode = 404; return res.end();
  };
  const srv = await serveRelease(r.out, { ollama });
  try {
    const w = world();
    rmSync(join(w.root, 'bin', 'peekaboo'));
    const env = { ...w.env, KINGMAKER_OLLAMA_URL: srv.url };
    const run = await runEngine(['--wake-word', 'Kingmaker', '--prefix', w.prefix, '--with-tools', '--base-url', srv.url, '--manifest', r.manifestFile], env);
    assert.equal(run.code, 0, run.out);
    assert.match(run.out, /huihui_ai\/qwen3-abliterated:1\.7b is here, digest matches the release's pin/);
    assert.match(run.out, /Pulled huihui_ai\/qwen3-abliterated:0\.6b \(digest matches the pin\)/);
    assert.ok(installed.has('huihui_ai/qwen2.5-coder-abliterate:1.5b') !== installed.has('huihui_ai/qwen2.5-coder-abliterate:7b'), 'exactly one coder, sized to this Mac');
    assert.match(readFileSync(join(w.root, 'brew.calls'), 'utf8'), /^brew install openclaw\/tap\/peekaboo$/m, 'the missing Hands of Horus came from Homebrew');
    assert.ok(isFile(join(w.prefix, 'home', 'Library', 'Application Support', 'solomon-desktop', 'services', 'searxng-native', 'commit.txt')), 'SearXNG set up');
    assert.ok(isFile(join(dataIn(w), 'runtime', 'data', 'knowledge', 'sources', '.receipts', 'kaikki-multilingual.json')), 'the knowledge library moved into place');
    // A model that changed upstream since the release was built is refused, and nothing lands.
    installed.clear();
    serveDigest = () => 'f'.repeat(64);
    const w2 = world();
    const drift = await runEngine(['--wake-word', 'Kingmaker', '--prefix', w2.prefix, '--with-tools', '--base-url', srv.url, '--manifest', r.manifestFile], { ...w2.env, KINGMAKER_OLLAMA_URL: srv.url });
    assert.equal(drift.code, 1);
    assert.match(drift.failed.message, /changed upstream/);
    assert.equal(existsSync(appIn(w2)), false);
    // A corpus that fails to download: nothing lands, what came down is kept for the next press.
    const w3 = world();
    serveDigest = (name) => r.manifest.models.find((m) => m.name === name)?.digest;
    const partial = await runEngine(['--wake-word', 'Kingmaker', '--prefix', w3.prefix, '--with-tools', '--base-url', srv.url, '--manifest', r.manifestFile], { ...w3.env, KINGMAKER_OLLAMA_URL: srv.url, KM_FAKE_CORPUS_FAIL: 'kaikki-multilingual' });
    assert.equal(partial.code, 1);
    assert.match(partial.failed.message, /knowledge library is not complete/);
    assert.equal(existsSync(appIn(w3)), false);
    assert.ok(isFile(join(dataIn(w3), '.install-staging', 'knowledge', 'sources', '.receipts', 'spec-standards.json')), 'the corpus that did come down is kept in staging');
    assert.equal(existsSync(join(dataIn(w3), 'runtime')), false, 'and nothing is in the live data folder');
  } finally { await srv.close(); }
});

test('the terms hook: the install screen needs "I accept" (TERMS.md readable), and install.json records which text was accepted', opts, async () => {
  const swift = readFileSync(new URL('../installer/KingmakerInstaller.swift', import.meta.url), 'utf8');
  assert.match(swift, /if TermsHook\.required && !termsAccepted \{ return "terms" \}/, 'the button is blocked until the box is ticked');
  assert.match(swift, /\.disabled\(installer\.blocker != nil\)/);
  assert.match(swift, /static let checkboxLabel = "I agree to the Kingmaker Terms and License"/);
  assert.doesNotMatch(swift, /PLACEHOLDER wording/);
  assert.match(swift, /\.sheet\(isPresented: \$installer\.showingTerms\) \{ TermsSheet/, 'TERMS.md is readable in the window');
  assert.match(readFileSync(new URL('../scripts/build-installer.sh', import.meta.url), 'utf8'), /cp "\$here\/TERMS\.md" "\$app\/Contents\/Resources\/TERMS\.md"/);
  assert.match(readFileSync(new URL('../installer/Info.plist', import.meta.url), 'utf8'), /<key>KingmakerTermsRequired<\/key><true\/>/);
  const r = await release();
  const srv = await serveRelease(r.out);
  try {
    const sha = 'ab'.repeat(32);
    const w = world();
    const run = await runEngine(['--wake-word', 'Kingmaker', '--terms-accepted', sha, '--prefix', w.prefix, '--base-url', srv.url, '--manifest', r.manifestFile], w.env);
    assert.equal(run.code, 0, run.out);
    const config = JSON.parse(readFileSync(join(dataIn(w), 'install.json'), 'utf8'));
    assert.equal(config.termsAccepted.sha256, sha);
    assert.match(config.termsAccepted.at, /^\d{4}-\d\d-\d\dT/);
    assert.equal(readInstallConfig(dataIn(w)).wakeWord, 'Kingmaker', 'the extra field never breaks reading the cemented word');
    const w2 = world();
    const bad = await runEngine(['--wake-word', 'Kingmaker', '--terms-accepted', 'not-a-sha', '--prefix', w2.prefix, '--base-url', srv.url, '--manifest', r.manifestFile], w2.env);
    assert.equal(bad.code, 1);
    assert.match(bad.failed.message, /named by their sha256/);
  } finally { await srv.close(); }
});

test('the Ronin Launcher installs beside Kingmaker (required): placed after verify; a tampered zip installs nothing; a release without its pin is refused', opts, async () => {
  const r = await release();
  const ok = await serveRelease(r.out);
  const w = world();
  try {
    const run = await runEngine(['--wake-word', 'Kingmaker', '--prefix', w.prefix, '--base-url', ok.url, '--manifest', r.manifestFile], w.env);
    assert.equal(run.code, 0, run.out);
    const placed = join(w.prefix, 'Applications', 'Ronin Launcher.app');
    assert.ok(isFile(join(placed, 'Contents', 'Info.plist')), 'Ronin Launcher.app is beside Kingmaker.app');
    assert.equal(spawnSync('codesign', ['--verify', '--deep', '--strict', placed]).status, 0, 'its signature still checks');
  } finally { await ok.close(); }
  const bad = await serveRelease(r.out, { corrupt: { [r.manifest.launcher.archive]: true } });
  const w2 = world();
  try {
    const run = await runEngine(['--wake-word', 'Kingmaker', '--prefix', w2.prefix, '--base-url', bad.url, '--manifest', r.manifestFile], w2.env);
    assert.equal(run.code, 1);
    assert.match(run.failed.message, /Ronin Launcher did not download or did not match its sha256/);
    assert.equal(existsSync(appIn(w2)), false, 'no Kingmaker.app either: it is a required part');
    assert.equal(existsSync(join(w2.prefix, 'Applications', 'Ronin Launcher.app')), false);
  } finally { await bad.close(); }
  const { launcher: _l, ...withoutPin } = r.manifest;
  assert.deepEqual(manifestProblems(withoutPin), [], 'an older release (no pin) still reads');
  assert.throws(() => buildManifest({ ...withoutPin, app: { bundleId: r.manifest.app.bundleId }, archive: { name: r.manifest.app.archive, size: r.manifest.app.size, sha256: r.manifest.app.sha256 } }), /Ronin Launcher is a required part/);
});

test('the installer shows the community download count from ronininc.org, and nothing when it cannot reach it', () => {
  const swift = readFileSync(new URL('../installer/KingmakerInstaller.swift', import.meta.url), 'utf8');
  assert.match(swift, /URL\(string: "https:\/\/www\.ronininc\.org\/api\/kingmaker\/community"\)/);
  assert.match(swift, /obj\["downloads"\] as\? NSNumber/, 'reads the public endpoint\'s downloads');
  assert.match(swift, /if let line = community\.line \{/, 'shown only once a count arrived');
  assert.doesNotMatch(swift.slice(swift.indexOf('final class Community'), swift.indexOf('struct InstallerView')), /hostName|serialNumber|installId|device/, 'the request carries nothing about this Mac');
});

test('Tailscale is pinned from its own stable index, its package hashed and checked against the sha256 it publishes', async () => {
  const { createHash } = await import('node:crypto');
  const pkg = Buffer.from('fake tailscale pkg');
  const good = createHash('sha256').update(pkg).digest('hex');
  const host = (sha) => async (url) => ({
    json: async () => ({ MacZipsVersion: '1.104.1' }),
    text: async () => `${sha}  Tailscale-1.104.1-macos.pkg\n`,
    arrayBuffer: async () => pkg,
    url,
  });
  const pin = await tailscalePin({ fetcher: host(good), base: 'https://pkgs.example/stable' });
  assert.deepEqual(pin, { version: '1.104.1', name: 'Tailscale-1.104.1-macos.pkg', url: 'https://pkgs.example/stable/Tailscale-1.104.1-macos.pkg', sha256: good, size: pkg.length });
  await assert.rejects(tailscalePin({ fetcher: host('0'.repeat(64)), base: 'https://pkgs.example/stable' }), /does not match/);
});
