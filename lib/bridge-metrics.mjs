// lib/bridge-metrics.mjs — what the Ronin launcher's machine card shows that only Kingmaker knows (GET /admin/metrics on
// the companion's loopback bridge, docs/kingmaker-bridge.md in ronin-launcher): its version, this Mac's facts, the
// model on each lane and whether Ollama holds it, the engine's queue, and its measured token rates. Nothing secret.
// A field that isn't known is null (the launcher shows a dash, never 0). No GPU numbers: reading them needs
// powermetrics as root, which Kingmaker has no grant for, so `gpu` is left out.
//
// The lanes are the starter floor's picks (lib/mac-profiles.mjs FLOOR_ROLES — the same on every Mac), with an
// installed model tabled for the role shown when the floor pick itself is not installed. There is no device
// profile to report since the metered-doctrine rework (2026-11-14): `device` carries this Mac's measured facts.
import { readCalibration } from './calibration.mjs';
import { BENCH_SETS, FLOOR_ROLES, detectMac, ROLES } from './mac-profiles.mjs';
import { runningVersion } from './update.mjs';

let mac = null;   // the chip and RAM don't change while Kingmaker runs
const thisMac = () => (mac ??= detectMac());

const ollama = async (path, { base, fetchImpl }) => {
  try { const r = await fetchImpl(`${base.replace(/\/$/, '')}${path}`, { signal: AbortSignal.timeout(2500) }); return r.ok ? await r.json() : null; } catch { return null; }
};

/** The model a lane shows: the floor pick, or — when it is not installed — an installed model the
 *  bench tables assign to the role, else the floor pick itself (shown as not loaded). */
function laneModel(role, installed) {
  const floor = FLOOR_ROLES[role];
  if (!installed.length || installed.includes(floor)) return floor;
  const tabled = Object.values(BENCH_SETS).flat().find((m) => m.role === role && installed.includes(m.tag));
  return tabled?.tag ?? floor;
}

/**
 * The metrics object. `jobs` → { running, queued } or null (only the engine knows its queue); `tokens` →
 * meterSnapshot() or null (only the engine's own process sees its answers).
 */
export async function bridgeMetrics({ state, jobs = () => null, tokens = () => null, base = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434', fetchImpl = fetch, macInfo = null } = {}) {
  const m = macInfo || thisMac();
  const [tags, ps] = await Promise.all([ollama('/api/tags', { base, fetchImpl }), ollama('/api/ps', { base, fetchImpl })]);
  const installed = (tags?.models ?? []).map((x) => String(x.name));
  const loaded = ps ? new Set((ps.models ?? []).flatMap((x) => [String(x.name), String(x.model)])) : null;
  let cal = null; try { cal = readCalibration(state); } catch { /* defaults */ }
  const lanes = ROLES.map((role) => {
    // The router's model is Customize → Router when the owner changed it; every other lane is the floor's pick.
    const model = (role === 'router' && cal?.router?.model) || laneModel(role, installed);
    const context = role === 'writer' && Number.isFinite(cal?.writer?.context) ? cal.writer.context : null;
    return { role, model: model || null, context, loaded: model && loaded ? loaded.has(model) : null };
  });
  return {
    at: new Date().toISOString(),
    kingmaker: { version: runningVersion() },
    device: m ? { chip: m.chip ?? null, ramGb: m.ramGb ?? null, model: m.model ?? null } : null,
    lanes,
    jobs: jobs() ?? null,
    tokens: tokens() ?? null,
  };
}
