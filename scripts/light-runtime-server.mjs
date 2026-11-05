// scripts/light-runtime-server.mjs — the light runtime's tiny server: no dependencies, bound to 127.0.0.1
// only (this is the owner's own machine surface; there is no auth because there is no network).
//
//   GET  /        the window (light-runtime/index.html)
//   GET  /state   the canonical state (light-runtime/state-schema.mjs), assembled live from the tree's own
//                 sources: lib/mac-profiles.mjs (this Mac's profile), lib/reflex-seat.mjs (the seat plan),
//                 the token meter's own log (<state>/metrics/model-calls-YYYY-MM.jsonl, lib/token-meter.mjs's
//                 file) when a Kingmaker state dir is given, and the light state dir's proof-report.json +
//                 verdicts.json + control.json.
//   GET  /control the owner's three switches as they stand.
//   POST /control a patch of those switches — the ONLY write this server performs. It writes intent flags
//                 (proofRun for scripts/run-10m-proof.mjs, the two reflex switches); it approves nothing,
//                 sends nothing, and starts nothing itself.
//
// Run: node scripts/light-runtime-server.mjs   (LIGHT_RUNTIME_PORT, KINGMAKER_LIGHT_DIR, KINGMAKER_STATE_DIR)
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { currentProfile } from '../lib/mac-profiles.mjs';
import { reflexSeatPlan, reflexPinEnabled } from '../lib/reflex-seat.mjs';
import { reflexEnabled } from '../lib/reflex-layer.mjs';
import { meterSnapshot } from '../lib/token-meter.mjs';
import {
  assembleState, readControl, writeControl, CONTROL_FILE, PROOF_REPORT_FILE, VERDICTS_FILE,
} from '../light-runtime/state-schema.mjs';

const readJson = (path) => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };

/** The meter's totals from its own monthly log: every recorded call's prompt + generated tokens. Rates are
 *  NOT derived from the log — a rate needs the meter's live window; totals are what the file honestly holds. */
export function meterTotalsFromLog(stateDir, d = new Date()) {
  if (!stateDir) return null;
  const f = join(stateDir, 'metrics', `model-calls-${d.toISOString().slice(0, 7)}.jsonl`);
  if (!existsSync(f)) return null;
  let generated = 0, prompt = 0, seen = false;
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (typeof r.generated === 'number') { generated += r.generated; seen = true; }
      if (typeof r.prompt === 'number') { prompt += r.prompt; seen = true; }
    } catch { /* a torn last line is not data */ }
  }
  return seen ? { decodeTokS: null, prefillTokS: null, generated, prompt, since: null } : null;
}

/** Assemble the live state from this machine's real sources. Every input is allowed to be absent; the
 *  schema renders an absent source as nulls and UNMEASURED, never as invented numbers. */
export function assembleLiveState({ stateDir, profileDir = null, env = process.env, now = new Date() } = {}) {
  let profile = null, seatPlan = null;
  try { profile = currentProfile(profileDir); } catch { profile = null; }
  if (profile) { try { seatPlan = reflexSeatPlan({ profile, env }); } catch { seatPlan = null; } }
  const control = readControl(stateDir);
  return assembleState({
    meter: meterTotalsFromLog(profileDir, now) ?? meterSnapshot(),
    profile, seatPlan,
    report: readJson(join(stateDir, PROOF_REPORT_FILE)),
    verdicts: readJson(join(stateDir, VERDICTS_FILE)),
    control,
    reflexOn: control.reflex && reflexEnabled({ env }),
    pinOn: control.reflexPin && reflexPinEnabled({ env }),
    now,
  });
}

const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(`${JSON.stringify(body)}\n`); };

/**
 * The server. `assetsDir` holds index.html (the repo's light-runtime folder); `stateDir` holds control.json,
 * proof-report.json and verdicts.json (default: the same folder; KINGMAKER_LIGHT_DIR separates them).
 * `stateProvider` replaces live assembly (tests).
 */
export function createLightRuntimeServer({ assetsDir, stateDir = assetsDir, profileDir = null, stateProvider = null } = {}) {
  const pagePath = join(assetsDir, 'index.html');
  return createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/') {
      if (!existsSync(pagePath)) return json(res, 500, { ok: false, errors: ['light-runtime/index.html is missing'] });
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(readFileSync(pagePath));
    }
    if (req.method === 'GET' && url.pathname === '/state') {
      try { return json(res, 200, stateProvider ? stateProvider() : assembleLiveState({ stateDir, profileDir })); }
      catch (e) { return json(res, 500, { ok: false, errors: [String(e?.message ?? e)] }); }
    }
    if (req.method === 'GET' && url.pathname === '/control') return json(res, 200, { ok: true, control: readControl(stateDir) });
    if (req.method === 'POST' && url.pathname === '/control') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 16384) req.destroy(); });
      req.on('end', () => {
        let patch;
        try { patch = JSON.parse(body || '{}'); } catch { return json(res, 400, { ok: false, errors: ['body must be JSON'] }); }
        const clean = {};
        for (const k of ['proofRun', 'reflex', 'reflexPin']) if (k in patch) clean[k] = patch[k];
        try { return json(res, 200, { ok: true, control: writeControl(stateDir, clean) }); }
        catch (e) { return json(res, 400, { ok: false, errors: [String(e?.message ?? e)] }); }
      });
      return;
    }
    return json(res, 404, { ok: false, errors: ['not found'] });
  });
}

/** Bind the server to loopback only. The one address this surface is ever served on. */
export function listenLightRuntime(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server.address()));
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const assetsDir = fileURLToPath(new URL('../light-runtime', import.meta.url));
  const stateDir = process.env.KINGMAKER_LIGHT_DIR || assetsDir;
  const server = createLightRuntimeServer({ assetsDir, stateDir, profileDir: process.env.KINGMAKER_STATE_DIR || null });
  const port = Number(process.env.LIGHT_RUNTIME_PORT || 8931);
  listenLightRuntime(server, port).then((a) => {
    console.log(`kingmaker light runtime: http://127.0.0.1:${a.port}  (state dir: ${stateDir}, control: ${CONTROL_FILE})`);
  });
}
