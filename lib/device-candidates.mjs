// GAPS → OPEN-SOURCE CANDIDATES → PROPOSALS.
//
// For each app on this Mac with no CLI or MCP of its own (device-scan.mjs gaps), look for open-source MCP servers and
// CLIs that drive it: the official MCP registry (registry.modelcontextprotocol.io, the servers' own published
// entries with their npm / PyPI package and repo) and GitHub's repository search. Rank them: licence first
// (permissive before weak copyleft before unknown; GPL/AGPL and non-commercial or source-available licences are
// FLAGGED, never hidden), then stars, then how recently they were worked on. Verify the repo is real (GitHub's own
// answer for it: exists, not archived, not a fork, its licence). Write the top ones as PROPOSALS in the map.
//
// What leaves the Mac: only the app's NAME, as a search word, to those two public read-only APIs. It runs only with
// the owner's consent (he said "find tools for my apps", or typed `kingmaker scan --find`), paced (GitHub allows an
// anonymous caller 10 searches a minute; a rate limit ends the run and the next one resumes where it stopped).
// NOTHING is installed here: installing is device-tools.mjs, on the owner's yes, from a pinned version.

import { appsInText } from './device-scan.mjs';

export const MCP_REGISTRY = 'https://registry.modelcontextprotocol.io/v0/servers';
export const GITHUB_API = 'https://api.github.com';
export const USER_AGENT = 'kingmaker-device-scan (+https://github.com/ronininc/Kingmaker)';
/** Anonymous GitHub search: 10 a minute. */
export const GITHUB_SEARCH_INTERVAL_MS = 6_500;
/** An app searched within this long is not searched again. */
export const RESEARCH_AFTER_MS = 30 * 24 * 3600_000;
export const PROPOSALS_PER_APP = 2;
export const MAX_VERIFY_PER_RUN = 40;

/** Apple's own apps worth a tool (the rest — Chess, Grapher, Boot Camp — are left to the hands). */
export const APPLE_WORTH = Object.freeze(new Set([
  'com.apple.Notes', 'com.apple.reminders', 'com.apple.iCal', 'com.apple.mail', 'com.apple.MobileSMS', 'com.apple.AddressBook', 'com.apple.Music',
  'com.apple.Photos', 'com.apple.Maps', 'com.apple.iWork.Keynote', 'com.apple.iWork.Numbers', 'com.apple.iWork.Pages', 'com.apple.systempreferences',
  'com.apple.TextEdit', 'com.apple.QuickTimePlayerX', 'com.apple.FaceTime', 'com.apple.VoiceMemos', 'com.apple.podcasts', 'com.apple.TV',
  'com.apple.Home', 'com.apple.freeform', 'com.apple.Console', 'com.apple.ActivityMonitor', 'com.apple.journal', 'com.apple.weather',
]));

// ── Licences ─────────────────────────────────────────────────────────────────────────────────────────────

const PERMISSIVE = /^(?:MIT|MIT-0|Apache-2\.0|BSD-[234]-Clause(?:-Clear)?|BSD-2-Clause-Patent|ISC|0BSD|Unlicense|CC0-1\.0|Zlib|BSL-1\.0|PostgreSQL|WTFPL|Python-2\.0|UPL-1\.0|BlueOak-1\.0\.0|X11)$/i;
const WEAK = /^(?:MPL-2\.0|LGPL-[23]\.[01](?:-only|-or-later)?|EPL-[12]\.0|CDDL-1\.[01]|EUPL-1\.[12])$/i;
const AGPL = /^AGPL/i;
const GPL = /^GPL/i;
const NONCOMMERCIAL = /(?:NC|Noncommercial|NonCommercial|BUSL|SSPL|Elastic|Commons-Clause|PolyForm|Confluent|FSL|Prosperity)/i;

/** Pure: an SPDX id → its class: permissive, weak-copyleft, copyleft, agpl, non-commercial or unknown. */
export function licenseClass(spdx) {
  const s = String(spdx ?? '').trim();
  if (!s || /^(?:NOASSERTION|NONE|OTHER)$/i.test(s)) return 'unknown';
  if (NONCOMMERCIAL.test(s)) return 'non-commercial';
  if (AGPL.test(s)) return 'agpl';
  if (GPL.test(s)) return 'copyleft';
  if (WEAK.test(s)) return 'weak-copyleft';
  if (PERMISSIVE.test(s)) return 'permissive';
  return 'unknown';
}

const LICENCE_RANK = { permissive: 4, 'weak-copyleft': 3, unknown: 1, copyleft: 1, agpl: 0, 'non-commercial': 0 };

/** Pure: what the owner must know before saying yes. */
export function candidateFlags(c, now = Date.now()) {
  const flags = [];
  const cls = licenseClass(c.license);
  if (cls === 'agpl') flags.push('AGPL: network copyleft, keep it out of client deliverables');
  else if (cls === 'copyleft') flags.push('GPL: copyleft');
  else if (cls === 'non-commercial') flags.push('non-commercial or source-available licence');
  else if (cls === 'unknown') flags.push('licence not stated');
  if (c.package?.type === 'remote') flags.push(`hosted: what you ask it goes to ${c.package.host ?? 'its server'}`);
  const pushed = Date.parse(c.pushedAt ?? '');
  if (Number.isFinite(pushed) && now - pushed > 2 * 365 * 24 * 3600_000) flags.push('not worked on in over two years');
  if (Number.isFinite(c.stars) && c.stars < 10) flags.push('few stars');
  if (c.verified && c.verified.ok === false) flags.push(`repo not verified: ${c.verified.reason}`);
  return flags;
}

/** Pure: rank score. Licence dominates, then stars, recency, how it installs, and whether it names the app. */
export function scoreCandidate(c, app, now = Date.now()) {
  const cls = licenseClass(c.license);
  let score = LICENCE_RANK[cls] * 100;
  score += Math.min(60, Math.round(Math.log10((c.stars ?? 0) + 1) * 20));
  const pushed = Date.parse(c.pushedAt ?? '');
  if (Number.isFinite(pushed)) score += now - pushed <= 90 * 864e5 ? 30 : now - pushed <= 365 * 864e5 ? 15 : 0;
  score += { npm: 20, pypi: 10, github: 5, remote: 0 }[c.package?.type ?? 'github'] ?? 0;
  if (c.verified?.ok) score += 10;
  const hay = `${c.name} ${c.fullName ?? ''}`.toLowerCase().replace(/[^a-z0-9]/g, '');
  if ((app?.tokens ?? []).some((t) => t.length >= 4 && hay.includes(t))) score += 20;
  return score;
}

// ── Which apps, which words ──────────────────────────────────────────────────────────────────────────────

/** Pure: the gap apps worth searching for, third-party first, minus the ones searched recently. */
export function appsToSearch(map, now = Date.now()) {
  const searched = map?.candidates?.searched ?? {};
  return (map?.apps ?? [])
    .filter((a) => a.gap && !a.self && (APPLE_WORTH.has(a.bundleId) || (!a.system && !/^com\.apple\./.test(a.bundleId))))
    .filter((a) => { const s = searched[a.bundleId || a.name]; return !s?.at || (now - Date.parse(s.at) > RESEARCH_AFTER_MS) || s.error === 'rate-limited'; })
    .sort((a, b) => Number(Boolean(a.system || /^com\.apple\./.test(a.bundleId))) - Number(Boolean(b.system || /^com\.apple\./.test(b.bundleId))) || a.name.localeCompare(b.name));
}

/** Pure: the search words for an app ("Apple Notes" for Notes; the app's name otherwise). */
export function searchTerms(app) {
  // Apple's own apps (com.apple.*, and Apple's other bundles such as developer.apple.wwdc) need "apple" or "mac" too.
  const apple = /(?:^|\.)apple\./.test(String(app.bundleId ?? ''));
  const name = String(app.name).replace(/[\s_-]*\d+(?:\.\d+)*(?:-\w+)?$/, '').trim();
  const words = name.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').trim();
  const primary = (app.tokens ?? []).find((t) => ['vscode', 'chrome'].includes(t)) ?? (words.includes(' ') ? words.split(' ').sort((a, b) => b.length - a.length)[0] : words);
  const vendor = apple ? null : vendorOf(app);
  return { registry: vendor ? `${vendor} ${primary}` : primary, github: apple ? `apple ${words}` : vendor ? `${vendor} ${words}` : words, match: apple ? ['apple', 'mac', 'macos', 'osx'] : [] };
}

/**
 * Pure: does a candidate really concern this app? Its NAME (repo, package or registry name) must carry the app's
 * name (all its words, or a distinctive token of it); a description that merely mentions the app is not enough.
 * Apple's apps also need "apple" or "mac" somewhere ("notes" alone is anyone's notes).
 */
export function concernsApp(c, app) {
  const named = `${c.name ?? ''} ${c.fullName ?? ''} ${c.package?.name ?? ''} ${c.registryName ?? ''}`.toLowerCase();
  const squashed = named.replace(/[^a-z0-9]/g, '');
  const nameWords = new Set(named.split(/[^a-z0-9]+/).filter(Boolean));
  const terms = searchTerms(app);
  const words = terms.github.split(' ').filter((w) => w.length >= 3 && !['apple', 'the', 'for', 'app'].includes(w));
  // A word of the name counts whole ("edit" is not "editor"); a long distinctive token may sit inside one ("whatsapp").
  const inName = (words.length && words.every((w) => nameWords.has(w) || (w.length >= 7 && squashed.includes(w))))
    || (app.tokens ?? []).some((t) => nameWords.has(t) || (t.length >= 7 && squashed.includes(t)));
  if (!inName) return false;
  const text = `${named} ${c.description ?? ''}`.toLowerCase();
  if (terms.match.length && !terms.match.some((w) => text.includes(w))) return false;
  // An app named with one everyday word ("Remote", "Viewer", "Edit") needs its maker too (com.sony.Remote → sony).
  const vendor = vendorOf(app);
  return !vendor || text.includes(vendor);
}

/** Pure: the maker an app with a one-word, everyday name must be searched with, or null. */
export function vendorOf(app) {
  if (app.webApp || /^com\.google\.chrome\.app\./i.test(String(app.bundleId ?? ''))) return null;
  const words = String(app.name ?? '').toLowerCase().replace(/[\s_-]*\d+(?:\.\d+)*$/, '').split(/[^a-z0-9]+/).filter(Boolean);
  const parts = String(app.bundleId ?? '').toLowerCase().split('.');
  const vendor = parts.length >= 3 && ['com', 'org', 'net', 'io', 'co', 'app', 'dev', 'me'].includes(parts[0]) ? parts[1] : null;
  if (!vendor || vendor === 'apple' || vendor.length < 3 || words.length !== 1 || words[0].includes(vendor) || vendor.includes(words[0])) return null;
  return EVERYDAY_NAMES.has(words[0]) ? vendor : null;
}

/** One-word app names that are everyday words: alone they find everyone's "viewer", so the maker is searched with them. */
export const EVERYDAY_NAMES = Object.freeze(new Set([
  'edit', 'editor', 'remote', 'viewer', 'developer', 'record', 'recorder', 'notes', 'music', 'photos', 'mail', 'maps', 'home', 'clock', 'games',
  'books', 'news', 'stocks', 'weather', 'journal', 'console', 'preview', 'calendar', 'contacts', 'messages', 'reminders', 'podcasts', 'phone',
  'terminal', 'finder', 'camera', 'player', 'studio', 'office', 'browser', 'chat', 'meet', 'drive', 'files', 'scanner', 'monitor', 'capture',
  'paint', 'draw', 'write', 'reader', 'translate', 'connect', 'link', 'sync', 'backup', 'mirror', 'screen', 'display', 'transfer', 'assistant',
]));

// ── The two sources ──────────────────────────────────────────────────────────────────────────────────────

async function getJson(fetchImpl, url, { timeoutMs = 15_000 } = {}) {
  const res = await fetchImpl(url, { headers: { accept: 'application/json', 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(timeoutMs) });
  const limited = res.status === 429 || (res.status === 403 && res.headers?.get?.('x-ratelimit-remaining') === '0');
  let json = null;
  try { json = await res.json(); } catch { json = null; }
  return { ok: res.ok, status: res.status, limited, json };
}

/** Pure: a registry entry → a candidate (npm first, then PyPI, then a hosted remote). */
export function registryCandidate(entry) {
  const s = entry?.server ?? entry;
  if (!s?.name) return null;
  const pkgs = Array.isArray(s.packages) ? s.packages : [];
  const npm = pkgs.find((p) => p.registryType === 'npm' && p.identifier && p.version);
  const pypi = pkgs.find((p) => p.registryType === 'pypi' && p.identifier && p.version);
  const remote = (Array.isArray(s.remotes) ? s.remotes : []).find((r) => r.url);
  const pick = npm ?? pypi;
  let host = null;
  if (remote) { try { host = new URL(remote.url).host; } catch { host = null; } }
  const repo = typeof s.repository?.url === 'string' && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+/.test(s.repository.url) ? s.repository.url.replace(/\.git$/, '') : null;
  const env = (pick?.environmentVariables ?? []).map((v) => ({ name: String(v.name ?? ''), required: v.isRequired === true, secret: v.isSecret === true })).filter((v) => /^[A-Za-z_][A-Za-z0-9_]{0,80}$/.test(v.name));
  return {
    source: 'mcp-registry', kind: 'mcp', registryName: s.name,
    name: pick ? pick.identifier : s.name.split('/').pop(),
    description: String(s.description ?? '').slice(0, 200),
    version: s.version ?? null,
    repo, fullName: repo ? repo.replace('https://github.com/', '') : null,
    package: npm ? { type: 'npm', name: npm.identifier, version: npm.version } : pypi ? { type: 'pypi', name: pypi.identifier, version: pypi.version } : remote ? { type: 'remote', url: remote.url, host } : null,
    needsEnv: env,
    license: null, stars: null, pushedAt: null,
  };
}

/** Pure: a GitHub search item → a candidate. Archived repos and forks are dropped. */
export function githubCandidate(item) {
  if (!item?.full_name || item.archived || item.fork) return null;
  const words = `${item.name} ${item.description ?? ''} ${(item.topics ?? []).join(' ')}`.toLowerCase();
  return {
    source: 'github', kind: /\bmcp\b|model.?context.?protocol|mcp-server|-mcp\b/.test(words) ? 'mcp' : 'cli',
    name: item.name, fullName: item.full_name, repo: item.html_url, description: String(item.description ?? '').slice(0, 200),
    stars: item.stargazers_count ?? 0, pushedAt: item.pushed_at ?? null, license: item.license?.spdx_id ?? null,
    package: { type: 'github', fullName: item.full_name },
    verified: { ok: true, via: 'github-search', at: new Date().toISOString() },
  };
}

export async function searchRegistry(term, { fetchImpl = fetch } = {}) {
  const url = `${MCP_REGISTRY}?search=${encodeURIComponent(term)}&version=latest&limit=30`;
  const r = await getJson(fetchImpl, url);
  if (!r.ok) return { ok: false, status: r.status, limited: r.limited, candidates: [] };
  return { ok: true, candidates: (r.json?.servers ?? []).map(registryCandidate).filter(Boolean) };
}

export async function searchGithub(query, { fetchImpl = fetch } = {}) {
  const q = `${query} mcp in:name,description,topics archived:false fork:false`;
  const r = await getJson(fetchImpl, `${GITHUB_API}/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=10`);
  if (!r.ok) return { ok: false, status: r.status, limited: r.limited, candidates: [] };
  return { ok: true, candidates: (r.json?.items ?? []).map(githubCandidate).filter(Boolean) };
}

/** Is the repo real? GitHub's own record: exists, not archived, not a fork. Fills stars, licence, pushedAt. */
export async function verifyRepo(c, { fetchImpl = fetch, now = () => new Date() } = {}) {
  if (!c.fullName || !/^[\w.-]+\/[\w.-]+$/.test(c.fullName)) return { ...c, verified: { ok: false, reason: 'no GitHub repo named', at: now().toISOString() } };
  const r = await getJson(fetchImpl, `${GITHUB_API}/repos/${c.fullName}`);
  if (r.limited) return { ...c, verified: { ok: false, reason: 'rate-limited', at: now().toISOString() }, limited: true };
  if (!r.ok) return { ...c, verified: { ok: false, reason: r.status === 404 ? 'repo not found' : `GitHub said ${r.status}`, at: now().toISOString() } };
  const j = r.json ?? {};
  if (j.archived) return { ...c, verified: { ok: false, reason: 'archived', at: now().toISOString() } };
  return { ...c, stars: j.stargazers_count ?? c.stars, pushedAt: j.pushed_at ?? c.pushedAt, license: j.license?.spdx_id ?? c.license, verified: { ok: true, via: 'github-repo', fork: j.fork === true, at: now().toISOString() } };
}

const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]{0,213}$/;

/**
 * Does this GitHub repo publish itself on npm? Its package.json (raw file, not the rate-limited API) names a package;
 * npm's latest record for that name must point back at THIS repo (a name that only looks right is refused). → an npm
 * package at that exact version (what the installer pins), or null.
 */
export async function npmPackageForRepo(fullName, { fetchImpl = fetch } = {}) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(String(fullName ?? ''))) return null;
  const pkg = await getJson(fetchImpl, `https://raw.githubusercontent.com/${fullName}/HEAD/package.json`).catch(() => null);
  const name = pkg?.ok ? pkg.json?.name : null;
  if (typeof name !== 'string' || !NPM_NAME.test(name) || pkg.json?.private === true) return null;
  const enc = name.startsWith('@') ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name);
  const latest = await getJson(fetchImpl, `https://registry.npmjs.org/${enc}/latest`).catch(() => null);
  const version = latest?.ok ? latest.json?.version : null;
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][\w.]+)?$/.test(version)) return null;
  const repo = String(latest.json?.repository?.url ?? latest.json?.repository ?? '').toLowerCase();
  if (!new RegExp(`github\\.com[/:]${fullName.toLowerCase().replace(/[.]/g, '\\.')}(?:\\.git)?(?:[/#]|$)`).test(repo)) return null;
  return { type: 'npm', name, version };
}

const slug = (s) => String(s).toLowerCase().replace(/^@/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

/** Pure: the proposal written into the map. */
export function proposalOf(c, app, now = new Date()) {
  const flags = candidateFlags(c, now.getTime());
  return {
    id: slug(c.package?.type === 'npm' || c.package?.type === 'pypi' ? c.package.name : c.fullName ?? c.name),
    app: app.name, bundleId: app.bundleId || null,
    name: c.package?.type === 'npm' || c.package?.type === 'pypi' ? c.package.name : c.name,
    kind: c.kind, source: c.source, registryName: c.registryName ?? null, repo: c.repo ?? null, fullName: c.fullName ?? null, description: c.description ?? '',
    package: c.package ?? null, needsEnv: c.needsEnv ?? [],
    license: c.license ?? null, licenseClass: licenseClass(c.license), flags,
    stars: c.stars ?? null, pushedAt: c.pushedAt ?? null, verified: c.verified ?? null,
    score: scoreCandidate(c, app, now.getTime()),
    npmCheckedAt: c.npmCheckedAt ?? null,
    installable: c.package?.type === 'npm' && /^\d+\.\d+\.\d+(?:[-+][\w.]+)?$/.test(String(c.package.version ?? '')),
    state: 'proposed', proposedAt: now.toISOString(),
  };
}

/**
 * Search for every gap app (resuming), rank, verify, and write the proposals into `map` (mutated and returned).
 * `save(map)` after every app; stops (resumable) on a rate limit or `signal`. Never installs.
 */
export async function findCandidates({ map, save = () => {}, fetchImpl = fetch, pace = null, signal, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => new Date(), maxApps = Infinity, log = () => {} }) {
  map.candidates ??= { consent: null, searched: {} };
  map.candidates.searched ??= {};
  map.proposals ??= [];
  // A proposal that no longer passes the relevance rule (it named the app only in passing) is dropped; decided ones stay.
  const appOf = (p) => (map.apps ?? []).find((a) => (p.bundleId && a.bundleId === p.bundleId) || a.name === p.app);
  map.proposals = map.proposals.filter((p) => p.state !== 'proposed' || !appOf(p) || concernsApp(p, appOf(p)));
  // Proposals from before npm linking existed: checked once each (raw files and npm only; no GitHub API calls).
  for (const p of map.proposals.filter((x) => x.state === 'proposed' && x.package?.type === 'github' && x.fullName && !x.npmCheckedAt).slice(0, 60)) {
    if (signal?.aborted) break;
    const npm = await npmPackageForRepo(p.fullName, { fetchImpl }).catch(() => null);
    p.npmCheckedAt = now().toISOString();
    if (npm) { p.package = npm; p.installable = true; p.score += 15; }
  }
  const todo = appsToSearch(map, now().getTime()).slice(0, maxApps);
  let verifies = 0;
  let lastGithub = 0;
  let stoppedFor = null;
  let searched = 0;
  for (const app of todo) {
    if (signal?.aborted) { stoppedFor = 'cancelled'; break; }
    const key = app.bundleId || app.name;
    const terms = searchTerms(app);
    const found = [];
    const reg = await searchRegistry(terms.registry, { fetchImpl }).catch((e) => ({ ok: false, error: String(e?.message ?? e), candidates: [] }));
    found.push(...reg.candidates);
    const wait = GITHUB_SEARCH_INTERVAL_MS - (Date.now() - lastGithub);
    if (wait > 0) await sleep(wait);
    lastGithub = Date.now();
    const gh = await searchGithub(terms.github, { fetchImpl }).catch((e) => ({ ok: false, error: String(e?.message ?? e), candidates: [] }));
    if (gh.limited) { map.candidates.searched[key] = { at: now().toISOString(), error: 'rate-limited' }; stoppedFor = 'rate-limited'; save(map); break; }
    found.push(...gh.candidates);
    let relevant = found.filter((c) => concernsApp(c, app));
    // One repo, one candidate: a registry entry and the same repo's search hit merge (the search hit has stars).
    const byRepo = new Map();
    for (const c of relevant) {
      const k = (c.fullName ?? c.name).toLowerCase();
      const prev = byRepo.get(k);
      byRepo.set(k, prev ? { ...prev, ...Object.fromEntries(Object.entries(c).filter(([, v]) => v !== null && v !== undefined)), source: prev.source === c.source ? c.source : 'mcp-registry+github', package: prev.package?.type === 'npm' || prev.package?.type === 'pypi' ? prev.package : c.package ?? prev.package } : c);
    }
    relevant = [...byRepo.values()];
    relevant.sort((a, b) => scoreCandidate(b, app, now().getTime()) - scoreCandidate(a, app, now().getTime()));
    const top = [];
    for (const c of relevant.slice(0, PROPOSALS_PER_APP)) {
      if (c.verified?.ok || verifies >= MAX_VERIFY_PER_RUN) { top.push(c); continue; }
      verifies += 1;
      const v = await verifyRepo(c, { fetchImpl, now }).catch(() => ({ ...c, verified: { ok: false, reason: 'unreachable', at: now().toISOString() } }));
      if (v.limited) { top.push(c); stoppedFor = 'rate-limited'; break; }
      // A repo GitHub says is gone or archived is not proposed; one that could not be checked is, flagged.
      if (v.verified?.ok || !['archived', 'repo not found'].includes(v.verified?.reason)) top.push(v);
    }
    // A repo that publishes itself on npm becomes installable at a pinned version (its raw package.json + npm's record).
    for (const c of top) {
      if (c.package?.type !== 'github' || !c.fullName) continue;
      const npm = await npmPackageForRepo(c.fullName, { fetchImpl }).catch(() => null);
      c.npmCheckedAt = now().toISOString();
      if (npm) c.package = npm;
    }
    const proposals = top.map((c) => proposalOf(c, app, now()));
    // Keep decisions already made (installed / declined) for the same id; replace what was only proposed.
    const decided = new Set(map.proposals.filter((p) => p.state !== 'proposed').map((p) => p.id));
    map.proposals = [...map.proposals.filter((p) => !(p.state === 'proposed' && (p.bundleId === app.bundleId && p.app === app.name))), ...proposals.filter((p) => !decided.has(p.id))];
    map.candidates.searched[key] = { at: now().toISOString(), found: relevant.length, proposed: proposals.length, ...(reg.ok ? {} : { registry: reg.status ?? reg.error ?? 'failed' }), ...(gh.ok ? {} : { github: gh.status ?? gh.error ?? 'failed' }) };
    searched += 1;
    log('device_candidates_app', { app: app.name, found: relevant.length, proposed: proposals.length });
    save(map);
    if (stoppedFor) break;
    if (pace) await pace.step(50);
  }
  map.candidates.lastRunAt = now().toISOString();
  map.candidates.lastRun = { searched, remaining: Math.max(0, appsToSearch(map, now().getTime()).length), stoppedFor };
  save(map);
  return { searched, stoppedFor, proposals: map.proposals.filter((p) => p.state === 'proposed').length };
}

/** Pure: proposals matching what the owner said ("install spotify-mcp", "install the spotify one"). */
export function matchProposal(map, words) {
  const w = String(words ?? '').toLowerCase().replace(/\b(?:the|a|an|one|tool|server|mcp|cli|please|for|it)\b/g, ' ').replace(/\s+/g, ' ').trim();
  if (!w) return null;
  const props = (map?.proposals ?? []).filter((p) => p.state === 'proposed');
  const squash = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const sw = squash(w);
  return props.find((p) => p.id === w || squash(p.id) === sw || squash(p.name) === sw)
    ?? props.find((p) => sw.length >= 4 && (squash(p.name).includes(sw) || squash(p.id).includes(sw)))
    ?? (() => { const app = appsInText(map, w)[0]; return app ? props.filter((p) => p.bundleId === app.bundleId || p.app === app.name).sort((a, b) => b.score - a.score)[0] ?? null : null; })();
}

/** Pure: one proposal in words. */
export function proposalLine(p) {
  const lic = p.license ? p.license : 'licence not stated';
  return `${p.name} for ${p.app}: ${p.kind === 'mcp' ? 'an MCP server' : 'a CLI'}${p.package?.type === 'npm' ? ` (npm ${p.package.version})` : p.package?.type === 'pypi' ? ` (PyPI ${p.package.version})` : p.package?.type === 'remote' ? ` (hosted at ${p.package.host})` : ''}, ${lic}${p.stars !== null && p.stars !== undefined ? `, ${p.stars} stars` : ''}${p.flags?.length ? ` [${p.flags.join('; ')}]` : ''}`;
}
