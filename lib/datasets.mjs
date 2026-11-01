// lib/datasets.mjs — GET /admin/datasets for the Ronin launcher: the data this installation has connected that Kingmaker
// can see, with its size, last sync and status. What Kingmaker reads from each is recorded as a use (meterDataset in
// lib/token-meter.mjs) and summed by GET /admin/metrics/history.
//
//   knowledge-library   the knowledge library under Kingmaker's runtime (sources → extracted → index shards), built by
//                       lib/knowledge.mjs; the engine draws on it inside its own turns, so its reads aren't seen here
//   memory:<tenant>     what Kingmaker has learned about its owner (lib/learning.mjs); read into the local writer's turns
//   crm:<host>          the CRM this installation is connected to; read by CRM skills and CRM jobs
//
// Connectors (CLIs, MCP servers, skills) are tools, not data, so they aren't listed. Never a path, a file's contents, a
// URL's credentials or a key: names, counts, sizes and times only. Unknown is null.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const KNOWLEDGE_ID = 'knowledge-library';
export const memoryDatasetId = (tenant) => `memory:${tenant}`;
const stateDir = (env = process.env) => String(env.SOL_GHOST_HOME ?? '').trim() || join(homedir(), 'Library/Application Support/sol-ghost');
const runtimeHomeOf = (state, env = process.env) => String(env.SOL_GHOST_RUNTIME_HOME || join(state, 'runtime'));
const knowledgeLast = (state) => join(state, 'knowledge-last.json');
const iso = (ms) => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null);
const mtime = (p) => { try { return statSync(p).mtimeMs; } catch { return null; } };
const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
const pidAlive = (pid) => { try { process.kill(Number(pid), 0); return true; } catch (e) { return e.code === 'EPERM'; } };

/** The CRM this installation is connected to, as a dataset id (crm:<host>), or null. Only the host: never a path or credential. */
export function crmDatasetId(runtimeHome) {
  const c = readJson(join(runtimeHome, 'data', 'home-crm.json'));
  try { return c?.url ? `crm:${new URL(c.url).host}` : null; } catch { return null; }
}

/** The engine, after each knowledge build (lib/knowledge.mjs provisionKnowledge's result): kept for its status. */
export function noteKnowledgeRun(state, r) {
  try { writeFileSync(knowledgeLast(state), JSON.stringify({ at: new Date().toISOString(), state: String(r?.state ?? 'unknown'), stage: r?.stage ?? null, fields: Number.isFinite(r?.fields) ? r.fields : null }), { mode: 0o600 }); } catch { /* status only */ }
}

// The knowledge library has tens of thousands of files: its document count and size are walked in the background and
// kept for half an hour. Until the first walk ends they are null.
const WALK_TTL = 30 * 60_000;
const walks = new Map();   // dir → { at, files, bytes, running }
async function walk(dir) {
  let files = 0, bytes = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries = []; try { entries = await readdir(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) { files++; try { bytes += (await stat(p)).size; } catch { /* gone */ } }
    }
  }
  return { files, bytes };
}
/** Start (or refresh) the walk of `dir`; what it found so far is in walks.get(dir). */
function walked(dir) {
  const w = walks.get(dir);
  if (w && (w.running || Date.now() - w.at <= WALK_TTL)) return;
  const next = { at: w?.at ?? 0, files: w?.files ?? null, bytes: w?.bytes ?? null, running: true };
  walks.set(dir, next);
  next.done = walk(dir).then((r) => Object.assign(next, r, { at: Date.now(), running: false }), () => { next.running = false; });
}

/** The knowledge library's entry, or null when it has never been set up here. */
function knowledge(state, runtimeHome) {
  const dir = join(runtimeHome, 'data', 'knowledge'), index = join(dir, 'index');
  if (!existsSync(dir)) return null;
  let shards = []; try { shards = readdirSync(index).filter((n) => n.endsWith('.db')); } catch { /* none yet */ }
  const sources = join(dir, 'sources');
  walked(sources); walked(dir);
  const job = readJson(join(state, 'knowledge-job.json')), last = readJson(knowledgeLast(state));
  const building = Boolean(job?.pid && pidAlive(job.pid));
  const why = last?.state === 'failed' ? `The last build stopped at its ${last.stage || ''} step; it tries again on the next start.`.replace('its  step', 'a step')
    : last?.state === 'deferred-disk' ? 'Paused: not enough free disk; it resumes on a later start.'
      : last?.state === 'deferred-meeting' ? 'Paused for your meeting; it resumes after.' : null;
  return {
    id: KNOWLEDGE_ID, name: 'Knowledge library', source: 'knowledge-library', connector: 'Kingmaker',
    items: shards.length, documents: walks.get(sources)?.files ?? null, bytes: walks.get(dir)?.bytes ?? null,
    lastSync: iso(Math.max(0, ...shards.map((n) => mtime(join(index, n)) ?? 0))),
    syncStatus: building ? 'syncing' : last?.state === 'failed' ? 'error' : shards.length ? 'ok' : 'never',
    error: building ? null : why,
  };
}

/** What Kingmaker has learned about its owner, per tenant. */
function memories(state) {
  const root = join(state, 'personalization');
  let tenants = []; try { tenants = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && /^[a-z0-9-]{1,40}$/.test(e.name)).map((e) => e.name); } catch { return []; }
  return tenants.flatMap((tenant) => {
    const dir = join(root, tenant), mem = readJson(join(dir, 'memory.json'));
    if (!mem) return [];
    let events = 0; try { events = readFileSync(join(dir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).length; } catch { /* none */ }
    let bytes = 0; const add = (d) => { try { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) add(p); else bytes += statSync(p).size; } } catch { /* gone */ } };
    add(dir);
    return [{
      id: memoryDatasetId(tenant), name: 'What Kingmaker has learned', source: 'memory', connector: 'Kingmaker learning',
      items: Object.keys(mem.preferences ?? {}).length, documents: events, bytes,
      lastSync: iso(Math.max(mtime(join(dir, 'memory.json')) ?? 0, mtime(join(dir, 'events.jsonl')) ?? 0)), syncStatus: 'ok', error: null,
    }];
  });
}

/** The connected CRM: live (read when asked, never copied here), so nothing to count or sync. */
function crm(runtimeHome) {
  const id = crmDatasetId(runtimeHome);
  if (!id) return [];
  const host = id.slice(4);
  return [{ id, name: host, source: 'crm', connector: 'CRM', items: null, documents: null, bytes: null, lastSync: null, syncStatus: 'ok', error: null }];
}

/** GET /admin/datasets. `settle` waits for the background walks (tests). */
export async function listDatasets({ state = stateDir(), env = process.env, settle = false } = {}) {
  const runtimeHome = runtimeHomeOf(state, env);
  if (settle) { knowledge(state, runtimeHome); await Promise.all([...walks.values()].map((w) => w.done)); }
  return [knowledge(state, runtimeHome), ...memories(state), ...crm(runtimeHome)].filter(Boolean);
}
