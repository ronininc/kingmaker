// lib/bridge-metrics.mjs — what the Ronin launcher's machine card shows that only Kingmaker knows (GET /admin/metrics on
// the companion's loopback bridge, docs/kingmaker-bridge.md in ronin-launcher): its version, this Mac's profile, the
// model on each lane and whether Ollama holds it, the engine's queue, and its measured token rates. Nothing secret.
// A field that isn't known is null (the launcher shows a dash, never 0). No GPU numbers: reading them needs
// powermetrics as root, which Kingmaker has no grant for, so `gpu` is left out.
import { readCalibration } from './calibration.mjs';
import { currentProfile, detectMac, roleModel, ROLES } from './mac-profiles.mjs';
import { runningVersion } from './update.mjs';

let mac = null;   // the chip and RAM don't change while Kingmaker runs
const thisMac = () => (mac ??= detectMac());

const ollama = async (path, { base, fetchImpl }) => {
  try { const r = await fetchImpl(`${base.replace(/\/$/, '')}${path}`, { signal: AbortSignal.timeout(2500) }); return r.ok ? await r.json() : null; } catch { return null; }
};

/**
 * The metrics object. `jobs` → { running, queued } or null (only the engine knows its queue); `tokens` →
 * meterSnapshot() or null (only the engine's own process sees its answers).
 */
export async function bridgeMetrics({ state, jobs = () => null, tokens = () => null, base = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434', fetchImpl = fetch, macInfo = null } = {}) {
  let p = null; try { p = currentProfile(state, { mac: macInfo || thisMac() }); } catch { /* shown as null */ }
  const [tags, ps] = await Promise.all([ollama('/api/tags', { base, fetchImpl }), ollama('/api/ps', { base, fetchImpl })]);
  const installed = (tags?.models ?? []).map((m) => String(m.name));
  const loaded = ps ? new Set((ps.models ?? []).flatMap((m) => [String(m.name), String(m.model)])) : null;
  let cal = null; try { cal = readCalibration(state); } catch { /* defaults */ }
  const lanes = p ? ROLES.map((role) => {
    // The router's model is Customize → Router when the owner changed it; every other lane is the profile's pick.
    const model = (role === 'router' && cal?.router?.model) || roleModel(p, role, installed) || (p[role] !== 'PENDING' ? p[role] : null);
    const context = role === 'writer' && Number.isFinite(cal?.writer?.context) ? cal.writer.context : p.context ?? null;
    return { role, model: model || null, context, loaded: model && loaded ? loaded.has(model) : null };
  }) : [];
  return {
    at: new Date().toISOString(),
    kingmaker: { version: runningVersion() },
    profile: p ? { id: p.id, label: p.label, source: p.overridden ? 'override' : 'auto', basis: p.basis ?? null } : null,
    lanes,
    jobs: jobs() ?? null,
    tokens: tokens() ?? null,
  };
}
