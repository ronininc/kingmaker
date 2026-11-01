// The indicator travels with the voice. Kingmaker's only UI is the Ronin Inc logo in the menu bar (app/Kingmaker.swift),
// and the operator's rule is that it shows whenever Kingmaker can hear or speak. Under Kingmaker.app the app IS the
// indicator. Started from a terminal (`kingmaker start`), Kingmaker launches it itself in attach mode
// (SOL_GHOST_GLOW_ATTACH=1) and feeds it the same "@@ghost {json}" state lines. If it cannot be shown, voice does not
// start; if it goes away mid-run, voice stops. (It was a screen-edge ring before the rename; the name "ring" stayed.)

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir, platform, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
/** The menu bar agent inside Kingmaker.app; an older Sol Ghost.app names it "Sol Ghost". */
const RING_EXE = join('Contents', 'MacOS', 'Kingmaker');
const LEGACY_RING_EXE = join('Contents', 'MacOS', 'Sol Ghost');

/** Where the indicator app can be found, first match wins. Pure given `exists`. Null off macOS or when none exists. */
export function findRingApp({ env = process.env, home = homedir(), os = platform(), exists = existsSync, moduleDir = HERE } = {}) {
  if (os !== 'darwin') return null;
  const explicit = String(env.SOL_GHOST_RING_APP ?? '').trim();
  const asExe = (p) => (p.endsWith('.app') ? join(p, /Sol Ghost\.app$/.test(p) ? LEGACY_RING_EXE : RING_EXE) : p);
  const candidates = [
    ...(explicit ? [asExe(explicit)] : []),
    // Inside a bundle: Contents/Resources/sol-ghost/lib → Contents/MacOS/Kingmaker
    resolve(moduleDir, '..', '..', '..', 'MacOS', 'Kingmaker'),
    join(home, 'Applications', 'Kingmaker.app', RING_EXE),
    join('/Applications', 'Kingmaker.app', RING_EXE),
    // A checkout's dev build (scripts/build-app.sh)
    resolve(moduleDir, '..', 'dist', 'Kingmaker.app', RING_EXE),
    // Not yet reinstalled: an older Sol Ghost.app
    resolve(moduleDir, '..', '..', '..', 'MacOS', 'Sol Ghost'),
    join(home, 'Applications', 'Sol Ghost.app', LEGACY_RING_EXE),
    join('/Applications', 'Sol Ghost.app', LEGACY_RING_EXE),
  ];
  if (explicit) return exists(candidates[0]) ? candidates[0] : null; // an explicit ring is the only ring
  return candidates.find((p) => exists(p)) ?? null;
}

/**
 * Launch the ring and wait for its "@@glow ready". Resolves { ok: true, send, stop, exited } or
 * { ok: false, reason }. `send(state, extra)` writes one "@@ghost" line; `stop()` closes its stdin (it quits).
 */
export function startRing({ binary, spawnImpl = spawn, timeoutMs = 10_000, env = process.env, onLine = () => {} } = {}) {
  if (!binary) return Promise.resolve({ ok: false, reason: 'no Kingmaker menu bar app on this Mac (install Kingmaker, or build it: scripts/build-app.sh)' });
  return new Promise((resolveStart) => {
    let child;
    try {
      child = spawnImpl(binary, [], { env: { ...env, SOL_GHOST_GLOW_ATTACH: '1' }, stdio: ['pipe', 'pipe', 'ignore'] });
    } catch (error) {
      resolveStart({ ok: false, reason: `the ring did not start: ${String(error?.message || error).slice(0, 120)}` });
      return;
    }
    let settled = false;
    let buffer = '';
    const exited = new Promise((r) => child.once('exit', (code, signal) => r({ code, signal })));
    const fail = (reason) => { if (settled) return; settled = true; try { child.kill('SIGTERM'); } catch { /* gone */ } resolveStart({ ok: false, reason }); };
    const timer = setTimeout(() => fail(`the ring did not come up within ${Math.round(timeoutMs / 1000)} s`), timeoutMs);
    child.once('error', (error) => { clearTimeout(timer); fail(`the ring did not start: ${String(error?.message || error).slice(0, 120)}`); });
    child.once('exit', (code) => { clearTimeout(timer); fail(`the ring exited before it was ready (code ${code})`); });
    let pending = '';
    child.stdout?.on('data', (d) => {
      pending += String(d);
      let nl;
      while ((nl = pending.indexOf('\n')) >= 0) { const line = pending.slice(0, nl).trim(); pending = pending.slice(nl + 1); if (line) onLine(line); }
      buffer += String(d);
      if (settled || !/^@@glow ready\b/m.test(buffer)) return;
      settled = true;
      clearTimeout(timer);
      const send = (state, extra = {}) => {
        try { if (child.stdin?.writable) child.stdin.write(`@@ghost ${JSON.stringify({ state, ...extra })}\n`); } catch { /* ring gone: exited handles it */ }
      };
      const stop = () => { try { child.stdin?.end(); } catch { /* gone */ } };
      resolveStart({ ok: true, send, stop, exited, pid: child.pid });
    });
    child.stdin?.on('error', () => { /* a closed pipe is reported by exit */ });
  });
}

/** An 8 GB-class Mac (8 GiB, reported a little under or over): text only by default. */
export const TEXT_ONLY_MAX_GB = 10;
/**
 * Pure: is this run text only (no listening loop, no spoken replies)? mode is Customize → Voice in the app: 'text' and
 * 'voice' are the owner's choice; 'auto' (the default) is text only on an 8 GB-class Mac, where the voice models' memory
 * (whisper, the wake word, Kokoro) is better spent on the language model, and voice on anything bigger.
 */
export function textOnlyFor(mode, memBytes = totalmem()) {
  const m = String(mode ?? 'auto').trim().toLowerCase();
  if (m === 'text') return true;
  if (m === 'voice') return false;
  return memBytes / 2 ** 30 <= TEXT_ONLY_MAX_GB;
}

/**
 * Pure: may this run listen? Under the app (--agent) the app is the ring. Otherwise voice needs a live ring.
 * Returns { listening, line } where `line` (when set) tells the operator why voice is off.
 */
export function voicePlan({ wantsVoice, agent, ring }) {
  if (!wantsVoice) return { listening: false, line: null };
  if (agent) return { listening: true, line: null };
  if (ring?.ok) return { listening: true, line: null };
  return { listening: false, line: `Voice is off: it never runs without the ring, and ${ring?.reason ?? 'no ring is available'}.` };
}
