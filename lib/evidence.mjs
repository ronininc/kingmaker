// THE DESKTOP IS THE UI (operator 2026-10-07: "it would actually be cool if the desktop WAS the UI").
//
// Kingmaker has no window of its own and no evidence board ("the evidence dashboard is UI, not actual function").
// While Kingmaker explains a research answer, the pages it actually read and accepted open in Chrome (operator,
// same night: no generated report file — "it's making html files instead of actually doing research and then leaving
// the result in the wind as it explains its conclusion"). What Kingmaker made (an image, a video, a page it serves)
// opens the same way; a file a browser cannot show opens in its own app. Ghost says what opened only once it did.
//
// What may open: the answer's VERIFIED web sources (answerEvidence.sources, ONLINE_PROVEN, http(s)), the engine's own
// output (files in its runtime data folders, pages on its own loopback port), and a page the turn was asked to open
// ("open bbc.com", "read source 2": data.liveWebBrowse.url, browseTarget). A link that merely appears in the answer
// text or anywhere else in the response is never opened.

import { FOLDERS, kingmakerHome } from './kingmaker-home.mjs';
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, normalize, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const SERVED_PREFIXES = ['/generated-media/', '/evidence-screenshots/'];
// Folders inside the runtime data dir that hold produced output. Nothing else there is ever opened
// (the database, keys and vault live alongside them).
const ARTIFACT_DIRS = ['generated-media', 'evidence-screenshots', 'artifacts'];
// One report plus two more on an 8 GB Mac: each Chrome window costs memory.
const MAX_WINDOWS = 3;
// What Chrome shows itself. Anything else (a .blend, a .glb, an .svg that could carry script) opens in its own app.
const BROWSER_VIEWABLE = /\.(?:html?|png|jpe?g|gif|webp|avif|bmp|pdf|mp4|webm|m4v|mov|mp3|m4a|wav|ogg|txt|json)$/i;
const CHROME = 'Google Chrome';

/** Where the engine writes a headless turn's report: Reports in Kingmaker's one hidden folder (lib/kingmaker-home.mjs),
 *  not the Desktop. */
export function reportsDir(env = process.env, home = homedir()) {
  const configured = String(env.SOLOMON_REPORTS_DIR ?? '').trim();
  return configured || join(kingmakerHome(env, home), FOLDERS.reports);
}

function* strings(value, depth = 0) {
  if (depth > 8 || value === null || value === undefined) return;
  if (typeof value === 'string') { yield value; return; }
  if (Array.isArray(value)) { for (const v of value) yield* strings(v, depth + 1); return; }
  if (typeof value === 'object') for (const v of Object.values(value)) yield* strings(v, depth + 1);
}

/**
 * Pure: the pages a research answer stands on, to show while Kingmaker explains it (operator 2026-10-07: "it's making
 * html files instead of actually doing research and then leaving the result in the wind as it explains its
 * conclusion"). Only the answer's VERIFIED web sources (answerEvidence.sources, state ONLINE_PROVEN, http(s), no
 * credentials): the pages the engine read and accepted, the lead source first, at most 3. A link that merely appears in
 * the answer text is never opened.
 */
export function sourcePages(raw, max = MAX_WINDOWS) {
  const data = raw?.data ?? raw;
  const sources = Array.isArray(data?.answerEvidence?.sources) ? data.answerEvidence.sources : [];
  const out = [];
  const seen = new Set();
  for (const s of [...sources].sort((a, b) => Number(Boolean(b?.isLead)) - Number(Boolean(a?.isLead)))) {
    if (s?.state !== 'ONLINE_PROVEN' || typeof s.url !== 'string') continue;
    let u;
    try { u = new URL(s.url.trim()); } catch { continue; }
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password) continue;
    if (seen.has(u.href)) continue;
    seen.add(u.href);
    out.push({ kind: 'page', target: u.href });
    if (out.length >= max) break;
  }
  return out;
}

/** Pure: what to open for one turn's response → [{kind:'page'|'file'|'url', target}] (deduped, at most 3): the
 *  answer's verified source pages first, then what the engine itself made (generated media, its own pages). */
export function evidenceTargets(raw, { port, runtimeHome, exists = existsSync }) {
  return collectTargets(raw, { port, runtimeHome, exists, max: MAX_WINDOWS });
}

function collectTargets(raw, { port, runtimeHome, exists = existsSync, max = MAX_WINDOWS, pages = true }) {
  const out = [];
  const seen = new Set();
  const add = (kind, target) => { if (!seen.has(target) && out.length < max) { seen.add(target); out.push({ kind, target }); } };
  const data = raw?.data ?? raw;
  if (pages) for (const page of sourcePages(raw, max)) add(page.kind, page.target);
  if (!runtimeHome) return out;
  const dataDir = normalize(join(runtimeHome, 'data'));
  for (const s of strings(data)) {
    for (const prefix of SERVED_PREFIXES) {
      const at = s.indexOf(prefix);
      if (at < 0) continue;
      // Either a bare served path or a URL on the engine's own loopback port; anything else is ignored.
      const before = s.slice(0, at);
      if (before && !new RegExp(`^https?://(127\\.0\\.0\\.1|localhost):${port}$`).test(before)) continue;
      const rel = decodeURIComponent(s.slice(at).split(/[?#\s"']/)[0]);
      if (rel.includes('..')) continue;
      const file = normalize(join(dataDir, rel));
      if (ARTIFACT_DIRS.some((d) => file.startsWith(join(dataDir, d) + sep)) && exists(file)) add('file', file);
      else add('url', `http://127.0.0.1:${port}${rel}`);
    }
    // An absolute path the engine wrote into one of its own output folders.
    if (s.startsWith('/') && !s.includes('\n') && s.length < 1024) {
      const file = normalize(s);
      if (ARTIFACT_DIRS.some((d) => file.startsWith(join(dataDir, d) + sep)) && exists(file)) add('file', file);
    }
  }
  return out;
}

export const MAX_LINKS = 8;
/**
 * Pure: the answer's sources and what Kingmaker made, as links for the bar to list under the answer (owner, 2026-10-15:
 * "just clicking the link for the source material … without using the compute automatically"). Nothing is opened:
 * the owner clicks one. → [{kind:'page'|'file'|'url', title, url}] (deduped, at most 8): the verified source pages
 * (lead first, each with its title or its domain), then what Kingmaker made (its file name).
 */
export function evidenceLinks(raw, { port, runtimeHome = null, exists = existsSync, max = MAX_LINKS } = {}) {
  const data = raw?.data ?? raw;
  const titles = new Map();
  for (const s of Array.isArray(data?.answerEvidence?.sources) ? data.answerEvidence.sources : []) {
    try { const t = String(s?.title || s?.name || '').replace(/\s+/g, ' ').trim(); if (t && typeof s?.url === 'string') titles.set(new URL(s.url.trim()).href, t.slice(0, 90)); } catch { /* not a URL */ }
  }
  const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };
  return collectTargets(raw, { port, runtimeHome, exists, max }).map((t) => {
    if (t.kind === 'page') return { kind: 'page', title: titles.get(t.target) || host(t.target), url: t.target };
    if (t.kind === 'file') return { kind: 'file', title: basename(t.target), url: pathToFileURL(t.target).href };
    return { kind: 'url', title: decodeURIComponent(t.target.split(/[?#]/)[0].split('/').filter(Boolean).pop() || 'Kingmaker page').slice(0, 90), url: t.target };
  });
}

/** Pure: the line the answer ends with when its links are listed (never a claim that anything opened). In the bar they're
 *  "in the bar", which is true whether it's open or hidden (a voice-only turn); printed in a terminal, "below". */
export function describeLinks(links, { where = 'bar' } = {}) {
  if (!links?.length) return '';
  const what = links.some((l) => l.kind === 'page') ? 'The sources are' : 'The links are';
  return `${what} ${where === 'bar' ? 'in the bar' : 'below'}.`;
}

/**
 * Pure: the web page a turn's response EXPLICITLY asked to open: data.liveWebBrowse.url ("open/browse <site>",
 * "read source N"), http(s) only, no credentials in it. → {kind:'url', target, browse:true} or null. This field
 * is the only source: a link that appears in the answer text or anywhere else in the response is never opened.
 */
export function browseTarget(raw) {
  const data = raw?.data ?? raw;
  const url = data?.liveWebBrowse?.url;
  if (typeof url !== 'string' || !url.trim() || url.length > 2048) return null;
  let parsed;
  try { parsed = new URL(url.trim()); } catch { return null; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.username || parsed.password) return null;
  return { kind: 'url', target: parsed.href, browse: true };
}

/** Pure: what Ghost adds once the page asked for actually opened in Chrome. Empty otherwise. */
export function describeBrowse(wall) {
  return wall?.where ? "It's open in Chrome." : '';
}

/** Pure: may this target open in a browser window? */
export function browserViewable(t) {
  return t.kind === 'url' || t.kind === 'page' || BROWSER_VIEWABLE.test(t.target);
}

function windowUrl(t) {
  return t.kind === 'url' || t.kind === 'page' ? t.target : pathToFileURL(t.target).href;
}

// Tabs go into the operator's VISIBLE Chrome, addressed by Apple events. `open -a "Google Chrome"` hands a URL to
// whichever Chrome instance launched last, and the engine's own headless screenshot Chrome is one (live 2026-10-07: the
// tabs vanished into it while Ghost said they were open). The script returns how many of the requested tabs are
// actually present afterwards, and that count is all Ghost may claim.
const CHROME_TABS_SCRIPT = `on run argv
  tell application "Google Chrome"
    if (count of windows) is 0 then make new window
    set w to front window
    repeat with u in argv
      tell w to make new tab with properties {URL:(u as text)}
    end repeat
    set index of w to 1
    activate
    set found to 0
    repeat with u in argv
      repeat with t in tabs of w
        if (URL of t as text) starts with (u as text) then
          set found to found + 1
          exit repeat
        end if
      end repeat
    end repeat
    return found as text
  end tell
end run`;

const runFile = (file, args, timeout = 20_000) => new Promise((resolve, reject) => {
  execFile(file, args, { timeout }, (error, stdout) => (error ? reject(error) : resolve(String(stdout))));
});

/**
 * Show the turn's evidence: web pages (sources, a page asked for, the engine's own media) as tabs in the front window
 * of the operator's visible Chrome, brought forward. Only tabs read back as present count. Without Chrome control the
 * pages open in the default browser (never with chromeOnly), reported as "your browser", never as Chrome. A file a
 * browser cannot show opens in its own app. → { where: 'chrome' | 'browser' | null, pages, windows, apps }
 */
export async function openDesktopWall(targets, { log = () => {}, launch = spawnOpen, exec = runFile, chromeOnly = false } = {}) {
  const web = targets.filter(browserViewable);
  const native = targets.filter((t) => !browserViewable(t));
  const result = { where: null, pages: 0, windows: 0, apps: 0 };
  for (const t of native) {
    if (await launch([t.target])) { result.apps += 1; log('evidence_opened', { ...t, via: 'app' }); }
  }
  if (!web.length) return result;
  const urls = web.map(windowUrl);
  let present = 0;
  try {
    present = Number.parseInt(String(await exec('/usr/bin/osascript', ['-e', CHROME_TABS_SCRIPT, ...urls])).trim(), 10) || 0;
  } catch (error) {
    log('evidence_chrome_failed', { error: String(error?.message ?? error).slice(0, 200) });
  }
  if (present > 0) {
    result.where = 'chrome';
    result.windows = present;
    result.pages = Math.min(present, web.filter((t) => t.kind === 'page').length);
  } else if (!chromeOnly && (await Promise.all(urls.map((u) => launch([u])))).some(Boolean)) {
    result.where = 'browser';
    result.windows = urls.length;
    result.pages = web.filter((t) => t.kind === 'page').length;
  }
  if (result.where) for (const t of web) log('evidence_opened', { ...t, via: result.where });
  return result;
}

/** `open <args>`; true when it started and exited 0. */
function spawnOpen(args) {
  return new Promise((resolve) => {
    const child = spawn('/usr/bin/open', args, { stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('exit', (code) => resolve(code === 0));
  });
}

/** Pure: the one sentence Ghost adds about what opened. Empty when nothing did. */
export function describeWall(wall) {
  if (!wall) return '';
  const where = wall.where === 'chrome' ? 'in Chrome' : 'in your browser';
  if (wall.where && wall.pages) return wall.pages === 1 ? `The source is open ${where}.` : `The ${wall.pages} sources are open ${where}.`;
  if (wall.where && wall.windows) return `${wall.windows === 1 ? "It's" : "They're"} open ${where}.`;
  if (wall.apps) return `${wall.apps === 1 ? "It's" : "They're"} open.`;
  return '';
}
