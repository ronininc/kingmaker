// Ronin Inc office dock for one local Kingmaker profile.
//
// The credential is never accepted on argv and never printed. It comes from the
// process environment or macOS Keychain. A Ronin profile uses its own token,
// pairing id, device id, runtime home and port; it cannot impersonate Orosolu.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { runBackgroundCommand } from './core.mjs';

const RONIN_CRM = 'https://www.ronininc.org';
const PROFILE_FILE = 'ronin-desk.json';

const sleep = (ms, signal) => new Promise((resolve) => {
  if (signal?.aborted) return resolve();
  const timer = setTimeout(done, ms);
  function done() { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); }
  signal?.addEventListener('abort', done, { once: true });
});

export function roninDeskConfigPath(paths) { return join(paths.state, PROFILE_FILE); }

export function readRoninDeskConfig(paths) {
  try {
    const value = JSON.parse(readFileSync(roninDeskConfigPath(paths), 'utf8'));
    if (value?.schema !== 1 || value?.crm !== 'ronininc') return { enabled: false, crm: RONIN_CRM, profile: 'ronininc' };
    return { enabled: value.enabled === true, crm: RONIN_CRM, profile: 'ronininc' };
  } catch { return { enabled: false, crm: RONIN_CRM, profile: 'ronininc' }; }
}

export function setRoninDeskEnabled(paths, enabled) {
  mkdirSync(paths.state, { recursive: true, mode: 0o700 });
  chmodSync(paths.state, 0o700);
  const path = roninDeskConfigPath(paths);
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ schema: 1, crm: 'ronininc', enabled: enabled === true }, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
  return readRoninDeskConfig(paths);
}

export function parseMcpEnvelope(raw) {
  const text = String(raw || '').trim();
  let envelope = null;
  try { envelope = JSON.parse(text); } catch {
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      try { envelope = JSON.parse(line.slice(5).trim()); } catch { /* another SSE line may be the result */ }
    }
  }
  if (!envelope) throw new Error('The CRM returned an unreadable MCP response.');
  if (envelope.error) throw new Error(String(envelope.error.message || 'MCP request failed.'));
  const content = envelope.result?.content;
  const item = Array.isArray(content) ? content.find((entry) => entry?.type === 'text') : null;
  const value = String(item?.text || '');
  if (envelope.result?.isError) throw new Error(value || 'The CRM refused the MCP tool call.');
  if (!value) return {};
  try { return JSON.parse(value); } catch { return { note: value }; }
}

/** One tools/call on the CRM's /mcp/desk with a desk token. The token is a header only; it is never logged. */
export async function callRoninDesk({ crm = RONIN_CRM, token, name, input = {}, id = 1, fetchImpl = fetch }) {
  const response = await fetchImpl(`${crm}/mcp/desk`, {
    method: 'POST', signal: AbortSignal.timeout(15_000),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: input } }),
  });
  const body = await response.text();
  if (!response.ok) throw Object.assign(new Error(`Ronin desk HTTP ${response.status}.`), { status: response.status });
  return parseMcpEnvelope(body);
}

/** Seeker addresses a desk: leave a question on it with the Kingmaker desk's own key. */
export async function askRoninDesk({ desk, question, context = '', env = process.env, run, fetchImpl } = {}) {
  const token = storedRoninDeskToken(env, run);
  if (!token) throw new Error('No Ronin desk credential is installed in Keychain (ronin-crm-prod / KINGMAKER_DESK_TOKEN).');
  // The order carries the context the job needs (the desk starts a fresh session per order), capped at the CRM's 6000.
  const ctx = String(context || '').trim().slice(0, 6000);
  return callRoninDesk({ token, name: 'desk_ask', input: { desk: String(desk || '').trim(), question: String(question || '').trim(), ...(ctx ? { context: ctx } : {}) }, fetchImpl });
}

/** The answers other desks gave to the Kingmaker desk's questions, newest first. */
export async function roninDeskReplies({ since = 0, env = process.env, run, fetchImpl } = {}) {
  const token = storedRoninDeskToken(env, run);
  if (!token) throw new Error('No Ronin desk credential is installed in Keychain (ronin-crm-prod / KINGMAKER_DESK_TOKEN).');
  return callRoninDesk({ token, name: 'desk_replies', input: since ? { since: Number(since) } : {}, fetchImpl });
}

export class DeskMismatchError extends Error {
  constructor(expected, actual) { super(`The key for the ${expected} desk belongs to the ${actual || 'unknown'} desk; not hosting it. Save the right key: kingmaker office ronin key ${expected}`); this.name = 'DeskMismatchError'; }
}

export function storedRoninDeskToken(env = process.env, run = execFileSync) {
  if (String(env.RONIN_DESK_TOKEN || '').trim()) return String(env.RONIN_DESK_TOKEN).trim();
  try {
    return run('security', ['find-generic-password', '-s', env.RONIN_DESK_KEYCHAIN_SERVICE || 'ronin-crm-prod', '-a', env.RONIN_DESK_KEYCHAIN_ACCOUNT || 'KINGMAKER_DESK_TOKEN', '-w'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch { return ''; }
}

function hostFacts(run = execFileSync) {
  let power = 'unknown'; let thermal = 'unknown';
  try { power = /AC Power/i.test(run('/usr/bin/pmset', ['-g', 'batt'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })) ? 'ac' : 'battery'; } catch { /* non-macOS */ }
  try {
    const value = run('/usr/bin/pmset', ['-g', 'therm'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    thermal = /CPU_Speed_Limit\s*=\s*100/.test(value) ? 'nominal' : /CPU_Speed_Limit\s*=\s*([0-4]\d)/.test(value) ? 'serious' : 'fair';
  } catch { /* unavailable */ }
  return { power, thermal };
}

export function roninDeskIdentity({ env = process.env, token, host = hostname() } = {}) {
  const crm = String(env.RONIN_CRM_URL || RONIN_CRM).replace(/\/$/, '');
  if (crm !== RONIN_CRM) throw new Error('The Ronin desk profile may connect only to https://www.ronininc.org.');
  return {
    crm,
    pairingId: String(env.RONIN_PAIRING_ID || `ronin-${createHash('sha256').update(`${crm}:${token}`).digest('hex').slice(0, 20)}`),
    deviceId: String(env.RONIN_DEVICE_ID || createHash('sha256').update(`ronin:${host}`).digest('hex').slice(0, 24)),
  };
}

export async function runRoninDeskDock(args = [], options = {}) {
  const env = options.env || process.env;
  const log = options.log || ((...parts) => console.log(new Date().toISOString(), ...parts));
  const token = options.token || storedRoninDeskToken(env, options.run);
  if (!token) throw new Error('No Ronin desk credential is installed in Keychain (ronin-crm-prod / KINGMAKER_DESK_TOKEN).');
  const identity = roninDeskIdentity({ env, token, host: options.hostname || hostname() });
  const solomon = String(env.SOLOMON_URL || 'http://127.0.0.1:3001').replace(/\/$/, '');
  const check = args.includes('--check');
  const signal = options.signal;
  const intervalMs = Math.max(10_000, Number(env.RONIN_HEARTBEAT_MS) || 30_000);
  const activeBrain = String(env.KINGMAKER_BRAIN || 'kingmaker').trim().toLowerCase();
  const availableBrains = [...new Set(String(env.KINGMAKER_BRAINS || activeBrain).split(',').map((v) => v.trim().toLowerCase()).filter(Boolean))];
  let paused = false; let rpcId = 0; let stopped = false;

  const mcp = (name, input = {}) => callRoninDesk({ crm: identity.crm, token, name, input, id: ++rpcId, fetchImpl: options.fetchImpl });
  // A desk hosted for a brain (grok-bot): ready() says whether that brain can run here; answer() turns one question
  // into plain text. Without them this is the Kingmaker desk: heartbeat and owner commands only.
  const ready = options.ready || (async () => ({ ok: true }));
  const answer = options.answer || null;
  const tried = new Set();
  // One slow /api/health (a model load or a busy event loop) is not an outage. Solomon is reported down only after
  // consecutive failed probes, so a seconds-long stall does not raise a desk fire that calls the owner.
  const probes = Math.max(1, Math.min(5, Number(env.RONIN_SOLOMON_PROBES) || 3));
  const probeGapMs = Math.max(0, Number(options.probeGapMs ?? env.RONIN_SOLOMON_PROBE_GAP_MS ?? 2000));
  const solomonUp = async () => {
    for (let attempt = 1; attempt <= probes; attempt++) {
      try { if ((await fetch(`${solomon}/api/health`, { signal: AbortSignal.timeout(3000) })).ok) return true; } catch { /* probe again */ }
      if (attempt < probes && !signal?.aborted) await sleep(probeGapMs, signal);
    }
    return false;
  };
  const heartbeat = async () => {
    const solomonOk = await solomonUp();
    const brain = solomonOk ? await ready() : { ok: false };
    const online = solomonOk && brain.ok;
    const state = online ? String(env.KINGMAKER_STATE || 'idle') : 'error';
    const facts = hostFacts(options.run);
    const result = await mcp('desk_heartbeat', {
      crm: 'ronininc', pairing_id: identity.pairingId, device_id: identity.deviceId,
      state, workflow: paused ? 'Ronin CRM work paused by owner' : String(env.KINGMAKER_WORKFLOW || ''),
      ...facts, workers: online ? 1 : 0, error: online ? '' : !solomonOk ? `Solomon is not answering at ${solomon}` : String(brain.error || 'The brain is not ready.'), lease_s: 90,
    });
    if (result?.ok !== true || !Number(result?.lease_expires_at)) throw new Error(String(result?.error || 'Ronin desk heartbeat was not accepted.'));
    return result;
  };
  const ack = (id, status, detail) => mcp('desk_command_ack', { id, status, detail: String(detail || '').slice(0, 400) });
  const commands = async () => {
    const pending = await mcp('desk_commands');
    for (const command of pending.commands || []) {
      await ack(command.id, 'accepted', 'Received by the bound Ronin Kingmaker profile.');
      let ok = true; let detail = '';
      if (command.command === 'status') detail = JSON.stringify({ online: await solomonUp(), active_brain: activeBrain, available_brains: availableBrains });
      else if (command.command === 'pause') { paused = true; detail = 'Ronin CRM work paused; the local Kingmaker remains available.'; }
      else if (command.command === 'resume') { paused = false; detail = 'Ronin CRM work resumed.'; }
      else if (command.command === 'disable_host') {
        const result = await runBackgroundCommand('disable'); ok = result.ok; detail = result.ok ? 'Headless Host Mode disabled.' : (result.message || result.status);
        if (ok) stopped = true;
      } else { ok = false; detail = 'Unsupported command.'; }
      await ack(command.id, ok ? 'completed' : 'failed', detail);
    }
  };

  // Questions on this desk (Seeker's desk_ask) answered by the hosted brain. Each question is tried once per run, so
  // a brain that fails does not burn a turn every heartbeat; the question stays open on the floor for the owner.
  const answerInbox = async () => {
    if (!answer || paused || !(await ready()).ok) return;
    const inbox = await mcp('desk_inbox');
    for (const ask of inbox.asks || []) {
      if (ask.type !== 'question' || tried.has(ask.id)) continue;
      tried.add(ask.id);
      const reply = await answer(ask).catch((error) => ({ ok: false, error: error.message }));
      if (reply?.ok && String(reply.text || '').trim()) await mcp('desk_answer', { ask_id: ask.id, answer: String(reply.text).trim().slice(0, 4000) });
      else log(`Ronin desk could not answer ${String(ask.id).slice(0, 8)}… (${reply?.error || 'no text'}); left open.`);
    }
  };

  // A hosted desk must be the desk its key belongs to: a key filed under the wrong Keychain account (grok-bot's slot
  // holding the accountant's key) would otherwise put this brain at someone else's desk. Checked before anything else.
  if (options.expectDesk) {
    const bound = await mcp('desk_status');
    if (bound?.slug !== options.expectDesk) throw new DeskMismatchError(options.expectDesk, bound?.slug);
  }

  let leaseExpiresAt = null;
  do {
    if (signal?.aborted) break;
    leaseExpiresAt = (await heartbeat()).lease_expires_at;
    await commands();
    await answerInbox();
    if (check || stopped) break;
    await sleep(intervalMs, signal);
  } while (!stopped && !signal?.aborted);
  log(`Ronin desk ${check ? 'check passed' : 'dock stopped'}; profile ${identity.pairingId.slice(0, 12)}…; secrets were not printed.`);
  return { ok: true, pairingId: identity.pairingId, deviceId: identity.deviceId, leaseExpiresAt };
}

/** Keep the installed host docked through a transient network/TLS/CRM outage.
 * A failed heartbeat has already expired server-side within the lease window;
 * retrying only reasserts the same bound pairing and cannot broaden authority. */
export async function maintainRoninDeskDock(options = {}) {
  const signal = options.signal;
  const log = options.log || ((...parts) => console.log(new Date().toISOString(), ...parts));
  const dock = options.dock || runRoninDeskDock;
  const retryDelays = Array.isArray(options.retryDelays) && options.retryDelays.length ? options.retryDelays : [5_000, 15_000, 30_000, 60_000];
  const forwarded = { ...options };
  delete forwarded.dock;
  delete forwarded.retryDelays;
  delete forwarded.onUnauthorized;
  let attempt = 0;
  while (!signal?.aborted) {
    try { return await dock([], forwarded); }
    catch (error) {
      if (signal?.aborted) break;
      if (error instanceof DeskMismatchError) { log(error.message); return { ok: false, mismatch: true }; } // retrying can't fix a wrong key
      // 401: the key was revoked on the site (a lost Mac, re-pair) or expired. Retrying can't fix that either; the
      // caller asks the owner to pair this Mac again (lib/ronin-pairing.mjs), which needs the owner's tap.
      if (error?.status === 401) { log('Ronin desk key was refused (revoked or expired); this Mac will ask to pair again.'); await options.onUnauthorized?.(); return { ok: false, unauthorized: true }; }
      const delay = retryDelays[Math.min(attempt, retryDelays.length - 1)];
      attempt += 1;
      log(`Ronin desk heartbeat failed (${error.message}); retrying in ${Math.ceil(delay / 1000)}s.`);
      await sleep(delay, signal);
    }
  }
  return { ok: true, stopped: true };
}
