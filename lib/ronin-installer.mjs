// lib/ronin-installer.mjs — the Ronin Installer on a Mac (the owner, 2026-10-15: "ronin installer will pull from repos i
// link to it"). The owners keep the repo list in the CRM (its Ronin Installer page; the installer_repos and
// installer_repo_add tools on its /mcp). Kingmaker installs a repo's LATEST RELEASE — never source: a stock Mac has no
// build tools.
//   1. GitHub's latest release → the one Mac file (pickMacAsset: a .dmg, then a .pkg, then a Mac .zip; Apple Silicon or
//      universal first; Windows/Linux files and checksums never).
//   2. Download it, checked against GitHub's recorded SHA-256 when the release has one (anything else is deleted).
//   3. Mark it as downloaded from the internet (com.apple.quarantine), so macOS's Gatekeeper checks it on first open
//      exactly as it would a browser download. Kingmaker never skips that check.
//   4. REA reads the app (lib/rea.mjs). Code that fetches-and-runs or hides what it runs is never installed.
//   5. Install: a .dmg's or .zip's app goes into /Applications (or ~/Applications when /Applications isn't writable); an
//      app already there moves to the Trash first, never deleted. A .pkg opens in macOS's own Installer for the owner to
//      confirm: Kingmaker never installs with administrator rights.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { inspect } from './rea.mjs';

const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/;

/** Pure: "https://github.com/a/b(.git)(/…)", "github.com/a/b", "git@github.com:a/b" or "a/b" → { owner, repo }, else null. */
export function parseRepo(input) {
  const s = String(input || '').trim().replace(/^git@github\.com:/i, 'https://github.com/');
  const m = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s?#]+)\/([^/\s?#]+)/i.exec(s) || /^([^/\s:]+)\/([^/\s]+)$/.exec(s);
  if (!m) return null;
  const owner = m[1], repo = m[2].replace(/\.git$/i, '');
  return NAME.test(owner) && NAME.test(repo) && !['.', '..'].includes(repo) ? { owner, repo } : null;
}

/** Pure: the owner's "install <owner/repo or its GitHub link>" → the repo text, else null. Only a repo's shape counts:
 *  "install ffmpeg" or "install the CLI hub" stay with the device desk, which installs tools. */
export function installRequest(text) {
  const m = /^\s*(?:please\s+)?(?:install|get me|download and install)\s+(?:the\s+)?(?:latest\s+(?:release\s+)?(?:of|from)\s+)?(\S+)\s*[.!]?\s*$/i.exec(String(text || ''));
  const target = m ? m[1].replace(/[.,!?;:]+$/, '') : '';
  return target && parseRepo(target) ? target : null;
}

/** Pure: the release file a Mac installs, or null (the same rule as the CRM's src/installer.js). */
export function pickMacAsset(assets = []) {
  const files = assets.filter((a) => a?.name && a?.browser_download_url && !/(win(dows|32|64)?|\.exe|\.msi|linux|\.deb|\.rpm|\.appimage|android|\.apk|ios|\.ipa|sha256|\.sig|\.asc|checksums?)/i.test(a.name));
  const score = (a) => {
    const n = a.name.toLowerCase(), ext = n.endsWith('.dmg') ? 3 : n.endsWith('.pkg') ? 2 : n.endsWith('.zip') ? 1 : 0;
    if (!ext) return -1;
    const mac = /(mac|darwin|osx|apple)/.test(n), arm = /(arm64|aarch64|apple[-_ ]?silicon|universal)/.test(n), intel = /(x86_64|x64|intel|amd64)/.test(n) && !arm;
    if (ext === 1 && !mac && !arm) return -1;
    return ext * 10 + (mac ? 3 : 0) + (arm ? 4 : 0) - (intel ? 5 : 0);
  };
  const best = files.map((a) => [score(a), a]).filter(([s]) => s >= 0).sort((x, y) => y[0] - x[0])[0]?.[1];
  return best ? { name: best.name, size: best.size || 0, url: best.browser_download_url, sha256: /^sha256:([0-9a-f]{64})$/.exec(best.digest || '')?.[1] || null,
    kind: best.name.toLowerCase().split('.').pop() } : null;
}

/** The latest release of owner/repo → { ok, tag, name, mac } or { ok: false, why }. */
export async function latestRelease({ owner, repo }, { fetchImpl = fetch, token = process.env.GITHUB_TOKEN, api = 'https://api.github.com' } = {}) {
  try {
    const r = await fetchImpl(`${api}/repos/${owner}/${repo}/releases/latest`, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'kingmaker-ronin-installer', ...(token ? { authorization: `Bearer ${token}` } : {}) } });
    if (r.status === 404) return { ok: false, why: `${owner}/${repo} has no published release (or it's private).` };
    if (!r.ok) return { ok: false, why: `GitHub answered ${r.status}${r.status === 403 ? ' (rate limit; try again in a bit)' : ''}.` };
    const j = await r.json(), mac = pickMacAsset(j.assets);
    return mac ? { ok: true, tag: clip(j.tag_name, 80), name: clip(j.name || j.tag_name, 160), mac } : { ok: false, why: `${owner}/${repo} ${clip(j.tag_name, 40)} has no Mac file (.dmg, .pkg or Mac .zip).` };
  } catch (e) { return { ok: false, why: `Couldn't reach GitHub: ${clip(e?.message, 120)}` }; }
}

const run = (bin, args, opts = {}) => new Promise((ok) => execFile(bin, args, { maxBuffer: 4 * 1024 * 1024, timeout: 10 * 60_000, ...opts }, (e, stdout, stderr) => ok({ ok: !e, code: e?.code ?? 0, stdout: String(stdout), stderr: String(stderr) })));

/** Download to `dest`, checked against `sha256` when given. → { ok, path } or { ok: false, why } (nothing left behind). */
export async function downloadChecked(url, dest, { sha256 = null, fetchImpl = fetch, maxBytes = 8e9 } = {}) {
  const part = `${dest}.part`;
  try {
    const r = await fetchImpl(url, { redirect: 'follow', headers: { 'user-agent': 'kingmaker-ronin-installer' } });
    if (!r.ok || !r.body) return { ok: false, why: `The download answered ${r.status}.` };
    const hash = createHash('sha256'), out = createWriteStream(part);
    let n = 0;
    for await (const chunk of r.body) {
      n += chunk.length;
      if (n > maxBytes) throw new Error('the file is larger than its release says');
      hash.update(chunk);
      if (!out.write(chunk)) await new Promise((ok) => out.once('drain', ok));
    }
    await new Promise((ok, fail) => out.end((e) => (e ? fail(e) : ok())));
    const got = hash.digest('hex');
    if (sha256 && got !== sha256) { rmSync(part, { force: true }); return { ok: false, why: "The file didn't match the SHA-256 GitHub recorded for it, so it was deleted." }; }
    renameSync(part, dest);
    return { ok: true, path: dest, sha256: got, checked: !!sha256 };
  } catch (e) { rmSync(part, { force: true }); return { ok: false, why: `The download failed: ${clip(e?.message, 120)}` }; }
}

/** Mark a path as downloaded from the internet, so Gatekeeper checks it on first open (as Safari would). */
export async function quarantine(path, { agent = 'Kingmaker', at = Date.now() } = {}) {
  return run('/usr/bin/xattr', ['-w', 'com.apple.quarantine', `0081;${Math.floor(at / 1000).toString(16)};${agent};`, path]);
}

/** Where apps go: /Applications when it's writable, else ~/Applications. */
export function appsDir({ home = homedir(), system = '/Applications' } = {}) {
  try { accessSync(system, constants.W_OK); return system; } catch { const d = join(home, 'Applications'); mkdirSync(d, { recursive: true }); return d; }
}

const appsIn = (dir) => { try { return readdirSync(dir).filter((n) => n.endsWith('.app') && !n.startsWith('.')); } catch { return []; } };
const pkgsIn = (dir) => { try { return readdirSync(dir).filter((n) => /\.(m?pkg)$/i.test(n)); } catch { return []; } };

/** Copy one .app into the apps folder; one already there goes to the Trash first. → { ok, path, replaced } */
async function placeApp(src, dest, { home = homedir() } = {}) {
  const target = join(dest, basename(src));
  let replaced = false;
  if (existsSync(target)) {
    const trash = join(home, '.Trash', `${basename(src, '.app')} (replaced ${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '.')}).app`);
    mkdirSync(join(home, '.Trash'), { recursive: true });
    renameSync(target, trash); replaced = true;
  }
  const c = await run('/usr/bin/ditto', [src, target]);
  return c.ok ? { ok: true, path: target, replaced } : { ok: false, why: `Copying the app failed: ${clip(c.stderr, 160)}` };
}

/**
 * Install one downloaded release file. kind: dmg | zip | pkg. → { ok, path?, opened?, rea?, why? }
 * deps (tests): { dest, open, home, reaInspect }
 */
export async function installFile(file, kind, { dest = appsDir(), home = homedir(), open = (p) => run('/usr/bin/open', [p]), reaInspect = inspect, log = () => {} } = {}) {
  await quarantine(file);
  if (kind === 'pkg') {
    const o = await open(file);
    return o.ok ? { ok: true, opened: file, note: "macOS's Installer is open: check what it installs and confirm there." } : { ok: false, why: `macOS's Installer didn't open: ${clip(o.stderr, 160)}` };
  }
  const work = mkdtempSync(join(tmpdir(), 'ronin-install-'));
  let mount = null;
  try {
    let from = work;
    if (kind === 'dmg') {
      mount = join(work, 'mnt'); mkdirSync(mount);
      const a = await run('/usr/bin/hdiutil', ['attach', file, '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mount]);
      if (!a.ok) { mount = null; return { ok: false, why: `The disk image didn't open: ${clip(a.stderr, 160)}` }; }
      from = mount;
    } else if (kind === 'zip') {
      const x = await run('/usr/bin/ditto', ['-x', '-k', file, work]);
      if (!x.ok) return { ok: false, why: `The zip didn't open: ${clip(x.stderr, 160)}` };
      const inner = appsIn(work).length ? null : readdirSync(work).map((n) => join(work, n)).find((p) => { try { return statSync(p).isDirectory() && appsIn(p).length; } catch { return false; } });
      if (inner) from = inner;
    } else return { ok: false, why: `Kingmaker doesn't install .${kind} files.` };
    const apps = appsIn(from);
    if (!apps.length) {
      const pkg = pkgsIn(from)[0];
      if (pkg) { // an installer package inside the image: copied out, then opened in macOS's Installer
        const copy = join(work, pkg); await run('/usr/bin/ditto', [join(from, pkg), copy]); await quarantine(copy);
        const o = await open(copy);
        return o.ok ? { ok: true, opened: copy, note: "macOS's Installer is open: check what it installs and confirm there." } : { ok: false, why: "macOS's Installer didn't open." };
      }
      return { ok: false, why: 'There was no app inside it.' };
    }
    if (apps.length > 1) log('installer_many_apps', { apps: apps.slice(0, 5) });
    const app = join(from, apps[0]);
    const rea = reaInspect([app]);
    if (rea.verdict === 'rejected') return { ok: false, rea, why: `REA refused it: ${rea.summary}` };
    const placed = await placeApp(app, dest, { home });
    if (placed.ok) await quarantine(placed.path);
    return placed.ok ? { ...placed, rea } : placed;
  } finally {
    if (mount) await run('/usr/bin/hdiutil', ['detach', mount, '-quiet']).then((d) => (d.ok ? d : run('/usr/bin/hdiutil', ['detach', mount, '-force', '-quiet'])));
    rmSync(work, { recursive: true, force: true });
  }
}

/** The whole job for one repo: latest release → download (checked) → install. → { ok, line, ... } with one plain line. */
export async function installRepo(input, { fetchImpl = fetch, downloads = join(homedir(), 'Downloads'), dest, home, open, reaInspect, log = () => {} } = {}) {
  const p = parseRepo(input);
  if (!p) return { ok: false, line: 'Give me a GitHub repo, like owner/repo or its link.' };
  const rel = await latestRelease(p, { fetchImpl });
  if (!rel.ok) return { ok: false, line: rel.why };
  mkdirSync(downloads, { recursive: true });
  const file = join(downloads, rel.mac.name.replace(/[/\\]/g, '_'));
  const dl = await downloadChecked(rel.mac.url, file, { sha256: rel.mac.sha256, fetchImpl });
  if (!dl.ok) return { ok: false, line: dl.why };
  log('installer_downloaded', { repo: `${p.owner}/${p.repo}`, tag: rel.tag, checked: dl.checked });
  const r = await installFile(file, rel.mac.kind, { ...(dest ? { dest } : {}), ...(home ? { home } : {}), ...(open ? { open } : {}), ...(reaInspect ? { reaInspect } : {}), log });
  const name = `${p.owner}/${p.repo} ${rel.tag}`;
  const shaNote = dl.checked ? 'SHA-256 checked' : 'GitHub recorded no SHA-256 for it';
  if (!r.ok) return { ok: false, line: `${name}: ${r.why}`, rea: r.rea };
  if (r.opened) return { ok: true, line: `${name} (${shaNote}): ${r.note}`, opened: r.opened };
  const reaNote = r.rea?.verdict === 'sandboxed' ? ` REA found: ${clip(r.rea.summary, 200)}` : '';
  return { ok: true, path: r.path, line: `Installed ${basename(r.path, '.app')} (${name}, ${shaNote}) in ${basename(dest || appsDir())}${r.replaced ? '; the old copy is in the Trash' : ''}. macOS checks it the first time you open it.${reaNote}` };
}
