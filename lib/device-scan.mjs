// FIRST-RUN DEVICE SCAN: everything on this Mac Ghost could drive, and how.
//
// Operator (2026-10-08): "one of the first things ghost should do upon first startup is scan the entire device and
// make sure it has cli's and mcps for everything on it … it should never find itself unable to do any task for me".
//
//   WHAT     A read-only inventory: the apps (/Applications, ~/Applications, the system's), Homebrew formulae and
//            casks, global npm / pipx / uv / cargo tools, the CLIs on PATH, the MCP servers already configured on
//            this Mac (Claude Desktop, Claude Code, Cursor, Windsurf, VS Code, Codex, Gemini, Zed: their config is
//            READ, never run, and only a server's name, transport, command name, package and env var NAMES are
//            kept, never its args or values), Ghost's own hands, and the web apps in his Chrome session (hosts only).
//   MAP      One file, <runtime home>/device-capabilities.json (0600): app → every way Ghost can drive it (its own
//            CLI, an MCP server, Kingmaker's own engine, its AppleScript dictionary, its URL scheme) and the Hands of
//            Horus, the universal fallback that drives any window. An app with no CLI or MCP is a GAP: the
//            candidate search (device-candidates.mjs) looks for open-source tools for it and writes PROPOSALS;
//            nothing is installed without the owner's yes (device-tools.mjs).
//   PACE     Cheap and quiet: directory reads and one `plutil` per app, at a cooperative duty cycle that follows the
//            same AIMD rule as every Ghost background job (pacer.mjs): a busy Mac stretches the gaps between steps,
//            an idle one runs straight through. RESUMABLE: each phase is saved as it finishes, so a killed scan picks
//            up at the first phase it had not finished.
//   NEVER    Anything that writes outside Ghost's own data, launches an app, asks for a permission (no AppleScript
//            to Chrome: its session file is read instead), or reads a secret value (the key scan is device-keys.mjs,
//            names only).

import { execFile } from 'node:child_process';
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { basename, delimiter, dirname, extname, join, sep } from 'node:path';
import { liveSignalSource, MIN_DUTY, nextDuty } from './pacer.mjs';
import { findGhostBinary, findPeekabooBinary } from './paths.mjs';
import { ronin } from './addons.mjs';

/** On a one-company install (the Ronin add-on's CRM lock), the other company's apps are left out. */
const isOtherTenantApp = (app, lock) => Boolean(lock && ronin?.isOtherTenantApp(app, lock));

export const MAP_SCHEMA = 'sol-ghost.device-capabilities/1';
export const MAP_FILE = 'device-capabilities.json';
/** A map older than this is refreshed on the next start (apps come and go). */
export const MAP_MAX_AGE_MS = 7 * 24 * 3600_000;
export const SCAN_PHASES = Object.freeze(['apps', 'packages', 'path', 'mcp', 'hands', 'web']);
/** How each route ranks: the best one is what Ghost reaches for first. The hands always work, last. */
export const ROUTE_RANK = Object.freeze({ cli: 5, mcp: 5, engine: 5, applescript: 3, 'url-scheme': 2, hands: 1 });
export const HANDS_LABEL = 'the Hands of Horus';

export const deviceMapPath = (paths) => join(paths.runtimeHome, MAP_FILE);

// ── Small injectable world (fs + exec), so every reader is testable on fixtures ─────────────────────────────

export function realWorld() {
  return {
    home: homedir(),
    env: process.env,
    readdir: (p) => readdirSync(p),
    stat: (p) => statSync(p),
    lstat: (p) => lstatSync(p),
    realpath: (p) => realpathSync(p),
    readFile: (p) => readFileSync(p),
    run: (file, args, { timeoutMs = 5_000 } = {}) => new Promise((resolve) => {
      execFile(file, args, { timeout: timeoutMs, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => resolve({ ok: !error, stdout: String(stdout ?? '') }));
    }),
  };
}

const safe = (fn, fallback) => { try { return fn(); } catch { return fallback; } };
const list = (w, dir) => safe(() => w.readdir(dir).filter((n) => !n.startsWith('.')), []);
const isDir = (w, p) => safe(() => w.stat(p).isDirectory(), false);
const isFile = (w, p) => safe(() => w.stat(p).isFile(), false);
const tilde = (p, home) => (home && String(p).startsWith(`${home}${sep}`) ? `~${String(p).slice(home.length)}` : String(p));

// ── Cooperative pacing: the in-process scan yields between steps by the same AIMD duty ─────────────────────

/**
 * step(workMs) after each unit of work sleeps workMs × (1 − duty) / duty, so the scan takes `duty` of the time it
 * runs in. The duty follows nextDuty on the live signals (subscribed only while the scan runs). stop() unsubscribes.
 */
// The rest between steps is awaited work, so its timer keeps the process alive (an unref'd one let a one-shot
// `kingmaker scan` exit silently mid-scan on a busy Mac).
export function cooperativePacer({ source = liveSignalSource(), sleep = (ms) => new Promise((r) => { setTimeout(r, ms); }), maxSleepMs = 5_000, initialDuty = 1 } = {}) {
  let duty = initialDuty;
  const unsubscribe = source.subscribe((s) => { duty = nextDuty(duty, s).duty; });
  return {
    get duty() { return duty; },
    async step(workMs = 10) {
      if (duty >= 1) return 0;
      let waited = 0;
      // A single rest is not admission to the next scan unit: remain here until a live sample clears the hold.
      while (duty <= 0) { await sleep(maxSleepMs); waited += maxSleepMs; }
      if (duty >= 1) return waited;
      const ms = Math.min(maxSleepMs, Math.round(Math.max(1, workMs) * (1 - duty) / Math.max(MIN_DUTY, duty)));
      if (ms > 0) await sleep(ms);
      return waited + ms;
    },
    stop() { unsubscribe?.(); },
  };
}

// ── Apps ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Where apps live. System apps are Apple's own. */
export function appRoots(home) {
  return [
    { dir: '/Applications', system: false, depth: 2 },
    { dir: join(home, 'Applications'), system: false, depth: 2 },
    { dir: '/System/Applications', system: true, depth: 2 },
    { dir: '/System/Library/CoreServices', system: true, depth: 1, only: ['Finder.app'] },
  ];
}

/** Every *.app under the roots (a vendor folder like "Adobe Photoshop 2025/" is looked into once). */
export function findApps(w, roots = appRoots(w.home)) {
  const out = [];
  const seen = new Set();
  const walk = (dir, root, depth) => {
    for (const name of list(w, dir)) {
      const p = join(dir, name);
      if (name.endsWith('.app')) {
        if (root.only && !root.only.includes(name)) continue;
        const key = safe(() => w.realpath(p), p);
        if (!seen.has(key) && isDir(w, p)) { seen.add(key); out.push({ path: p, system: root.system }); }
      } else if (depth > 1 && !root.only && isDir(w, p)) walk(p, root, depth - 1);
    }
  };
  for (const root of roots) walk(root.dir, root, root.depth);
  return out;
}

/** Pure: the few Info.plist values the map needs, from a minimal XML plist reading (plutil's JSON is preferred). */
export function parsePlistXml(text) {
  const t = String(text ?? '');
  const out = {};
  const str = (key) => new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(t)?.[1];
  const bool = (key) => { const m = new RegExp(`<key>${key}</key>\\s*<(true|false)\\s*/>`).exec(t); return m ? m[1] === 'true' : undefined; };
  for (const k of ['CFBundleIdentifier', 'CFBundleName', 'CFBundleDisplayName', 'CFBundleExecutable', 'CFBundleShortVersionString', 'OSAScriptingDefinition']) { const v = str(k); if (v !== undefined) out[k] = v; }
  for (const k of ['LSBackgroundOnly', 'LSUIElement']) { const v = bool(k) ?? (str(k) !== undefined ? /^(yes|true|1)$/i.test(str(k)) : undefined); if (v !== undefined) out[k] = v; }
  const scripting = bool('NSAppleScriptEnabled') ?? (str('NSAppleScriptEnabled') ? /^(yes|true|1)$/i.test(str('NSAppleScriptEnabled')) : undefined);
  if (scripting !== undefined) out.NSAppleScriptEnabled = scripting;
  const schemesBlock = /<key>CFBundleURLSchemes<\/key>\s*<array>([\s\S]*?)<\/array>/g;
  const schemes = [];
  for (const m of t.matchAll(schemesBlock)) for (const s of m[1].matchAll(/<string>([^<]+)<\/string>/g)) schemes.push(s[1]);
  if (schemes.length) out.CFBundleURLTypes = [{ CFBundleURLSchemes: schemes }];
  return out;
}

export async function readInfoPlist(w, appPath) {
  const plist = join(appPath, 'Contents', 'Info.plist');
  const r = await w.run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist]);
  if (r.ok) { try { return JSON.parse(r.stdout); } catch { /* fall through */ } }
  return safe(() => parsePlistXml(w.readFile(plist).toString('utf8')), {});
}

/** Pure: an app's URL schemes, minus the web's own (an app that only opens http links is not drivable by them). */
export function urlSchemes(info) {
  const out = [];
  for (const t of Array.isArray(info?.CFBundleURLTypes) ? info.CFBundleURLTypes : []) {
    for (const s of Array.isArray(t?.CFBundleURLSchemes) ? t.CFBundleURLSchemes : []) {
      const v = String(s).toLowerCase();
      if (/^[a-z][a-z0-9+.-]{1,40}$/.test(v) && !['http', 'https', 'file', 'mailto', 'ftp'].includes(v) && !out.includes(v)) out.push(v);
    }
  }
  return out.slice(0, 6);
}

/** Apps whose own CLI is not on PATH under the app's name, by bundle id → the binary names (any on PATH counts). */
export const KNOWN_APP_CLIS = Object.freeze({
  'com.microsoft.VSCode': ['code'],
  'com.microsoft.VSCodeInsiders': ['code-insiders'],
  'com.todesktop.230313mzl4w4u92': ['cursor'],
  'com.exafunction.windsurf': ['windsurf'],
  'com.sublimetext.4': ['subl'],
  'com.sublimetext.3': ['subl'],
  'com.barebones.bbedit': ['bbedit'],
  'com.apple.dt.Xcode': ['xcodebuild', 'xcrun'],
  'com.docker.docker': ['docker'],
  'com.tailscale.ipn.macos': ['tailscale'],
  'io.tailscale.ipn.macsys': ['tailscale'],
  'com.1password.1password': ['op'],
  'com.github.GitHubClient': ['gh', 'github'],
  'com.anthropic.claudefordesktop': ['claude'],
  'com.electron.ollama': ['ollama'],
  'com.ollama.ollama': ['ollama'],
  'com.colliderli.iina': ['iina', 'iina-cli'],
  'org.videolan.vlc': ['vlc'],
  'org.inkscape.Inkscape': ['inkscape'],
  'org.blenderfoundation.blender': ['blender'],
  'com.google.Chrome': ['chrome-cli'],
  'org.mozilla.firefox': ['firefox'],
  'com.jetbrains.intellij': ['idea'],
  'com.jetbrains.pycharm': ['pycharm'],
  'com.jetbrains.WebStorm': ['webstorm'],
  'com.raycast.macos': ['ray'],
  'com.apple.Terminal': ['osascript'],
  'com.googlecode.iterm2': ['it2api'],
  'com.obsproject.obs-studio': ['obs-cmd'],
  'org.gimp.gimp-2.10': ['gimp'],
  'com.spotify.client': ['spotify_player', 'spt', 'ncspot'],
  'md.obsidian': ['obsidian-cli', 'obs'],
  'com.apple.Safari': ['safaridriver'],
  'com.apple.Notes': ['memo'],
  'com.apple.reminders': ['reminders'],
  'com.apple.iCal': ['icalbuddy'],
  'com.apple.finder': ['open'],
  'com.apple.Preview': ['sips'],
  'com.apple.Music': ['music'],
  'com.apple.shortcuts': ['shortcuts'],
  'com.apple.Automator': ['automator'],
  'com.apple.ScriptEditor2': ['osascript'],
});

/** The same, by a word of the app's name (a Chrome web app like "GitHub" or "Cloudflare" has no bundle of its own). */
export const KNOWN_NAME_CLIS = Object.freeze({
  github: ['gh'], cloudflare: ['wrangler', 'cloudflared'], stripe: ['stripe'], vercel: ['vercel'], netlify: ['netlify'], heroku: ['heroku'],
  docker: ['docker'], slack: ['slack'], spotify: ['spotify_player', 'spt'], youtube: ['yt-dlp'], supabase: ['supabase'], firebase: ['firebase'],
  shopify: ['shopify'], twilio: ['twilio'], ollama: ['ollama'], tailscale: ['tailscale'], obsidian: ['obsidian-cli'], linear: ['linear'],
});

/** Ghost and the desktop app themselves: never a gap, never searched for. */
export const SELF_BUNDLES = Object.freeze(['com.ronininc.solghost', 'com.ronin.solomon']);

/** Executables an app carries inside its own bundle (VS Code's bin/code, Sublime's subl, IINA's iina-cli). */
export const BUNDLED_CLI_DIRS = Object.freeze([
  ['Contents', 'Resources', 'app', 'bin'],
  ['Contents', 'Resources', 'bin'],
  ['Contents', 'SharedSupport', 'bin'],
  ['Contents', 'Helpers'],
]);

/** Pure: of the CLIs an app carries or links onto PATH, the ones that are ITS command line (named for it), else none
 *  of its helpers (an app bundling pip, gs or dot does not make pip a way to drive the app). */
export function ownClis(names, tokens) {
  const related = names.filter((n) => tokens.some((t) => String(n).toLowerCase().replace(/[^a-z0-9]/g, '').includes(t)));
  return related.slice(0, 4);
}

function bundledClis(w, appPath, info) {
  const out = [];
  for (const parts of BUNDLED_CLI_DIRS) {
    const dir = join(appPath, ...parts);
    for (const name of list(w, dir)) {
      if (name.endsWith('.app') || name.endsWith('.framework') || /\.(dylib|plist|json|node|so)$/.test(name)) continue;
      if (parts.at(-1) === 'Helpers' && !/cli|ctl|tool/i.test(name)) continue;
      const p = join(dir, name);
      const st = safe(() => w.stat(p), null);
      if (st?.isFile() && (st.mode & 0o111)) out.push({ bin: name, path: p });
    }
  }
  // A Contents/MacOS/*-cli next to the main binary (IINA, many Electron apps' helpers).
  for (const name of list(w, join(appPath, 'Contents', 'MacOS'))) {
    if (name !== info?.CFBundleExecutable && /(^|[-_])cli$/i.test(name)) out.push({ bin: name, path: join(appPath, 'Contents', 'MacOS', name) });
  }
  return out;
}

const hasSdef = (w, appPath, info) => Boolean(info?.OSAScriptingDefinition)
  || info?.NSAppleScriptEnabled === true
  || list(w, join(appPath, 'Contents', 'Resources')).some((n) => n.endsWith('.sdef'));

/** Pure: an app's name as Finder shows it (the bundle's file name), and the name its bundle gives itself. */
export function appName(info, appPath) {
  return basename(String(appPath), '.app').trim() || String(info?.CFBundleDisplayName || info?.CFBundleName || '').trim();
}

const GENERIC_WORDS = new Set(['app', 'apps', 'the', 'for', 'and', 'mac', 'macos', 'desktop', 'studio', 'pro', 'lite', 'code', 'beta', 'helper', 'microsoft', 'google', 'apple', 'adobe', 'by', 'of', 'tool', 'tools', 'client', 'player', 'manager', 'editor', 'assistant', 'utility', 'center', 'centre', 'settings', 'web', 'online', 'free', 'plus', 'new', 'classic', 'release', 'mobile', 'launcher', 'machine', 'sharing', 'screen', 'file', 'exchange', 'time', 'script', 'system', 'information']);

/** Pure: the words an app goes by (for matching MCP servers, CLIs and requests): "Visual Studio Code" → vscode, visual. */
export function appTokens(name, bundleId = '', alsoNamed = '') {
  const tokens = new Set();
  for (const n of [name, alsoNamed]) {
    const words = String(n ?? '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/).filter((x) => x && !/^\d+$/.test(x));
    const joined = words.join('');
    if (joined.length >= 3 && !GENERIC_WORDS.has(joined)) tokens.add(joined);
    for (const w of words) if (w.length >= 4 && !GENERIC_WORDS.has(w)) tokens.add(w);
    const alias = { visualstudiocode: 'vscode', googlechrome: 'chrome', microsoftword: 'word', microsoftexcel: 'excel', microsoftpowerpoint: 'powerpoint', microsoftoutlook: 'outlook', microsoftteams: 'teams' }[joined];
    if (alias) tokens.add(alias);
  }
  const last = String(bundleId).toLowerCase().split('.').at(-1);
  if (last && last.length >= 4 && !GENERIC_WORDS.has(last) && /^[a-z][a-z0-9-]+$/.test(last) && !/^com\.google\.chrome\.app\./.test(String(bundleId).toLowerCase())) tokens.add(last.replace(/-/g, ''));
  return [...tokens];
}

/** Kingmaker's own engines that already drive an app (by bundle id). Only what ships in the engine today. */
export const SOLOMON_ENGINES = Object.freeze({
  'com.google.Chrome': "Kingmaker's Chrome connector and live web",
  'org.blenderfoundation.blender': "Kingmaker's Titan render engine (Blender in the background)",
});

/** Pure: every route for one app, best first, and whether it is a gap (no CLI, MCP or own engine). */
export function appRoutes(app, { pathClis = new Map(), mcpServers = [], handsLabel = HANDS_LABEL } = {}) {
  const routes = [];
  const clis = new Set();
  const tokens = app.tokens ?? [];
  for (const c of app.bundledClis ?? []) { routes.push({ kind: 'cli', via: c.bin, detail: c.path }); clis.add(c.bin); }
  for (const bin of app.pathLinkedClis ?? []) if (!clis.has(bin)) { routes.push({ kind: 'cli', via: bin, detail: 'on PATH, linked into the app' }); clis.add(bin); }
  // Known CLIs count wherever they are; a CLI merely NAMED like the app counts only off the system's own dirs
  // (/usr/bin/mail is not Mail.app's command line, /usr/bin/time is not Time Machine's).
  const known = [...(KNOWN_APP_CLIS[app.bundleId] ?? []), ...tokens.flatMap((t) => KNOWN_NAME_CLIS[t] ?? [])];
  for (const bin of [...known, ...tokens]) {
    const where = pathClis.get(bin);
    if (clis.has(bin) || !where || (where === 'system' && !known.includes(bin))) continue;
    routes.push({ kind: 'cli', via: bin, detail: where === 'system' ? 'macOS' : where });
    clis.add(bin);
  }
  for (const s of mcpServers) {
    const words = mcpWords(s);
    if (tokens.some((t) => words.has(t))) routes.push({ kind: 'mcp', via: s.name, detail: `${s.client}${s.package ? ` (${s.package})` : s.host ? ` (${s.host})` : ''}` });
  }
  if (app.self) routes.push({ kind: 'engine', via: 'self', detail: 'Kingmaker and the desktop app themselves' });
  else if (SOLOMON_ENGINES[app.bundleId]) routes.push({ kind: 'engine', via: 'engine', detail: SOLOMON_ENGINES[app.bundleId] });
  else if (app.webApp) routes.push({ kind: 'engine', via: 'chrome', detail: "a Chrome web app: Kingmaker's Chrome connector and live web" });
  if (app.scriptable && !app.webApp) routes.push({ kind: 'applescript', via: 'osascript', detail: 'its AppleScript dictionary' });
  if (app.schemes?.length) routes.push({ kind: 'url-scheme', via: `${app.schemes[0]}://`, detail: app.schemes.map((s) => `${s}://`).join(' ') });
  routes.push({ kind: 'hands', via: 'hands', detail: `${handsLabel} (any window)` });
  routes.sort((a, b) => ROUTE_RANK[b.kind] - ROUTE_RANK[a.kind]);
  // A web app is driven through Chrome, but its own CLI or MCP would still be better: it stays searchable.
  const direct = routes.some((r) => r.kind === 'cli' || r.kind === 'mcp' || (r.kind === 'engine' && r.via !== 'chrome'));
  return { routes, best: routes[0].kind, gap: !direct };
}

/** Pure: the words an MCP server goes by (its name, package and command, split). */
export function mcpWords(server) {
  const words = new Set();
  for (const v of [server.name, server.package, server.command, server.host]) {
    for (const w of String(v ?? '').toLowerCase().split(/[^a-z0-9]+/)) if (w.length >= 3) words.add(w);
    const joined = String(v ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (joined.length >= 3) words.add(joined);
  }
  return words;
}

export async function scanApps(w, { pace = null, pathLinks = new Map(), lock = null } = {}) {
  const apps = [];
  const seen = new Set();
  for (const { path, system } of findApps(w)) {
    const t0 = Date.now();
    const info = await readInfoPlist(w, path);
    if (info?.LSBackgroundOnly === true || /^(1|yes|true)$/i.test(String(info?.LSBackgroundOnly ?? ''))) continue;
    const name = appName(info, path);
    const bundleId = String(info?.CFBundleIdentifier ?? '');
    // The other company's apps are not Kingmaker's to drive (crm-lock.mjs): left out of the device map entirely.
    if (lock && isOtherTenantApp({ name, bundleId, path }, lock)) continue;
    // The same app installed twice (~/Applications and /Applications) is one app.
    const key = bundleId || name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const own = String(info?.CFBundleDisplayName || info?.CFBundleName || '').trim();
    const tokens = appTokens(name, bundleId, own !== name ? own : '');
    const linked = pathLinks.get(safe(() => w.realpath(path), path)) ?? [];
    const bundled = bundledClis(w, path, info);
    apps.push({
      name, bundleId, path: tilde(path, w.home), system, version: info?.CFBundleShortVersionString ? String(info.CFBundleShortVersionString).slice(0, 40) : null,
      tokens,
      scriptable: hasSdef(w, path, info),
      schemes: urlSchemes(info),
      bundledClis: bundled.filter((c) => ownClis([c.bin], tokens).length).slice(0, 4).map((c) => ({ bin: c.bin, path: tilde(c.path, w.home) })),
      pathLinkedClis: ownClis(linked, tokens),
      webApp: /^com\.google\.Chrome\.app\./.test(bundleId) || /\/Chrome Apps(\.localized)?\//.test(path),
      self: SELF_BUNDLES.includes(bundleId),
    });
    if (pace) await pace.step(Date.now() - t0);
  }
  return apps.sort((a, b) => a.name.localeCompare(b.name));
}

// ── Packages ─────────────────────────────────────────────────────────────────────────────────────────────

export function scanPackages(w) {
  const prefixes = ['/opt/homebrew', '/usr/local'].filter((p) => isDir(w, join(p, 'Cellar')) || isDir(w, join(p, 'Caskroom')));
  const brewFormulae = [...new Set(prefixes.flatMap((p) => list(w, join(p, 'Cellar'))))].sort();
  const brewCasks = [...new Set(prefixes.flatMap((p) => list(w, join(p, 'Caskroom'))))].sort();
  const npmRoots = [...new Set(['/opt/homebrew/lib/node_modules', '/usr/local/lib/node_modules', join(w.home, '.npm-global', 'lib', 'node_modules')])];
  const npmGlobal = [];
  for (const root of npmRoots) {
    for (const name of list(w, root)) {
      if (name.startsWith('@')) for (const sub of list(w, join(root, name))) npmGlobal.push(`${name}/${sub}`);
      else npmGlobal.push(name);
    }
  }
  return {
    brewFormulae, brewCasks,
    npmGlobal: [...new Set(npmGlobal)].sort(),
    pipx: list(w, join(w.home, '.local', 'pipx', 'venvs')).sort(),
    uvTools: list(w, join(w.home, '.local', 'share', 'uv', 'tools')).sort(),
    cargo: list(w, join(w.home, '.cargo', 'bin')).sort(),
  };
}

// ── CLIs on PATH ─────────────────────────────────────────────────────────────────────────────────────────

export const SYSTEM_BIN_DIRS = Object.freeze(['/usr/bin', '/bin', '/usr/sbin', '/sbin', '/usr/libexec']);

export function pathDirs(w) {
  const extra = ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', join(w.home, '.cargo', 'bin'), join(w.home, '.local', 'bin'), join(w.home, 'bin'), join(w.home, '.npm-global', 'bin'), join(w.home, '.bun', 'bin')];
  return [...new Set([...String(w.env.PATH ?? '').split(delimiter).filter((d) => d.startsWith('/')), ...extra, ...SYSTEM_BIN_DIRS])].filter((d) => !/\/System\/Cryptexes\//.test(d) && isDir(w, d));
}

/**
 * Every executable name on PATH (first dir wins, like the shell). Symlinks that resolve into an app bundle are
 * that app's own CLI (`code` → Visual Studio Code.app): returned as appLinks (realpath of the .app → names).
 */
export function scanPathClis(w) {
  const names = new Map();
  const appLinks = new Map();
  let systemCount = 0;
  for (const dir of pathDirs(w)) {
    const system = SYSTEM_BIN_DIRS.includes(dir);
    for (const name of list(w, dir)) {
      if (names.has(name)) continue;
      const p = join(dir, name);
      const l = safe(() => w.lstat(p), null);
      if (!l) continue;
      if (l.isSymbolicLink()) {
        const real = safe(() => w.realpath(p), null);
        const at = real ? real.indexOf('.app/') : -1;
        if (at > 0) {
          const app = real.slice(0, at + 4);
          appLinks.set(app, [...(appLinks.get(app) ?? []), name]);
        }
        const st = real ? safe(() => w.stat(real), null) : null;
        if (!st?.isFile() || !(st.mode & 0o111)) continue;
      } else if (!l.isFile() || !(l.mode & 0o111)) continue;
      names.set(name, system ? 'system' : tilde(dir, w.home));
      if (system) systemCount += 1;
    }
  }
  return { names, appLinks, systemCount };
}

// ── MCP servers already configured on this Mac (config is read, never run) ───────────────────────────────

export function mcpConfigSources(home) {
  const support = join(home, 'Library', 'Application Support');
  return [
    { client: 'claude-desktop', file: join(support, 'Claude', 'claude_desktop_config.json'), format: 'json', keys: ['mcpServers'] },
    { client: 'claude-code', file: join(home, '.claude.json'), format: 'json', keys: ['mcpServers'], projects: true },
    { client: 'claude-code', file: join(home, '.mcp.json'), format: 'json', keys: ['mcpServers'] },
    { client: 'cursor', file: join(home, '.cursor', 'mcp.json'), format: 'json', keys: ['mcpServers'] },
    { client: 'windsurf', file: join(home, '.codeium', 'windsurf', 'mcp_config.json'), format: 'json', keys: ['mcpServers'] },
    { client: 'vscode', file: join(support, 'Code', 'User', 'mcp.json'), format: 'json', keys: ['servers'] },
    { client: 'gemini', file: join(home, '.gemini', 'settings.json'), format: 'json', keys: ['mcpServers'] },
    { client: 'zed', file: join(home, '.config', 'zed', 'settings.json'), format: 'jsonc', keys: ['context_servers'] },
    { client: 'codex', file: join(home, '.codex', 'config.toml'), format: 'toml' },
  ];
}

/** Pure: JSON with // and /* comments and trailing commas (Zed's settings). */
export function parseJsonc(text) {
  const stripped = String(text).replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, s) => s ?? '').replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(stripped);
}

/** Pure: the package an npx / uvx / pipx / bunx launch runs, else null. Only a package-shaped word is kept. */
export function launchPackage(command, args) {
  const cmd = basename(String(command ?? ''));
  const a = (Array.isArray(args) ? args : []).map(String);
  const runners = { npx: true, bunx: true, uvx: true, pipx: true, pnpm: true, yarn: true, docker: true };
  if (!runners[cmd]) return null;
  for (let i = 0; i < a.length; i += 1) {
    const v = a[i];
    if (v.startsWith('-') || ['run', 'dlx', 'exec', '--from'].includes(v)) continue;
    if (/^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(@[\w.^~<>=-]+)?$/i.test(v) || (cmd === 'docker' && /^[a-z0-9][\w./-]+(:[\w.-]+)?$/i.test(v))) return v.slice(0, 120);
    return null;
  }
  return null;
}

/** Pure: one configured server → what the map keeps (never args, env values or headers). */
export function mcpEntry(client, name, cfg, file) {
  const url = typeof cfg?.url === 'string' ? cfg.url : typeof cfg?.serverUrl === 'string' ? cfg.serverUrl : null;
  let host = null;
  if (url) { try { host = new URL(url).host; } catch { host = null; } }
  const command = typeof cfg?.command === 'string' ? cfg.command : typeof cfg?.command?.path === 'string' ? cfg.command.path : null;
  const args = Array.isArray(cfg?.args) ? cfg.args : Array.isArray(cfg?.command?.args) ? cfg.command.args : [];
  const env = cfg?.env && typeof cfg.env === 'object' ? cfg.env : cfg?.command?.env && typeof cfg.command.env === 'object' ? cfg.command.env : {};
  return {
    name: String(name).slice(0, 80),
    client,
    transport: url ? 'http' : 'stdio',
    command: command ? basename(command).slice(0, 60) : null,
    package: command ? launchPackage(command, args) : null,
    host,
    envNames: Object.keys(env).filter((k) => /^[A-Za-z_][A-Za-z0-9_]{0,80}$/.test(k)).slice(0, 20),
    disabled: cfg?.disabled === true || cfg?.enabled === false,
    file,
  };
}

/** Pure: a codex config.toml's [mcp_servers.<name>] tables (command, args, url, and the env table's names). */
export function parseCodexMcp(text) {
  const servers = {};
  let current = null;
  let inEnv = false;
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    const header = /^\[mcp_servers\.(?:"([^"]+)"|([A-Za-z0-9_-]+))(\.env)?\]$/.exec(line);
    if (header) { current = servers[header[1] ?? header[2]] ??= { env: {} }; inEnv = Boolean(header[3]); continue; }
    if (/^\[/.test(line)) { current = null; continue; }
    if (!current) continue;
    const kv = /^([A-Za-z_][\w-]*)\s*=\s*(.+)$/.exec(line);
    if (!kv) continue;
    if (inEnv) { current.env[kv[1]] = true; continue; }
    if (kv[1] === 'command' || kv[1] === 'url') { const m = /^"([^"]*)"/.exec(kv[2]); if (m) current[kv[1]] = m[1]; }
    if (kv[1] === 'args') current.args = [...kv[2].matchAll(/"([^"]*)"/g)].map((m) => m[1]);
    if (kv[1] === 'env') for (const m of kv[2].matchAll(/([A-Za-z_]\w*)\s*=/g)) current.env[m[1]] = true;
  }
  return servers;
}

export function scanMcpConfigs(w) {
  const out = [];
  for (const src of mcpConfigSources(w.home)) {
    if (!isFile(w, src.file)) continue;
    const file = tilde(src.file, w.home);
    let parsed;
    try {
      const text = w.readFile(src.file).toString('utf8');
      parsed = src.format === 'toml' ? { mcpServers: parseCodexMcp(text) } : src.format === 'jsonc' ? parseJsonc(text) : JSON.parse(text);
    } catch { out.push({ name: null, client: src.client, unreadable: true, file }); continue; }
    const blocks = [];
    for (const k of src.keys ?? ['mcpServers']) if (parsed?.[k] && typeof parsed[k] === 'object') blocks.push(parsed[k]);
    if (src.format === 'toml') blocks.push(parsed.mcpServers);
    if (src.projects && parsed?.projects && typeof parsed.projects === 'object') {
      for (const proj of Object.values(parsed.projects)) if (proj?.mcpServers && typeof proj.mcpServers === 'object') blocks.push(proj.mcpServers);
    }
    for (const block of blocks) for (const [name, cfg] of Object.entries(block)) out.push(mcpEntry(src.client, name, cfg, file));
  }
  // The same server configured in two clients is one capability with two homes.
  const seen = new Map();
  for (const s of out.filter((x) => x.name)) {
    const key = `${s.name}|${s.package ?? s.command ?? s.host}`;
    if (seen.has(key)) seen.get(key).alsoIn = [...new Set([...(seen.get(key).alsoIn ?? []), s.client])].filter((c) => c !== seen.get(key).client);
    else seen.set(key, s);
  }
  return [...seen.values(), ...out.filter((x) => !x.name)];
}

// ── Web apps in his Chrome session (hosts only, read from the session file: no AppleScript, no permission ask) ─

export function chromeSessionFiles(w) {
  const root = join(w.home, 'Library', 'Application Support', 'Google', 'Chrome');
  const files = [];
  for (const profile of list(w, root)) {
    if (profile !== 'Default' && !/^Profile \d+$/.test(profile)) continue;
    const dir = join(root, profile, 'Sessions');
    const newest = list(w, dir).filter((n) => /^(Session|Tabs)_\d+$/.test(n))
      .map((n) => ({ n, m: safe(() => w.stat(join(dir, n)).mtimeMs, 0) })).sort((a, b) => b.m - a.m);
    const pick = ['Session', 'Tabs'].map((kind) => newest.find((f) => f.n.startsWith(kind))).filter(Boolean);
    for (const f of pick) files.push(join(dir, f.n));
  }
  return files;
}

/** Pure: the hosts of http(s) URLs in a session file's bytes, most seen first. Paths and queries are dropped. */
export function sessionHosts(bytes, limit = 60) {
  const text = Buffer.isBuffer(bytes) ? bytes.toString('latin1') : String(bytes ?? '');
  const counts = new Map();
  for (const m of text.matchAll(/https?:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?::\d{2,5})?(?=[/?#"'\s\x00-\x1f]|$)/gi)) {
    const host = m[1].toLowerCase();
    if (/^(?:\d+\.){3}\d+$/.test(host) || host === 'localhost' || host.endsWith('.localhost')) continue;
    counts.set(host, (counts.get(host) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit).map(([h]) => h);
}

export function scanWeb(w) {
  const files = chromeSessionFiles(w);
  const hosts = [];
  for (const f of files) {
    const bytes = safe(() => { const st = w.stat(f); return st.size <= 16 * 1024 * 1024 ? w.readFile(f) : null; }, null);
    if (bytes) for (const h of sessionHosts(bytes)) if (!hosts.includes(h)) hosts.push(h);
  }
  return { hosts: hosts.slice(0, 80), source: files.length ? 'his Chrome session' : 'no Chrome session found', route: 'Chrome (connector, live web) and the hands' };
}

// ── Ghost's own hands ────────────────────────────────────────────────────────────────────────────────────

export function scanHands(env = process.env, exists) {
  const peekaboo = findPeekabooBinary(env, ...(exists ? [exists] : []));
  const ghost = findGhostBinary(env, ...(exists ? [exists] : []));
  return {
    kind: peekaboo && env.SOLOMON_MAC_HANDS !== 'ghost' ? 'peekaboo' : ghost ? 'ghost-os' : null,
    name: peekaboo ? 'Hands of Horus' : ghost ? 'ghost-os' : null,
    peekaboo, ghostOs: ghost,
    fix: peekaboo || ghost ? null : 'brew install openclaw/tap/peekaboo',
  };
}

// ── The map file ─────────────────────────────────────────────────────────────────────────────────────────

export function readDeviceMap(file, read = (p) => readFileSync(p, 'utf8'), lock = null) {
  try {
    const m = JSON.parse(read(file));
    if (!m || m.schema !== MAP_SCHEMA) return null;
    // A map written by an older Kingmaker may carry a route kind this one renamed (the engine's own route had another
    // name): a kind it doesn't know is read as the engine's, so a cached map keeps every route it promised.
    for (const app of Array.isArray(m.apps) ? m.apps : []) {
      for (const r of Array.isArray(app?.routes) ? app.routes : []) if (r && typeof r.kind === 'string' && !(r.kind in ROUTE_RANK)) r.kind = 'engine';
    }
    // A map written before the CRM lock may still list the other company's app: never hand it out.
    if (lock && Array.isArray(m.apps)) {
      const otherTenantEntry = (item = {}) => typeof item === 'string'
        ? isOtherTenantApp({ name: item, bundleId: item, path: item }, lock)
        : isOtherTenantApp({ name: item.app ?? item.name, bundleId: item.bundleId, path: item.path }, lock);
      const foreignApps = m.apps.filter((app) => isOtherTenantApp(app, lock));
      const foreignProposals = Array.isArray(m.proposals) ? m.proposals.filter((proposal) => otherTenantEntry(proposal)) : [];
      const foreignIds = new Set([...foreignApps, ...foreignProposals].flatMap((item) => [item.bundleId, item.app, item.name]).filter(Boolean));
      const isForeignKey = (key) => foreignIds.has(key) || otherTenantEntry(key);
      m.apps = m.apps.filter((app) => !isOtherTenantApp(app, lock));
      // Gaps are string bundle/name IDs. Proposals and candidate keys must be screened independently:
      // PR #56 may already have removed the app while leaving these old actionable caches behind.
      if (Array.isArray(m.gaps)) m.gaps = m.gaps.filter((gap) => !isForeignKey(gap));
      if (Array.isArray(m.proposals)) m.proposals = m.proposals.filter((proposal) => !otherTenantEntry(proposal));
      if (m.candidates?.searched && typeof m.candidates.searched === 'object') {
        for (const key of Object.keys(m.candidates.searched)) if (isForeignKey(key)) delete m.candidates.searched[key];
        delete m.candidates.lastRun;
      }
    }
    return m;
  } catch { return null; }
}

export function writeDeviceMap(file, map) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(map, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

/** Pure: does this map need a scan now? → 'missing' | 'resume' | 'stale' | null. */
export function scanDue(map, now = Date.now(), maxAgeMs = MAP_MAX_AGE_MS) {
  if (!map) return 'missing';
  if (!SCAN_PHASES.every((p) => map.phases?.[p]?.doneAt)) return 'resume';
  const at = Date.parse(map.scannedAt ?? '');
  return !Number.isFinite(at) || now - at > maxAgeMs ? 'stale' : null;
}

/** Pure: rebuild every app's routes and the gap list from the phases' raw results. */
export function buildCapabilities(map) {
  const pathClis = new Map(Object.entries(map.clis?.where ?? {}));
  const hands = map.hands?.name ? `the ${map.hands.name === 'Hands of Horus' ? 'Hands of Horus' : map.hands.name}` : HANDS_LABEL;
  const apps = (map.apps ?? []).map((a) => ({ ...a, ...appRoutes(a, { pathClis, mcpServers: (map.mcp ?? []).filter((s) => s.name && !s.disabled), handsLabel: hands }) }));
  const gaps = apps.filter((a) => a.gap).map((a) => a.bundleId || a.name);
  return { ...map, apps, gaps };
}

/** Pure: the counts said and shown everywhere (doctor, the first-run line, the MCP tool). */
export function mapCounts(map) {
  const apps = map?.apps ?? [];
  const by = (k) => apps.filter((a) => a.best === k).length;
  const props = (map?.proposals ?? []).filter((p) => p.state === 'proposed');
  return {
    apps: apps.length,
    direct: apps.filter((a) => !a.gap).length,
    cli: apps.filter((a) => a.routes?.some((r) => r.kind === 'cli')).length,
    mcpApps: apps.filter((a) => a.routes?.some((r) => r.kind === 'mcp')).length,
    applescript: by('applescript'),
    urlScheme: by('url-scheme'),
    handsOnly: by('hands'),
    clis: map?.clis?.count ?? 0,
    mcpServers: (map?.mcp ?? []).filter((s) => s.name).length,
    gaps: (map?.gaps ?? []).length,
    proposals: props.length,
    webHosts: map?.web?.hosts?.length ?? 0,
    keys: map?.keys?.found ?? 0,
    keyProviders: Object.keys(map?.keys?.byProvider ?? {}).length,
  };
}

/**
 * The scan. Resumes from `previous` (phases already done within the max age are kept), saves after every phase,
 * paced. `onPhase(name)` reports progress. → the built map.
 */
export async function scanDevice({ file, world = realWorld(), previous = null, pace = null, signal, onPhase = () => {}, now = () => new Date(), save = writeDeviceMap, force = false, lock = null } = {}) {
  const w = world;
  const reuse = !force && previous && scanDue(previous, now().getTime()) === 'resume';
  const map = reuse ? { ...previous } : {
    schema: MAP_SCHEMA, host: hostname(), startedAt: now().toISOString(), phases: {},
    // What later steps own survives a rescan: the consent, the candidates searched, proposals, the key scan.
    candidates: previous?.candidates ?? { consent: null, searched: {} }, proposals: previous?.proposals ?? [], keys: previous?.keys ?? null, announcedAt: previous?.announcedAt ?? null,
  };
  map.phases ??= {};
  let pathResult = null;
  const runPhase = async (name, fn) => {
    if (signal?.aborted) return false;
    if (map.phases[name]?.doneAt) return true;
    onPhase(name);
    const t0 = Date.now();
    await fn();
    map.phases[name] = { doneAt: now().toISOString(), ms: Date.now() - t0 };
    if (file) save(file, buildCapabilities(map));
    if (pace) await pace.step(Date.now() - t0);
    return true;
  };
  // PATH first: its symlinks into app bundles are the apps' own CLIs.
  const ensurePath = () => { pathResult ??= scanPathClis(w); return pathResult; };
  await runPhase('path', async () => {
    const r = ensurePath();
    const userNames = [...r.names.entries()].filter(([, where]) => where !== 'system');
    map.clis = { count: r.names.size, systemCount: r.systemCount, names: userNames.map(([n]) => n).sort(), where: Object.fromEntries([...r.names.entries()].map(([n, where]) => [n, where === 'system' ? 'system' : where])) };
  });
  await runPhase('apps', async () => {
    const r = ensurePath();
    map.apps = await scanApps(w, { pace, pathLinks: r.appLinks, lock });
  });
  await runPhase('packages', async () => { map.packages = scanPackages(w); });
  await runPhase('mcp', async () => { map.mcp = scanMcpConfigs(w); });
  await runPhase('hands', async () => { map.hands = scanHands(w.env, w.exists); });
  await runPhase('web', async () => { map.web = scanWeb(w); });
  const built = buildCapabilities(map);
  if (SCAN_PHASES.every((p) => built.phases[p]?.doneAt)) {
    built.scannedAt = now().toISOString();
    built.complete = true;
  }
  if (file) save(file, built);
  return built;
}

// ── Never a bare "I can't" ───────────────────────────────────────────────────────────────────────────────

/** Pure: an answer that says it cannot, with nothing it CAN do instead. */
export const BARE_CANT = /\b(?:I\s+(?:can(?:no|')?t|cannot|am\s+(?:not\s+able|unable)|'m\s+(?:not\s+able|unable)|don'?t\s+have\s+(?:a|an|the|any)\s+(?:way|tool|connector|engine|integration|access))|(?:not|isn'?t)\s+(?:something\s+I\s+can|supported|possible\s+for\s+me)|no\s+(?:engine|connector|tool|integration)\s+(?:for|to)|unable\s+to)\b/i;

export function isBareCant(spoken) {
  const s = String(spoken ?? '');
  return BARE_CANT.test(s) && !/\b(?:instead|but I can|I can still|the hands)\b/i.test(s);
}

/** Pure: the apps a request names (longest token first; "Spotify", "VS Code", "my chrome"). */
export function appsInText(map, text) {
  const t = ` ${String(text ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ')} `;
  const squashed = t.replace(/\s+/g, '');
  const hits = [];
  for (const a of map?.apps ?? []) {
    const name = String(a.name).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    const named = (name.length >= 3 && t.includes(` ${name} `)) || (a.tokens ?? []).some((tok) => tok.length >= 4 && (t.includes(` ${tok} `) || (tok.length >= 6 && squashed.includes(tok))));
    if (named) hits.push(a);
  }
  return hits.sort((x, y) => String(y.name).length - String(x.name).length);
}

const ROUTE_WORDS = {
  cli: (r) => `its command line (${r.via})`,
  mcp: (r) => `the ${r.via} MCP server`,
  engine: (r) => r.detail,
  applescript: () => 'its AppleScript dictionary',
  'url-scheme': (r) => `its ${r.via} links`,
  hands: () => HANDS_LABEL,
};

/** Pure: the proposal for one app, best first. */
export function proposalFor(map, app) {
  return (map?.proposals ?? []).filter((p) => p.state === 'proposed' && (p.bundleId === app.bundleId || p.app === app.name)).sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0] ?? null;
}

/**
 * Pure: what to say instead of a bare "I can't": the closest capability Ghost HAS for what was asked (the hands as
 * the fallback) and the proposal to get a better one. Null when the answer was not a bare can't.
 */
export function closestCapabilityLine(map, request, spoken) {
  if (!isBareCant(spoken)) return null;
  const app = appsInText(map, request)[0];
  if (!app) {
    const hands = map?.hands?.name ? `the ${map.hands.name}` : HANDS_LABEL;
    return `I can still do it on screen with ${hands}, step by step, if you say "do it with the hands". Or say "find a tool for it" and I'll look for an open-source one.`;
  }
  const routes = (app.routes ?? []).filter((r) => r.kind !== 'hands');
  const best = routes[0];
  const words = best && ROUTE_WORDS[best.kind];
  const have = words ? `${words(best)} and ${HANDS_LABEL}` : HANDS_LABEL;
  const p = proposalFor(map, app);
  const better = p ? ` A better route is ${p.name} (${p.license ?? 'licence unknown'}${p.stars ? `, ${p.stars} stars` : ''}): say "acquire ${p.name}" and I'll read it back before anything is installed.`
    : app.gap ? ` I haven't found a dedicated tool for ${app.name} yet: say "find tools for my apps" and I'll look.` : '';
  return `I can still drive ${app.name} with ${have} right now.${better}`;
}
