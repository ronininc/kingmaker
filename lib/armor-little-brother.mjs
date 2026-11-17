// lib/armor-little-brother.mjs — Kingmaker's client for Scripture Armor's Little Brother (interface scripture-armor.lb-host/2).
//
// Owner decisions (2026-11-17): Little Brother is Armor's own runtime, part of the paid Armor subscription. Kingmaker (free)
// may use it only when the user is entitled — and ARMOR enforces that, not Kingmaker: every call runs `lb-host.mjs` as a
// SEPARATE Armor process, on Armor's own bundled Node when the install has one, after Kingmaker has authenticated the
// exact lb-host.mjs import closure (lib/armor-connection.mjs). Kingmaker passes no entitlement and cannot approve a scope:
// Armor reads its own signed, device-bound receipt and the user-approved scope record. No Kingmaker paywall is added.
// Progress is Armor's own event stream (scripture-armor.lb-events/1): real step and tool counts, never a made-up percentage.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ArmorUnavailableError, verifyInstalledArmor } from './armor-connection.mjs';

export const LB_INTERFACE = 'scripture-armor.lb-host/2';
export const LB_EVENTS = 'scripture-armor.lb-events/1';
const EXIT = { 0: 'completed', 1: 'incomplete', 2: 'plan-error', 3: 'entitlement-refused', 4: 'scope-refused', 5: 'runtime-flags-refused' };

/** Armor's identity folder (where its firewall profile, entitlement receipt and scopes live). */
export function armorIdentityDir(env = process.env) {
  return env.KINGMAKER_ARMOR_IDENTITY_DIR || join(env.HOME || homedir(), '.scripture-armor');
}

/** Authenticate the install for the lb-host entry point and choose the runtime Armor itself would use. */
export function locateLbHost({ verify = verifyInstalledArmor, env = process.env } = {}) {
  const info = verify({ env, entries: ['lb-host.mjs'] });
  const bundledNode = join(info.root, 'runtime', 'node', 'bin', process.platform === 'win32' ? 'node.exe' : 'node');
  // An install that ships its own Node (1.2.4+) is run ONLY on it (its launchers refuse anything else). Older or
  // owner-pinned developer installs run on this Node; Armor's lb-host still refuses injected loader/inspect flags.
  const node = existsSync(bundledNode) ? bundledNode : process.execPath;
  return { root: info.root, version: info.version, auth: info.auth, node, entry: join(info.root, 'lb-host.mjs') };
}

function cleanEnv(env) {
  const out = {};
  for (const k of ['HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR', 'PATH']) if (env[k]) out[k] = env[k];
  return out; // never NODE_OPTIONS / NODE_PATH / loaders
}

function runCli(host, args, { env = process.env, onLine = null, signal = null, timeoutMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(host.node, [host.entry, ...args], { cwd: host.root, env: cleanEnv(env), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = ''; let buf = '';
    const abort = () => child.kill('SIGTERM');
    if (signal) { if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true }); }
    const timer = timeoutMs ? setTimeout(abort, timeoutMs) : null;
    child.stdout.on('data', (d) => {
      const s = d.toString('utf8'); out += s;
      if (onLine) { buf += s; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line.trim()) onLine(line); } }
    });
    child.stderr.on('data', (d) => { err += d.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (code, sig) => { if (timer) clearTimeout(timer); signal?.removeEventListener?.('abort', abort); if (onLine && buf.trim()) onLine(buf); resolve({ code, signal: sig, out, err }); });
  });
}

/** Ask Armor whether this user may start a Little Brother run. Never throws for a refusal; reports it. */
export async function littleBrotherAccess({ env = process.env, locate = locateLbHost } = {}) {
  let host;
  try { host = locate({ env }); } catch (e) { return { allowed: false, state: 'armor-unavailable', code: e.code ?? 'ARMOR_LOAD_FAILED', reason: e.detail ?? e.message }; }
  const d = await runCli(host, ['describe'], { env, timeoutMs: 20_000 });
  let desc = null; try { desc = JSON.parse(d.out.trim().split('\n').at(-1)); } catch { /* below */ }
  if (desc?.interface !== LB_INTERFACE) return { allowed: false, state: 'armor-incompatible', code: 'ARMOR_INCOMPATIBLE', reason: `installed Armor ${host.version} offers ${desc?.interface ?? 'no Little Brother interface'}, Kingmaker needs ${LB_INTERFACE}` };
  const r = await runCli(host, ['access', '--identity-dir', armorIdentityDir(env)], { env, timeoutMs: 20_000 });
  let a = null; try { a = JSON.parse(r.out.trim().split('\n').at(-1)); } catch { /* below */ }
  if (!a || typeof a.allowed !== 'boolean') return { allowed: false, state: 'unavailable', code: 'LB_ACCESS_UNREADABLE', reason: (r.err || r.out).slice(0, 300) };
  return { ...a, allowed: a.allowed === true && r.code === 0, armorVersion: host.version };
}

/** Map one Armor LB event to what Kingmaker's tool panel shows. Counts only — the panel never invents a percentage. */
export function lbEventToPanel(e) {
  if (!e || e.schema !== LB_EVENTS) return null;
  switch (e.type) {
    case 'start': return { phase: 'started', steps: { done: 0, total: e.stepsTotal } };
    case 'progress': return { phase: e.phase, steps: { done: e.stepsCompleted ?? 0, total: e.stepsTotal }, ...(e.counts ? { tool: e.counts } : {}), findings: e.findingsSoFar ?? null };
    case 'output': return { phase: 'output', line: `${e.tool}: ${e.line}` };
    case 'finding': return { phase: 'finding', finding: e.finding };
    case 'error': return { phase: 'error', error: `${e.stage}: ${e.code} — ${e.message}` };
    case 'done': return { phase: 'done', status: e.status, steps: { done: e.stepsCompleted, total: e.stepsTotal }, findings: e.findings };
    default: return null;
  }
}

/** Run an assessment in Armor's process. `scopeId` must name a scope the USER approved in Armor. */
export async function runLittleBrother({ scopeId, plan, onEvent = () => {}, signal = null, env = process.env, locate = locateLbHost } = {}) {
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(String(scopeId ?? ''))) throw new Error('LB_SCOPE_ID_REQUIRED');
  let host;
  try { host = locate({ env }); } catch (e) { if (e instanceof ArmorUnavailableError) throw e; throw new ArmorUnavailableError('ARMOR_LOAD_FAILED', e.message); }
  const { writeFileSync, mkdtempSync, rmSync } = await import('node:fs'); const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'km-lb-plan-')); const planFile = join(dir, 'plan.json');
  writeFileSync(planFile, JSON.stringify(plan), { mode: 0o600 });
  const events = [];
  try {
    const r = await runCli(host, ['run', '--identity-dir', armorIdentityDir(env), '--scope-id', scopeId, '--plan', planFile], {
      env, signal, onLine: (line) => { let e; try { e = JSON.parse(line); } catch { return; } if (e?.schema !== LB_EVENTS) return; events.push(e); onEvent(e, lbEventToPanel(e)); },
    });
    const done = events.findLast?.((e) => e.type === 'done') ?? [...events].reverse().find((e) => e.type === 'done') ?? null;
    return { outcome: EXIT[r.code] ?? (r.signal ? 'cancelled' : 'failed'), exitCode: r.code, done, events, armorVersion: host.version, stderr: r.err.slice(-2000) };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
