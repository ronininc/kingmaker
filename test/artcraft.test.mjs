// The ArtCraft apps on Kingmaker (lib/artcraft.mjs, the craft CLI, the MCP tools). Hermetic: git, cargo and the
// server are fakes; files are written only under a temp folder.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildSignals, busyJobs, cargoBuildArgv, cargoBuildEnv, cargoVersion, classifyCraftAsk, CRAFT_APP_IDS, CRAFT_APPS, CRAFT_MANIFEST, craftApp, craftBackendEnv, craftBinDir,
  craftDataRoot, craftDoctor, craftDoctorLines, craftInboxDir, craftTurnText, defaultJobs, DISK_FLOOR_BYTES, installCraftApps, readCraftManifest, ROOM_BACKOFF_MS,
  roomReasons, sha256File, engineCraftLine, stageCraftInput, waitForRoom,
} from '../lib/artcraft.mjs';
import { consoleCraftTurn, craftOutputLines, parseCraftArgs, splitConsoleWords } from '../lib/cli.mjs';
import { callTool, handleMessage, READ_BACK_NOTE, serveStdio, TOOLS } from '../lib/mcp.mjs';
import { READ_BACK_LINE, turn } from '../lib/client.mjs';
import { PassThrough } from 'node:stream';
import { DESKTOP_NONCE_HEADER, ghostBackendEnv } from '../lib/profile.mjs';
import { MIN_DUTY, nextDuty } from '../lib/pacer.mjs';
import { classifyLine } from '../lib/session.mjs';
import { FORK_DIR } from '../lib/fork.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = () => mkdtempSync(join(tmpdir(), 'sg-craft-'));
const paths = { runtimeHome: '/Users/owner/Library/Application Support/sol-ghost/runtime', state: '/Users/owner/Library/Application Support/sol-ghost', userData: '/u', logs: '/l', resources: '/r', voice: { wakePhraseFile: '/w' } };
const app = (id) => craftApp(id);

const ADAPTER = join(root, FORK_DIR, 'server/src/runtime/artcraft/artcraft-apps.ts');

test('the seven apps are the adapter\'s seven, at the commits its evaluation verified, under the CLI names it looks for', { skip: !existsSync(ADAPTER) && 'the engine\'s source is not in this checkout' }, () => {
  assert.deepEqual(CRAFT_APP_IDS, ['photocraft', 'vectorcraft', 'filmcraft', 'lightcraft', 'effectcraft', 'printcraft', 'designcraft']);
  const adapter = readFileSync(ADAPTER, 'utf8');
  for (const a of CRAFT_APPS) {
    const row = new RegExp(`id: '${a.id}', name: '${a.name}', cli: '${a.cli}'[^\\n]*\\n[^\\n]*verifiedCommit: '${a.commit}', verifiedVersion: '${a.version}'`);
    assert.match(adapter, row, `${a.id}: same cli, commit and version as the engine's artcraft-apps.ts`);
    assert.match(a.repo, /^https:\/\/github\.com\/storytold\//);
  }
  // PrintCraft's repo moved upstream (printcraft → pdfcraft); the CLI at the pinned commit keeps the adapter's name.
  assert.equal(app('printcraft').repo, 'https://github.com/storytold/pdfcraft');
  assert.equal(app('printcraft').cli, 'printcraft-cli');
  for (const w of ['PhotoCraft', 'photo', 'photo-craft', 'photocraft-cli']) assert.equal(craftApp(w)?.id, 'photocraft', w);
  for (const w of ['pdfcraft', 'pdf', 'PrintCraft']) assert.equal(craftApp(w)?.id, 'printcraft', w);
  assert.equal(craftApp('blender'), null);
});

test('the bin folder is Ghost\'s own data root (where the adapter also looks); the operator\'s folder wins', () => {
  assert.equal(craftDataRoot(paths, {}), `${paths.runtimeHome}/data`);
  assert.equal(craftBinDir(paths, {}), `${paths.runtimeHome}/data/artcraft/bin`);
  assert.equal(craftInboxDir(paths, {}), `${paths.runtimeHome}/data/artcraft/inbox`);
  assert.equal(craftBinDir(paths, { SOLOMON_ARTCRAFT_BIN_DIR: '/opt/craft' }), '/opt/craft');
  assert.equal(craftBinDir(paths, { SOLOMON_ARTCRAFT_BIN_DIR: 'relative/is/ignored' }), `${paths.runtimeHome}/data/artcraft/bin`, 'the adapter ignores a relative folder, so does this');
  assert.equal(craftDataRoot(paths, { SOLOMON_DATA_DIR: 'elsewhere' }), `${paths.runtimeHome}/elsewhere`);
});

test('the backend env pins the knowledge library to Kingmaker\'s own data dir, never the desktop app\'s', () => {
  const secrets = { nonce: 'n'.repeat(64), voiceKey: 'v'.repeat(64) };
  const backend = ghostBackendEnv({ env: { PATH: '/usr/bin' }, paths, port: 3001, secrets, ghostBin: null });
  const lib = `${paths.runtimeHome}/data/knowledge`;
  assert.deepEqual([backend.SOLOMON_INDEX_DIR, backend.SOLOMON_CORPUS_DIR, backend.SOLOMON_EXTRACTED_DIR], [`${lib}/index`, `${lib}/sources`, `${lib}/extracted`],
    'explicit roots, so the provision module never falls back to ~/.solomon/knowledge');
});

test('the backend env carries the folder and a sha256 pin for each app sol-ghost installed and is there', () => {
  const bin = `${paths.runtimeHome}/data/artcraft/bin`;
  const manifest = { apps: { photocraft: { sha256: 'a'.repeat(64) }, designcraft: { sha256: 'b'.repeat(64) }, filmcraft: { sha256: 'not-a-sha' } } };
  const env = craftBackendEnv(paths, {}, { manifest, exists: (p) => p === `${bin}/photocraft-cli` || p === `${bin}/filmcraft-cli` });
  assert.deepEqual(env, { SOLOMON_ARTCRAFT_BIN_DIR: bin, SOLOMON_PHOTOCRAFT_CLI_SHA256: 'a'.repeat(64) }, 'designcraft is gone from disk and filmcraft has no valid sha: neither is pinned');
  const secrets = { nonce: 'n'.repeat(64), voiceKey: 'v'.repeat(64) };
  const backend = ghostBackendEnv({ env: { PATH: '/usr/bin' }, paths, port: 3001, secrets, ghostBin: null, artcraftEnv: env });
  assert.equal(backend.SOLOMON_ARTCRAFT_BIN_DIR, bin);
  assert.equal(backend.SOLOMON_PHOTOCRAFT_CLI_SHA256, 'a'.repeat(64));
  const mine = ghostBackendEnv({ env: { SOLOMON_ARTCRAFT_BIN_DIR: '/mine', SOLOMON_PHOTOCRAFT_CLI_SHA256: 'c'.repeat(64) }, paths, port: 3001, secrets, ghostBin: null, artcraftEnv: env });
  assert.equal(mine.SOLOMON_ARTCRAFT_BIN_DIR, '/mine', 'the operator\'s folder wins');
  assert.equal(mine.SOLOMON_PHOTOCRAFT_CLI_SHA256, 'c'.repeat(64), 'the operator\'s pin wins');
  assert.equal(ghostBackendEnv({ env: {}, paths, port: 3001, secrets, ghostBin: null }).SOLOMON_ARTCRAFT_BIN_DIR, undefined, 'no artcraftEnv given → nothing invented');
});

test('doctor: all seven, found with version and pin, or missing with the exact fix line; a changed binary is named', async () => {
  const bin = `${paths.runtimeHome}/data/artcraft/bin`;
  const files = new Map([[`${bin}/photocraft-cli`, 'p'.repeat(64)], [`${bin}/designcraft-cli`, 'd'.repeat(64)], [`${bin}/lightcraft-cli`, 'l'.repeat(64)], ['/opt/homebrew/bin/printcraft-cli', 'x'.repeat(64)]]);
  const manifest = { apps: { photocraft: { version: '0.2.0', commit: '909efc0f6df0', sha256: 'p'.repeat(64) }, designcraft: { version: '0.2.1', commit: 'd582277cc79c', sha256: 'e'.repeat(64) }, lightcraft: { version: '0.2.1', commit: '265248c86fa3', sha256: 'l'.repeat(64) } } };
  const report = await craftDoctor(paths, { PATH: '' }, { manifest, exists: (p) => files.has(p), hash: async (p) => files.get(p) });
  const by = Object.fromEntries(report.rows.map((r) => [r.app, r]));
  assert.equal(report.rows.length, 7);
  assert.equal(by.photocraft.state, 'found');
  assert.match(by.photocraft.line, /PhotoCraft 0\.2\.0 \(909efc0\).*sha256 pppppppppppp…, pinned/);
  assert.equal(by.designcraft.state, 'pin-mismatch', 'the binary is not what sol-ghost installed');
  assert.match(by.designcraft.line, /not what Kingmaker installed .*refuse to run it/);
  assert.equal(by.designcraft.fix, 'kingmaker craft install designcraft');
  assert.equal(by.printcraft.state, 'found');
  assert.equal(by.printcraft.source, 'PATH');
  assert.match(by.printcraft.line, /version unknown \(not installed by Kingmaker\)/);
  for (const id of ['vectorcraft', 'filmcraft', 'effectcraft']) {
    assert.equal(by[id].state, 'missing');
    assert.equal(by[id].fix, `kingmaker craft install ${id}`);
  }
  assert.equal(report.found, 3);
  const lines = craftDoctorLines(report).join('\n');
  assert.match(lines, /ArtCraft apps: 3 of 7 installed/);
  assert.match(lines, /✗ FilmCraft: not installed \(Ronin Clipper \/ Content Studio reels\)\n {6}→ kingmaker craft install filmcraft/);
  assert.match(lines, /LightCraft: HEIC and AVIF do not decode .*Nikon \.nrw/, 'LightCraft\'s limits are said where it is offered');
  assert.match(lines, /one at a time: kingmaker craft install vectorcraft filmcraft effectcraft/);
  const pinned = await craftDoctor(paths, { PATH: '', SOLOMON_PHOTOCRAFT_CLI_SHA256: 'f'.repeat(64) }, { manifest, exists: (p) => files.has(p), hash: async (p) => files.get(p) });
  const photo = pinned.rows.find((r) => r.app === 'photocraft');
  assert.equal(photo.state, 'pin-mismatch', 'the operator\'s own pin is checked too');
  assert.match(photo.fix, /SOLOMON_PHOTOCRAFT_CLI_SHA256=p{64}/);
  const explicit = await craftDoctor(paths, { PATH: '', SOLOMON_FILMCRAFT_CLI: 'relative/filmcraft' }, { manifest: { apps: {} }, exists: () => false, hash: async () => null });
  assert.match(explicit.rows.find((r) => r.app === 'filmcraft').line, /SOLOMON_FILMCRAFT_CLI is set to relative\/filmcraft, which is not a file/);
});

test('the engine\'s own view of the install (GET /api/artcraft/doctor) in one line', () => {
  assert.equal(engineCraftLine([{ name: 'PhotoCraft', ok: true, pinned: true }, { name: 'DesignCraft', ok: false, state: 'PIN_MISMATCH' }, { name: 'FilmCraft', ok: false, state: 'NOT_INSTALLED' }], 3001),
    'The engine on :3001 sees 1 of 3: PhotoCraft (pinned); refused (pin mismatch): DesignCraft.');
  assert.match(engineCraftLine(null, 3001), /no ArtCraft report/);
});

test('craft asks are sentences to the engine: the app named with an action, the input by name, the words quoted; raw CLI/MCP never', () => {
  assert.deepEqual(craftTurnText(app('photocraft')), { text: 'PhotoCraft, make a carousel image' });
  assert.deepEqual(craftTurnText(app('photocraft'), [], { inputName: 'beach.jpg', says: 'Summer sale' }), { text: 'PhotoCraft, make a carousel image from beach.jpg that says "Summer sale"' });
  assert.deepEqual(craftTurnText(app('vectorcraft'), ['for', 'the', 'blog'], { says: '"Why most" restaurants fail' }), { text: 'VectorCraft, make a thumbnail for the blog that says "Why most restaurants fail"' });
  assert.deepEqual(craftTurnText(app('filmcraft'), ['cut', 'a', '30', 'second', 'reel', 'with', 'captions'], { inputName: 'ep12.mp4' }), { text: 'FilmCraft, cut a 30 second reel with captions from ep12.mp4' });
  assert.deepEqual(craftTurnText(app('printcraft'), "what's in proposal.pdf".split(' '), { inputName: 'proposal.pdf' }), { text: "PrintCraft, what's in proposal.pdf" }, 'an input already named is not repeated');
  for (const raw of [['mcp'], ['mcp', '--headless'], ['run', 'app.export'], ['--headless'], ['exec', 'file.exportMedia']]) {
    const r = craftTurnText(app('vectorcraft'), raw);
    assert.ok(r.error, raw.join(' '));
    assert.match(r.error, /never runs vectorcraft-cli or its MCP server directly/);
  }
});

test('what a request does is read from its arguments, never from a tool\'s readOnlyHint', () => {
  assert.equal(classifyCraftAsk(app('printcraft'), "PrintCraft, what's in proposal.pdf"), 'read');
  assert.equal(classifyCraftAsk(app('filmcraft'), 'FilmCraft, probe ep12.mp4'), 'read');
  assert.equal(classifyCraftAsk(app('filmcraft'), 'FilmCraft, check and cut ep12.mp4 to a reel'), 'write');
  assert.equal(classifyCraftAsk(app('printcraft'), 'PrintCraft, make a PDF from notes.md'), 'write');
  // The upstream pitfall: these two advertise readOnlyHint yet write a file when given a path.
  assert.equal(classifyCraftAsk(app('vectorcraft'), 'VectorCraft, screenshot the canvas to /tmp/x.png'), 'write');
  assert.equal(classifyCraftAsk(app('designcraft'), 'DesignCraft, render_page 1 path=/tmp/page.png'), 'write');
  assert.equal(classifyCraftAsk(app('designcraft'), 'DesignCraft status'), 'status');
  assert.equal(classifyCraftAsk(app('designcraft'), 'DesignCraft, lay out a status report'), 'write');
});

test('inputs are copied into the ArtCraft inbox; the same bytes are reused, a different file keeps both; LightCraft\'s limits are counted', async () => {
  const dir = tmp();
  const inbox = join(dir, 'data', 'artcraft', 'inbox');
  writeFileSync(join(dir, 'beach.jpg'), 'one');
  const first = await stageCraftInput(join(dir, 'beach.jpg'), inbox, { app: app('photocraft') });
  assert.deepEqual({ name: first.name, reused: first.reused }, { name: 'beach.jpg', reused: false });
  assert.equal(readFileSync(join(inbox, 'beach.jpg'), 'utf8'), 'one');
  const again = await stageCraftInput(join(dir, 'beach.jpg'), inbox, { app: app('photocraft') });
  assert.equal(again.reused, true);
  mkdirSync(join(dir, 'other'));
  writeFileSync(join(dir, 'other', 'beach.jpg'), 'two');
  const other = await stageCraftInput(join(dir, 'other', 'beach.jpg'), inbox, { app: app('photocraft') });
  assert.equal(other.name, 'beach-2.jpg');
  assert.equal(readFileSync(join(inbox, 'beach.jpg'), 'utf8'), 'one', 'never overwritten');
  await assert.rejects(stageCraftInput(join(dir, 'nope.jpg'), inbox, { app: app('photocraft') }), /does not exist/);
  await assert.rejects(stageCraftInput(dir, inbox, { app: app('photocraft') }), /is not a file for PhotoCraft/);
  const shoot = join(dir, 'shoot');
  mkdirSync(shoot);
  for (const n of ['a.jpg', 'b.HEIC', 'c.avif', 'd.nrw', 'e.png']) writeFileSync(join(shoot, n), n);
  const folder = await stageCraftInput(shoot, inbox, { app: app('lightcraft') });
  assert.equal(folder.name, 'shoot');
  assert.deepEqual(readdirSync(join(inbox, 'shoot')).sort(), ['a.jpg', 'b.HEIC', 'c.avif', 'd.nrw', 'e.png']);
  assert.deepEqual(folder.notes, ['2 HEIC/AVIF files will not import: LightCraft cannot decode them in this build.', '1 Nikon .nrw file will be skipped: LightCraft\'s folder import does not take .nrw yet.']);
  await assert.rejects(stageCraftInput(join(dir, 'beach.jpg'), inbox, { app: app('lightcraft') }), /is not a folder for LightCraft/);
});

test('a build waits for the packager, another cargo and critical memory pressure — never for itself or a grep', () => {
  const ps = [
    '  101 /bin/zsh -c source snap.sh && npm run package:ghost',
    '  102 node scripts/solomon-package-ghost.mjs',
    '  103 /opt/homebrew/bin/cargo build --release -p filmcraft-cli',
    '  104 /Users/o/.rustup/toolchains/stable/bin/rustc --crate-name serde',
    '  105 vim Cargo.toml',
    '  106 grep cargo build',
    '  107 /opt/homebrew/bin/cargo build --release -p photocraft-cli',
    '  108 /Applications/Kingmaker.app/Contents/MacOS/Solomon headless-server.mjs',
    '  109 /Applications/Blender.app/Contents/MacOS/Blender -b --python blender_titan_worker.py',
    '  110 /Applications/Blender.app/Contents/MacOS/Blender',
    '  111 /Applications/Ollama.app/Contents/Resources/ollama runner --model qwen3',
  ].join('\n');
  const busy = busyJobs(ps, new Set([107]));
  assert.deepEqual(busy.map((b) => b.label), ['npm run package:ghost', 'the Kingmaker packager', 'another cargo build', 'rustc', 'a Blender render']);
  assert.equal(busy.find((b) => b.label === 'a Blender render').pid, 109, 'an open Blender window is not a render');
  assert.deepEqual(busyJobs('  9 /usr/bin/node lib/cli.mjs craft install photocraft\n 10 ollama serve'), []);
  assert.deepEqual(roomReasons({ busy: [], pressure: 'warning', freeBytes: 50 * 2 ** 30 }), { wait: [], diskLow: false }, 'a warning is paced, not waited on');
  assert.deepEqual(roomReasons({ busy: [], pressure: 'critical', freeBytes: 50 * 2 ** 30 }).wait, ['memory pressure is critical']);
  assert.equal(roomReasons({ freeBytes: DISK_FLOOR_BYTES - 1 }).diskLow, true);
});

test('waiting for room backs off and never gives up; a full disk stops it', async () => {
  const samples = [
    { busy: [{ pid: 7, label: 'npm run package:ghost' }], pressure: 'normal', freeBytes: 1e12 },
    { busy: [{ pid: 7, label: 'npm run package:ghost' }], pressure: 'normal', freeBytes: 1e12 },
    { busy: [], pressure: 'critical', freeBytes: 1e12 },
    ...Array.from({ length: 6 }, () => ({ busy: [], pressure: 'critical', freeBytes: 1e12 })),
    { busy: [], pressure: 'normal', freeBytes: 1e12 },
  ];
  const slept = [];
  const said = [];
  const r = await waitForRoom({ sample: async () => samples.shift(), sleep: async (ms) => { slept.push(ms); }, out: (l) => said.push(l) });
  assert.equal(r.ok, true);
  assert.equal(r.waited, true);
  assert.deepEqual(slept, [5_000, 15_000, 30_000, 60_000, 60_000, 60_000, 60_000, 60_000, 60_000], 'the bounded backoff, then steady');
  assert.equal(slept.length, 9);
  assert.equal(said.length, 2, 'said once per change of reason, not once per look');
  assert.match(said[0], /npm run package:ghost is running \(pid 7\)/);
  assert.match(said[1], /memory pressure is critical/);
  assert.deepEqual(ROOM_BACKOFF_MS, [5_000, 15_000, 30_000, 60_000]);
  const full = await waitForRoom({ sample: async () => ({ busy: [], pressure: 'normal', freeBytes: 2 ** 30 }), sleep: async () => {} });
  assert.deepEqual(full, { ok: false, freeBytes: 2 ** 30 });
});

test('the build: nice 15, release, locked, only the CLI package, 2 jobs on 8 GB; LTO off for memory', () => {
  assert.deepEqual(cargoBuildArgv(app('photocraft'), { cargo: '/opt/homebrew/bin/cargo', jobs: 2 }), ['/usr/bin/nice', '-n', '15', '/opt/homebrew/bin/cargo', 'build', '--release', '--locked', '-p', 'photocraft-cli', '-j', '2']);
  const env = cargoBuildEnv({ PATH: '/usr/bin', HOME: '/h' }, '/w/target/photocraft');
  assert.equal(env.CARGO_TARGET_DIR, '/w/target/photocraft');
  assert.equal(env.CARGO_PROFILE_RELEASE_LTO, 'off');
  assert.equal(env.CARGO_PROFILE_RELEASE_CODEGEN_UNITS, '16');
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(defaultJobs(8 * 2 ** 30), 2);
  assert.equal(defaultJobs(16 * 2 ** 30), 4);
  assert.equal(defaultJobs(64 * 2 ** 30), 4);
  assert.equal(defaultJobs(2 * 2 ** 30), 1);
  assert.equal(cargoVersion('[workspace]\nmembers=[]\n[workspace.package]\nversion = "0.2.1"\nedition = "2024"\n[workspace.dependencies]\nfoo = { version = "1.0" }\n'), '0.2.1');
  assert.equal(cargoVersion('[package]\nname = "x"\nversion = "1.4.0"\n[dependencies]\nversion = "9"\n'), '1.4.0');
  assert.equal(cargoVersion('nothing'), null);
});

test('a running build backs off for distress (critical, paging, heat), not for this Mac\'s steady warning or its own CPU', () => {
  const calm = { pressureLevel: 'warning', pagingBytesPerSecond: 4 * 2 ** 20, thermal: 'nominal', cpuIdle: 0.02 };
  assert.equal(nextDuty(0.5, buildSignals(calm)).congested, false, 'warning + the build\'s own CPU: headroom');
  assert.equal(nextDuty(0.5, buildSignals(calm)).duty, 0.6);
  assert.equal(nextDuty(0.5, calm).congested, true, 'the shared pacer itself is unchanged for other jobs');
  assert.equal(nextDuty(0.8, buildSignals({ ...calm, pressureLevel: 'critical' })).duty, MIN_DUTY, 'critical: straight to the floor');
  assert.equal(nextDuty(0.8, buildSignals({ ...calm, pagingBytesPerSecond: 40 * 2 ** 20 })).duty, 0.4, 'heavy paging halves it');
  assert.equal(nextDuty(0.8, buildSignals({ ...calm, thermal: 'hot' })).duty, 0.4, 'heat halves it');
});

test('an owner meeting is an admission blocker before an ArtCraft build starts', async () => {
  let meeting = true; let built = 0; const waits = [];
  const dir = mkdtempSync(join(tmpdir(), 'km-craft-meeting-'));
  const fake = fakeToolchain();
  const r = await installCraftApps(['photocraft'], {
    binDir: join(dir, 'bin'), workDir: join(dir, 'state', 'artcraft-build'), out: () => {}, env: {},
    deps: {
      git: fake.git, build: async (args) => { built += 1; return fake.build(args); }, sample: async () => ({ busy: [], pressure: 'normal', freeBytes: 10 * 2 ** 30 }),
      inMeeting: () => meeting, sleep: async (ms) => { waits.push(ms); meeting = false; },
    },
  });
  assert.equal(r.ok, true);
  assert.ok(waits.length >= 1, 'the installer waited before admission');
  assert.equal(built, 1);
});

/** A fake git that "fetches" a repo by writing its Cargo.toml, and a fake cargo that writes a binary. */
function fakeToolchain({ failBuild = new Set(), wrongHead = new Set(), log = [] } = {}) {
  let active = 0;
  let maxActive = 0;
  const git = async (args, { cwd }) => {
    log.push({ tool: 'git', args, cwd });
    const id = cwd.split('/').at(-1);
    const a = craftApp(id);
    if (args[0] === 'fetch') { writeFileSync(join(cwd, 'Cargo.toml'), `[workspace.package]\nversion = "${a.version}"\n`); mkdirSync(join(cwd, '.git'), { recursive: true }); }
    if (args[0] === 'rev-parse') return { code: 0, stdout: `${wrongHead.has(id) ? 'f'.repeat(40) : a.commit}\n`, stderr: '' };
    if (args[0] === 'status') return { code: 0, stdout: '', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const build = async ({ argv, cwd, env, app: a, onLine }) => {
    log.push({ tool: 'cargo', argv, cwd, target: env.CARGO_TARGET_DIR });
    active += 1; maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 5));
    for (let i = 0; i < 3; i += 1) onLine(`   Compiling crate${i} v1.0.0`);
    active -= 1;
    if (failBuild.has(a.id)) return { code: 101, tail: 'error[E0432]: unresolved import `foo`\nerror: could not compile `bar`' };
    mkdirSync(join(env.CARGO_TARGET_DIR, 'release'), { recursive: true });
    writeFileSync(join(env.CARGO_TARGET_DIR, 'release', a.cli), `#!/bin/sh\necho ${a.id}\n`);
    return { code: 0, tail: '' };
  };
  return { git, build, log, maxActive: () => maxActive };
}

const roomy = async () => ({ busy: [], pressure: 'normal', freeBytes: 1e12 });

test('install: one app at a time, at the pinned commit, binary copied executable with its sha256, commit and version recorded; build folders removed', async () => {
  const dir = tmp();
  const binDir = join(dir, 'data', 'artcraft', 'bin');
  const workDir = join(dir, 'state', 'artcraft-build');
  const fake = fakeToolchain();
  const said = [];
  const r = await installCraftApps(['photocraft', 'designcraft'], { binDir, workDir, jobs: 2, out: (l) => said.push(l), env: { PATH: '/usr/bin' }, deps: { git: fake.git, build: fake.build, sample: roomy, sleep: async () => {} } });
  assert.equal(r.ok, true);
  assert.deepEqual(r.installed.map((i) => i.id), ['photocraft', 'designcraft']);
  assert.equal(fake.maxActive(), 1, 'never two builds at once');
  const fetches = fake.log.filter((l) => l.tool === 'git' && l.args[0] === 'fetch').map((l) => l.args);
  assert.deepEqual(fetches, [['fetch', '-q', '--depth', '1', 'origin', app('photocraft').commit], ['fetch', '-q', '--depth', '1', 'origin', app('designcraft').commit]]);
  assert.deepEqual(fake.log.filter((l) => l.tool === 'git' && l.args[0] === 'remote').map((l) => l.args[3]), [app('photocraft').repo, app('designcraft').repo]);
  for (const l of fake.log) {
    const argv = l.tool === 'cargo' ? l.argv : ['git', ...l.args];
    assert.ok(!argv.includes('mcp'), 'nothing ever starts an app\'s MCP server');
    assert.ok(!CRAFT_APPS.some((a) => argv[0] === a.cli || argv[0]?.endsWith(`/${a.cli}`)), 'nothing ever runs an app');
  }
  assert.deepEqual(fake.log.filter((l) => l.tool === 'cargo').map((l) => l.argv.slice(-6)), [['--release', '--locked', '-p', 'photocraft-cli', '-j', '2'], ['--release', '--locked', '-p', 'designcraft-cli', '-j', '2']]);
  const manifest = readCraftManifest(binDir);
  for (const id of ['photocraft', 'designcraft']) {
    const bin = join(binDir, app(id).cli);
    assert.ok(existsSync(bin));
    assert.equal(statSync(bin).mode & 0o777, 0o755);
    const rec = manifest.apps[id];
    assert.equal(rec.sha256, await sha256File(bin));
    assert.equal(rec.commit, app(id).commit);
    assert.equal(rec.version, app(id).version);
    assert.equal(rec.licence, 'MIT OR Apache-2.0');
    assert.equal(r.installed.find((i) => i.id === id).sha256, rec.sha256);
  }
  assert.ok(existsSync(join(binDir, CRAFT_MANIFEST)));
  assert.deepEqual(readdirSync(workDir).sort(), [], 'clone, target folder and lock are gone');
  assert.ok(said.some((l) => /^✓ \[1\/2\] PhotoCraft 0\.2\.0 \(909efc0\) installed in .*sha256 [0-9a-f]{12}…\)$/.test(l)));
  assert.ok(said.some((l) => /pinned to the sha256 above/.test(l)));
  // The pins this install produced are what the next start hands the engine.
  const env = craftBackendEnv({ runtimeHome: join(dir, 'runtime') }, { SOLOMON_ARTCRAFT_BIN_DIR: binDir });
  assert.equal(env.SOLOMON_PHOTOCRAFT_CLI_SHA256, manifest.apps.photocraft.sha256);
  assert.equal(env.SOLOMON_DESIGNCRAFT_CLI_SHA256, manifest.apps.designcraft.sha256);
  // And the doctor now says so, with the version from the record.
  const report = await craftDoctor({ runtimeHome: join(dir, 'runtime') }, { SOLOMON_ARTCRAFT_BIN_DIR: binDir, PATH: '' });
  assert.equal(report.found, 2);
  assert.match(report.rows[0].line, /^PhotoCraft 0\.2\.0 \(909efc0\): .*pinned\) — blog \/ Instagram images$/);
});

test('install: a failed build is reported and the next app still builds; a wrong commit is refused; the disk floor stops the rest', async () => {
  const dir = tmp();
  const binDir = join(dir, 'bin');
  const workDir = join(dir, 'work');
  const fake = fakeToolchain({ failBuild: new Set(['vectorcraft']), wrongHead: new Set(['filmcraft']) });
  const said = [];
  const r = await installCraftApps(['vectorcraft', 'filmcraft', 'printcraft'], { binDir, workDir, jobs: 1, out: (l) => said.push(l), env: {}, deps: { git: fake.git, build: fake.build, sample: roomy, sleep: async () => {} } });
  assert.equal(r.ok, false);
  assert.deepEqual(r.installed.map((i) => i.id), ['printcraft']);
  assert.deepEqual(r.failed.map((f) => f.id), ['vectorcraft', 'filmcraft']);
  assert.match(r.failed[0].reason, /cargo build exited 101: error\[E0432\]/);
  assert.match(r.failed[1].reason, /not the pinned 771b614ad4c3fbefda5d668ce4384504b8c13f6d/);
  assert.ok(!existsSync(join(binDir, 'vectorcraft-cli')), 'nothing is installed from a failed build');
  assert.ok(!fake.log.some((l) => l.tool === 'cargo' && l.argv.includes('filmcraft-cli')), 'a clone at the wrong commit is never built');

  let n = 0;
  const lowDisk = async () => ({ busy: [], pressure: 'normal', freeBytes: n++ < 2 ? 1e12 : 2 ** 30 });
  const r2 = await installCraftApps(['photocraft', 'lightcraft', 'effectcraft'], { binDir, workDir, out: (l) => said.push(l), env: {}, deps: { git: fake.git, build: fake.build, sample: lowDisk, sleep: async () => {} } });
  assert.deepEqual(r2.installed.map((i) => i.id), ['photocraft']);
  assert.deepEqual(r2.notStarted, ['lightcraft', 'effectcraft']);
  assert.ok(said.some((l) => /a build needs about 4\.0 GB\. Free some space, then: kingmaker craft install lightcraft effectcraft$/.test(l)));
});

test('install: one installer at a time (a live lock refuses; a stale one is taken over)', async () => {
  const dir = tmp();
  const workDir = join(dir, 'work');
  mkdirSync(workDir, { recursive: true });
  writeFileSync(join(workDir, 'install.lock'), JSON.stringify({ pid: 4242 }));
  const fake = fakeToolchain();
  const said = [];
  const held = await installCraftApps(['photocraft'], { binDir: join(dir, 'bin'), workDir, out: (l) => said.push(l), env: {}, deps: { git: fake.git, build: fake.build, sample: roomy, alive: (pid) => pid === 4242 } });
  assert.equal(held.ok, false);
  assert.match(said[0], /Another kingmaker craft install \(pid 4242\) is building/);
  assert.equal(fake.log.length, 0);
  const stale = await installCraftApps(['photocraft'], { binDir: join(dir, 'bin'), workDir, out: () => {}, env: {}, deps: { git: fake.git, build: fake.build, sample: roomy, alive: () => false } });
  assert.equal(stale.ok, true);
});

test('install waits for the packager before building (a live sample says it is running, then gone)', async () => {
  const dir = tmp();
  const fake = fakeToolchain();
  const seq = [{ busy: [{ pid: 9, label: 'npm run package:ghost' }], pressure: 'normal', freeBytes: 1e12 }, { busy: [], pressure: 'normal', freeBytes: 1e12 }];
  const order = [];
  const r = await installCraftApps(['designcraft'], {
    binDir: join(dir, 'bin'), workDir: join(dir, 'work'), out: (l) => order.push(l), env: {},
    deps: { git: fake.git, build: async (o) => { order.push('BUILD'); return fake.build(o); }, sample: async () => seq.shift() ?? seq.at(-1) ?? { busy: [], pressure: 'normal', freeBytes: 1e12 }, sleep: async () => { order.push('SLEEP'); } },
  });
  assert.equal(r.ok, true);
  const waitAt = order.findIndex((l) => /waiting for room: npm run package:ghost is running/.test(l));
  assert.ok(waitAt >= 0 && waitAt < order.indexOf('SLEEP') && order.indexOf('SLEEP') < order.indexOf('BUILD'));
});

test('craft args, the console\'s :craft, and what a run made', async () => {
  assert.deepEqual({ ...parseCraftArgs(['make', 'a', 'card', '--input', 'a.jpg', '-i', 'b.srt', '--says', 'Hi there', '--port', '3002', '--no-open', '--jobs', '1']), flags: undefined },
    { words: ['make', 'a', 'card'], inputs: ['a.jpg', 'b.srt'], says: 'Hi there', conversation: undefined, jobs: 1, flags: undefined });
  assert.deepEqual(splitConsoleWords(':craft vectorcraft --says "Why most restaurants fail" \'for the blog\''), [':craft', 'vectorcraft', '--says', 'Why most restaurants fail', 'for the blog']);
  assert.equal(classifyLine(':craft photocraft'), 'craft');
  assert.equal(classifyLine(':crafty'), 'text');
  const staged = [];
  const fakeStage = async (src, inbox, { app: a }) => { staged.push({ src, inbox, app: a.id }); return { name: 'beach.jpg', path: join(inbox, 'beach.jpg'), reused: false, notes: [] }; };
  const ok = await consoleCraftTurn(':craft photocraft --input /tmp/beach.jpg --says "Summer sale"', paths, fakeStage);
  assert.deepEqual(ok, { text: 'PhotoCraft, make a carousel image from beach.jpg that says "Summer sale"', notes: ['copied into the ArtCraft inbox: beach.jpg'] });
  assert.deepEqual(staged, [{ src: '/tmp/beach.jpg', inbox: `${paths.runtimeHome}/data/artcraft/inbox`, app: 'photocraft' }]);
  assert.match((await consoleCraftTurn(':craft lightcraft', paths, fakeStage)).notes[0], /LightCraft: HEIC and AVIF/);
  assert.match((await consoleCraftTurn(':craft blender', paths, fakeStage)).error, /the seven: photocraft/);
  assert.match((await consoleCraftTurn(':craft vectorcraft mcp', paths, fakeStage)).error, /never runs vectorcraft-cli or its MCP server/);
  const lines = craftOutputLines({ data: { output: { kind: 'artcraft_job', status: 'PRODUCED', outputs: [{ role: 'carousel', url: '/media/x.jpg', mime: 'image/jpeg', bytes: 1234, sha256: 'a'.repeat(64) }], receiptUrl: '/media/receipt.json', receiptSigned: true, networkKernelBlocked: true } } });
  assert.deepEqual(lines, ['  ⇢ carousel: /media/x.jpg (image/jpeg, 1234 bytes, sha256 aaaaaaaaaaaa…)', '  ⇢ receipt: /media/receipt.json (signed); network kernel-blocked']);
  assert.deepEqual(craftOutputLines({ data: { output: { kind: 'codegen' } } }), []);
});

/** A fake engine: records each request (path, headers, body) and answers like the real routes. */
function fakeEngine(answers = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const path = new URL(url).pathname;
    calls.push({ path, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : null });
    const json = answers[path]?.(calls.at(-1)) ?? { ok: false };
    return { ok: true, status: 200, json: async () => json };
  };
  return { calls, fetchImpl };
}

test('MCP: the apps are reachable only through the engine — status is a read, a request is a turn with no nonce, a write comes back proposed', async () => {
  const names = TOOLS.map((t) => t.name);
  assert.ok(names.includes('artcraft_status') && names.includes('artcraft_request'));
  assert.ok(!names.some((n) => /screenshot|render_page|-cli|^(?:photo|vector|film|light|effect|print|design)craft_/.test(n)), 'no app\'s own MCP tools are re-exported');
  assert.ok(!names.some((n) => /approve|confirm|install/.test(n)), 'nothing here approves or installs');
  const req = TOOLS.find((t) => t.name === 'artcraft_request');
  assert.equal(req.annotations.readOnlyHint, false, 'never advertised read-only');
  assert.deepEqual(req.inputSchema.properties.app.enum, CRAFT_APP_IDS);
  assert.equal(TOOLS.find((t) => t.name === 'artcraft_status').annotations.readOnlyHint, true);

  const engine = fakeEngine({
    '/api/artcraft/doctor': () => ({ ok: true, data: [{ app: 'photocraft', name: 'PhotoCraft', state: 'AVAILABLE', ok: true, pinned: true, serves: 'Blog', verdict: 'USABLE_NOW', bin: '/secret/path' }, { app: 'filmcraft', name: 'FilmCraft', state: 'NOT_INSTALLED', ok: false, serves: 'Clipper', verdict: 'USABLE_WITH_WORKAROUNDS' }] }),
    '/api/conversation/turn': (c) => ({ ok: true, data: { conversationId: 'conv-1', spokenResponse: `I will make it. Say go ahead to make it. (${c.body.userText})`, confirmationRequired: true, dispatchExecuted: false } }),
  });
  const status = JSON.parse((await callTool('artcraft_status', {}, { port: 3001, fetchImpl: engine.fetchImpl, inbox: '/in', listInbox: () => [{ name: 'beach.jpg', kind: 'file', bytes: 3 }] })).content[0].text);
  assert.deepEqual(status.apps.map((a) => [a.app, a.ready, a.pinned]), [['photocraft', true, true], ['filmcraft', false, false]]);
  assert.equal(status.apps[1].fix, 'the owner runs: kingmaker craft install filmcraft');
  assert.equal(status.apps[0].bin, undefined, 'binary paths are not handed out');
  assert.deepEqual(status.inboxEntries, [{ name: 'beach.jpg', kind: 'file', bytes: 3 }]);
  assert.match(status.lightcraft, /HEIC and AVIF/);

  const res = JSON.parse((await callTool('artcraft_request', { app: 'photocraft', request: 'make a carousel image from beach.jpg', says: 'Summer' }, { port: 3001, fetchImpl: engine.fetchImpl })).content[0].text);
  const sent = engine.calls.find((c) => c.path === '/api/conversation/turn');
  assert.equal(sent.body.userText, 'PhotoCraft, make a carousel image from beach.jpg that says "Summer"');
  assert.equal(sent.headers[DESKTOP_NONCE_HEADER], undefined, 'an MCP client never carries the owner nonce');
  assert.deepEqual(Object.keys(sent.headers).filter((h) => /nonce|attestation/i.test(h)), []);
  assert.equal(res.kind, 'write');
  assert.equal(res.awaitingOwnerApproval, true);
  assert.equal(res.note, READ_BACK_NOTE, 'a read-back in this client\'s conversation is not something the console can approve');
  assert.equal(res.ownerAsk, 'PhotoCraft, make a carousel image from beach.jpg that says "Summer"');
  assert.ok(engine.calls.every((c) => c.path === '/api/artcraft/doctor' || c.path === '/api/conversation/turn'), 'only the engine\'s routes are called');

  const raw = await callTool('artcraft_request', { app: 'vectorcraft', request: 'mcp --headless' }, { port: 3001, fetchImpl: engine.fetchImpl });
  assert.equal(raw.isError, true);
  assert.equal((await callTool('artcraft_request', { app: 'gimp' }, { port: 3001, fetchImpl: engine.fetchImpl })).isError, true);
  const listed = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { port: 3001 });
  assert.equal(listed.result.tools.length, TOOLS.length);
});

test('MCP over stdio: a call still answering when a piped client closes stdin is answered before the server ends', async () => {
  const input = new PassThrough();
  const written = [];
  const output = { write: (line) => written.push(line) };
  const slow = async () => { await new Promise((r) => setTimeout(r, 30)); return { ok: true, status: 200, json: async () => ({ ok: true, data: [] }) }; };
  const done = serveStdio({ port: 3001, fetchImpl: slow, inbox: null }, { input, output });
  input.end(`${JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'artcraft_status', arguments: {} } })}\n`);
  await done;
  assert.equal(written.length, 1);
  assert.equal(JSON.parse(written[0]).id, 7);
});

test('an engine\'s read-back is a wait, though the core\'s confirmationRequired says false (live shape, 2026-10-08)', async () => {
  const live = { ok: true, data: { conversationId: 'conv_x', spokenResponse: 'I will make a 1080×1350 carousel image from beach.jpg in PhotoCraft: centre crop to 4:5, auto tone, headline "Summer sale". It runs on this computer in a sandbox with no network. Say go ahead to make it.', confirmationRequired: false, dispatchExecuted: false, workflowRoute: 'create' } };
  const answer = (json) => async () => ({ ok: true, status: 200, json: async () => json });
  const r = await turn(3001, { text: 'x', fetchImpl: answer(live) });
  assert.equal(r.confirmationRequired, true);
  assert.equal(r.readBack, true);
  const ran = await turn(3001, { text: 'go ahead', fetchImpl: answer({ ok: true, data: { ...live.data, spokenResponse: 'PhotoCraft made the carousel image carousel.jpg at 1080 by 1350. Say go ahead if you want another.', dispatchExecuted: true } }) });
  assert.equal(ran.confirmationRequired, false, 'an executed turn is never a wait');
  const plain = await turn(3001, { text: 'x', fetchImpl: answer({ ok: true, data: { spokenResponse: 'It is sunny.', confirmationRequired: false } }) });
  assert.equal(plain.readBack, false);
  for (const line of ['Say go ahead and I will render it.', 'say "yes, go ahead" to approve', 'Say “go ahead” to start step 1']) assert.match(line, READ_BACK_LINE, line);
  assert.doesNotMatch('Go ahead and ask me anything.', READ_BACK_LINE);
});

test('no Kingmaker code starts an ArtCraft app or its MCP server', () => {
  for (const file of readdirSync(join(root, 'lib')).filter((f) => f.endsWith('.mjs'))) {
    const src = readFileSync(join(root, 'lib', file), 'utf8');
    for (const a of CRAFT_APPS) {
      assert.doesNotMatch(src, new RegExp(`${a.cli}['"\`]?\\s*,\\s*\\[?\\s*['"\`]mcp`), `${file} must not start ${a.cli} mcp`);
      assert.doesNotMatch(src, new RegExp(`(?:spawn|execFile|execFileSync)\\([^)]*${a.cli}`), `${file} must not run ${a.cli}`);
    }
  }
});

test('a fake binary on disk is hashed by its bytes (streamed)', async () => {
  const dir = tmp();
  const f = join(dir, 'x');
  writeFileSync(f, 'abc');
  chmodSync(f, 0o755);
  assert.equal(await sha256File(f), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('an operator env override into ~/.solomon is dropped back to Kingmaker\'s own library', () => {
  const secrets = { nonce: 'n'.repeat(64), voiceKey: 'v'.repeat(64) };
  const env = { HOME: '/Users/o', PATH: '/usr/bin', SOLOMON_INDEX_DIR: '/Users/o/.solomon/knowledge/index', SOLOMON_CORPUS_DIR: '~/.solomon/knowledge/sources', SOLOMON_DATA_DIR: '/Users/o/.solomon' };
  const backend = ghostBackendEnv({ env, paths, port: 3001, secrets, ghostBin: null });
  const lib = `${paths.runtimeHome}/data/knowledge`;
  assert.equal(backend.SOLOMON_INDEX_DIR, `${lib}/index`);
  assert.equal(backend.SOLOMON_CORPUS_DIR, `${lib}/sources`);
  assert.equal(backend.SOLOMON_DATA_DIR, undefined, 'a data dir inside ~/.solomon is dropped');
  const mine = ghostBackendEnv({ env: { ...env, SOLOMON_INDEX_DIR: '/Volumes/lib/index' }, paths, port: 3001, secrets, ghostBin: null });
  assert.equal(mine.SOLOMON_INDEX_DIR, '/Volumes/lib/index', 'a library elsewhere is still the operator\'s choice');
});

test('a packaged runtime preserves an external library selected in runtime/.env', () => {
  const secrets = { nonce: 'n'.repeat(64), voiceKey: 'v'.repeat(64) };
  const runtimeHome = tmp();
  const profile = [
    'SOLOMON_INDEX_DIR=/Volumes/Knowledge/index',
    'SOLOMON_CORPUS_DIR=/Volumes/Knowledge/sources',
    'SOLOMON_EXTRACTED_DIR=/Volumes/Knowledge/extracted',
    'SOLOMON_KNOWLEDGE_FIELDS=/Volumes/Knowledge/fields.json',
  ].join('\n');
  writeFileSync(join(runtimeHome, '.env'), profile);
  const packagedPaths = { ...paths, runtimeHome };
  const packaged = ghostBackendEnv({ env: { HOME: '/Users/o' }, paths: packagedPaths, port: 3001, secrets, ghostBin: null });
  assert.deepEqual(
    [packaged.SOLOMON_INDEX_DIR, packaged.SOLOMON_CORPUS_DIR, packaged.SOLOMON_EXTRACTED_DIR, packaged.SOLOMON_KNOWLEDGE_FIELDS],
    ['/Volumes/Knowledge/index', '/Volumes/Knowledge/sources', '/Volumes/Knowledge/extracted', '/Volumes/Knowledge/fields.json'],
  );
  const shell = ghostBackendEnv({ env: { HOME: '/Users/o', SOLOMON_INDEX_DIR: '/Volumes/Shell/index' }, paths: packagedPaths, port: 3001, secrets, ghostBin: null });
  assert.equal(shell.SOLOMON_INDEX_DIR, '/Volumes/Shell/index', 'an explicit launch environment still wins over the saved profile');
  writeFileSync(join(runtimeHome, '.env'), 'SOLOMON_INDEX_DIR=/Users/o/.solomon/knowledge/index\n');
  const refused = ghostBackendEnv({ env: { HOME: '/Users/o' }, paths: packagedPaths, port: 3001, secrets, ghostBin: null });
  assert.equal(refused.SOLOMON_INDEX_DIR, `${runtimeHome}/data/knowledge/index`, 'a saved profile may not redirect Kingmaker into the desktop app\'s data');
});
