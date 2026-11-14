// lib/model-residency.mjs — keep a model loaded, without pushing out a model that is not ours.
//
// Ollama makes room for a new model by unloading whichever loaded model was used least recently.
// On a host that others share (another person, another program, Kingmaker's own pinned reflex
// seat) that means a "warm this model" request can silently unload somebody else's. So:
//
//   · Kingmaker remembers which models IT asked a host to hold (a small file in its state folder).
//   · Warming a model first works out whether it fits beside what is loaded. If it fits, it loads.
//   · If it does not fit, nothing is unloaded unless the owner said so (--evict), and then
//     Kingmaker's own models go first and anything else is named before it goes.
//   · When the host's memory limit is not known, "does it fit" is unavailable, and the answer is to
//     ask, not to assume.
//   · "Stop all" unloads the models Kingmaker loaded. Other people's stay unless --everyone is given.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isUnavailable, unavailable } from './model-hosts.mjs';

export const RESIDENCY_FILE = 'model-residency.json';
const same = (a, b) => a === b || `${a}:latest` === b || a === `${b}:latest`;

/** What Kingmaker asked each host to hold: { [hostName]: { [model]: { at, keepAlive } } }. */
export function readOurs(stateDir) {
  try { const doc = JSON.parse(readFileSync(join(stateDir, RESIDENCY_FILE), 'utf8')); return doc && typeof doc.hosts === 'object' && doc.hosts ? doc.hosts : {}; } catch { return {}; }
}
/** What each model was SEEN to take once loaded on each host (read from the host after a load): { [host]: { [model]: bytes } }. */
export function readSizes(stateDir) {
  try { const doc = JSON.parse(readFileSync(join(stateDir, RESIDENCY_FILE), 'utf8')); return doc && typeof doc.sizes === 'object' && doc.sizes ? doc.sizes : {}; } catch { return {}; }
}
function writeOurs(stateDir, hosts, sizes = readSizes(stateDir)) {
  const file = join(stateDir, RESIDENCY_FILE);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ schema: 'kingmaker.model-residency/1', hosts, sizes }, null, 2)}\n`, { mode: 0o600 });
}
/**
 * How much memory this model takes once loaded on this host, if that has been seen before; else unavailable.
 * The size of the model's file is NOT this figure: a loaded model also holds its working memory, so the file
 * size is only a floor (see planWarm's `atLeastBytes`).
 */
export function measuredNeed(stateDir, hostName, model) {
  const seen = readSizes(stateDir)[hostName] ?? {};
  const key = Object.keys(seen).find((k) => same(k, model));
  return key && Number.isFinite(seen[key]) && seen[key] > 0 ? seen[key]
    : unavailable('how much memory it takes once loaded has not been measured on this host yet');
}
function noteSize(stateDir, hostName, model, bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return;
  const sizes = readSizes(stateDir);
  (sizes[hostName] ||= {})[model] = bytes;
  writeOurs(stateDir, readOurs(stateDir), sizes);
}
export function noteOurs(stateDir, hostName, model, keepAlive, now = new Date()) {
  const hosts = readOurs(stateDir);
  (hosts[hostName] ||= {})[model] = { at: now.toISOString(), keepAlive };
  writeOurs(stateDir, hosts);
}
export function forgetOurs(stateDir, hostName, model) {
  const hosts = readOurs(stateDir);
  if (!hosts[hostName]) return;
  for (const k of Object.keys(hosts[hostName])) if (same(k, model)) delete hosts[hostName][k];
  writeOurs(stateDir, hosts);
}
/** Is this loaded model one Kingmaker asked for? `pinned` are models Kingmaker holds by design (the reflex seat). */
export const isOurs = (ours, hostName, model, pinned = []) => Object.keys(ours?.[hostName] ?? {}).some((k) => same(k, model)) || pinned.some((p) => same(p, model));

/** Ollama's keep_alive forms: '30m', '24h', '45s', a whole number of seconds, or 'forever'. */
export function parseKeepAlive(input, fallback = '30m') {
  const text = String(input ?? '').trim().toLowerCase();
  if (!text) return fallback;
  if (text === 'forever' || text === '-1') return -1;
  if (/^\d+(ms|s|m|h)$/.test(text)) return text;
  if (/^\d+$/.test(text)) return Number(text);
  throw new Error(`"${input}" is not a time: use forms like 30m, 24h, 90s, or "forever"`);
}

/**
 * Decide what warming `model` would mean. Pure: no host is touched.
 *   resident      what the host has loaded now: [{ name, bytes }] (bytes may be unavailable)
 *   needBytes     how much the model takes when loaded, as measured on this host before, or unavailable
 *   atLeastBytes  the size of the model's file: the least it can take, never the whole of it
 *   budgetBytes   how much the host may hold at once, or unavailable
 * → { action: 'already-loaded' | 'load' | 'ask', fits, freeBytes, wouldUnload: [{ name, ours, bytes }], why }
 * 'ask' means: do not load unless the owner allows unloading, because another model would or might go.
 */
export function planWarm({ model, resident = [], needBytes, atLeastBytes = unavailable('the size of its file is not known'), budgetBytes, ours = {}, hostName, pinned = [] }) {
  if (resident.some((m) => same(m.name, model))) {
    return { action: 'already-loaded', fits: true, freeBytes: unavailable('not worked out: the model is already loaded'), wouldUnload: [], why: `${model} is already loaded; its time is extended.` };
  }
  const others = resident.map((m) => ({ name: m.name, bytes: m.bytes, ours: isOurs(ours, hostName, m.name, pinned), pinned: pinned.some((p) => same(p, m.name)) }));
  if (!others.length) return { action: 'load', fits: true, freeBytes: isUnavailable(budgetBytes) ? budgetBytes : budgetBytes, wouldUnload: [], why: 'Nothing else is loaded.' };

  // The loaded size has never been measured here. The file size is a floor, so it can prove "does not fit" but
  // never "fits": a model always takes more loaded than its file. When even the floor does not fit, say so with
  // what would have to go. When the floor fits, the honest answer is "cannot tell", and the owner is asked.
  const roomKnown = Number.isFinite(budgetBytes) && others.every((o) => Number.isFinite(o.bytes));
  if (isUnavailable(needBytes) && Number.isFinite(atLeastBytes) && roomKnown && atLeastBytes > budgetBytes - others.reduce((n, o) => n + o.bytes, 0)) {
    needBytes = atLeastBytes; // enough to know it does not fit; the list below is the least that would have to go
  }
  const unknown = [needBytes, budgetBytes, ...others.map((o) => o.bytes)].find(isUnavailable);
  if (unknown || !Number.isFinite(needBytes) || !Number.isFinite(budgetBytes)) {
    const reason = unknown ? unknown.reason : 'the sizes are not known';
    return {
      action: 'ask', fits: unavailable(`cannot tell whether it fits: ${reason}`), freeBytes: unavailable(reason), wouldUnload: others,
      why: `Other models are loaded and it cannot be worked out whether ${model} fits beside them (${reason}). Loading it may make the host unload one of them.`,
    };
  }
  const used = others.reduce((n, o) => n + o.bytes, 0);
  const freeBytes = budgetBytes - used;
  if (needBytes <= freeBytes) return { action: 'load', fits: true, freeBytes, wouldUnload: [], why: 'It fits beside what is already loaded.' };

  // It does not fit. Choose what would have to go: ours before anyone else's, unpinned before pinned, largest first.
  const order = [...others].sort((a, b) => Number(b.ours) - Number(a.ours) || Number(a.pinned) - Number(b.pinned) || b.bytes - a.bytes);
  const wouldUnload = []; let freed = 0;
  for (const o of order) { if (needBytes <= freeBytes + freed) break; wouldUnload.push(o); freed += o.bytes; }
  const enough = needBytes <= freeBytes + freed;
  return {
    action: 'ask', fits: false, freeBytes, wouldUnload,
    why: enough ? `${model} does not fit beside what is loaded. Making room means unloading ${wouldUnload.map((o) => `${o.name}${o.ours ? '' : ' (not loaded by Kingmaker)'}`).join(', ')}.`
      : `${model} does not fit on this host even with everything else unloaded.`,
    impossible: !enough,
  };
}

/**
 * Warm a model on a host. Nothing is unloaded unless `evict` is true.
 * → { loaded, plan, unloaded: [names], keepAlive }
 */
export async function warmModel(client, { stateDir, model, keepAlive = '30m', needBytes = undefined, atLeastBytes = undefined, budgetBytes, evict = false, pinned = [], log = () => {} }) {
  const hostName = client.host.name;
  const ps = await client.ps();
  const resident = ps.map((m) => ({ name: m.name ?? m.model, bytes: Number.isFinite(m.size) && m.size > 0 ? m.size : unavailable('the host did not report its size') }));
  const plan = planWarm({ model, resident, needBytes: needBytes ?? measuredNeed(stateDir, hostName, model), ...(atLeastBytes !== undefined ? { atLeastBytes } : {}), budgetBytes, ours: readOurs(stateDir), hostName, pinned });
  if (plan.action === 'ask' && !evict) return { loaded: false, plan, unloaded: [], keepAlive };
  if (plan.impossible) return { loaded: false, plan, unloaded: [], keepAlive };
  const unloaded = [];
  if (plan.action === 'ask' && evict) {
    for (const o of plan.wouldUnload) {
      log(`unloading ${o.name}${o.ours ? '' : ' (not loaded by Kingmaker)'}`);
      await client.unload(o.name);
      forgetOurs(stateDir, hostName, o.name);
      unloaded.push(o.name);
    }
  }
  await client.load(model, keepAlive);
  noteOurs(stateDir, hostName, model, keepAlive);
  // Read back what it really takes once loaded, so the next "does it fit" on this host is measured, not floored.
  // And check that the host did not unload something on its own while making room.
  let pushedOut = [];
  try {
    const after = await client.ps();
    const row = after.find((m) => same(m.name ?? m.model, model));
    if (row) noteSize(stateDir, hostName, model, row.size);
    const still = new Set(after.map((m) => m.name ?? m.model));
    pushedOut = resident.map((m) => m.name).filter((n) => !still.has(n) && !unloaded.includes(n) && !same(n, model));
  } catch { /* the load itself succeeded; the read-back is a bonus */ }
  return { loaded: true, plan, unloaded, pushedOut, keepAlive };
}

/**
 * Unload. `target` is a model name or 'all'. 'all' means every model Kingmaker loaded on that host;
 * models it did not load stay, unless `everyone` is true. Pinned models stay unless named outright.
 * → { unloaded: [names], left: [{ name, why }] }
 */
export async function stopModels(client, { stateDir, target, everyone = false, pinned = [] }) {
  const hostName = client.host.name;
  const ours = readOurs(stateDir);
  const resident = (await client.ps()).map((m) => m.name ?? m.model);
  const unloaded = [], left = [];
  if (target !== 'all') {
    const hit = resident.find((n) => same(n, target));
    if (!hit) { forgetOurs(stateDir, hostName, target); return { unloaded, left: [{ name: target, why: 'it is not loaded' }] }; }
    await client.unload(hit); forgetOurs(stateDir, hostName, hit); unloaded.push(hit);
    return { unloaded, left };
  }
  for (const name of resident) {
    if (pinned.some((p) => same(p, name))) { left.push({ name, why: 'Kingmaker keeps it loaded on purpose; name it to unload it' }); continue; }
    if (!everyone && !isOurs(ours, hostName, name)) { left.push({ name, why: 'not loaded by Kingmaker; add --everyone to unload it too' }); continue; }
    await client.unload(name); forgetOurs(stateDir, hostName, name); unloaded.push(name);
  }
  return { unloaded, left };
}
