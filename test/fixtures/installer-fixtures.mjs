// Test fixtures for the installer: a tiny ad-hoc-signed Kingmaker.app (with stand-ins for the bundled corpus and
// SearXNG installers and for Electron-as-Node), a release built from it by the real scripts/release-parts.mjs, a local
// HTTP server for the parts (Range-aware, with fault switches), and a runner for installer/engine.sh.
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const ENGINE = join(ROOT, 'installer', 'engine.sh');

const CORPUS = `// stand-in for the engine's bootstrap-corpus script (same contract: TIER1, receipts, --dry-run)
import { mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
export const TIER1 = [
  { id: 'spec-standards', field: 'software', license: 'MIT', sizeMB: 1, confirmed: true, sources: [] },
  { id: 'kaikki-multilingual', field: 'language', license: 'CC-BY-SA-4.0', sizeMB: 2, confirmed: true, sources: [] },
  { id: 'stackexchange', field: 'software', license: 'CC-BY-SA', sizeMB: 9, confirmed: false, sources: [] },
];
const direct = (() => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (direct) {
  const dir = process.env.SOLOMON_CORPUS_DIR;
  for (const e of TIER1.filter((x) => x.confirmed)) {
    console.log('  ▸ ' + e.id + ' [' + e.field + ']');
    if (process.argv.includes('--dry-run')) continue;
    if (process.env.KM_FAKE_CORPUS_FAIL === e.id) { console.log('      ✗ failed'); continue; }
    mkdirSync(join(dir, e.field, e.id), { recursive: true });
    writeFileSync(join(dir, e.field, e.id, 'data.txt'), e.id);
    mkdirSync(join(dir, '.receipts'), { recursive: true });
    writeFileSync(join(dir, '.receipts', e.id + '.json'), JSON.stringify({ id: e.id }));
  }
  process.exit(process.env.KM_FAKE_CORPUS_FAIL ? 1 : 0);
}
`;
const SEARXNG = `// stand-in for the engine's SearXNG native-setup script
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
export const SEARXNG_PIN = '12f8b6515ca77c3c3bc1498584950ef5daca1433';
const root = process.env.SOLOMON_SEARXNG_NATIVE_ROOT;
if (process.argv.includes('--dry-run')) { console.log('would: clone SearXNG into ' + root); process.exit(0); }
mkdirSync(root, { recursive: true });
writeFileSync(join(root, 'commit.txt'), SEARXNG_PIN + '\\n');
console.log('SearXNG native installed at ' + root);
`;

/** A Kingmaker.app small enough for a test, signed ad hoc so codesign --verify --deep --strict passes. */
export function makeFixtureApp(parent, { version = '0.2.0', padBytes = 300_000, executable = 'Kingmaker' } = {}) {
  const app = join(parent, 'Kingmaker.app');
  const c = join(app, 'Contents');
  mkdirSync(join(c, 'MacOS'), { recursive: true });
  mkdirSync(join(c, 'Resources', 'solomon-runtime', 'scripts'), { recursive: true });
  // Stand-ins for every runtime a release requires (release-parts REQUIRED_RUNTIMES); the release refuses an app without them.
  for (const r of ['voice-runtime', 'guardrails-runtime', 'guardrails-config', 'agent-runtime', 'knowledge-runtime', 'playwright-browsers', 'chrome-connector', 'sol-ghost', 'app.asar']) {
    mkdirSync(join(c, 'Resources', r), { recursive: true });
    writeFileSync(join(c, 'Resources', r, '.stub'), r);
  }
  // The engine's own folders (release-parts refuses an engine without them) and a `kingmaker version` that starts.
  const engine = join(c, 'Resources', 'sol-ghost');
  for (const d of ['lib', 'bin', 'vendor', 'catalog', 'core', 'assets']) { mkdirSync(join(engine, d), { recursive: true }); writeFileSync(join(engine, d, '.stub'), d); }
  writeFileSync(join(engine, 'package.json'), JSON.stringify({ name: 'kingmaker', version }));
  writeFileSync(join(engine, 'payload.json'), JSON.stringify({ schema: 'kingmaker.payload/1', version, count: 0, files: [] })); // the one payload file's list
  writeFileSync(join(engine, 'bin', 'kingmaker'), `#!/bin/sh\necho ${version}\n`, { mode: 0o755 });
  writeFileSync(join(c, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.ronininc.solghost</string>
<key>CFBundleExecutable</key><string>${executable}</string>
<key>CFBundleName</key><string>Kingmaker</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>SolomonRuntimeBuild</key><string>fixture</string>
</dict></plist>
`);
  writeFileSync(join(c, 'MacOS', executable), '#!/bin/sh\nexit 0\n');
  // Electron-as-Node stand-in: the engine runs the bundled scripts with Contents/MacOS/Solomon + ELECTRON_RUN_AS_NODE=1.
  writeFileSync(join(c, 'MacOS', 'Solomon'), `#!/bin/sh\nexec "${process.execPath}" "$@"\n`);
  chmodSync(join(c, 'MacOS', executable), 0o755);
  chmodSync(join(c, 'MacOS', 'Solomon'), 0o755);
  writeFileSync(join(c, 'Resources', 'solomon-runtime', 'scripts', 'solomon-bootstrap-corpus.mjs'), CORPUS);
  writeFileSync(join(c, 'Resources', 'solomon-runtime', 'scripts', 'solomon-searxng-native-setup.mjs'), SEARXNG);
  // Incompressible padding, so the archive really splits into several parts.
  writeFileSync(join(c, 'Resources', 'payload.bin'), randomBytes(padBytes));
  // Inside out, as the real packager signs: the second executable first, then the bundle.
  for (const target of [join(c, 'MacOS', 'Solomon'), app]) {
    const sign = spawnSync('codesign', ['--force', '--sign', '-', target], { encoding: 'utf8' });
    if (sign.status !== 0) throw new Error(`codesign ${target}: ${sign.stderr}`);
  }
  return app;
}

export const FIXTURE_MODELS = {
  'huihui_ai/qwen3-abliterated:1.7b': 'a'.repeat(64),
  'huihui_ai/qwen3-abliterated:0.6b': 'b'.repeat(64),
  'huihui_ai/qwen3.5-abliterated:2b': 'c'.repeat(64),
  'huihui_ai/qwen2.5-coder-abliterate:1.5b': 'd'.repeat(64),
  'huihui_ai/qwen2.5-coder-abliterate:7b': 'e'.repeat(64),
};

/** Build a release from a fixture app with the real release-parts script (offline: pins from a file and a stub). */
/** A small ad-hoc-signed "Ronin Launcher.app", zipped the way ronin-launcher packages it (ditto -c -k --keepParent),
 *  and its pin beside it. → the pin's path. */
export function makeFixtureLauncher(parent) {
  const app = join(parent, 'Ronin Launcher.app'), c = join(app, 'Contents');
  mkdirSync(join(c, 'MacOS'), { recursive: true });
  writeFileSync(join(c, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>org.ronininc.launcher</string>
<key>CFBundleExecutable</key><string>ronin-launcher</string>
<key>CFBundleName</key><string>Ronin Launcher</string>
<key>CFBundleShortVersionString</key><string>0.1.0</string>
</dict></plist>
`);
  writeFileSync(join(c, 'MacOS', 'ronin-launcher'), '#!/bin/sh\nexit 0\n'); chmodSync(join(c, 'MacOS', 'ronin-launcher'), 0o755);
  const signed = spawnSync('codesign', ['--force', '--sign', '-', app], { encoding: 'utf8' });
  if (signed.status !== 0) throw new Error(`codesign the fixture launcher: ${signed.stderr}`);
  const zip = join(parent, 'Ronin-Launcher-0.1.0-arm64.zip');
  const z = spawnSync('ditto', ['-c', '-k', '--keepParent', app, zip], { encoding: 'utf8' });
  if (z.status !== 0) throw new Error(`zip the fixture launcher: ${z.stderr}`);
  const bytes = readFileSync(zip);
  const pin = { name: 'Ronin Launcher.app', bundleId: 'org.ronininc.launcher', version: '0.1.0', archive: basename(zip), format: 'zip', url: null, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), required: true };
  const pinFile = join(parent, 'ronin-launcher-pin.json');
  writeFileSync(pinFile, JSON.stringify(pin, null, 2));
  return pinFile;
}

export async function buildFixtureRelease({ partSize = 100_000, padBytes = 300_000, models = FIXTURE_MODELS, pins = null } = {}) {
  const work = mkdtempSync(join(tmpdir(), 'km-release-'));
  const app = makeFixtureApp(join(work, 'build'), { padBytes });
  const out = join(work, 'release');
  const pinsFile = join(work, 'pins.json');
  writeFileSync(pinsFile, JSON.stringify(pins ?? {}));
  mkdirSync(join(work, 'launcher'), { recursive: true });
  const launcherPin = makeFixtureLauncher(join(work, 'launcher'));
  const lines = [];
  const { main } = await import('../../scripts/release-parts.mjs');
  const code = await main({ argv: ['--app', app, '--out', out, '--part-size', String(partSize), '--offline', '--pins', pinsFile, '--level', '1', '--launcher', launcherPin], env: { ...process.env, KINGMAKER_ALLOW_ADHOC: '1' }, out: (l) => lines.push(l), offlineDigests: async () => models });
  if (code !== 0) throw new Error(`release-parts exited ${code}:\n${lines.join('\n')}`);
  const manifest = JSON.parse(readFileSync(join(out, 'kingmaker-manifest.json'), 'utf8'));
  return { work, app, out, manifest, lines, manifestFile: join(out, 'kingmaker-manifest.json') };
}

/**
 * Serve a release folder over HTTP with Range support. Switches: corrupt = { [partName]: true } serves wrong bytes;
 * dropOnce = { [partName]: byteCount } closes the connection after that many bytes the first time; github = { repo, tag,
 * token } also serves the GitHub release API (assets by id, only with "Authorization: Bearer <token>").
 */
export async function serveRelease(dir, { corrupt = {}, dropOnce = {}, github = null, ollama = null } = {}) {
  const seen = [];
  const dropped = new Set();
  const shipped = github ? JSON.parse(readFileSync(join(dir, 'kingmaker-manifest.json'), 'utf8')) : null;
  const assetNames = shipped ? [...shipped.parts.map((p) => p.name), ...(shipped.launcher ? [shipped.launcher.archive] : [])] : [];
  const server = createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, range: req.headers.range ?? null, auth: req.headers.authorization ?? null, accept: req.headers.accept ?? null });
    if (ollama && req.url.startsWith('/api/')) return ollama(req, res);
    let name = decodeURIComponent(req.url.split('?')[0].replace(/^\/+/, ''));
    if (github) {
      const authed = req.headers.authorization === `Bearer ${github.token}`;
      if (req.url === `/api/repos/${github.repo}/releases/tags/${github.tag}`) {
        if (!authed) { res.statusCode = 404; return res.end('{"message":"Not Found"}'); }
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify({ tag_name: github.tag, assets: assetNames.map((n, i) => ({ id: 9000 + i, name: n })) }));
      }
      const m = /^\/api\/repos\/[^/]+\/[^/]+\/releases\/assets\/(\d+)$/.exec(req.url);
      if (m) {
        if (!authed || req.headers.accept !== 'application/octet-stream') { res.statusCode = 404; return res.end(); }
        name = assetNames[Number(m[1]) - 9000];
      } else if (!req.url.startsWith('/public/')) { res.statusCode = 404; return res.end(); }
    }
    const file = join(dir, basename(name));
    if (!name || !existsSync(file)) { res.statusCode = 404; return res.end('not found'); }
    let body = readFileSync(file);
    if (corrupt[basename(name)]) { body = Buffer.from(body); body[0] ^= 0xff; }
    let start = 0;
    const range = /^bytes=(\d+)-$/.exec(req.headers.range ?? '');
    if (range) {
      start = Number(range[1]);
      if (start >= body.length) { res.statusCode = 416; return res.end(); }
      res.statusCode = 206;
      res.setHeader('content-range', `bytes ${start}-${body.length - 1}/${body.length}`);
    }
    res.setHeader('accept-ranges', 'bytes');
    res.setHeader('content-length', String(body.length - start));
    const cut = dropOnce[basename(name)];
    if (cut && !dropped.has(name)) {
      dropped.add(name);
      res.write(body.subarray(start, start + cut));
      setTimeout(() => res.socket.destroy(), 50);
      return;
    }
    res.end(body.subarray(start));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, seen, close: () => new Promise((r) => server.close(r)) };
}

/** A hermetic PATH for the engine: the given fake tools first, then only the system folders (no Homebrew). */
export function fakeTools(dir, tools) {
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(tools)) {
    writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(dir, name), 0o755);
  }
  return `${dir}:/usr/bin:/bin:/usr/sbin:/sbin`;
}

/** Run installer/engine.sh; resolves { code, out, events } (events = the parsed "@@km" lines). */
export function runEngine(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(ENGINE, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.once('exit', (code) => {
      const events = out.split('\n').filter((l) => l.startsWith('@@km ')).map((l) => JSON.parse(l.slice(5)));
      resolve({ code, out, err, events, failed: events.find((e) => e.t === 'failed') ?? null, done: events.find((e) => e.t === 'done') ?? null });
    });
  });
}

export const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };
export const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };
