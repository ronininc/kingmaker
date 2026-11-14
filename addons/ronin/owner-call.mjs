// Owner calls: any Ronin agent (claude, codex, grok, muse, kingmaker, the CRM scheduler) asks the CRM to phone the owner;
// this Mac places the call. Free only: a FaceTime Audio call from this Mac (signed into a SEPARATE Apple ID, because a
// Mac on the owner's own Apple ID cannot ring their own iPhone) to the ONE handle saved at setup. No Twilio, no paid API;
// lib/phone.mjs (Twilio) is not used here.
//
// The Worker side is the contract in docs/OWNER-CALL.md (GET /api/owner-call/pending, POST start | answered | missed |
// result on https://www.ronininc.org, bearer = the owner-call-transport token). Two kinds of call:
//   message         "This is <Caller>, for Ronin. <message>" then one spoken reply, transcribed. A reply is information
//                   only, never an approval of anything.
//   outbound_batch  "<ord>. <recipient>, by <channel>: <subject>." for each pending outgoing message (never a body),
//                   then "Say okay to send these N, or say no." One utterance; only "okay", "ok", "yes", "okay send
//                   them" or "yes send them" (case, punctuation and spacing aside) is an approval, and only before the
//                   approval deadline. Everything else sends nothing.
//
// Audio, with no custom native sidecar: FaceTime's microphone is set (by the owner, once) to "BlackHole 2ch" and its
// output to a Multi-Output device that includes "BlackHole 16ch". Kingmaker speaks into the call by playing its voice
// to BlackHole 2ch (Kokoro WAV through sox, or `say -a`), and hears the owner by recording BlackHole 16ch with sox and
// transcribing with the bundled whisper.cpp. "Connected" = FaceTime running audio input AND output at once
// (solomon-audio-activity, Core Audio process objects, macOS 14.2+).
//
// Safety: one call at a time; a request id is dialled at most once per Kingmaker session; an attempt whose outcome is
// uncertain is never retried; any error means no approval (nothing is sent) and the call is ended on every path. Off
// until `kingmaker owner-call setup` stores the handle and token and `kingmaker owner-call on` is run. Ronin only.
//
// Every Mac-specific step (open, osascript, sox, say, the audio-activity helper, whisper) is an injectable runner, so
// the whole flow is tested with stubs (test/owner-call.test.mjs). What only a live call can prove: docs/OWNER-CALL.md.

import { spawn as nodeSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { activeCrmLock, CRM_LOCKS } from './crm-lock.mjs';
import { createPhoneRunners } from './core.mjs';
import { runSecurity } from './core.mjs';
import { createSegmenter, isNonSpeech, SAMPLE_RATE, synthesizeKokoroWav, transcribe as whisperTranscribe } from './core.mjs';

export const OWNER_CALL_KEYCHAIN_SERVICE = 'ronin-crm-prod';
export const OWNER_CALL_TOKEN_ACCOUNT = 'KINGMAKER_OWNER_CALL_TOKEN';
export const OWNER_CALL_HANDLE_ACCOUNT = 'KINGMAKER_OWNER_CALL_HANDLE';
export const OWNER_CALL_BASE = CRM_LOCKS.ronininc.url;
export const OWNER_CALL_KINDS = Object.freeze(['message', 'outbound_batch']);
export const OWNER_CALL_CONFIG_FILE = 'owner-call.json';

export const POLL_INTERVAL_MS = 30_000;
export const CONNECT_TIMEOUT_MS = 45_000;
export const REPLY_MAX_MS = 20_000;
export const APPROVAL_MAX_MS = 8_000;
/** An approval must reach the Worker this long before the deadline, or it is reported ambiguous (nothing sent). */
export const DEADLINE_MARGIN_MS = 5_000;
export const TRANSCRIPT_MAX_BYTES = 4_000;

/** Which processes' duplex audio means "the FaceTime call is connected". avconferenced may carry FaceTime's audio. */
export const FACETIME_BUNDLES = Object.freeze(['com.apple.FaceTime', 'com.apple.avconferenced']);

export const DEFAULT_DEVICES = Object.freeze({ speak: 'BlackHole 2ch', hear: 'BlackHole 16ch', hearRemix: '1,2' });
export const DEFAULT_BUTTONS = Object.freeze({ call: 'Call', end: 'End' });

/** One voice per caller; same machinery for every agent, only the name and the voice differ. Configurable. */
export const DEFAULT_VOICES = Object.freeze({
  claude: Object.freeze({ name: 'Claude', kokoro: 'af_heart', say: 'Samantha' }),
  codex: Object.freeze({ name: 'Codex', kokoro: 'am_michael', say: 'Daniel' }),
  grok: Object.freeze({ name: 'Grok', kokoro: 'am_adam', say: 'Fred' }),
  muse: Object.freeze({ name: 'Muse', kokoro: 'af_nova', say: 'Karen' }),
  kingmaker: Object.freeze({ name: 'Kingmaker', kokoro: 'bm_george', say: 'Rishi' }),
  'ronin-crm': Object.freeze({ name: 'Ronin CRM', kokoro: 'bf_emma', say: 'Moira' }),
});
/** A caller not in the map still calls (no agent is ever refused); it gets this voice and its own name. */
export const FALLBACK_VOICE = Object.freeze({ kokoro: 'af_sky', say: 'Tessa' });

export const APPROVE_PHRASES = Object.freeze(['okay', 'ok', 'yes', 'okay send them', 'yes send them']);
const DENY_FIRST_WORDS = new Set(['no', 'nope', 'nah', 'dont', 'stop', 'cancel']);

const sleepFor = (ms, signal) => new Promise((resolve) => {
  if (signal?.aborted) return resolve();
  const timer = setTimeout(done, ms);
  function done() { clearTimeout(timer); signal?.removeEventListener?.('abort', done); resolve(); }
  signal?.addEventListener?.('abort', done, { once: true });
});

export class CallDropped extends Error { constructor() { super('The call ended.'); this.name = 'CallDropped'; } }
export class OwnerCallHttpError extends Error {
  constructor(status, code) { super(`Owner-call route answered HTTP ${status}${code ? ` (${code})` : ''}.`); this.name = 'OwnerCallHttpError'; this.status = status; this.code = code; }
}

// ── the handle: the only number or Apple ID this Mac will ever ring ──────────────────────────────────────────────

const PHONE_RX = /^\+[1-9]\d{7,14}$/;
const EMAIL_RX = /^[a-z0-9](?:[a-z0-9._%+-]{0,62}[a-z0-9_%+-])?@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/i;

/** Strict: an E.164 phone number or an email address, nothing else. → {kind, handle} | null. Pure. */
export function validHandle(value) {
  const s = String(value ?? '');
  if (s !== s.trim() || !s) return null;
  if (PHONE_RX.test(s)) return { kind: 'phone', handle: s };
  if (EMAIL_RX.test(s) && !s.includes('..')) return { kind: 'email', handle: s.toLowerCase() };
  return null;
}

/** What the owner typed at setup → a strict handle, or null. "(602) 555-0100" → "+16025550100". Pure. */
export function normalizeHandle(value) {
  const s = String(value ?? '').trim();
  if (s.includes('@')) return validHandle(s.toLowerCase())?.handle ?? null;
  if (!/^[\d\s().+-]+$/.test(s)) return null;
  const digits = s.replace(/[^\d+]/g, '');
  const e164 = /^\+\d+$/.test(digits) ? digits : /^\d{10}$/.test(digits) ? `+1${digits}` : /^1\d{10}$/.test(digits) ? `+${digits}` : null;
  return validHandle(e164)?.handle ?? null;
}

/** facetime-audio://<handle> for a valid handle; throws on anything else. Pure. */
export function facetimeUrl(handle) {
  const v = validHandle(handle);
  if (!v) throw new Error('Refusing to dial: the saved handle is not an E.164 phone number or an email address.');
  return `facetime-audio://${v.handle}`;
}

/** "+16025550100" → "+1•••••••0100"; "ana@x.com" → "a•••@x.com". For status lines. Pure. */
export function maskHandle(handle) {
  const v = validHandle(handle);
  if (!v) return '(none)';
  if (v.kind === 'phone') return `${v.handle.slice(0, 2)}${'•'.repeat(Math.max(0, v.handle.length - 6))}${v.handle.slice(-4)}`;
  const [local, domain] = v.handle.split('@');
  return `${local[0]}•••@${domain}`;
}

const TOKEN_RX = /^[A-Za-z0-9._~+/=-]{16,512}$/;
export const validToken = (token) => TOKEN_RX.test(String(token ?? ''));

// ── Keychain: handle + token (service ronin-crm-prod), written on stdin, never argv ─────────────────────────────

const kcQuote = (s) => `"${String(s).replace(/["\\\n\r]/g, '')}"`;

function readItem(account, run) {
  const r = run(['find-generic-password', '-s', OWNER_CALL_KEYCHAIN_SERVICE, '-a', account, '-w']);
  return r.status === 0 ? String(r.stdout || '').trim() : '';
}

/** {handle, token} from the Keychain ('' when missing). */
export function readOwnerCallSecrets({ run = runSecurity } = {}) {
  return { handle: readItem(OWNER_CALL_HANDLE_ACCOUNT, run), token: readItem(OWNER_CALL_TOKEN_ACCOUNT, run) };
}

export function saveOwnerCallSecrets({ handle, token }, { run = runSecurity } = {}) {
  const h = normalizeHandle(handle);
  if (!h) throw new Error('That is not a FaceTime handle: use a phone number in E.164 form (+16025550100) or an Apple ID email.');
  if (!validToken(token)) throw new Error('That does not look like an owner-call token.');
  for (const [account, value, label] of [[OWNER_CALL_HANDLE_ACCOUNT, h, 'Kingmaker owner call handle'], [OWNER_CALL_TOKEN_ACCOUNT, token, 'Kingmaker owner call token']]) {
    const r = run(['-i'], `add-generic-password -U -s ${kcQuote(OWNER_CALL_KEYCHAIN_SERVICE)} -a ${kcQuote(account)} -l ${kcQuote(label)} -w ${kcQuote(value)}\n`);
    if (r.status !== 0) throw new Error('Could not save to the Keychain.');
  }
  return { handle: h };
}

// ── config (state/owner-call.json): on/off, devices, voices. Off by default. ───────────────────────────────────

export const ownerCallConfigPath = (paths) => join(paths.state, OWNER_CALL_CONFIG_FILE);

const plainString = (v, max = 64) => (typeof v === 'string' && v.trim() && v.length <= max && !/[\u0000-\u001f]/.test(v) ? v.trim() : null);

export function readOwnerCallConfig(paths, read = (p) => readFileSync(p, 'utf8')) {
  let raw = null;
  try { raw = JSON.parse(read(ownerCallConfigPath(paths))); } catch { /* missing → defaults (off) */ }
  const ok = raw?.schema === 1;
  const devices = { ...DEFAULT_DEVICES };
  const voices = {};
  for (const [k, v] of Object.entries(DEFAULT_VOICES)) voices[k] = { ...v };
  if (ok) {
    for (const key of Object.keys(DEFAULT_DEVICES)) if (plainString(raw.devices?.[key])) devices[key] = plainString(raw.devices[key]);
    for (const [caller, v] of Object.entries(raw.voices && typeof raw.voices === 'object' ? raw.voices : {})) {
      if (!/^[a-z0-9-]{1,32}$/.test(caller) || !v || typeof v !== 'object') continue;
      voices[caller] = { ...(voices[caller] ?? { name: caller }), ...Object.fromEntries(['name', 'kokoro', 'say'].filter((f) => plainString(v[f], 40)).map((f) => [f, plainString(v[f], 40)])) };
    }
  }
  const buttons = { ...DEFAULT_BUTTONS };
  if (ok) for (const key of Object.keys(DEFAULT_BUTTONS)) if (plainString(raw.buttons?.[key], 24)) buttons[key] = plainString(raw.buttons[key], 24);
  const engine = ok && ['kokoro', 'say'].includes(raw.engine) ? raw.engine : 'kokoro';
  return { enabled: ok && raw.enabled === true, devices, voices, buttons, engine };
}

export function writeOwnerCallConfig(paths, patch, read) {
  const current = (() => { try { return JSON.parse((read ?? ((p) => readFileSync(p, 'utf8')))(ownerCallConfigPath(paths))); } catch { return {}; } })();
  const next = { ...(current?.schema === 1 ? current : {}), ...patch, schema: 1 };
  mkdirSync(paths.state, { recursive: true, mode: 0o700 });
  const file = ownerCallConfigPath(paths);
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, file);
  return readOwnerCallConfig(paths);
}

export const isRoninInstall = (paths, read) => activeCrmLock(paths, read)?.tenant === 'ronininc';

// ── the script ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Spoken text: no control characters, one line, bounded. Pure. */
export function spokenText(value, max = 300) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** {caller, name, kokoro, say} for a caller id. Unknown callers are not refused: they get the fallback voice. Pure. */
export function voiceForCaller(caller, callerName, voices = DEFAULT_VOICES) {
  const id = String(caller ?? '').trim().toLowerCase();
  const mapped = Object.hasOwn(voices, id) ? voices[id] : null;
  const name = spokenText(callerName, 40) || mapped?.name || spokenText(id, 40) || 'an agent';
  return { caller: id || 'unknown', name, kokoro: mapped?.kokoro || FALLBACK_VOICE.kokoro, say: mapped?.say || FALLBACK_VOICE.say };
}

export const openingLine = (name) => `This is ${spokenText(name, 40) || 'an agent'}, for Ronin.`;
export const REPLY_PROMPT = 'Any reply? Speak after the tone.';

const trimEnd = (s) => s.replace(/[\s.!?;:,]+$/, '');
/** "<ord>. <recipient>, by <channel>: <subject>." Only those three fields; a body is never read. Pure. */
export function batchItemLine(item) {
  const ord = Number.isInteger(Number(item?.ord)) ? Number(item.ord) : '?';
  return `${ord}. ${trimEnd(spokenText(item?.recipient, 120)) || 'unknown recipient'}, by ${trimEnd(spokenText(item?.channel, 20)) || 'unknown channel'}: ${trimEnd(spokenText(item?.subject, 200)) || 'no subject'}.`;
}
export const batchQuestion = (n) => `Say okay to send these ${n}, or say no.`;

/** Lower case, curly quotes straightened, punctuation → space, spaces collapsed. Pure. */
export function normalizeUtterance(text) {
  return String(text ?? '').toLowerCase().replace(/[‘’]/g, "'").replace(/'/g, '').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * The batch grammar. Exactly one of APPROVE_PHRASES (after normalising) → approve. No speech / whisper's non-speech
 * markers → silence. An explicit no / don't / stop → deny. Anything else ("not yet", "okay but skip three") →
 * ambiguous. Only approve sends anything. → {outcome, phrase}. Pure.
 */
export function classifyBatchReply(text) {
  const raw = String(text ?? '');
  if (isNonSpeech(raw)) return { outcome: 'silence', phrase: '' };
  const phrase = normalizeUtterance(raw);
  if (!phrase) return { outcome: 'silence', phrase: '' };
  if (APPROVE_PHRASES.includes(phrase)) return { outcome: 'approve', phrase };
  const first = phrase.split(' ')[0];
  if (DENY_FIRST_WORDS.has(first) || phrase.startsWith('do not')) return { outcome: 'deny', phrase };
  return { outcome: 'ambiguous', phrase };
}

/** The approval deadline as ms epoch (ms or s number, or an ISO string); null when unreadable. Pure. */
export function deadlineMs(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value < 1e12 ? value * 1000 : value;
  if (typeof value === 'string' && value.trim()) {
    if (/^\d+$/.test(value.trim())) return deadlineMs(Number(value.trim()));
    const t = Date.parse(value);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

/** True only when `at` is at least `margin` before a readable deadline (unreadable → false: fail closed). Pure. */
export function beforeDeadline(deadline, at, margin = DEADLINE_MARGIN_MS) {
  const d = deadlineMs(deadline);
  return d !== null && at + margin < d;
}

/** Truncate to a UTF-8 byte budget without splitting a character. Pure. */
export function boundBytes(text, max = TRANSCRIPT_MAX_BYTES) {
  let s = String(text ?? '');
  while (Buffer.byteLength(s, 'utf8') > max) s = Array.from(s).slice(0, -Math.max(1, Math.ceil((Buffer.byteLength(s, 'utf8') - max) / 4))).join('');
  return s;
}

// ── the Worker routes ──────────────────────────────────────────────────────────────────────────────────────────

/** The five owner-call routes with the transport token as a bearer header (never logged). */
export function createOwnerCallApi({ token, base = OWNER_CALL_BASE, fetchImpl = fetch, timeoutMs = 15_000 } = {}) {
  if (base !== OWNER_CALL_BASE) throw new Error(`Owner calls connect only to ${OWNER_CALL_BASE}.`);
  const call = async (method, route, body) => {
    const response = await fetchImpl(`${base}/api/owner-call/${route}`, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = await response.json().catch(() => null);
    // A non-2xx is an error, except start's "nothing to send" (the request is closed; nothing is dialled).
    if (!response.ok && !(json?.ok === false && json?.error === 'nothing_to_send')) throw new OwnerCallHttpError(response.status, typeof json?.error === 'string' ? json.error.slice(0, 60) : undefined);
    return json ?? {};
  };
  return {
    pending: () => call('GET', 'pending'),
    start: ({ id, session_id }) => call('POST', 'start', { id, session_id }),
    answered: ({ id, session_id, connected_at }) => call('POST', 'answered', { id, session_id, connected_at }),
    missed: ({ id, session_id }) => call('POST', 'missed', { id, session_id }),
    result: (body) => call('POST', 'result', body),
  };
}

// ── is the FaceTime call connected? (solomon-audio-activity) ──────────────────────────────────────────────────

export const audioActivityHelperPath = (paths) => join(paths.resources, 'voice-runtime', 'system', 'solomon-audio-activity');

/** True when a FaceTime process runs audio input AND output at once. Pure. */
export function faceTimeDuplex(processes, bundles = FACETIME_BUNDLES) {
  return (Array.isArray(processes) ? processes : []).some((p) => p && bundles.includes(String(p.bundle || '')) && p.input === true && p.output === true);
}

/** Watch the helper's events for one call. connected(): true | false | null (unknown: not started, unsupported, died). */
export function createFaceTimeWatch({ executable, spawnImpl = nodeSpawn, exists = existsSync, bundles = FACETIME_BUNDLES } = {}) {
  let child = null; let buffer = ''; let state = null; let reason = 'not_started';
  const onLine = (line) => {
    let msg; try { msg = JSON.parse(line); } catch { return; }
    if (msg?.event === 'unsupported') { state = null; reason = String(msg.reason || 'unsupported'); return; }
    if (msg?.event === 'audio_activity') { state = faceTimeDuplex(msg.processes, bundles); reason = 'watching'; }
  };
  return {
    start() {
      if (child) return { ok: true };
      if (!executable || !exists(executable)) { reason = 'helper_not_installed'; return { ok: false, reason }; }
      try { child = spawnImpl(executable, [], { stdio: ['pipe', 'pipe', 'ignore'] }); } catch { child = null; reason = 'spawn_failed'; return { ok: false, reason }; }
      child.stdout?.setEncoding?.('utf8');
      child.stdout?.on('data', (chunk) => {
        buffer += String(chunk);
        for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) { const line = buffer.slice(0, i); buffer = buffer.slice(i + 1); if (line.trim()) onLine(line); }
      });
      child.on?.('exit', () => { child = null; state = null; reason = 'helper_exited'; });
      child.on?.('error', () => { child = null; state = null; reason = 'helper_error'; });
      reason = 'starting';
      return { ok: true };
    },
    connected: () => state,
    reason: () => reason,
    stop() { const c = child; child = null; state = null; reason = 'stopped'; try { c?.stdin?.end(); } catch { /* gone */ } try { c?.kill?.(); } catch { /* gone */ } },
  };
}

// ── the Mac runners (open, osascript, sox, say, whisper) ──────────────────────────────────────────────────────

/** One process → {code, out, err}; never throws. */
export function runCommand(cmd, args, { timeoutMs = 30_000, input, spawnImpl = nodeSpawn } = {}) {
  return new Promise((resolve) => {
    let child;
    try { child = spawnImpl(cmd, args, { stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] }); } catch (e) { resolve({ code: -1, out: '', err: String(e?.message ?? e) }); return; }
    let out = ''; let err = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, timeoutMs);
    if (input) { child.stdin.on('error', () => {}); child.stdin.end(input); }
    child.stdout?.on('data', (d) => { out += d; });
    child.stderr?.on('data', (d) => { err += d; });
    child.once('error', (e) => { clearTimeout(timer); resolve({ code: -1, out, err: String(e.message) }); });
    child.once('exit', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

// One handler both scripts share: click the first button named <name> (or so described) in a process's windows.
const CLICK_HANDLER = [
  'on clickNamed(procName, buttonName)',
  '  tell application "System Events"',
  '    if not (exists process procName) then return false',
  '    tell process procName',
  '      repeat with w in windows',
  '        try',
  '          set els to entire contents of w',
  '          repeat with el in els',
  '            try',
  '              if (class of el is button) and (((name of el) as text) is buttonName or ((description of el) as text) is buttonName) then',
  '                click el',
  '                return true',
  '              end if',
  '            end try',
  '          end repeat',
  '        end try',
  '      end repeat',
  '    end tell',
  '  end tell',
  '  return false',
  'end clickNamed',
];

/** Press the "Call" button macOS shows after `open facetime-audio://…` (System Events; needs Accessibility). */
export const CONFIRM_CALL_SCRIPT = Object.freeze([
  ...CLICK_HANDLER,
  'on run argv',
  '  set buttonName to item 1 of argv',
  '  set waitSeconds to (item 2 of argv) as integer',
  '  set t0 to current date',
  '  repeat',
  '    repeat with p in {"FaceTime", "NotificationCenter", "UserNotificationCenter"}',
  '      if my clickNamed(p as text, buttonName) then return "clicked:" & (p as text)',
  '    end repeat',
  '    if ((current date) - t0) > waitSeconds then return "not_found"',
  '    delay 0.4',
  '  end repeat',
  'end run',
]);

/** End the FaceTime call: press End if it is there, then quit FaceTime (which ends any call). */
export const END_CALL_SCRIPT = Object.freeze([
  ...CLICK_HANDLER,
  'on run argv',
  '  set buttonName to item 1 of argv',
  '  try',
  '    if not my clickNamed("FaceTime", buttonName) then my clickNamed("NotificationCenter", buttonName)',
  '  end try',
  '  delay 0.5',
  '  if application "FaceTime" is running then',
  '    tell application "FaceTime" to quit',
  '  end if',
  '  return "ended"',
  'end run',
]);

export const osascriptArgs = (lines, args = []) => [...lines.flatMap((line) => ['-e', line]), ...args.map(String)];

/** sox: record the call's audio (what FaceTime plays) from the hear device as 16 kHz mono s16le on stdout. Pure. */
export function recordArgs({ device = DEFAULT_DEVICES.hear, remix = DEFAULT_DEVICES.hearRemix } = {}) {
  return ['-q', '--buffer', '65536', '-t', 'coreaudio', device, '-t', 'raw', '-r', String(SAMPLE_RATE), '-e', 'signed', '-b', '16', '-c', '1', '-', ...(remix ? ['remix', remix] : [])];
}
/** sox: play a WAV into the speak device (FaceTime's microphone). Pure. */
export const playArgs = (wav, device = DEFAULT_DEVICES.speak) => ['-q', wav, '-t', 'coreaudio', device];
/** sox: the short tone before a reply. Pure. */
export const toneArgs = (device = DEFAULT_DEVICES.speak) => ['-q', '-n', '-t', 'coreaudio', device, 'synth', '0.35', 'sine', '880', 'vol', '0.4'];
/** Apple's say, into a device. Pure. */
export const sayArgs = (line, device = DEFAULT_DEVICES.speak, voice = null) => ['-a', device, ...(voice ? ['-v', voice] : []), line];

export const SOX_CANDIDATES = Object.freeze(['/opt/homebrew/bin/sox', '/usr/local/bin/sox']);
export const findSox = (exists = existsSync) => SOX_CANDIDATES.find((p) => exists(p)) ?? null;

function waitExit(child) {
  return new Promise((resolve) => { child.once('exit', (code) => resolve(code ?? -1)); child.once('error', () => resolve(-1)); });
}

/**
 * Record one utterance from the hear device: ends on the first completed utterance, at `maxMs`, or when the call
 * drops (`connected()` stops being true). → {samples: Int16Array | null, hangup}. Throws if sox cannot record.
 */
export function listenOnce({ sox, device, remix, maxMs, connected = () => true, pollMs = 200, spawnImpl = nodeSpawn, segmenter = createSegmenter({ maxMs, endSilenceMs: 1200, minSpeechMs: 250 }) }) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawnImpl(sox, recordArgs({ device, remix }), { stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { reject(new Error(`Could not start sox: ${e.message}`)); return; }
    const chunks = []; let bytes = 0; let err = ''; let finished = false;
    const cap = (SAMPLE_RATE * 2 * maxMs) / 1000;
    const finish = (value, error) => {
      if (finished) return; finished = true;
      clearTimeout(timer); clearInterval(poll);
      try { child.kill('SIGTERM'); } catch { /* gone */ }
      for (const c of chunks) c.fill(0);
      if (error) reject(error); else resolve(value);
    };
    const all = () => { const b = Buffer.concat(chunks); const out = new Int16Array(Math.floor(b.byteLength / 2)); for (let i = 0; i < out.length; i += 1) out[i] = b.readInt16LE(i * 2); b.fill(0); return out; };
    child.stdout.on('data', (data) => {
      if (finished) return;
      const chunk = Buffer.from(data); // a copy: aligned for the Int16 view, and ours to zero-fill
      if (bytes < cap) { chunks.push(chunk); bytes += chunk.length; }
      const done = segmenter.push(chunk);
      if (done.length) finish({ samples: done[0].samples, hangup: false });
    });
    child.stderr?.on('data', (d) => { err += d; });
    const timer = setTimeout(() => finish({ samples: segmenter.inSpeech ? all() : null, hangup: false }), maxMs + 300);
    const poll = setInterval(() => { if (connected() !== true) finish({ samples: null, hangup: true }); }, pollMs);
    child.once('error', (e) => finish(null, new Error(`sox could not record: ${e.message}`)));
    child.once('exit', (code) => {
      if (finished) return;
      if (!bytes) finish(null, new Error(`sox could not record from "${device}" (exit ${code}): ${String(err).trim().slice(0, 160)}`));
      else finish({ samples: segmenter.inSpeech ? all() : null, hangup: false });
    });
  });
}

/**
 * The default Mac runners. Each is replaceable (tests pass stubs).
 *   dial(handle) · confirmPrompt() · endCall() · forceQuit() · speak(text, voice) · tone() · hear({maxMs, connected})
 *   · watch()
 */
export function createMacRunners({ paths, config = null, spawnImpl = nodeSpawn, exists = existsSync, run = (cmd, args, opts) => runCommand(cmd, args, { ...opts, spawnImpl }), synth = synthesizeKokoroWav, transcribeImpl = whisperTranscribe, language = process.env.SOL_GHOST_LANG || 'auto' } = {}) {
  const cfg = config ?? readOwnerCallConfig(paths);
  const { devices, buttons, engine } = cfg;
  const sox = () => findSox(exists);
  const play = (cmd, args) => {
    let child = null; let stopped = false;
    const done = (async () => {
      if (stopped) return;
      child = spawnImpl(cmd, args, { stdio: 'ignore' });
      const code = await waitExit(child);
      if (code !== 0 && !stopped) throw new Error(`${cmd.split('/').pop()} could not play into "${devices.speak}" (exit ${code}).`);
    })();
    return { done, stop: () => { stopped = true; try { child?.kill('SIGKILL'); } catch { /* gone */ } } };
  };
  return {
    dial: (handle) => run('/usr/bin/open', [facetimeUrl(handle)], { timeoutMs: 15_000 }),
    confirmPrompt: () => run('/usr/bin/osascript', osascriptArgs(CONFIRM_CALL_SCRIPT, [buttons.call, 12]), { timeoutMs: 20_000 }),
    endCall: () => run('/usr/bin/osascript', osascriptArgs(END_CALL_SCRIPT, [buttons.end]), { timeoutMs: 15_000 }),
    forceQuit: () => run('/usr/bin/killall', ['FaceTime'], { timeoutMs: 5_000 }),
    speak(text, voice = {}) {
      const line = spokenText(text, 1200);
      let current = null; let stopped = false;
      const done = (async () => {
        if (!line) return;
        const wav = engine === 'kokoro' && sox() ? await synth(line, { voice: voice.kokoro, engine }).catch(() => null) : null;
        if (stopped) { if (wav) rmSync(wav.dir, { recursive: true, force: true }); return; }
        if (wav) {
          try { current = play(sox(), playArgs(wav.out, devices.speak)); await current.done; return; } finally { rmSync(wav.dir, { recursive: true, force: true }); }
        }
        current = play('/usr/bin/say', sayArgs(line, devices.speak, voice.say || null));
        try { await current.done; } catch (e) {
          if (stopped || !voice.say) throw e;
          current = play('/usr/bin/say', sayArgs(line, devices.speak, null)); await current.done; // a missing voice: the default one
        }
      })();
      return { done, stop: () => { stopped = true; current?.stop(); } };
    },
    tone() {
      const s = sox();
      if (!s) return { done: Promise.resolve(), stop: () => {} };
      const t = play(s, toneArgs(devices.speak));
      return { done: t.done.catch(() => {}), stop: t.stop };
    },
    async hear({ maxMs, connected }) {
      const s = sox();
      if (!s) throw new Error('sox is not installed (brew install sox).');
      const got = await listenOnce({ sox: s, device: devices.hear, remix: devices.hearRemix, maxMs, connected, spawnImpl });
      if (got.hangup) return { text: '', hangup: true };
      if (!got.samples?.length) return { text: '', hangup: false };
      try { return { text: await transcribeImpl(got.samples, { whisper: paths.voice.whisper, model: paths.voice.sttModel, language }), hangup: false }; } finally { got.samples.fill(0); }
    },
    watch: () => createFaceTimeWatch({ executable: audioActivityHelperPath(paths), spawnImpl, exists }),
  };
}

// ── one call ───────────────────────────────────────────────────────────────────────────────────────────────────

async function waitFor(test, ms, { now, sleep, pollMs }) {
  const t0 = now();
  for (;;) {
    if (test()) return true;
    if (now() - t0 >= ms) return false;
    await sleep(pollMs);
  }
}

/** Await a speech task; if the call drops meanwhile, stop it and throw CallDropped. */
function guarded(task, watch, pollMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const end = (fn) => { if (settled) return; settled = true; clearInterval(timer); fn(); };
    const timer = setInterval(() => { if (watch.connected() !== true) end(() => { try { task.stop?.(); } catch { /* gone */ } reject(new CallDropped()); }); }, pollMs);
    Promise.resolve(task.done).then(
      () => end(() => (watch.connected() === true ? resolve() : reject(new CallDropped()))),
      (e) => end(() => reject(e)),
    );
  });
}

/**
 * Place one owner call. `call` is a row from GET pending. The transport is the Worker (or the local self-test).
 * → {outcome, ...}. Outcomes: skipped (nothing happened: try again later), start_failed / start_refused /
 * nothing_to_send (not dialled), missed, approve | deny | ambiguous | silence | hangup | reply, approve_uncertain,
 * error (no approval, result reported if possible).
 */
export async function placeOwnerCall(call, {
  transport, mac, handle, sessionId, voices = DEFAULT_VOICES, onCommit = () => {},
  now = Date.now, sleep = sleepFor, log = () => {}, pollMs = 250, connectTimeoutMs = CONNECT_TIMEOUT_MS,
  knownStateMs = 3_000, endWaitMs = 3_000, replyMaxMs = REPLY_MAX_MS, approvalMaxMs = APPROVAL_MAX_MS, deadlineMarginMs = DEADLINE_MARGIN_MS,
}) {
  const id = String(call?.id ?? '');
  if (!id || !OWNER_CALL_KINDS.includes(call?.kind)) return { outcome: 'skipped', reason: 'unsupported_request' };
  if (mac?.channel !== 'phone' && !validHandle(handle)) return { outcome: 'skipped', reason: 'bad_handle' };   // the phone needs no handle
  const waitOpts = { now, sleep, pollMs };
  const watch = mac.watch();
  const started = watch.start();
  if (!started.ok) return { outcome: 'skipped', reason: started.reason || 'audio_activity_unavailable' };
  // Call detection must be working, and FaceTime must not already be on a call, before anything reaches the CRM.
  const known = await waitFor(() => watch.connected() !== null, knownStateMs, waitOpts).catch(() => false);
  const before = watch.connected();
  if (!known || before !== false) { watch.stop(); return { outcome: 'skipped', reason: !known ? 'audio_activity_silent' : before === true ? 'facetime_busy' : 'audio_activity_unknown' }; }

  // From here on the request is spent for this session: it is never started or dialled again.
  onCommit(id);
  const ids = { id, session_id: sessionId };
  let start;
  try { start = await transport.start(ids); } catch (e) {
    watch.stop();
    // 409 batch_busy is a definite refusal (another live call holds the batch; nothing started, nothing dialled), so the
    // request may be tried again later. Every other start failure stays uncertain and is not retried this session.
    if (e instanceof OwnerCallHttpError && e.status === 409 && e.code === 'batch_busy') return { outcome: 'skipped', reason: 'batch_busy', retryId: id };
    log('owner_call_start_failed', { id: id.slice(0, 8), error: String(e?.message ?? e).slice(0, 120) }); return { outcome: 'start_failed' };
  }
  if (start?.ok !== true) { watch.stop(); return { outcome: start?.error === 'nothing_to_send' ? 'nothing_to_send' : 'start_refused', error: start?.error ?? null }; }
  if (start.kind !== call.kind) { watch.stop(); return { outcome: 'start_refused', error: 'kind_mismatch' }; }

  const voice = voiceForCaller(start.caller ?? call.caller, start.caller_name ?? call.caller_name, voices);
  const say = (text) => guarded(mac.speak(text, voice), watch, pollMs);
  const sayAfter = async (text) => { try { await say(text); } catch { /* the result is already reported */ } };
  const eventId = (outcome) => `km-owner-call:${sessionId}:${id}:${outcome}`;
  let answered = false; let resultSent = false; let outcome = 'error'; let ended = false;
  const report = async (body) => { resultSent = true; return transport.result({ ...ids, ...body, transport_event_id: eventId(body.outcome) }); };

  try {
    const dialledAt = now();
    const dial = await mac.dial(handle);
    if (dial?.code !== 0) throw new Error(`open facetime-audio failed (exit ${dial?.code}).`);
    const confirmed = await mac.confirmPrompt().catch((e) => ({ code: -1, err: String(e?.message ?? e) }));
    log('owner_call_dialled', { id: id.slice(0, 8), kind: call.kind, prompt: String(confirmed?.out ?? '').trim().slice(0, 40) || `exit ${confirmed?.code}` });
    // 45 s from the dial (the prompt's click counts against it), then it is a missed call.
    if (!(await waitFor(() => watch.connected() === true, Math.max(0, connectTimeoutMs - (now() - dialledAt)), waitOpts))) {
      outcome = 'missed';
      await endCall();
      await transport.missed(ids).catch((e) => log('owner_call_report_failed', { id: id.slice(0, 8), route: 'missed', error: String(e?.message ?? e).slice(0, 120) }));
      return { outcome };
    }
    answered = true;
    await transport.answered({ ...ids, connected_at: now() }).catch((e) => log('owner_call_report_failed', { id: id.slice(0, 8), route: 'answered', error: String(e?.message ?? e).slice(0, 120) }));

    if (start.kind === 'message') {
      const message = spokenText(start.message, 1500);
      if (!message) throw new Error('The message call carries no message.');
      await say(`${openingLine(voice.name)} ${message}`);
      await say(REPLY_PROMPT);
      await guarded(mac.tone(), watch, pollMs);
      const heard = await mac.hear({ maxMs: replyMaxMs, connected: () => watch.connected() });
      if (heard.hangup || watch.connected() !== true) throw new CallDropped();
      const text = spokenText(heard.text, 8000);
      outcome = isNonSpeech(text) ? 'silence' : 'reply';
      await report(outcome === 'reply' ? { outcome, transcript: boundBytes(text) } : { outcome });
      await sayAfter(outcome === 'reply' ? 'Got it. I will pass that on. Goodbye.' : 'I did not hear a reply. Goodbye.');
      return { outcome, transcript: outcome === 'reply' ? boundBytes(text) : null };
    }

    // outbound_batch
    const items = Array.isArray(start.items) ? start.items : [];
    if (!items.length) throw new Error('The batch carries no items.');
    const n = items.length;
    await say(openingLine(voice.name));
    for (const item of items) await say(batchItemLine(item));
    const question = batchQuestion(n);
    await say(question);
    let heard = await mac.hear({ maxMs: approvalMaxMs, connected: () => watch.connected() });
    if (heard.hangup || watch.connected() !== true) throw new CallDropped();
    let verdict = classifyBatchReply(heard.text);
    if (verdict.outcome === 'silence') {
      await say(`I did not hear anything. ${question}`);
      heard = await mac.hear({ maxMs: approvalMaxMs, connected: () => watch.connected() });
      if (heard.hangup || watch.connected() !== true) throw new CallDropped();
      verdict = classifyBatchReply(heard.text);
    }
    const transcript = boundBytes(spokenText(heard.text, 2000));
    if (verdict.outcome === 'approve') {
      const affirmedAt = now();
      if (!beforeDeadline(start.approval_deadline, affirmedAt, deadlineMarginMs)) {
        outcome = 'ambiguous';
        await report({ outcome, phrase: verdict.phrase, transcript });
        await sayAfter('That came after the approval window closed. Nothing was sent. Goodbye.');
        return { outcome, late: true };
      }
      let res;
      try { res = await report({ outcome: 'approve', phrase: verdict.phrase, transcript, affirmed_at: affirmedAt }); } catch (e) {
        // Uncertain: the approval may or may not have landed. Never retried, never reported twice.
        outcome = 'approve_uncertain';
        log('owner_call_report_failed', { id: id.slice(0, 8), route: 'result', error: String(e?.message ?? e).slice(0, 120) });
        await sayAfter('I could not confirm that with the CRM. Check it there before approving again. Goodbye.');
        return { outcome };
      }
      outcome = 'approve';
      const sending = res?.ok === true && res?.approved === true;
      await sayAfter(sending ? `Sending those ${n}. Goodbye.` : 'Nothing was sent. Goodbye.');
      return { outcome, sending };
    }
    outcome = verdict.outcome;
    await report({ outcome, ...(verdict.phrase ? { phrase: verdict.phrase } : {}), ...(transcript ? { transcript } : {}) });
    await sayAfter('Nothing was sent. Goodbye.');
    return { outcome };
  } catch (e) {
    const dropped = e instanceof CallDropped;
    log('owner_call_error', { id: id.slice(0, 8), dropped, error: String(e?.message ?? e).slice(0, 160) });
    if (!answered) {
      // Never connected (dial or prompt failed): the owner did not pick up a call from us.
      await endCall();
      await transport.missed(ids).catch(() => null);
      return { outcome: 'missed', error: String(e?.message ?? e).slice(0, 160) };
    }
    if (!resultSent) {
      outcome = dropped ? 'hangup' : 'ambiguous';
      await report({ outcome }).catch(() => null); // never an approve
      return { outcome, error: dropped ? null : String(e?.message ?? e).slice(0, 160) };
    }
    return { outcome };
  } finally {
    await endCall();
    watch.stop();
  }

  async function endCall() {
    if (ended) return;
    ended = true;
    try { await mac.endCall(); } catch { /* fall through to force quit */ }
    if (watch.connected() === true && !(await waitFor(() => watch.connected() !== true, endWaitMs, waitOpts))) {
      try { await mac.forceQuit?.(); } catch { /* nothing more to do */ }
    }
  }
}

// ── the loop ───────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Poll the CRM for owner calls and place them, one at a time. Nothing is polled while owner calls are off, while
 * this is not a Ronin install, or before setup. tick() handles at most one call.
 */
export function createOwnerCallLoop({
  paths, readConfig = () => readOwnerCallConfig(paths), readSecrets = () => readOwnerCallSecrets(), roninLocked = () => isRoninInstall(paths),
  api = (token) => createOwnerCallApi({ token }), mac = null, preflight = null, sessionId = `km-${randomUUID()}`, phone = null,
  now = Date.now, sleep = sleepFor, log = () => {}, intervalMs = POLL_INTERVAL_MS, callOptions = {},
} = {}) {
  const attempted = new Set();
  let busy = false;
  let lastSkip = '';
  const skip = (reason, extra = {}) => { if (reason !== lastSkip) { lastSkip = reason; log('owner_call_waiting', { reason, ...extra }); } return { outcome: 'skipped', reason, ...extra }; };

  async function tick() {
    if (busy) return { busy: true };
    const config = readConfig();
    if (!config.enabled) return { off: true };
    if (!roninLocked()) return { off: true, reason: 'not_ronin' };
    busy = true;
    try {
      const { handle, token } = readSecrets();
      // THE PHONE FIRST (lib/phone-ring.mjs): a paired phone that can be rung takes the call on Kingmaker's own call
      // screen; FaceTime (a separate Apple ID, BlackHole audio) only when no phone can be reached.
      const viaPhone = Boolean(phone?.reachable());
      if (!token || (!viaPhone && !handle)) return skip('not_set_up');
      if (!viaPhone && !validHandle(handle)) return skip('bad_handle');
      const transport = api(token);
      const pending = await transport.pending();
      const call = (Array.isArray(pending?.calls) ? pending.calls : []).find((c) => c?.id && !attempted.has(String(c.id)));
      if (!call) { lastSkip = ''; return { idle: true }; }
      if (!OWNER_CALL_KINDS.includes(call.kind)) { attempted.add(String(call.id)); return skip('unsupported_kind'); }
      const runners = viaPhone ? createPhoneRunners(phone, call) : (mac ?? createMacRunners({ paths, config }));
      if (preflight && !viaPhone) {
        const pre = await preflight({ config });
        if (!pre.ok) return skip('preflight', { failures: pre.failures });
      }
      const result = await placeOwnerCall(call, { transport, mac: runners, handle, sessionId, voices: config.voices, onCommit: (id) => attempted.add(id), now, sleep, log, ...callOptions });
      if (result.outcome === 'skipped') { if (result.retryId) attempted.delete(result.retryId); return skip(result.reason); }
      lastSkip = '';
      log('owner_call_done', { id: String(call.id).slice(0, 8), kind: call.kind, outcome: result.outcome });
      return result;
    } finally { busy = false; }
  }

  async function run({ signal } = {}) {
    while (!signal?.aborted) {
      try { await tick(); } catch (e) { log('owner_call_poll_failed', { error: String(e?.message ?? e).slice(0, 160) }); }
      await sleep(intervalMs, signal);
    }
  }
  return { tick, run, attempted, sessionId };
}

/** The daemon's entry: only called when owner calls are on (lib/cli.mjs cmdStart). */
export function runOwnerCallLoop({ paths, signal, log = () => {}, phone = null }) {
  const loop = createOwnerCallLoop({ paths, log, phone, preflight: ({ config }) => ownerCallPreflight({ paths, config }) });
  return loop.run({ signal });
}

// ── doctor ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** Every audio device system_profiler lists → [{name, input, output}] (input/output null when it does not say). Pure. */
export function audioDevicesFrom(json) {
  const out = [];
  const walk = (node) => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!node || typeof node !== 'object') return;
    if (typeof node._name === 'string' && Object.keys(node).some((k) => k.startsWith('coreaudio_'))) {
      const has = (k) => (k in node ? Number(node[k]) > 0 || node[k] === 'spaudio_yes' : null);
      out.push({ name: node._name, input: has('coreaudio_device_input'), output: has('coreaudio_device_output') });
    }
    for (const v of Object.values(node)) if (v && typeof v === 'object') walk(v);
  };
  walk(json?.SPAudioDataType ?? json);
  return out;
}

const macVersionAtLeast = (version, [maj, min]) => { const [a = 0, b = 0] = String(version).split('.').map(Number); return a > maj || (a === maj && b >= min); };

/**
 * The checks a call needs, each precise about what is missing. → {ok, rows: [{ok, required, label, fix}], failures}.
 * `quick` skips the checks that ask macOS for a permission dialog's state (osascript) and the Keychain.
 */
export async function ownerCallDoctor({ paths, config = readOwnerCallConfig(paths), secrets = null, run = (c, a, o) => runCommand(c, a, o), exists = existsSync, roninLocked = () => isRoninInstall(paths), quick = false } = {}) {
  const rows = [];
  const row = (ok, label, fix = '', required = true) => rows.push({ ok: Boolean(ok), required, label, fix });
  if (!quick) {
    row(roninLocked(), 'Ronin install (owner calls are Ronin only)', 'kingmaker office ronin enable   (or: kingmaker crm-lock ronininc)');
    const s = secrets ?? readOwnerCallSecrets();
    row(validHandle(s.handle), s.handle ? `owner handle saved (${maskHandle(s.handle)})` : 'owner handle saved', 'kingmaker owner-call setup');
    row(Boolean(s.token), 'owner-call transport token saved (Keychain ronin-crm-prod / KINGMAKER_OWNER_CALL_TOKEN)', 'Mint it in the CRM owner session (role owner-call-transport), then: kingmaker owner-call setup');
  }
  const ver = await run('/usr/bin/sw_vers', ['-productVersion'], { timeoutMs: 5_000 });
  const version = String(ver.out || '').trim();
  row(ver.code === 0 && macVersionAtLeast(version, [14, 2]), `macOS ${version || 'unknown'} (call detection needs 14.2 or later)`, 'Update macOS to 14.2 or later.');
  row(exists('/System/Applications/FaceTime.app'), 'FaceTime.app present', 'FaceTime ships with macOS; reinstall macOS if it is missing.');
  const helper = audioActivityHelperPath(paths);
  row(exists(helper), 'call detection helper (solomon-audio-activity)', `Missing at ${helper}: reinstall Kingmaker with the Solomon voice runtime.`);
  const sox = findSox(exists);
  row(Boolean(sox), `sox ${sox ? `(${sox})` : ''}`.trim(), 'brew install sox');
  if (sox) {
    const help = await run(sox, ['-h'], { timeoutMs: 5_000 });
    row(/coreaudio/i.test(`${help.out}\n${help.err}`), 'sox can use Core Audio devices', 'Reinstall sox from Homebrew (brew reinstall sox): this build has no coreaudio driver.');
  }
  const prof = await run('/usr/sbin/system_profiler', ['SPAudioDataType', '-json'], { timeoutMs: 20_000 });
  let devices = [];
  try { devices = audioDevicesFrom(JSON.parse(prof.out)); } catch { /* reported below */ }
  const find = (name) => devices.find((d) => d.name === name);
  const speak = find(config.devices.speak); const hear = find(config.devices.hear);
  row(speak && speak.output !== false, `"${config.devices.speak}" (Kingmaker speaks into the call through it)`, speak ? `"${config.devices.speak}" has no output side.` : `Install BlackHole 2ch (brew install blackhole-2ch), or set devices.speak in ${ownerCallConfigPath(paths)}.`);
  row(hear && hear.input !== false, `"${config.devices.hear}" (Kingmaker hears the call through it)`, hear ? `"${config.devices.hear}" has no input side.` : `Install BlackHole 16ch (brew install blackhole-16ch), or set devices.hear in ${ownerCallConfigPath(paths)}.`);
  row(devices.some((d) => /multi-output/i.test(d.name)), 'a Multi-Output Device exists (FaceTime output = your speakers + BlackHole 16ch)', 'Audio MIDI Setup → + → Create Multi-Output Device; tick your speakers and BlackHole 16ch.', false);
  row(exists(paths.voice.whisper) && exists(paths.voice.sttModel), 'whisper.cpp and its model (transcribes the reply)', 'Reinstall Kingmaker with the Solomon voice runtime.');
  if (config.engine === 'kokoro') row(exists(paths.voice.kokoro), 'Kokoro voice (else Apple say is used)', '', false);
  if (!quick) {
    const ax = await run('/usr/bin/osascript', ['-e', 'tell application "System Events" to get UI elements enabled'], { timeoutMs: 10_000 });
    const automation = ax.code === 0 || !/-1743|not authori[sz]ed to send apple events/i.test(ax.err);
    row(automation, 'Automation: Kingmaker may control System Events', 'System Settings → Privacy & Security → Automation → allow Kingmaker (or your terminal) to control System Events.');
    row(ax.code === 0 && /true/.test(ax.out), 'Accessibility: Kingmaker may press FaceTime\'s Call and End buttons', 'System Settings → Privacy & Security → Accessibility → turn on Kingmaker (or your terminal).');
  }
  const failures = rows.filter((r) => r.required && !r.ok).map((r) => r.label);
  return { ok: failures.length === 0, rows, failures };
}

/** The quick per-call preflight: devices, helper, tools. No permission probes, no Keychain. */
export const ownerCallPreflight = ({ paths, config, run, exists }) => ownerCallDoctor({ paths, config, run, exists, quick: true });

export function doctorLines({ rows }) {
  const lines = rows.map((r) => `${r.ok ? '✓' : r.required ? '✗' : '·'} ${r.label}${r.ok || !r.fix ? '' : `\n    → ${r.fix}`}`);
  lines.push('· manual: FaceTime → Video menu → Microphone: the speak device; Output: the Multi-Output device (not your Mac\'s system output).');
  lines.push('· manual: FaceTime is signed in to a SEPARATE Apple ID on this Mac (not the owner\'s own).');
  return lines;
}

// ── the CLI: kingmaker owner-call setup | doctor | test | on | off | status ────────────────────────────────────

/** A transport that never reaches the CRM: the self-test's request is local and its reply is printed here only. */
export function localSelfTestTransport({ out = console.log } = {}) {
  return {
    start: async ({ id }) => ({ ok: true, id, kind: 'message', caller: 'kingmaker', caller_name: 'Kingmaker', reason: 'self-test', message: 'This is a test of owner calls from your Mac. Nothing is being approved or sent.' }),
    answered: async () => { out('Connected.'); return { ok: true }; },
    missed: async () => { out('Not answered within 45 seconds.'); return { ok: true }; },
    result: async (body) => { out(body.outcome === 'reply' ? `Heard: ${body.transcript}` : `Outcome: ${body.outcome}`); return { ok: true }; },
  };
}

export async function ownerCallCommand(args, {
  paths, readAnswer, readHidden, out = console.log, err = console.error, secrets = null, runSec = runSecurity,
  fetchImpl = fetch, doctor = (opts) => ownerCallDoctor(opts), place = placeOwnerCall, macFor = (config) => createMacRunners({ paths, config }),
  roninLocked = () => isRoninInstall(paths),
} = {}) {
  const sub = args[0] || 'status';
  const loadSecrets = () => secrets ?? readOwnerCallSecrets({ run: runSec });
  if (sub === 'status') {
    const config = readOwnerCallConfig(paths); const s = loadSecrets();
    out(JSON.stringify({ enabled: config.enabled, ronin: roninLocked(), handle: maskHandle(s.handle), token: s.token ? 'saved' : 'missing', devices: config.devices, engine: config.engine, voices: config.voices }, null, 2));
    return 0;
  }
  if (sub === 'off') { writeOwnerCallConfig(paths, { enabled: false }); out('Owner calls are off. A running Kingmaker stops polling at its next tick; the handle and token stay in the Keychain.'); return 0; }
  if (!roninLocked()) { err('✗ Owner calls are Ronin only: this Kingmaker is not bound to the Ronin CRM (kingmaker office ronin enable).'); return 2; }
  if (sub === 'setup') {
    const handle = normalizeHandle(await readAnswer({ prompt: "The owner's FaceTime handle (phone as +16025550100, or Apple ID email). The ONLY one this Mac will ever call: " }));
    if (!handle) { err('✗ That is not a phone number in E.164 form or an email address. Nothing was saved.'); return 1; }
    // A Mac paired on the site (lib/ronin-pairing.mjs) already holds its token: only the handle is asked for.
    let token = loadSecrets().token;
    if (validToken(token)) out('Using the owner-call token this Mac collected when it was paired on the site.');
    else {
      const raw = await readHidden({ prompt: 'Owner-call transport token from the CRM owner session (hidden, then Enter): ' });
      out('');
      token = Buffer.from(raw).toString('utf8').trim(); raw.fill?.(0);
    }
    if (!validToken(token)) { err('✗ That does not look like an owner-call token. Nothing was saved.'); return 1; }
    try { await createOwnerCallApi({ token, fetchImpl }).pending(); } catch (e) {
      if (e instanceof OwnerCallHttpError && (e.status === 401 || e.status === 403)) { err(`✗ The CRM refused that token (HTTP ${e.status}). Mint a new owner-call-transport token. Nothing was saved.`); return 1; }
      out(`! Could not confirm the token with the CRM (${e.message}). Saving it anyway; the CRM may have owner calls switched off.`);
    }
    saveOwnerCallSecrets({ handle, token }, { run: runSec });
    out(`✓ Saved. This Mac will only ever call ${maskHandle(handle)}. Next: kingmaker owner-call doctor, then kingmaker owner-call on.`);
    return 0;
  }
  const config = readOwnerCallConfig(paths);
  const s = loadSecrets();
  if (sub === 'doctor') {
    const report = await doctor({ paths, config, secrets: s, roninLocked });
    for (const line of doctorLines(report)) out(line);
    return report.ok ? 0 : 1;
  }
  if (sub === 'on') {
    const report = await doctor({ paths, config, secrets: s, roninLocked });
    if (!report.ok) { for (const line of doctorLines(report)) out(line); err('✗ Owner calls stay off until every ✗ above is fixed.'); return 1; }
    writeOwnerCallConfig(paths, { enabled: true });
    out('✓ Owner calls are on. Restart Kingmaker to start polling the CRM (kingmaker stop, then kingmaker start).');
    return 0;
  }
  if (sub === 'test') {
    const report = await doctor({ paths, config, secrets: s, roninLocked });
    if (!report.ok) { for (const line of doctorLines(report)) out(line); err('✗ Fix every ✗ above first.'); return 1; }
    out(`This places a real FaceTime Audio call to ${maskHandle(s.handle)} now, speaks a short test message and records one reply (printed here only; nothing goes to the CRM).`);
    const typed = String(await readAnswer({ prompt: 'Type "call me" to place it: ' }) ?? '').trim();
    if (typed !== 'call me') { out('No call placed.'); return 1; }
    const result = await place({ id: `self-test-${Date.now()}`, kind: 'message', caller: 'kingmaker', caller_name: 'Kingmaker' }, {
      transport: localSelfTestTransport({ out }), mac: macFor(config), handle: s.handle, sessionId: `local-${randomUUID()}`, voices: config.voices, log: () => {},
    });
    out(`Self-test outcome: ${result.outcome}${result.reason ? ` (${result.reason})` : ''}${result.error ? ` (${result.error})` : ''}`);
    return ['reply', 'silence'].includes(result.outcome) ? 0 : 1;
  }
  err('Usage: kingmaker owner-call setup | doctor | test | on | off | status');
  return 2;
}

/** The owner-call Keychain items the duress switch destroys with the core's (lib/duress.mjs KEYCHAIN_ITEMS). */
export const DURESS_KEYCHAIN_ITEMS = Object.freeze([
  { service: 'ronin-crm-prod', account: 'KINGMAKER_OWNER_CALL_TOKEN', what: 'owner-call token' },
  { service: 'ronin-crm-prod', account: 'KINGMAKER_OWNER_CALL_HANDLE', what: 'owner-call handle' },
]);
