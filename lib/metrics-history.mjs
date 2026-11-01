// lib/metrics-history.mjs — GET /admin/metrics/history for the Ronin launcher's analytics: the model calls Kingmaker
// recorded (lib/token-meter.mjs) and the connected datasets they read, summed per hour or day (the Mac's local time),
// per model and per dataset, plus the latest calls. Only what was recorded: a bucket with no calls is left out, and
// recordedSince says where "no data" ends (null when nothing was ever recorded). A number nobody reported (a cloud CLI
// that prints no usage) stays null, never 0. Local calls have no cost (costUsd null).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { callsFile, metricsDir, usesFile } from './token-meter.mjs';

const MAX_DAYS = 400, RECENT = 50, MIN_TOKENS = 16;

/** Pure: the query → { from, to, bucket } (Dates and 'hour'|'day'), or { error }. Defaults: the last 24 hours, hourly. */
export function historyQuery(params, now = new Date()) {
  const to = params.get('to') ? new Date(params.get('to')) : now;
  const from = params.get('from') ? new Date(params.get('from')) : new Date(to.getTime() - 86_400_000);
  if (Number.isNaN(+from) || Number.isNaN(+to) || from >= to) return { error: 'from and to are ISO times, from before to' };
  if (to - from > MAX_DAYS * 86_400_000) return { error: `at most ${MAX_DAYS} days` };
  const b = params.get('bucket') || (to - from <= 2 * 86_400_000 ? 'hour' : 'day');
  if (!['hour', 'day'].includes(b)) return { error: 'bucket is hour or day' };
  return { from, to, bucket: b };
}

/** The start of the hour or day `t` falls in, on this Mac's clock. */
const bucketStart = (t, bucket) => { const d = new Date(t); d.setMinutes(0, 0, 0); if (bucket === 'day') d.setHours(0); return d.toISOString(); };

/** Every record of one monthly log family in [from, to), oldest first. Lines start {"at":"<ISO>" so most are skipped unparsed. */
function* records(state, fileOf, from, to) {
  const lo = from.toISOString(), hi = to.toISOString();
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
  for (; d <= to; d.setUTCMonth(d.getUTCMonth() + 1)) {
    const f = fileOf(state, d);
    if (!existsSync(f)) continue;
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      if (line.length < 10 || line.slice(7, 31) < lo || line.slice(7, 31) >= hi) continue;
      let r; try { r = JSON.parse(line); } catch { continue; }
      if (typeof r.at === 'string' && r.at >= lo && r.at < hi) yield r;
    }
  }
}

const kindOf = (r) => (r.provider === 'ollama' ? 'local' : 'cloud');
const laneOf = (r) => (r.lane && r.lane !== 'cloud' ? r.lane : null);

/** One model's running sum. A number nobody reported keeps the total null until one is. */
const blank = (r) => ({ model: r.model ?? null, provider: r.provider ?? null, kind: kindOf(r), lanes: {}, prompt: null, generated: null, requests: 0, costUsd: null, dec: [0, 0], pre: [0, 0] });
const add = (a, r) => {
  a.requests++;
  const lane = laneOf(r); if (lane) a.lanes[lane] = (a.lanes[lane] ?? 0) + 1;
  if (r.prompt != null) a.prompt = (a.prompt ?? 0) + r.prompt;
  if (r.generated != null) a.generated = (a.generated ?? 0) + r.generated;
  if (r.costUsd != null && kindOf(r) === 'cloud') a.costUsd = +((a.costUsd ?? 0) + r.costUsd).toFixed(6);
  if (r.generated >= MIN_TOKENS && r.evalNs > 0) { a.dec[0] += r.generated; a.dec[1] += r.evalNs; }
  if (r.prompt >= MIN_TOKENS && r.promptNs > 0) { a.pre[0] += r.prompt; a.pre[1] += r.promptNs; }
};
const tps = ([n, ns]) => (ns ? +(n / (ns / 1e9)).toFixed(1) : null);
const out = (a) => ({
  model: a.model, provider: a.provider, kind: a.kind,
  lane: Object.entries(a.lanes).sort((x, y) => y[1] - x[1])[0]?.[0] ?? null,
  prompt: a.prompt, generated: a.generated, requests: a.requests, costUsd: a.costUsd, decodeTokS: tps(a.dec), prefillTokS: tps(a.pre),
});
const keyOf = (r) => `${r.provider ?? ''}\u0000${r.model ?? ''}`;

/** The history for [from, to). */
export function readHistory(state, { from, to, bucket }) {
  let recordedSince = null;
  try { recordedSince = JSON.parse(readFileSync(join(metricsDir(state), 'since.json'), 'utf8')).recordedSince ?? null; } catch { /* never recorded */ }
  const buckets = new Map(), totals = new Map(), recent = [];
  const slot = (at) => { const b = bucketStart(at, bucket); if (!buckets.has(b)) buckets.set(b, { models: new Map(), datasets: {} }); return buckets.get(b); };
  for (const r of records(state, callsFile, from, to)) {
    const k = keyOf(r), s = slot(r.at).models;
    if (!s.has(k)) s.set(k, blank(r)); add(s.get(k), r);
    if (!totals.has(k)) totals.set(k, blank(r)); add(totals.get(k), r);
    recent.push(r); if (recent.length > RECENT * 4) recent.splice(0, recent.length - RECENT);
  }
  const datasets = new Map();
  for (const u of records(state, usesFile, from, to)) {
    if (!u.dataset) continue;
    const b = slot(u.at).datasets; b[u.dataset] = (b[u.dataset] ?? 0) + 1;
    if (!datasets.has(u.dataset)) datasets.set(u.dataset, { id: u.dataset, uses: 0, by: new Map() });
    const d = datasets.get(u.dataset); d.uses++;
    const bk = `${u.model ?? ''}\u0000${u.lane ?? ''}\u0000${u.kind ?? ''}`;
    if (!d.by.has(bk)) d.by.set(bk, { model: u.model ?? null, lane: u.lane ?? null, kind: u.kind ?? null, uses: 0 });
    d.by.get(bk).uses++;
  }
  const byRequests = (a, b) => b.requests - a.requests;
  return {
    from: from.toISOString(), to: to.toISOString(), bucket, recordedSince,
    series: [...buckets.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([at, s]) => ({ at, models: [...s.models.values()].map(out).sort(byRequests), datasets: s.datasets })),
    models: [...totals.values()].map(out).sort(byRequests),
    datasets: [...datasets.values()].map(({ id, uses, by }) => ({ id, uses, usedBy: [...by.values()].sort((a, b) => b.uses - a.uses) })).sort((a, b) => b.uses - a.uses),
    recent: recent.slice(-RECENT).reverse().map((r) => ({ at: r.at, model: r.model ?? null, provider: r.provider ?? null, kind: kindOf(r), lane: laneOf(r), job: r.kind ?? null, prompt: r.prompt ?? null, generated: r.generated ?? null, costUsd: kindOf(r) === 'cloud' ? r.costUsd ?? null : null, outcome: r.outcome ?? null })),
  };
}
