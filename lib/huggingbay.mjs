// HUGGING BAY (https://huggingbay.xyz): Kingmaker's source for local model files, each recorded with its SHA-256 and
// licence. Reads need no account. Three ways in:
//   • MCP   https://huggingbay.xyz/api/mcp, registered in the engine's MCP hub at start (ensureHuggingBayMcp): its read
//           tools are on for the brain; the ones that post publicly (report_run, post_to_board, blackboard,
//           request_feature, request_missing, bakeoff) stay off until the owner reviews them.
//   • API   /api/v1/search for the catalog, the MCP's get_model / deployment_plan for one model's exact file.
//   • CLI   kingmaker models hb search | info | pull | catalog (lib/cli.mjs).
// A download is the owner's ask (the CLI or the bar), goes to the models folder, and is kept only when its size and
// SHA-256 match the record; anything else is deleted. Hugging Bay says it plainly: a matching SHA-256 proves the file
// arrived intact, not that it runs.

import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ownerCall } from './client.mjs';
import { looksAbliterated } from './models.mjs';

export const HB_ORIGIN = 'https://huggingbay.xyz';
export const HB_MCP_URL = `${HB_ORIGIN}/api/mcp`;
/** The tools that post publicly or file something: never on without the owner's review. */
export const HB_PUBLIC_TOOLS = Object.freeze(['report_run', 'post_to_board', 'blackboard', 'request_feature', 'request_missing', 'bakeoff']);

const sleeper = (ms) => new Promise((r) => setTimeout(r, ms));

/** Pure: the structured result of an MCP tools/call reply (structuredContent, else JSON text), or throws its error. */
export function toolResult(reply) {
  if (reply?.error) { const e = new Error(reply.error.message || 'hugging_bay_error'); e.retryAfterS = Number(reply.error.data?.retryAfterSeconds ?? reply.error.data?.retry_after_s) || 0; e.retryable = reply.error.data?.retryable === true; throw e; }
  const r = reply?.result ?? {};
  if (r.structuredContent !== undefined) return r.structuredContent;
  const text = (r.content ?? []).map((c) => c?.text ?? '').join('');
  try { return JSON.parse(text); } catch { return text; }
}

/** A small Hugging Bay client: the MCP for one model's facts, the REST search for the catalog. Retries what the server
 *  says is retryable (waiting as long as it asks, at most 10 s), and paces itself under the 300-a-minute limit. */
export function createHbClient({ fetchImpl = fetch, origin = HB_ORIGIN, sleep = sleeper, paceMs = 250, searchTries = 6, log = () => {} } = {}) {
  let session = null, last = 0, seq = 0;
  const pace = async () => { const wait = last + paceMs - Date.now(); if (wait > 0) await sleep(wait); last = Date.now(); };
  const headers = () => ({ 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18', ...(session ? { 'mcp-session-id': session } : {}) });
  async function post(body) {
    await pace();
    const r = await fetchImpl(`${origin}/api/mcp`, { method: 'POST', headers: headers(), body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
    const sid = r.headers?.get?.('mcp-session-id'); if (sid) session = sid;
    const text = await r.text();
    return text ? JSON.parse(text) : null;
  }
  async function connect() {
    if (session) return;
    await post({ jsonrpc: '2.0', id: ++seq, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'kingmaker', version: '1' } } });
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' }).catch(() => null);
  }
  async function callTool(name, args = {}, tries = 4) {
    for (let i = 1; ; i += 1) {
      await connect();
      try { return toolResult(await post({ jsonrpc: '2.0', id: ++seq, method: 'tools/call', params: { name, arguments: args } })); }
      catch (error) {
        if (i >= tries || error?.retryable === false) throw error;
        log('hb_retry', { tool: name, attempt: i });
        await sleep(Math.min(10_000, Math.max(1_000, (error?.retryAfterS || 1) * 1000)));
        if (/session/i.test(String(error?.message))) session = null;
      }
    }
  }
  async function search(q, { limit = 100, cursor = 0, format = null } = {}) {
    const u = new URL(`${origin}/api/v1/search`);
    u.searchParams.set('q', q); u.searchParams.set('limit', String(limit)); if (cursor) u.searchParams.set('cursor', String(cursor)); if (format) u.searchParams.set('format', format);
    for (let i = 1; ; i += 1) {
      await pace();
      const r = await fetchImpl(u, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(60_000) });
      if (r.ok) { const d = await r.json(); return { rows: d.rows ?? [], total: Number(d.total) || 0, next: d.nextCursor ?? null }; }
      if (i >= searchTries || ![429, 502, 503, 504].includes(r.status)) throw new Error(`Hugging Bay search HTTP ${r.status}`);
      await sleep(Math.min(60_000, Math.max(Number(r.headers?.get?.('retry-after')) || 0, i * 5) * 1000));
    }
  }
  return { callTool, search, model: (id) => callTool('get_model', { id }), plan: (id) => callTool('deployment_plan', { artifact: id }) };
}

/** Pure: is a search row a hosted GGUF repo worth looking up? */
export function isHostedGgufRow(row) {
  return /gguf/i.test(`${row?.name ?? ''} ${row?.id ?? ''}`) && Number(row?.hostedFileCount) > 0 && row?.visibility !== 'private';
}

/** Pure: one catalog entry from get_model, or null when it isn't a downloadable, hosted GGUF with a recorded SHA-256. */
export function catalogEntry(m) {
  const f = m?.mainFile;
  if (!m?.id || !m.downloadable || !m.hosted || !f?.sha256 || !/\.gguf$/i.test(String(f.path ?? ''))) return null;
  const name = String(m.name ?? m.id);
  return Object.freeze({
    id: m.id, name, file: f.path, sizeBytes: Number(f.sizeBytes) || Number(m.sizeBytes) || 0, sha256: String(f.sha256).toLowerCase(),
    ramGb: Number(m.ramNeededGb) || null, license: m.licenseLabel || 'unknown', commercialUse: m.commercialUse || 'unknown',
    abliterated: looksAbliterated(name), downloadUrl: `${HB_ORIGIN}/api/downloads/${encodeURIComponent(m.id)}/${String(f.path).split('/').map(encodeURIComponent).join('/')}`,
  });
}

/**
 * The abliterated catalog: every hosted GGUF that Hugging Bay can serve now, with a SHA-256, and fits `maxRamGb`, plus
 * the essentials (marked `essential`).
 * Search pages are filtered first; only candidates get the per-model lookup. → { entries, scanned, candidates, skipped }
 */
/**
 * One model's catalog entry, asking again when Hugging Bay answers with a partial record (2026-10-15: the same
 * Devstral lookup came back whole twice, then with no file and no SHA-256). → the entry, or null after `tries`.
 */
export async function modelEntry(client, id, { tries = 3, sleep = sleeper, waitMs = 1500 } = {}) {
  for (let i = 0; i < tries; i += 1) {
    const e = catalogEntry(await client.model(id));
    if (e) return e;
    if (i < tries - 1) await sleep(waitMs * (i + 1));
  }
  return null;
}

/** The essentials (catalog/essentials.json): best-in-class models with no abliterated build, or where it means nothing. */
export function loadEssentials(url = new URL('../catalog/essentials.json', import.meta.url)) {
  try { return JSON.parse(readFileSync(url, 'utf8')).essentials ?? []; } catch { return []; }
}

/** Look up each essential and return its catalog entry, marked `essential` with its role. A failed lookup is skipped. */
export async function essentialEntries({ client, essentials = loadEssentials(), maxRamGb = 24, retry = {}, log = () => {} }) {
  const out = [];
  for (const x of essentials) {
    let e = null;
    try { e = await modelEntry(client, x.id, retry); } catch (error) { log('hb_essential_failed', { id: x.id, error: String(error?.message ?? error).slice(0, 80) }); }
    if (!e) { log('hb_essential_skipped', { id: x.id, why: 'no downloadable hosted GGUF with a SHA-256 this time' }); continue; }
    if (!(e.ramGb && e.ramGb > maxRamGb)) out.push(Object.freeze({ ...e, essential: true, role: x.role }));
  }
  return out;
}

export async function buildCatalog({ client, queries = ['abliterated', 'heretic', 'uncensored'], maxRamGb = 24, maxPages = 80, essentials = loadEssentials(), retry = {}, log = () => {} }) {
  const seen = new Set(), candidates = [];
  let scanned = 0;
  for (const q of queries) {
    let cursor = 0;
    for (let page = 0; page < maxPages; page += 1) {
      const { rows, next } = await client.search(q, { cursor, limit: 100 });
      scanned += rows.length;
      for (const row of rows) if (isHostedGgufRow(row) && !seen.has(row.id)) { seen.add(row.id); candidates.push(row.id); }
      log('hb_catalog_page', { q, page, rows: rows.length, candidates: candidates.length });
      if (!rows.length || next == null || Number(next) <= Number(cursor)) break;
      cursor = next;
    }
  }
  const entries = [], skipped = [], retryLater = [];
  const keep = (id, e) => {
    if (!e.abliterated) { skipped.push({ id, why: 'not abliterated' }); return; }
    if (e.ramGb && e.ramGb > maxRamGb) { skipped.push({ id, why: `needs ${e.ramGb} GB` }); return; }
    entries.push(e);
  };
  for (const id of candidates) {
    let e = null;
    try { e = await modelEntry(client, id, retry); } catch (error) { skipped.push({ id, why: String(error?.message ?? error).slice(0, 80) }); continue; }
    if (!e) { retryLater.push(id); continue; }
    keep(id, e);
  }
  // A second, slower pass for the partial answers (2026-10-15: 44 good models, the best pick among them, came back
  // partial three times in a row during a full build, then whole on a later look).
  for (const id of retryLater) {
    let e = null;
    try { e = await modelEntry(client, id, { ...retry, tries: 3, waitMs: (retry.waitMs ?? 1500) * 3 }); } catch { /* below */ }
    if (e) keep(id, e); else skipped.push({ id, why: 'not a downloadable hosted GGUF with a SHA-256' });
  }
  for (const e of await essentialEntries({ client, essentials, maxRamGb, retry, log })) if (!entries.some((x) => x.id === e.id)) entries.push(e);
  entries.sort((a, b) => (a.ramGb ?? 99) - (b.ramGb ?? 99) || a.name.localeCompare(b.name));
  return { entries, scanned, candidates: candidates.length, skipped };
}

/**
 * Pure: the GGUF to pull from a deployment plan, within `maxBytes` when given (a 24 GB Mac lets the GPU wire ~16 GB):
 * the first of Q4_K_M, IQ4_XS, Q4_K_S, Q4_0, Q5_K_M, IQ3_M, Q3_K_M that fits, else the largest that fits. Never a vision
 * projector (mmproj); never a file without a recorded SHA-256.
 */
export function pickGguf(plan, { maxBytes = Infinity } = {}) {
  const files = (plan?.files ?? []).filter((f) => /\.gguf$/i.test(String(f.path ?? '')) && f.sha256 && f.downloadUrl && !/mmproj/i.test(f.path)
    && !/-0000[2-9]-of-|\.part\d/i.test(f.path) && (Number(f.sizeBytes) || 0) <= maxBytes);
  for (const want of ['Q4_K_M', 'IQ4_XS', 'Q4_K_S', 'Q4_0', 'Q5_K_M', 'IQ3_M', 'Q3_K_M']) {
    const f = files.find((x) => new RegExp(`[._-]${want}[._-]|${want}\\.gguf$`, 'i').test(x.path)); if (f) return f;
  }
  return files.sort((a, b) => (Number(b.sizeBytes) || 0) - (Number(a.sizeBytes) || 0))[0] ?? null;
}

/** Stream a file to dest, hashing as it lands; keep it only when its size and SHA-256 match. → { ok, path?, why? } */
export async function downloadVerified({ url, dest, sha256, sizeBytes = 0, fetchImpl = fetch, onProgress = () => {} }) {
  mkdirSync(dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  rmSync(part, { force: true });
  const r = await fetchImpl(url, { redirect: 'follow' });
  if (!r.ok || !r.body) return { ok: false, why: `HTTP ${r.status}` };
  const hash = createHash('sha256'), out = createWriteStream(part, { mode: 0o644 });
  let got = 0, lastTick = 0;
  try {
    for await (const chunk of r.body) {
      hash.update(chunk); got += chunk.length;
      if (!out.write(chunk)) await new Promise((res) => out.once('drain', res));
      if (Date.now() - lastTick > 1000) { lastTick = Date.now(); onProgress(got, sizeBytes); }
    }
    await new Promise((res, rej) => out.end((e) => (e ? rej(e) : res())));
  } catch (error) { out.destroy(); rmSync(part, { force: true }); return { ok: false, why: String(error?.message ?? error).slice(0, 120) }; }
  const digest = hash.digest('hex');
  if ((sizeBytes && got !== Number(sizeBytes)) || digest !== String(sha256).toLowerCase()) {
    rmSync(part, { force: true });
    return { ok: false, why: `the file didn't match its record (${got} bytes, sha256 ${digest.slice(0, 12)}…), so it was deleted` };
  }
  renameSync(part, dest);
  onProgress(got, sizeBytes);
  return { ok: true, path: dest };
}

/** Pull one Hugging Bay model into the models folder, verified. → { ok, path?, file?, why? } */
export async function pullModel({ client, id, modelsDir, maxBytes = Infinity, fetchImpl = fetch, onProgress, log = () => {} }) {
  const plan = await client.plan(id);
  if (!plan?.available) return { ok: false, why: `Hugging Bay can't serve ${id} right now${plan?.reason ? ` (${plan.reason})` : ''}` };
  const f = pickGguf(plan, { maxBytes });
  if (!f) return { ok: false, why: `${id} has no hosted GGUF file with a recorded SHA-256${Number.isFinite(maxBytes) ? ` within ${(maxBytes / 1e9).toFixed(0)} GB` : ''}` };
  const repo = String(plan.artifact?.repo ?? id).replace(/[^\w.-]+/g, '_');
  const dest = join(modelsDir, repo, String(f.path).split('/').pop());
  if (existsSync(dest) && statSync(dest).size === Number(f.sizeBytes)) return { ok: true, path: dest, file: f, already: true };
  log('hb_pull', { id, file: f.path, bytes: f.sizeBytes });
  const r = await downloadVerified({ url: f.downloadUrl, dest, sha256: f.sha256, sizeBytes: f.sizeBytes, fetchImpl, onProgress });
  return r.ok ? { ...r, file: f } : r;
}

/**
 * Hugging Bay in the engine's MCP hub (owner console calls, nonce): added once as an http server, its read-only tools
 * switched on. The public-posting tools stay unreviewed (off) until the owner turns them on. Never throws.
 */
export async function ensureHuggingBayMcp({ port, nonce, fetchImpl, log = () => {} }) {
  const call = (path, opts = {}) => ownerCall(port, path, { nonce, timeoutMs: 30_000, ...(fetchImpl ? { fetchImpl } : {}), ...opts }).catch((e) => ({ ok: false, status: 0, json: { error: String(e?.message ?? e) } }));
  const listed = await call('/api/mcp/servers?tenantId=primary');
  if (!listed.ok) { log('hb_mcp', { ok: false, step: 'list', error: listed.json?.error ?? listed.status }); return { ok: false, why: listed.json?.error ?? `HTTP ${listed.status}` }; }
  let server = (listed.json?.servers ?? []).find((s) => s?.config?.url === HB_MCP_URL || s?.url === HB_MCP_URL || /huggingbay\.xyz\/api\/mcp/.test(JSON.stringify(s ?? {})));
  let added = false;
  if (!server) {
    const r = await call('/api/mcp/servers', { method: 'POST', body: { tenantId: 'primary', transport: 'http', label: 'Hugging Bay (models)', url: HB_MCP_URL } });
    if (!r.ok) { log('hb_mcp', { ok: false, step: 'add', error: r.json?.error ?? r.status }); return { ok: false, why: r.json?.message ?? r.json?.error ?? `HTTP ${r.status}` }; }
    server = r.json?.server; added = true;
  }
  const id = server?.serverId ?? server?.id;
  if (!id) return { ok: false, why: 'the MCP hub returned no server id' };
  // The hub lists a server's tools on a refresh; read-only review only sees tools it has listed.
  const refreshed = await call(`/api/mcp/servers/${encodeURIComponent(id)}/refresh`, { method: 'POST', body: { tenantId: 'primary' } });
  const refresh = refreshed.json?.refresh ?? {};
  if (!refreshed.ok || refresh.ok === false) {
    const why = String(refresh.error?.message ?? refreshed.json?.message ?? refreshed.json?.error ?? `HTTP ${refreshed.status}`).slice(0, 200);
    log('hb_mcp', { ok: false, step: 'refresh', added, error: why });
    return { ok: false, added, serverId: id, why: `Hugging Bay is registered but its tools could not be listed: ${why}` };
  }
  const ro = await call(`/api/mcp/servers/${encodeURIComponent(id)}/enable-read-only`, { method: 'POST', body: { tenantId: 'primary' } });
  const reviewed = (ro.json?.reviewed ?? []).map((t) => t?.name ?? t?.toolName).filter(Boolean);
  const leaked = reviewed.filter((n) => HB_PUBLIC_TOOLS.includes(n));
  log('hb_mcp', { ok: ro.ok, added, tools: Number(refresh.toolCount) || null, reviewed: reviewed.length, leaked: leaked.length });
  return { ok: Boolean(ro.ok) && !leaked.length, added, serverId: id, tools: Number(refresh.toolCount) || null, reviewed, leaked };
}

// ── THE MONTHLY CHURN SCAN (owner 2026-10-15: "a churn scan done once a month for new additions") ──
// Compares this month's hosted abliterated GGUF builds on Hugging Bay with last month's: what was added, what left, and
// whether any of Kingmaker's picks changed file or disappeared. New entries are looked up (size, RAM, licence, SHA-256);
// nothing is downloaded. A dated report and the scan state live in the repo (catalog/churn/).

/** Every hosted GGUF build the search finds for these words: id → { name, license, hostedFileCount }. */
export async function scanHostedGguf({ client, queries = ['abliterated', 'heretic', 'uncensored'], maxPages = 120, log = () => {} }) {
  const found = {};
  for (const q of queries) {
    let cursor = 0;
    for (let page = 0; page < maxPages; page += 1) {
      const { rows, next } = await client.search(q, { cursor, limit: 100 });
      for (const r of rows) if (isHostedGgufRow(r)) found[r.id] = { name: r.name ?? r.id, license: r.license ?? 'unknown', hostedFileCount: Number(r.hostedFileCount) || 0 };
      if (!rows.length || next == null || Number(next) <= Number(cursor)) break;
      cursor = next;
    }
    log('hb_churn_query', { q, total: Object.keys(found).length });
  }
  return found;
}

/** Pure: what changed between two scans. */
export function churnDiff(prev = {}, next = {}) {
  return { added: Object.keys(next).filter((id) => !(id in prev)).sort(), removed: Object.keys(prev).filter((id) => !(id in next)).sort() };
}

/** Pure: is a newly added entry worth the owner's look? A Heretic build (least capability loss) that fits this Mac. */
export function worthALook(entry, { maxRamGb = 24 } = {}) {
  return Boolean(entry) && /heretic/i.test(entry.name) && (!entry.ramGb || entry.ramGb <= maxRamGb);
}

/**
 * One scan. `state` is last month's ({ scannedAt, entries: {id: …}, picks: {id: {file, sha256}} }) or null for the
 * first (a baseline: nothing is "new"). → { state, report } (the caller writes them).
 */
export async function churnScan({ client, state = null, picks = [], maxGbPerFile = 16, maxRamGb = 24, maxLookups = 400, now = new Date(), log = () => {} }) {
  const next = await scanHostedGguf({ client, log });
  const baseline = !state?.entries;
  const { added, removed } = baseline ? { added: [], removed: [] } : churnDiff(state.entries, next);
  const looked = [];
  for (const id of added.slice(0, maxLookups)) {
    try { const e = catalogEntry(await client.model(id)); if (e) looked.push(e); } catch { /* listed by name only */ }
  }
  const pickNow = {}, pickChanges = [];
  for (const p of picks) {
    let f = null;
    try { f = pickGguf(await client.plan(p.id), { maxBytes: maxGbPerFile * 1e9 }); } catch { /* checked below */ }
    const was = state?.picks?.[p.id];
    if (!f) { pickChanges.push({ id: p.id, role: p.role, change: 'no longer served (or no file within the size cap)' }); continue; }
    pickNow[p.id] = { file: f.path, sha256: f.sha256, sizeBytes: Number(f.sizeBytes) || 0 };
    if (was && (was.sha256 !== f.sha256 || was.file !== f.path)) pickChanges.push({ id: p.id, role: p.role, change: `file changed: ${was.file} → ${f.path}` });
  }
  const look = looked.filter((e) => worthALook(e, { maxRamGb }));
  const day = now.toISOString().slice(0, 10);
  const lines = [
    `# Hugging Bay churn scan, ${day}`, '',
    baseline ? `Baseline: ${Object.keys(next).length} hosted abliterated/Heretic/uncensored GGUF builds recorded. Next month's scan reports what changed against this.`
      : `${Object.keys(next).length} hosted builds now (last scan ${state.scannedAt?.slice(0, 10) ?? '?'}: ${Object.keys(state.entries).length}). **${added.length} added, ${removed.length} removed.**`,
    '', '## Kingmaker\'s picks', '',
    ...(pickChanges.length ? pickChanges.map((c) => `- ⚠️ ${c.role} (${c.id}): ${c.change}`) : [`- All ${picks.length} picks still served, same files.`]),
  ];
  if (!baseline) {
    lines.push('', `## Worth a look (new Heretic builds that fit a ${maxRamGb} GB Mac): ${look.length}`, '');
    for (const e of look) lines.push(`- ${e.id} — ${(e.sizeBytes / 1e9).toFixed(1)} GB, ~${e.ramGb ?? '?'} GB RAM, ${e.license}. Pull: \`kingmaker models hb pull ${e.id} --max-gb ${maxGbPerFile}\``);
    lines.push('', `## All added (${added.length})`, '');
    for (const id of added) { const e = looked.find((x) => x.id === id); lines.push(`- ${id}${e ? ` — ${(e.sizeBytes / 1e9).toFixed(1)} GB, ~${e.ramGb ?? '?'} GB RAM, ${e.license}` : ''}`); }
    lines.push('', `## Removed (${removed.length})`, '', ...removed.map((id) => `- ${id} (${state.entries[id]?.name ?? ''})`));
  }
  const newState = { scannedAt: now.toISOString(), entries: next, picks: { ...(state?.picks ?? {}), ...pickNow } };
  return { state: newState, report: `${lines.join('\n')}\n`, day, added: added.length, removed: removed.length, worth: look.length, pickChanges };
}
