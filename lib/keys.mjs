// API KEYS FROM THE TERMINAL (operator 2026-10-07: "it literally has terminal, it should just pull the page and
// explain the process to the user which they then do, just like you and I, and these keys get stored in the vault
// automatically when saved, for each user. Remember [Kingmaker is] local first.")
//
//   `:key github` typed at the owner console, "connect my GitHub key" said or typed to it, or
//   `kingmaker key github` against a headless engine that left its owner secret for this user:
//     1. the provider's own key page (the engine's key-handoff catalog, never a URL made up here) opens in Chrome;
//     2. the steps are printed and spoken;
//     3. the key is read from a HIDDEN prompt (no echo), as bytes;
//     4. it goes to the engine's governed vault path (/api/key-handoff/console/seal, owner console only) and the
//        bytes are zero-filled; "Saved your <Provider> key to the vault" is said only after the engine confirms;
//     5. connecting it and running its live test waits for the owner's typed yes.
//
// The key is never logged, printed, echoed or spoken, never in argv, a child's env or a URL, and never becomes a
// JS string here: it lives in one Buffer that is zero-filled after the call (best effort: the HTTP stack may
// copy it while sending).

import { spawn } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ownerCall } from './client.mjs';

export const CHROME_APP = 'Google Chrome';
const MAX_KEY_BYTES = 4096;
const SEAL_TRIES = 3;
/** Where a headless engine that minted its own owner secret leaves it for its local owner (its
 *  OWNER_NONCE_FILE). Kingmaker never writes one: its console keeps the nonce in memory. */
export const OWNER_NONCE_FILE = 'owner-console.nonce';

/**
 * The owner secret a headless engine left for this user, or why it cannot be used. Trusted only as a plain file
 * owned by this user and closed to everyone else (0600), like the launcher wrote it.
 */
export function readOwnerNonce(runtimeHome, { lstat = lstatSync, read = (p) => readFileSync(p, 'utf8'), uid = process.getuid?.() } = {}) {
  const path = join(String(runtimeHome ?? ''), OWNER_NONCE_FILE);
  let st;
  try { st = lstat(path); } catch { return { ok: false, reason: `No owner console secret in ${runtimeHome}: no headless engine minted one there.` }; }
  if (!st.isFile()) return { ok: false, reason: `${path} is not a plain file, so it is not trusted.` };
  if ((st.mode & 0o077) !== 0) return { ok: false, reason: `${path} is open to other users (mode ${(st.mode & 0o777).toString(8)}), so it is not trusted.` };
  if (typeof uid === 'number' && st.uid !== uid) return { ok: false, reason: `${path} belongs to another user, so it is not trusted.` };
  let value = '';
  try { value = String(read(path)).trim(); } catch { return { ok: false, reason: `${path} could not be read.` }; }
  if (!/^[A-Za-z0-9]{32,256}$/.test(value)) return { ok: false, reason: `${path} does not hold an owner secret.` };
  return { ok: true, value, path };
}

/** `open <args>` → true when it started and exited 0. Only ever handed the catalog URL. */
function spawnOpen(args) {
  return new Promise((resolve) => {
    const child = spawn('/usr/bin/open', args, { stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('exit', (code) => resolve(code === 0));
  });
}

/** Open the key page in Google Chrome, else the default browser. → 'chrome' | 'browser' | null */
export async function openKeyPage(url, { launch = spawnOpen } = {}) {
  if (await launch(['-a', CHROME_APP, url])) return 'chrome';
  if (await launch([url])) return 'browser';
  return null;
}

/** Pure: an https page from the catalog, or null (anything else is never opened). */
export function safePageUrl(value) {
  try {
    const url = new URL(String(value ?? ''));
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

/** Pure: the provider a word names (id, label, or a word of the label: "github", "GitHub", "ronin crm", "crm"). */
export function matchProvider(providers, word) {
  const w = String(word ?? '').trim().toLowerCase().replace(/[\s_]+/g, '-');
  if (!w) return null;
  const list = Array.isArray(providers) ? providers : [];
  return list.find((p) => p.id === w)
    ?? list.find((p) => String(p.label ?? '').toLowerCase().replace(/\s+/g, '-') === w)
    ?? list.find((p) => String(p.label ?? '').toLowerCase().split(/\s+/).includes(w))
    ?? null;
}

/** Pure: the steps, as printed. */
export function keySteps(info, opened) {
  const where = opened === 'chrome' ? 'Chrome is open on' : opened === 'browser' ? 'Your browser is open on' : 'Open';
  return [
    `${where} the ${info.label} key page: ${info.keyPageUrl}  (sign in if it asks)`,
    String(info.guidance ?? '').trim() || `Create the ${info.keyNoun} and copy it.`,
    `Come back here and paste the ${info.keyNoun} at the prompt, then press Enter. Nothing shows while you paste. Ctrl-C cancels.`,
  ];
}

/** Pure: the steps, as spoken (short). */
export function spokenSteps(info) {
  return `I'm opening the ${info.label} key page in Chrome. ${String(info.guidance ?? '').trim()} Then paste it here; it won't show on screen.`;
}

/**
 * Read one line from a TTY without echo. Resolves a Buffer (the caller zero-fills it) or null on Ctrl-C/Ctrl-D.
 * Escape sequences (arrows, bracketed-paste markers) are dropped; control bytes never enter the value.
 */
export function readHidden({ input = process.stdin, output = process.stdout, prompt = '', maxBytes = MAX_KEY_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    if (!input.isTTY || typeof input.setRawMode !== 'function') { reject(new Error('NO_TTY')); return; }
    const buf = Buffer.alloc(maxBytes);
    let len = 0;
    let escape = false;
    const wasRaw = input.isRaw === true;
    output.write(prompt);
    input.setRawMode(true);
    const finish = (value) => {
      input.off('data', onData);
      try { input.setRawMode(wasRaw); } catch { /* closed */ }
      input.pause();
      output.write('\n');
      resolve(value);
    };
    function onData(chunk) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      for (let i = 0; i < bytes.length; i += 1) {
        const b = bytes[i];
        if (escape) { if (b >= 0x40 && b <= 0x7e && b !== 0x5b) escape = false; continue; }
        if (b === 0x1b) { escape = true; continue; }
        if (b === 0x0d || b === 0x0a) { const value = Buffer.from(buf.subarray(0, len)); buf.fill(0); bytes.fill(0); finish(value); return; }
        if (b === 0x03 || b === 0x04) { buf.fill(0); bytes.fill(0); finish(null); return; }
        if (b === 0x7f || b === 0x08) { if (len > 0) { len -= 1; buf[len] = 0; } continue; }
        if (b < 0x20) continue;
        if (len < maxBytes) { buf[len] = b; len += 1; }
      }
      bytes.fill(0);
    }
    input.on('data', onData);
    input.resume();
  });
}

/** Read one visible line (a y/n answer). '' on Ctrl-C/Ctrl-D or no TTY. */
export async function readAnswer({ input = process.stdin, output = process.stdout, prompt = '' } = {}) {
  output.write(prompt);
  const { createInterface } = await import('node:readline');
  return new Promise((resolve) => {
    const rl = createInterface({ input, output, terminal: false });
    let done = false;
    const end = (value) => { if (done) return; done = true; rl.close(); input.pause(); resolve(value); };
    rl.once('line', (line) => end(String(line).trim()));
    rl.once('close', () => end(''));
  });
}

/** Pure: the bytes without leading/trailing spaces or tabs (a view: zero-filling the original clears it too). */
export function trimBytes(bytes) {
  let start = 0;
  let end = bytes.length;
  while (start < end && (bytes[start] === 0x20 || bytes[start] === 0x09)) start += 1;
  while (end > start && (bytes[end - 1] === 0x20 || bytes[end - 1] === 0x09)) end -= 1;
  return bytes.subarray(start, end);
}

/** Pure: a key is printable ASCII with no space, quote or backslash (every provider's keys are). */
export function keyBytesUsable(bytes) {
  if (!bytes || bytes.length === 0) return false;
  for (const b of bytes) if (b <= 0x20 || b >= 0x7f || b === 0x22 || b === 0x5c) return false;
  return true;
}

/**
 * Pure: the /console/seal JSON body built around the key bytes, never via a string of the key. The handoff id
 * comes from the engine and is checked to be a plain id. The caller zero-fills the result after sending.
 */
export function sealBody(handoffId, keyBytes) {
  const id = String(handoffId ?? '');
  if (!/^[A-Za-z0-9_-]{6,80}$/.test(id)) throw new Error('BAD_HANDOFF_ID');
  if (!keyBytesUsable(keyBytes)) throw new Error('NOT_A_KEY_SHAPE');
  return Buffer.concat([Buffer.from(`{"handoffId":"${id}","secret":"`, 'utf8'), keyBytes, Buffer.from('"}', 'utf8')]);
}

/**
 * The whole flow. `handoff` (from a `key_handoff.console` event: a turn already started it) or `provider` (a word).
 * Every engine call is an owner call with `nonce`. Injectable: launch (the opener), out (print), speak, readSecret,
 * ask, fetchImpl, log (events only, never values). → { ok, reason?, last4? }
 */
export async function runKeyFlow({
  port, nonce, provider, handoff = null, conversationId = null,
  launch, out = (line) => process.stdout.write(`${line}\n`), speak = () => {}, readSecret = readHidden, ask = readAnswer,
  fetchImpl, log = () => {}, spokenAlready = false,
}) {
  const owner = (path, opts = {}) => ownerCall(port, path, { nonce, ...(fetchImpl ? { fetchImpl } : {}), ...opts });
  let info = null;
  let handoffId = null;
  if (handoff?.handoffId) {
    handoffId = String(handoff.handoffId);
    info = { id: handoff.provider, label: handoff.label, keyNoun: handoff.keyNoun, keyPageUrl: handoff.keyPageUrl, guidance: handoff.guidance };
  } else {
    const listed = await owner('/api/key-handoff/providers');
    if (!listed.ok) { out(`  ✗ The engine did not list key pages (${listed.json?.error ?? `HTTP ${listed.status}`}).`); return { ok: false, reason: listed.json?.error ?? 'PROVIDERS_UNAVAILABLE' }; }
    const providers = listed.json?.data?.providers ?? [];
    const match = matchProvider(providers, provider);
    if (!match) {
      out(`  I can take keys for: ${providers.map((p) => `${p.label} (${p.id})`).join(', ') || 'nothing yet'}.`);
      return { ok: false, reason: 'UNKNOWN_PROVIDER' };
    }
    const started = await owner('/api/key-handoff/start', { method: 'POST', body: { provider: match.id, ...(conversationId ? { conversationId } : {}) } });
    if (!started.ok || !started.json?.data?.id) { out(`  ✗ ${started.json?.spoken || started.json?.error || `HTTP ${started.status}`}`); return { ok: false, reason: started.json?.error ?? 'START_FAILED' }; }
    handoffId = started.json.data.id;
    info = { ...match, ...(started.json.data.providerInfo ?? {}) };
  }
  log('key_flow', { step: 'started', provider: info.id });
  const cancel = async (why) => {
    await owner(`/api/key-handoff/${encodeURIComponent(handoffId)}/cancel`, { method: 'POST', body: {} }).catch(() => null);
    out(`  ${why} Nothing was stored.`);
    log('key_flow', { step: 'cancelled', provider: info.id });
    return { ok: false, reason: 'CANCELLED' };
  };

  const url = safePageUrl(info.keyPageUrl);
  if (!url) return cancel(`The engine gave no usable ${info.label} key page.`);
  const opened = await openKeyPage(url, launch ? { launch } : {});
  for (const [i, line] of keySteps({ ...info, keyPageUrl: url }, opened).entries()) out(`  ${i + 1}. ${line}`);
  if (!spokenAlready) speak(spokenSteps(info));

  for (let attempt = 1; attempt <= SEAL_TRIES; attempt += 1) {
    let key = null;
    try { key = await readSecret({ prompt: `  Paste your ${info.keyNoun} (hidden): ` }); } catch (error) {
      return cancel(error?.message === 'NO_TTY' ? 'A key is typed at a terminal, and this one has none.' : 'The prompt closed.');
    }
    if (!key || key.length === 0) { key?.fill(0); return cancel('Cancelled.'); }
    let body = null;
    try { body = sealBody(handoffId, trimBytes(key)); } catch { body = null; }
    key.fill(0);
    if (!body) { out(`  That isn't a ${info.keyNoun} (keys have no spaces or quotes). Copy it again and paste it.`); continue; }
    let sealed;
    try { sealed = await owner('/api/key-handoff/console/seal', { method: 'POST', rawBody: body }); } finally { body.fill(0); }
    const data = sealed.json?.data ?? {};
    if (sealed.ok && data.state === 'SEALED_AWAITING_CONFIRM') {
      const last4 = typeof data.fingerprint?.last4 === 'string' ? data.fingerprint.last4 : null;
      const saved = `Saved your ${info.label} key to the vault.`;
      out(`  ✓ ${saved}${last4 ? ` (ending ${last4})` : ''}`);
      speak(saved);
      log('key_flow', { step: 'sealed', provider: info.id });
      await offerConnect({ owner, handoffId, info, ask, out, speak, log });
      return { ok: true, last4 };
    }
    if (sealed.json?.error === 'NOT_A_KEY') { out(`  That isn't a ${info.keyNoun}, so nothing was stored. Copy it again and paste it.`); continue; }
    out(`  ✗ Not saved: ${sealed.json?.error ?? `HTTP ${sealed.status}`}.`);
    log('key_flow', { step: 'refused', provider: info.id, error: String(sealed.json?.error ?? sealed.status).slice(0, 80) });
    return { ok: false, reason: sealed.json?.error ?? 'SEAL_FAILED' };
  }
  return cancel(`Three tries without a ${info.keyNoun}.`);
}

/**
 * KINGMAKER'S KEY FIELD (app/Kingmaker.swift): the bar's hidden paste field hands the key bytes to this console over its
 * stdin, and they go to the engine in ONE owner call, like the terminal prompt's: a CRM key to /console/crm-seal (sealed,
 * then live-checked), any other to /console/seal (connecting stays the owner's yes). The bytes are zero-filled here.
 * → { ok, spoken } (spoken never carries key material; last-4 at most).
 */
export async function sealFromKeyField({ port, nonce, handoff, keyBytes, fetchImpl, log = () => {} }) {
  const label = String(handoff?.label || 'that');
  let body = null;
  // A paste can carry a line break at either end (copied with the line): trimmed as a view, so the wipe below clears it.
  let start = 0; let end = keyBytes?.length ?? 0;
  while (start < end && [0x0a, 0x0d].includes(keyBytes[start])) start += 1;
  while (end > start && [0x0a, 0x0d].includes(keyBytes[end - 1])) end -= 1;
  try { body = sealBody(handoff?.handoffId, trimBytes(keyBytes.subarray(start, end))); } catch { body = null; } finally { keyBytes?.fill?.(0); }
  if (!body) return { ok: false, retry: true, spoken: `That isn't a ${handoff?.keyNoun || 'key'} (keys have no spaces or quotes). Copy it again and paste it.` };
  const path = handoff.crm ? '/api/key-handoff/console/crm-seal' : '/api/key-handoff/console/seal';
  let r = null;
  try { r = await ownerCall(port, path, { nonce, method: 'POST', rawBody: body, timeoutMs: 60_000, ...(fetchImpl ? { fetchImpl } : {}) }).catch(() => null); } finally { body.fill(0); }
  const data = r?.json?.data ?? {};
  const last4 = typeof data.fingerprint?.last4 === 'string' ? data.fingerprint.last4 : null;
  log('key_field', { provider: String(handoff.provider || '').slice(0, 40), ok: Boolean(r?.ok), state: data.state ?? null, error: r?.ok ? null : String(r?.json?.error ?? r?.status ?? 'no answer').slice(0, 80) });
  if (r?.ok && (data.state === 'CONNECTED' || data.state === 'CONNECT_FAILED' || data.state === 'SEALED_AWAITING_CONFIRM')) {
    return { ok: data.state !== 'CONNECT_FAILED', spoken: String(data.spoken || `Saved your ${label} key${last4 ? ` ending ${last4}` : ''}.`) };
  }
  // A provider key that isn't one leaves its handoff open (paste again); a CRM's one-shot handoff closes ("connect my CRM" again).
  if (r?.json?.error === 'NOT_A_KEY') return { ok: false, retry: !handoff.crm, spoken: handoff.crm ? 'That wasn\'t an API key, so nothing was stored. Say "connect my CRM" to try again.' : `That isn't a ${handoff.keyNoun || 'key'}, so nothing was stored. Copy it again and paste it.` };
  return { ok: false, spoken: `Not saved (${String(r?.json?.error ?? (r ? `HTTP ${r.status}` : 'the engine did not answer')).slice(0, 80)}). Nothing was stored.` };
}

/** Connecting and the live test are the owner's word: a typed y here. */
async function offerConnect({ owner, handoffId, info, ask, out, speak, log }) {
  const answer = String(await ask({ prompt: `  Connect ${info.label} and run a live test now? [y/N] ` }).catch(() => '')).trim().toLowerCase();
  const id = encodeURIComponent(handoffId);
  if (answer === 'y' || answer === 'yes') {
    const r = await owner(`/api/key-handoff/${id}/confirm`, { method: 'POST', body: { operatorConfirmed: true }, timeoutMs: 90_000 }).catch(() => null);
    const line = r?.json?.data?.spoken || (r?.ok ? `${info.label} is connected.` : `${info.label} did not connect (${r?.json?.error ?? 'no answer'}).`);
    out(`  ${r?.json?.data?.state === 'CONNECTED' ? '✓' : '·'} ${line}`);
    speak(line);
    log('key_flow', { step: 'connect', provider: info.id, state: r?.json?.data?.state ?? null });
    return;
  }
  const r = await owner(`/api/key-handoff/${id}/decline`, { method: 'POST', body: {} }).catch(() => null);
  out(`  ${r?.json?.data?.spoken || `The key stays sealed and ${info.label} stays off.`}`);
}
