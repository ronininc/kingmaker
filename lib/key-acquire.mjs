// GUIDED KEY ACQUISITION — for the free APIs Kingmaker's lanes use and this Mac has no key for.
//
// Operator (2026-10-08): "automate key input via copy paste with the folder they need to be pasted into already
// selected so the only thing left is to paste the actual key, and I only have to do it once per key per vault install".
//
//   CATALOG   The engine's free-tier API catalog (GET /api/key-handoff/free-tier, owner console): provider, free tier,
//             signup and key pages, the key's shape, and whether the vault already has a key for it.
//   ONE KEY   "get me a Groq key" → read back (free tier, what it powers, what is his) → on his yes: the provider's
//             key page opens in his VISIBLE Chrome (Apple events, evidence.mjs; never `open -a`), the steps are said,
//             and a native hidden paste box for exactly that provider opens beside it. Pasting and pressing Save IS
//             his act: the bytes are shape-checked for that provider and sealed through the engine's vault path
//             (/api/key-handoff/console/import, one receipt), then a read-only probe says whether the key works.
//             Cancel stores nothing.
//   ALL KEYS  "set up my keys" → the catalog's gaps one provider at a time (Save / Skip / Stop in each box).
//   SAVE IT   The voice alternative: "save the Groq key" → read back → on his spoken yes the clipboard is read ONCE,
//             shape-checked and sealed the same way. Nothing else is touched (the clipboard is left as it is).
//   ONCE      A provider whose key the vault already holds is skipped ("already have it"): the vault lives outside
//             every app bundle (the engine's secure root, ~/.solomon-secure), so rebuilding or reinstalling Ghost keeps it.
//
// NEVER: signing up, accepting terms, typing a password, passing a CAPTCHA or bot check, clicking on the provider's
// page, or a key value in a log, a print, a spoken line, a return value or an error. Values live in Buffers that are
// zero-filled after use; the osascript dialog's answer comes back as bytes, never decoded.

import { execFile } from 'node:child_process';
import { ownerCall } from './client.mjs';
import { importBody } from './device-keys.mjs';
import { openDesktopWall } from './evidence.mjs';

/** The engine's catalog, with what the vault already holds. → { ok, providers } | { ok: false, reason }. */
export async function freeCatalog({ port, nonce, fetchImpl }) {
  const r = await ownerCall(port, '/api/key-handoff/free-tier', { nonce, timeoutMs: 15_000, ...(fetchImpl ? { fetchImpl } : {}) }).catch((e) => ({ ok: false, status: 0, json: { error: String(e?.message ?? e) } }));
  if (r.status === 404) return { ok: false, reason: "This Kingmaker build has no free-tier key catalog yet (it comes with the engine's device capability scan)." };
  if (!r.ok || !Array.isArray(r.json?.data?.providers)) return { ok: false, reason: `The engine did not list it (${r.json?.error ?? `HTTP ${r.status}`}).` };
  return { ok: true, providers: r.json.data.providers };
}

export const catalogGaps = (providers) => (providers ?? []).filter((p) => !p.stored);

/** Pure: the catalog provider a few words name ("groq", "Google Gemini", "hugging face", "nim"). */
export function matchCatalog(providers, words) {
  const w = String(words ?? '').toLowerCase().replace(/\b(?:my|the|a|an|api|key|token|free)\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
  if (!w) return null;
  const sq = w.replace(/\s+/g, '');
  const list = providers ?? [];
  return list.find((p) => p.id === sq || p.label.toLowerCase().replace(/[^a-z0-9]/g, '') === sq)
    ?? list.find((p) => p.label.toLowerCase().split(/[^a-z0-9]+/).filter((x) => x.length >= 3).some((x) => w.split(' ').includes(x)))
    ?? list.find((p) => (sq === 'nim' && p.id === 'nvidia') || (sq === 'google' && p.id === 'gemini') || (sq === 'kimi' && p.id === 'ollama') || (sq === 'hf' && p.id === 'huggingface'))
    ?? null;
}

const CHARSETS = {
  base62: (b) => (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a),
  'base62-dash': (b) => CHARSETS.base62(b) || b === 0x2d || b === 0x5f,
  base64url: (b) => CHARSETS.base62(b) || b === 0x2d || b === 0x5f,
  printable: (b) => b > 0x20 && b < 0x7f && b !== 0x22 && b !== 0x27 && b !== 0x5c,
};

/** Pure: is this the provider's key shape (the engine's catalog rule, checked here first, on the bytes)? */
export function matchesShape(shape, bytes) {
  if (!shape || !bytes || bytes.length < shape.minLength || bytes.length > shape.maxLength) return false;
  if (bytes.every((b) => b >= 0x30 && b <= 0x39)) return false; // digits only: a number (a card), never a key
  const prefix = shape.prefix ? Buffer.from(shape.prefix, 'utf8') : null;
  if (prefix && !bytes.subarray(0, prefix.length).equals(prefix)) return false;
  const ok = CHARSETS[shape.charset] ?? CHARSETS.printable;
  for (const b of bytes.subarray(prefix ? prefix.length : 0)) if (!ok(b)) return false;
  return true;
}

/** Pure: bytes without leading/trailing whitespace or line breaks (a view; zero-filling the original clears it). */
export function trimKeyBytes(bytes) {
  let s = 0; let e = bytes.length;
  const ws = (b) => b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d;
  while (s < e && ws(bytes[s])) s += 1;
  while (e > s && ws(bytes[e - 1])) e -= 1;
  return bytes.subarray(s, e);
}

// ── The paste box (a native macOS dialog with a hidden answer) ──────────────────────────────────────────────

/** argv: label, mode ('one' | 'batch'). Prints "<button>\n<answer>" (answer only on Save) or "TIMEOUT\n". */
export const PASTE_DIALOG_SCRIPT = `on run argv
  set label to item 1 of argv
  set mode to item 2 of argv
  if mode is "batch" then
    set btns to {"Stop", "Skip", "Save"}
    set cancelBtn to "Stop"
  else
    set btns to {"Cancel", "Save"}
    set cancelBtn to "Cancel"
  end if
  activate
  set r to display dialog "Paste your " & label & " API key here. It stays hidden and goes only into Kingmaker's vault." default answer "" with hidden answer with title "Kingmaker — " & label & " key" buttons btns default button "Save" cancel button cancelBtn with icon note giving up after 900
  if gave up of r then return "TIMEOUT" & linefeed
  if button returned of r is "Save" then return "Save" & linefeed & (text returned of r)
  return (button returned of r) & linefeed
end run`;

const execBytes = (file, args, timeoutMs = 960_000) => new Promise((resolve) => {
  execFile(file, args, { encoding: 'buffer', timeout: timeoutMs, maxBuffer: 64 * 1024 }, (error, stdout) => {
    resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.alloc(0) });
  });
});

/** Pure: the dialog's output bytes → { action: 'save', bytes } | { action: 'skip' | 'stop' | 'cancel' | 'timeout' }. */
export function parseDialogOutput(stdout, code = 0) {
  if (code !== 0) return { action: 'cancel' }; // Cancel / Stop is AppleScript's error -128
  const nl = stdout.indexOf(0x0a);
  const button = (nl < 0 ? stdout : stdout.subarray(0, nl)).toString('ascii').trim();
  if (button === 'Save') return { action: 'save', bytes: Buffer.from(trimKeyBytes(stdout.subarray(nl + 1))) };
  if (button === 'Skip') return { action: 'skip' };
  if (button === 'TIMEOUT') return { action: 'timeout' };
  return { action: 'cancel' };
}

/** Open the paste box for one provider. In batch mode Stop ends the walk (as Cancel). */
export async function promptPaste(label, { batch = false, exec = execBytes } = {}) {
  const r = await exec('/usr/bin/osascript', ['-e', PASTE_DIALOG_SCRIPT, String(label).replace(/[^\p{L}\p{N} .()-]/gu, '').slice(0, 40), batch ? 'batch' : 'one']);
  try {
    const parsed = parseDialogOutput(r.stdout, r.code);
    return batch && parsed.action === 'cancel' ? { action: 'stop' } : parsed;
  } finally { r.stdout.fill(0); }
}

/** The clipboard, read once, as bytes (trimmed copy; the caller zero-fills it). Null when empty or unreadable. */
export async function readClipboardOnce({ exec = execBytes } = {}) {
  const r = await exec('/usr/bin/pbpaste', [], 10_000);
  try {
    if (r.code !== 0) return null;
    const v = trimKeyBytes(r.stdout);
    return v.length ? Buffer.from(v) : null;
  } finally { r.stdout.fill(0); }
}

// ── Storing one key ──────────────────────────────────────────────────────────────────────────────────────

/**
 * Seal one key for a catalog provider through the engine's vault path, with its read-only probe. The bytes are checked
 * against the provider's shape first and zero-filled by the caller. → { ok, receiptId, probe, reason }.
 */
export async function storeProviderKey({ port, nonce, provider, bytes, source, fetchImpl, log = () => {} }) {
  if (!matchesShape(provider.shape, bytes)) return { ok: false, reason: 'NOT_THIS_PROVIDERS_KEY_SHAPE' };
  let body = null;
  let r;
  try {
    body = importBody([{ envName: provider.envName, provider: provider.id, source, secret: bytes }], { probe: true });
    r = await ownerCall(port, '/api/key-handoff/console/import', { nonce, method: 'POST', rawBody: body, timeoutMs: 30_000, ...(fetchImpl ? { fetchImpl } : {}) })
      .catch((e) => ({ ok: false, status: 0, json: { error: String(e?.message ?? e).slice(0, 80) } }));
  } finally { body?.fill(0); }
  const d = r.json?.data ?? {};
  const ok = r.ok && (d.imported ?? []).length === 1;
  log('key_acquire_store', { provider: provider.id, ok, receiptId: d.receiptId ?? null, probe: d.probes?.[0]?.state ?? null, refused: d.refused?.[0]?.reason ?? null });
  return { ok, receiptId: d.receiptId ?? null, probe: d.probes?.[0] ?? null, reason: ok ? null : (d.refused?.[0]?.reason ?? r.json?.error ?? `HTTP ${r.status}`) };
}

/** Pure: the line after a store (never a value). */
export function storedLine(provider, r) {
  if (!r.ok) {
    const why = { NOT_THIS_PROVIDERS_KEY_SHAPE: `that isn't a ${provider.label} key`, NOT_A_KEY: 'that isn\'t a key', PRIVATE_KEY_REFUSED: 'that is a private key, not an API key', PAYMENT_CARD_REFUSED: 'that looks like a card number', SEED_PHRASE_REFUSED: 'that looks like a recovery phrase' }[r.reason] ?? `the engine refused it (${r.reason})`;
    return `Nothing stored: ${why}.`;
  }
  const probe = r.probe?.state === 'LIVE' ? ` I checked it: ${provider.label} accepted it, so ${provider.lane} is live.`
    : r.probe?.state === 'REJECTED' ? ` But ${provider.label} rejected it just now; it stays sealed, and you can paste a new one to replace it.`
      : r.probe?.state === 'UNREACHABLE' ? ` I couldn't reach ${provider.label} to check it; it's used on the next request.`
        : ` ${provider.label} has no read-only check, so it's proven on the next request.`;
  return `Sealed your ${provider.label} key in the vault${r.receiptId ? ` (receipt ${r.receiptId})` : ''}.${probe}`;
}

/** Pure: the read-back before opening a provider's page and paste box. */
export function acquireReadBack(p) {
  return `${p.label}: ${p.freeTier}. It powers ${p.lane}. I'll open its key page in Chrome and a hidden paste box for it. Signing up, the terms, any check and your password are yours; I don't touch that page. Say yes to open them.`;
}

/** Pure: the read-back before the batch. */
export function setupReadBack(gaps) {
  if (!gaps.length) return null;
  return `${gaps.length} free ${gaps.length === 1 ? 'API' : 'APIs'} Kingmaker can use ${gaps.length === 1 ? 'has' : 'have'} no key yet: ${gaps.map((p) => p.label).join(', ')}. I'll go one at a time: its key page in Chrome and a hidden paste box. Save stores it, Skip moves on, Stop ends. Signing up and passwords are yours. Say yes to start.`;
}

/**
 * One provider: page in his visible Chrome, the steps said, the paste box; Save stores (the box is the consent).
 * → { action, stored, result }.
 */
export async function acquireKey(provider, { port, nonce, say = async () => {}, out = () => {}, open = openDesktopWall, prompt = promptPaste, batch = false, fetchImpl, log = () => {} }) {
  const wall = await open([{ kind: 'url', target: provider.keyPageUrl }], { chromeOnly: true, log }).catch(() => null);
  const where = wall?.where === 'chrome' ? `The ${provider.label} key page is open in Chrome.` : `Open ${provider.keyPageUrl} in Chrome.`;
  out(`  ↳ ${provider.label}: ${provider.keyPageUrl}  (signup: ${provider.signupUrl})`);
  void say(`${where} ${provider.steps} Then paste it in the Kingmaker box and press Save.`);
  const answer = await prompt(provider.label, { batch });
  if (answer.action !== 'save') {
    log('key_acquire_prompt', { provider: provider.id, action: answer.action });
    return { action: answer.action, stored: false };
  }
  try {
    if (!answer.bytes?.length) return { action: 'empty', stored: false };
    const result = await storeProviderKey({ port, nonce, provider, bytes: answer.bytes, source: 'paste', fetchImpl, log });
    await say(storedLine(provider, result));
    return { action: 'save', stored: result.ok, result };
  } finally { answer.bytes?.fill(0); }
}

/** The batch: every gap in turn, Skip moves on, Stop (or a closed box) ends it. → { stored, skipped, stopped }. */
export async function setupKeys(gaps, deps) {
  const summary = { stored: [], skipped: [], stopped: false };
  for (const p of gaps) {
    const r = await acquireKey(p, { ...deps, batch: true });
    if (r.stored) summary.stored.push(p.id);
    else if (r.action === 'stop' || r.action === 'cancel' || r.action === 'timeout') { summary.stopped = true; break; }
    else summary.skipped.push(p.id);
  }
  return summary;
}

/** "save it": the clipboard, once, sealed as that provider's key (the caller has his spoken yes). */
export async function saveFromClipboard(provider, { port, nonce, read = readClipboardOnce, fetchImpl, log = () => {} }) {
  const bytes = await read();
  if (!bytes) return { ok: false, reason: 'CLIPBOARD_EMPTY' };
  try {
    return await storeProviderKey({ port, nonce, provider, bytes, source: 'clipboard', fetchImpl, log });
  } finally { bytes.fill(0); }
}
