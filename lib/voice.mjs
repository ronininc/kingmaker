// The voice stack with no window: macOS microphone → endpointing → the bundled whisper.cpp → a governed
// turn → Kokoro (Apple's `say` as the fallback). Nothing stays resident between utterances (whisper loads per utterance).
//
// Authority: every voice turn is sent as mode 'voice' with a solvox2 owner attestation minted for the exact
// text sent (owner-voice.mjs). The server's PrincipalVerifier re-checks it: only the enrolled owner's live
// voice becomes owner_voice and can approve ("yes, go ahead"); anything else (no print, another voice,
// Kingmaker's own echo, a replayed token, speech over Kingmaker) stays unverified voice: ask, answer, propose.
// The wake phrase is never sent, so it can never approve anything.
//
// No raw audio touches the disk: whisper reads the WAV on stdin, the speaker sidecar gets PCM on stdin, and
// each utterance's samples (and its embedding) are zero-filled once it is handled.

import { noteHeard, replyLanguage, voiceFor } from './lang.mjs';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMicProbe } from './health.mjs';
import { DEFAULT_WAKE_WORD, matchWakeWord, wakeWordForms } from './install-config.mjs';

export const SAMPLE_RATE = 16_000;

// ── wake word ────────────────────────────────────────────────────────────────
/**
 * The operator's wake phrases from the spotter's keywords file ("▁KI NG MA KER @hey_kingmaker" → "hey kingmaker",
 * "kingmaker"). Never a hardcoded name: the file is what the desktop spotter hears. Pure.
 */
export function wakePhrasesFromKeywords(text) {
  const out = new Set();
  for (const line of String(text ?? '').split('\n')) {
    const label = /@([\w-]+)\s*$/.exec(line.trim())?.[1];
    if (!label) continue;
    const phrase = label.replace(/[_-]+/g, ' ').trim().toLowerCase();
    if (!phrase) continue;
    out.add(phrase);
    const bare = phrase.replace(/^(hey|ok|okay|hi|yo)\s+/, '');
    if (bare && bare !== phrase) out.add(bare);
  }
  return [...out].sort((a, b) => b.length - a.length);
}

export function readWakePhrases(files, read = (p) => readFileSync(p, 'utf8')) {
  for (const file of files) {
    try {
      const phrases = wakePhrasesFromKeywords(read(file));
      if (phrases.length) return phrases;
    } catch { /* next */ }
  }
  return [];
}

/** {addressed, command}: strips a leading wake phrase. Pure. */
export function splitWake(transcript, phrases) {
  const text = String(transcript ?? '').trim();
  const norm = text.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, ' ').replace(/\s+/g, ' ').trim();
  for (const phrase of phrases) {
    if (norm === phrase) return { addressed: true, command: '' };
    if (norm.startsWith(`${phrase} `)) {
      // Consume the phrase's words from the ORIGINAL tokens: one token can hold two words ("king-maker").
      const tokens = text.split(/\s+/);
      let words = phrase.split(' ').length;
      let at = 0;
      while (at < tokens.length && words > 0) {
        words -= tokens[at].toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, ' ').trim().split(/\s+/).filter(Boolean).length;
        at += 1;
      }
      const command = tokens.slice(at).join(' ').replace(/^[\s,.:;!?-]+/, '').trim();
      return { addressed: true, command };
    }
  }
  return { addressed: false, command: text };
}

// ── sleep / wake ─────────────────────────────────────────────────────────────
// The wake word is CEMENTED at install (install-config.mjs: Kingmaker Installer writes it, default "Kingmaker"), and
// its mishearings are generated from it (wakeWordForms / matchWakeWord), never hardcoded. A legacy install (Sol Ghost
// from before the installer, no install.json) wakes on the default "Kingmaker" and ALSO on the old names: "ghost",
// "hey ghost" and "Sol Ghost" as the recogniser spells it (operator 2026-10-07: "it's still not activating for me when
// I speak its name"). Once a word is cemented, only that word and its mishearings wake it.
const LEGACY_NAME_FORMS = ['sol ghost', 'solghost', 'soul ghost', 'sole ghost', 'saul ghost'];
export const LEGACY_WAKE_PHRASES = Object.freeze([
  ...LEGACY_NAME_FORMS.flatMap((n) => [`hey ${n}`, `${n} wake up`, `wake up ${n}`, `ok ${n}`, `okay ${n}`, n]),
  'ghost wake up', 'hey ghost', 'wake up ghost', 'ghost',
]);
/** Legacy installs only: the old names that still address it besides the default word. */
export const LEGACY_NAMES = Object.freeze(['sol ghost', 'ghost']);
/** What a legacy install (no cemented word) wakes on: the default word's forms first, then the old Ghost names. */
export const DEFAULT_WAKE_PHRASES = Object.freeze([...new Set([...wakeWordForms(DEFAULT_WAKE_WORD).phrases, ...LEGACY_WAKE_PHRASES])]);
const spokenVariants = (word) => wakeWordForms(word).variants.filter((v) => !v.includes('-'));
const DEFAULT_NAMES = Object.freeze([...spokenVariants(DEFAULT_WAKE_WORD), ...LEGACY_NAMES]);
const sleepFor = (names) => ['go to sleep', ...names.flatMap((n) => [`${n} go to sleep`, `go to sleep ${n}`, `${n} sleep`])];
export const DEFAULT_SLEEP_PHRASES = Object.freeze(sleepFor(DEFAULT_NAMES));

/**
 * What wakes this install. `install` = readInstallConfig(paths.state). Cemented: the word's own forms only; the
 * environment's SOL_GHOST_WAKE_PHRASES and the desktop spotter's word are ignored (the word is cemented). Legacy:
 * SOL_GHOST_WAKE_PHRASES (or the default word plus the old Ghost names), then the operator's desktop wake word from
 * the spotter file. Pure. → { word, phrases, names, sleepPhrases, cemented, ignored }
 */
export function wakeSetup({ install = null, env = process.env, spotter = [] } = {}) {
  if (install?.cemented) {
    const names = spokenVariants(install.wakeWord);
    const ignored = String(env.SOL_GHOST_WAKE_PHRASES || '').trim() ? ['SOL_GHOST_WAKE_PHRASES'] : [];
    return { word: install.wakeWord, phrases: wakeWordForms(install.wakeWord).phrases, names, sleepPhrases: sleepFor(names), cemented: true, ignored };
  }
  const custom = String(env.SOL_GHOST_WAKE_PHRASES || '').split(',').map((p) => p.trim()).filter(Boolean);
  return { word: DEFAULT_WAKE_WORD, phrases: [...new Set([...(custom.length ? custom : DEFAULT_WAKE_PHRASES), ...spotter])], names: [...DEFAULT_NAMES], sleepPhrases: [...DEFAULT_SLEEP_PHRASES], cemented: false, ignored: [] };
}

// MUTE and OFF in his own words (operator 2026-10-07: "a ghost mute command to make it stop listening, send it to
// sleep until called again, in addition to the off switch, so that I can say colloquial phrases that mean shut down
// and it does so"). Whole utterances only (after its name, if said), so "shut down the Mac" or "quit Spotify" still
// go to the engine. Mute = asleep with the microphone OFF until it is called again; off = Kingmaker stops. Its own name
// may trail either one ("go to sleep, Kingmaker").
const escapeRx = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const tailRx = (names) => String.raw`(?:\s+(?:thanks|thank you|please|for now|now|buddy|man${names.map((n) => `|${escapeRx(normPhrase(n))}`).join('')}))*`;
const MUTE_BODY = String.raw`(?:(?:ok|okay|alright|all right|thanks|thank you|cool|great)\s+)*(?:(?:you can|please|just|go ahead and)\s+)?(?:go to sleep|sleep|go quiet|mute(?: yourself)?|stop listening|quit listening|stop listening to me|be quiet|quiet|hush|shush|shut up|stand by|standby|take a break|rest|that's all|thats all|that's it|thats it|that's enough|thats enough|that will be all|that'll be all|thatll be all|i'm done|im done|i'm good|im good|we're done|were done|good night|goodnight|you can go|dismissed|later|see you|bye|goodbye)`;
const offBody = (names) => String.raw`(?:please\s+)?(?:shut (?:yourself )?down|shut off|turn (?:yourself )?off|switch (?:yourself )?off|power (?:yourself )?(?:off|down)|go offline|log off|quit|exit${names.map((n) => { const x = escapeRx(normPhrase(n)); return `|turn off ${x}|${x} off|shut ${x} down|turn ${x} off`; }).join('')})`;
const rxCache = new Map();
function commandRx(kind, names) {
  const key = `${kind}\u0000${names.join('\u0000')}`;
  if (!rxCache.has(key)) rxCache.set(key, new RegExp(`^${kind === 'mute' ? MUTE_BODY : offBody(names)}${tailRx(names)}$`));
  return rxCache.get(key);
}
/** Pure: does this whole utterance (name already stripped) mean "go quiet until I call you"? */
export function isMuteCommand(text, names = DEFAULT_NAMES) { return commandRx('mute', names).test(normPhrase(text)); }
/** Pure: does this whole utterance mean "turn Kingmaker off"? */
export function isOffCommand(text, names = DEFAULT_NAMES) { return commandRx('off', names).test(normPhrase(text)); }

/** Heard while already awake, these get "I'm here." locally: never a command sent to the engine. */
export const AWAKE_CHECK_PHRASES = Object.freeze(['wake up', 'are you there', 'you there', 'are you awake', 'you awake', 'are you listening']);

function normPhrase(t) { return String(t ?? '').toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, ' ').replace(/\s+/g, ' ').trim(); }

/**
 * Always on, asleep by default. Asleep, only its name does anything (nothing else heard is sent anywhere): an exact
 * wake phrase, or the wake word as the recogniser heard it (matchWakeWord: "king maker", "Kingmakers"). Awake, every
 * utterance is a command with no wake word, until a sleep phrase or `idleMs` of silence. Waking is activation only:
 * it never approves anything. Pure: handle(transcript, nowMs) → {action, text}. With no options it is a legacy
 * install's state (the default word and the old Ghost names); a cemented install passes wakeSetup()'s fields.
 */
export function createWakeState({ wakePhrases, wakeWord = DEFAULT_WAKE_WORD, names = DEFAULT_NAMES, sleepPhrases, idleMs = 120_000 } = {}) {
  const wakes = [...new Set((wakePhrases ?? DEFAULT_WAKE_PHRASES).map(normPhrase).filter(Boolean))].sort((a, b) => b.length - a.length);
  const sleeps = [...new Set((sleepPhrases ?? sleepFor(names)).map(normPhrase).filter(Boolean))];
  const addressedBy = (transcript) => {
    const exact = splitWake(transcript, wakes);
    return exact.addressed || !wakeWord ? exact : matchWakeWord(transcript, wakeWord);
  };
  let awakeUntil = 0;
  return {
    get awake() { return awakeUntil > 0; },
    handle(transcript, now = Date.now()) {
      if (awakeUntil && now > awakeUntil) awakeUntil = 0;
      const said = normPhrase(transcript);
      if (!said) return { action: 'ignore', text: '' };
      // Off and mute work awake, or asleep when called by name first ("Kingmaker, shut down").
      const call = addressedBy(transcript);
      const cmd = call.addressed ? normPhrase(call.command) : said;
      if ((awakeUntil || call.addressed) && cmd && isOffCommand(cmd, names)) { awakeUntil = 0; return { action: 'off', text: '' }; }
      if ((awakeUntil || call.addressed) && cmd && (sleeps.includes(cmd) || isMuteCommand(cmd, names))) { awakeUntil = 0; return { action: 'sleep', text: '' }; }
      if (awakeUntil && AWAKE_CHECK_PHRASES.includes(said)) { awakeUntil = now + idleMs; return { action: 'wake', text: '' }; }
      if (call.addressed) {
        awakeUntil = now + idleMs;
        return call.command && !sleeps.includes(normPhrase(call.command)) ? { action: 'command', text: call.command, woke: true } : { action: 'wake', text: '' };
      }
      if (!awakeUntil) return { action: 'ignore', text: '' };
      awakeUntil = now + idleMs;
      return { action: 'command', text: String(transcript).trim() };
    },
    touch(now = Date.now()) { if (awakeUntil) awakeUntil = now + idleMs; },
    /** Woken from outside (the kingmaker://wake link Siri opens): awake now, no wake word needed for the next words. */
    wakeNow(now = Date.now()) { awakeUntil = now + idleMs; },
    sleep() { awakeUntil = 0; },
  };
}

/** Whisper's non-speech placeholders ("[BLANK_AUDIO]", "(music)") and empty strings. Pure. */
export function isNonSpeech(text) {
  const t = String(text ?? '').trim();
  return !t || /^[[(][^\])]*[\])]$/.test(t) || /^\W+$/.test(t);
}

// ── endpointing ──────────────────────────────────────────────────────────────
/**
 * Energy endpointer over 16 kHz mono s16le. push(Buffer) → completed utterances ({samples: Int16Array,
 * speechMs}[]; speechMs counts voiced frames only, never the pre-roll or the trailing silence, so it can only
 * under-state). The noise floor adapts on non-speech frames, so a fan or a quiet room both work. Pure (no I/O).
 */
export function createSegmenter({
  frameMs = 30, ratio = 3, absMin = 350, startFrames = 3, endSilenceMs = 750, maxMs = 15_000, minSpeechMs = 350,
} = {}) {
  const frameLen = (SAMPLE_RATE / 1000) * frameMs;
  let floor = 200;
  let carry = new Int16Array(0);
  let voicedRun = 0;
  let inSpeech = false;
  let silenceMs = 0;
  let speechMs = 0;
  let frames = [];
  let pre = [];

  const rms = (f) => { let s = 0; for (let i = 0; i < f.length; i += 1) s += f[i] * f[i]; return Math.sqrt(s / f.length); };

  function push(buffer) {
    const incoming = new Int16Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.byteLength / 2));
    const all = new Int16Array(carry.length + incoming.length);
    all.set(carry); all.set(incoming, carry.length);
    const done = [];
    let at = 0;
    for (; at + frameLen <= all.length; at += frameLen) {
      const frame = all.slice(at, at + frameLen);
      const level = rms(frame);
      const voiced = level > Math.max(floor * ratio, absMin);
      if (!inSpeech) {
        if (!voiced) floor = floor * 0.95 + level * 0.05;
        pre.push(frame); if (pre.length > startFrames + 5) pre.shift();
        voicedRun = voiced ? voicedRun + 1 : 0;
        if (voicedRun >= startFrames) { inSpeech = true; frames = [...pre]; speechMs = voicedRun * frameMs; silenceMs = 0; pre = []; }
        continue;
      }
      frames.push(frame);
      if (voiced) { speechMs += frameMs; silenceMs = 0; } else silenceMs += frameMs;
      if (silenceMs >= endSilenceMs || frames.length * frameMs >= maxMs) {
        if (speechMs >= minSpeechMs) done.push({ samples: concat(frames), speechMs });
        inSpeech = false; frames = []; voicedRun = 0; silenceMs = 0; speechMs = 0;
      }
    }
    carry = all.slice(at);
    return done;
  }
  function reset() { carry = new Int16Array(0); inSpeech = false; frames = []; pre = []; voicedRun = 0; silenceMs = 0; speechMs = 0; }
  return { push, reset, get floor() { return floor; }, get inSpeech() { return inSpeech; } };
}

/**
 * PUSH-TO-TALK (operator 2026-10-15: "bind the speak and barge in to the fn key as default … assumes they aren't done
 * until the person releases the key"). While the key is held every chunk is kept, pauses included: no end-of-speech
 * guess cuts the command short. Released → the whole hold is one utterance, or nothing when it was too short or
 * silent. Pure apart from the clock.
 */
export function createPushToTalk({ minMs = 300, absMin = 350, frameMs = 30, now = Date.now } = {}) {
  let chunks = [];
  let held = false;
  let since = 0;
  let last = null;
  return {
    get held() { return held; },
    down() { held = true; chunks = []; since = now(); },
    push(buffer) { if (held) chunks.push(new Int16Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.byteLength / 2)).slice()); },
    cancel() { held = false; chunks = []; },
    /** → { samples, speechMs, heldMs } or null (too short, or nothing louder than the room). */
    up() {
      if (!held) return null;
      held = false;
      const samples = concat(chunks); chunks = [];
      const heldMs = now() - since;
      const frameLen = (SAMPLE_RATE / 1000) * frameMs;
      let voiced = 0;
      for (let at = 0; at + frameLen <= samples.length; at += frameLen) {
        let s = 0; for (let i = at; i < at + frameLen; i += 1) s += samples[i] * samples[i];
        if (Math.sqrt(s / frameLen) > absMin) voiced += 1;
      }
      const speechMs = voiced * frameMs;
      // What the hold actually captured, for the voice log: silence from a mic macOS isn't letting through reads as
      // audio with peak 0; no audio at all reads as audioMs 0.
      let peak = 0; for (let i = 0; i < samples.length; i += 1) { const v = Math.abs(samples[i]); if (v > peak) peak = v; }
      last = { heldMs, audioMs: Math.round(samples.length / (SAMPLE_RATE / 1000)), peak, speechMs };
      if (heldMs < minMs || speechMs < minMs) return null;
      return { samples, speechMs, heldMs };
    },
    get last() { return last; },
    /** The audio held so far (a copy), for live dictation while the key is still down. */
    snapshot() { return concat(chunks); },
  };
}

function concat(frames) {
  const out = new Int16Array(frames.reduce((n, f) => n + f.length, 0));
  let o = 0; for (const f of frames) { out.set(f, o); o += f.length; }
  return out;
}

/** 16-bit PCM WAV bytes. Pure. */
export function wavBytes(samples, sampleRate = SAMPLE_RATE) {
  const data = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sampleRate, 24); h.writeUInt32LE(sampleRate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

// ── native I/O ───────────────────────────────────────────────────────────────
function run(cmd, args, { timeoutMs = 30_000, input } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    if (input) { child.stdin.on('error', () => {}); child.stdin.end(input); }
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.once('error', (e) => { clearTimeout(timer); resolve({ code: -1, out, err: String(e.message) }); });
    child.once('exit', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

/** whisper.cpp reads the WAV on stdin (`-f -`) and prints the text on stdout (`-otxt -of -`): no file. With
 *  language 'auto' (the default: Kingmaker hears any language) it also says on stderr which language it heard
 *  ("auto-detected language: es (p = 0.95)"), and that becomes the conversation's language (lib/lang.mjs). */
/** whisper's initial prompt: the owner's own vocabulary, so words it would otherwise mishear (CRM → "serum") land.
 *  Kept short; domain terms and the project's own names, not a sentence. The caller can extend it (team/merchant names). */
export const OWNER_VOCAB_WORDS = Object.freeze(['Kingmaker', 'CRM', 'Kronos', 'Oversight', 'merchant', 'run sheet']);
let vocab = `Vocabulary: ${OWNER_VOCAB_WORDS.join(', ')}.`;
/** The default prompt, read at each call: the core's words, plus what an add-on adds (its people and products). */
export const ownerVocab = () => vocab;
/** An add-on's words join the default vocabulary (lib/cli.mjs, at start). Bounded like any prompt. */
export function extendVocabulary(words = []) {
  const extra = [...new Set(words.map((w) => String(w).replace(/[^\p{L}\p{N} '-]/gu, '').trim()).filter(Boolean))].slice(0, 40);
  vocab = `Vocabulary: ${[...OWNER_VOCAB_WORDS, ...extra].join(', ')}.`;
}
/** Kept for callers that read it as a constant: the core's words alone. */
export const OWNER_VOCAB = `Vocabulary: ${OWNER_VOCAB_WORDS.join(', ')}.`;

export async function transcribe(samples, { whisper, model, language = 'auto', onLanguage = noteHeard, prompt = ownerVocab() } = {}) {
  const wav = wavBytes(samples);
  try {
    const auto = language === 'auto';
    // `prompt` is whisper.cpp's initial prompt: an owner-vocabulary hint (names, products, jargon the meeting uses)
    // so homophones resolve to the words the owner actually says. OWNER_VOCAB unless the caller passes its own (a
    // meeting's names); trimmed and length-bounded.
    const bias = String(prompt ?? '').replace(/\s+/g, ' ').trim().slice(0, 900);
    const r = await run(whisper, ['-m', model, '-f', '-', '-l', language, '-nt', ...(auto ? [] : ['-np']), ...(bias ? ['--prompt', bias] : []), '-otxt', '-of', '-'], { timeoutMs: 30_000, input: wav });
    const m = auto ? /auto-detected language: ([a-z]{2,3}) \(p = ([\d.]+)\)/.exec(r.err || '') : null;
    if (m && r.code === 0) onLanguage({ code: m[1], p: Number(m[2]) });
    return r.code === 0 ? r.out.replace(/\s+/g, ' ').trim() : '';
  } finally { wav.fill(0); }
}

/** Apple's own voice, headless and zero-resident. {done, stop}: stop() cuts it off at once (barge-in). */
let onMissingVoice = () => {};
/** Told (once per language) when an answer is in a language this Mac has no voice for. */
export function setMissingVoiceHandler(fn) { const told = new Set(); onMissingVoice = (code) => { if (!told.has(code)) { told.add(code); fn(code); } }; }

export function speakSay(text, { voice = process.env.SOL_GHOST_SAY_VOICE } = {}) {
  const line = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 1200);
  if (!line) return { done: Promise.resolve(), stop: () => {} };
  const child = spawn('/usr/bin/say', [...(voice ? ['-v', voice] : []), line], { stdio: 'ignore' });
  audibleWhile(child);
  const done = new Promise((resolve) => { child.once('exit', resolve); child.once('error', resolve); });
  return { done, stop: () => { try { child.kill('SIGKILL'); } catch { /* already done */ } } };
}

// Whether a reply is audible right now (afplay or `say` running), not just "a reply is on its way". Kokoro spends a
// second or two synthesising before a sound plays; barge-in must not learn the person's voice as echo in that gap.
let audibleCount = 0;
export const isAudible = () => audibleCount > 0;
function audibleWhile(child) {
  audibleCount += 1;
  let done = false;
  const end = () => { if (!done) { done = true; audibleCount -= 1; } };
  child.once('exit', end); child.once('error', end);
}

// ── Kokoro: the reply voice ──────────────────────────────────────────────────
// Kingmaker spoke with `say` alone, so it sounded like whatever system voice the Mac had (the compact default on
// a new Mac: "the kingmaker voice degraded", operator 2026-10-08) while the desktop app speaks with Kokoro.
// The same bundled server (voice-runtime/tts/kokoro-ane-server) now speaks Kingmaker's replies: one resident
// process on the Neural Engine, started on first use or by warmVoice(), JSON lines on stdin
// ({id, text, out, voice} → {event: "synthesized", id, out}). It holds the event loop only while a line is in
// flight, so a one-shot CLI still exits. Any failure, or a server not ready in time, falls back to `say` for that
// line. SOL_GHOST_TTS=say keeps Apple's voice; SOL_GHOST_KOKORO_VOICE picks the Kokoro voice (default af_heart).
export const KOKORO_READY_MS = 4_000;
export const KOKORO_SYNTH_MS = 20_000;
let kokoro = null;
let kokoroSeq = 0;

function defaultKokoroExecutable() {
  // Lazy: paths.mjs is only needed once something speaks.
  return import('./paths.mjs').then(({ resolvePaths }) => resolvePaths().voice.kokoro).catch(() => null);
}

function kokoroServer(exe, { spawnImpl = spawn } = {}) {
  if (kokoro && kokoro.exe === exe && !kokoro.dead) return kokoro;
  const proc = spawnImpl(exe, [], { stdio: ['pipe', 'pipe', 'ignore'] });
  const s = { exe, proc, dead: false, waiters: new Map(), buf: '', isReady: false };
  s.ready = new Promise((resolve) => { s.markReady = resolve; });
  const hold = (on) => { try { on ? (proc.ref(), proc.stdout.ref?.()) : (proc.unref(), proc.stdout.unref?.(), proc.stdin.unref?.()); } catch { /* gone */ } };
  s.hold = hold;
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk) => {
    s.buf += chunk;
    for (let i = s.buf.indexOf('\n'); i >= 0; i = s.buf.indexOf('\n')) {
      const raw = s.buf.slice(0, i); s.buf = s.buf.slice(i + 1);
      let ev; try { ev = JSON.parse(raw); } catch { continue; }
      if (ev.event === 'ready') { s.isReady = true; s.markReady(true); if (!s.waiters.size) hold(false); continue; }
      const w = s.waiters.get(String(ev.id));
      if (w) { s.waiters.delete(String(ev.id)); w(ev); if (!s.waiters.size) hold(false); }
    }
  });
  const gone = () => {
    if (s.dead) return; s.dead = true; s.markReady(false);
    for (const w of s.waiters.values()) w({ event: 'error', reason: 'server_exit' });
    s.waiters.clear();
  };
  proc.once('exit', gone); proc.once('error', gone);
  proc.stdin.on('error', gone);
  kokoro = s;
  return s;
}

/** Start the Kokoro server ahead of the first reply (its first load compiles for the Neural Engine). */
export async function warmVoice({ executable, exists = existsSync, spawnImpl = spawn } = {}) {
  if ((process.env.SOL_GHOST_TTS || 'kokoro') !== 'kokoro') return false;
  const exe = executable ?? await defaultKokoroExecutable();
  if (!exe || !exists(exe)) return false;
  const s = kokoroServer(exe, { spawnImpl });
  if (!s.isReady) s.hold(false);
  return true;
}

/** One line → a WAV path, or null (not ready in time, failed, or stopped). */
async function kokoroSynth(exe, line, voice, { spawnImpl = spawn, readyMs = KOKORO_READY_MS, synthMs = KOKORO_SYNTH_MS, cancelled = () => false } = {}) {
  const s = kokoroServer(exe, { spawnImpl });
  s.hold(true);
  const ready = s.isReady || await Promise.race([s.ready, new Promise((r) => setTimeout(r, readyMs, false))]);
  if (!ready || s.dead || cancelled()) { if (!s.waiters.size) s.hold(false); return null; }
  const dir = mkdtempSync(join(tmpdir(), 'kingmaker-say-'));
  const out = join(dir, 'reply.wav');
  const id = `k${++kokoroSeq}`;
  const ev = await new Promise((resolve) => {
    const timer = setTimeout(() => { s.waiters.delete(id); resolve({ event: 'error', reason: 'timeout' }); }, synthMs);
    s.waiters.set(id, (e) => { clearTimeout(timer); resolve(e); });
    try { s.proc.stdin.write(JSON.stringify({ id, text: line, out, voice }) + '\n'); }
    catch { s.waiters.delete(id); clearTimeout(timer); resolve({ event: 'error', reason: 'write_failed' }); }
  });
  if (!s.waiters.size) s.hold(false);
  if (ev.event !== 'synthesized' || !existsSync(out)) { rmSync(dir, { recursive: true, force: true }); return null; }
  return { out, dir };
}

/**
 * One line → a Kokoro WAV on disk ({out, dir}; the caller plays it and removes `dir`), or null when Kokoro is off,
 * not bundled, not ready in time or failed. For a caller that plays the line somewhere other than the default output
 * (owner-call.mjs plays it into the FaceTime call's microphone device); speak() keeps its own afplay path.
 */
export async function synthesizeKokoroWav(text, { voice = process.env.SOL_GHOST_KOKORO_VOICE || 'af_heart', engine = process.env.SOL_GHOST_TTS || 'kokoro', executable, exists = existsSync, spawnImpl = spawn } = {}) {
  const line = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 1200);
  if (!line || engine !== 'kokoro') return null;
  const exe = executable ?? await defaultKokoroExecutable();
  if (!exe || !exists(exe)) return null;
  return kokoroSynth(exe, line, voice, { spawnImpl }).catch(() => null);
}

// ── a question asked on waking ────────────────────────────────────────────────
export const OFFER_YES = /^(yes|yeah|yep|yup|sure|ok(ay)?|do it|go ahead|install( it)?|update( it)?|please do)\b/i;
export const OFFER_WHAT = /^(what('?s| is)? (it|in it|new|changed|the update)|tell me (more|about it|what('?s| is) (in it|new))|what does it (do|change)|what changed|details|hear (it|more))\b/i;
export const OFFER_NO = /^(no|nope|nah|not now|later|skip( it)?|don'?t|cancel)\b/i;
/**
 * One pending question (`set({prompt, onYes, onNo})`): asked aloud on the next wake; the next thing said is the answer.
 * "What's in it?" speaks `details` and asks again. Yes runs onYes, no runs onNo (each may return a line to speak) and clears it; anything else leaves it for the next wake and goes on as a command.
 */
export function createOfferQuestion({ say, log = () => {} }) {
  let pending = null;
  let asking = false;
  return {
    set(q) { pending = q; asking = false; },
    get pending() { return pending; },
    async ask() { if (!pending) return; asking = true; log('offer_asked', { id: pending.id }); await say(pending.prompt); },
    async answer(text) {
      if (!asking || !pending) return false;
      const said = String(text ?? '').trim().replace(/^[^a-z]+/i, '');
      asking = false;
      const q = pending;
      if (OFFER_YES.test(said)) { pending = null; log('offer_yes', { id: q.id }); const line = await q.onYes(); if (line) await say(line); return true; }
      // "What's in it?": hear the release notes, then the same question again (still no install without a yes).
      if (OFFER_WHAT.test(said)) { log('offer_what', { id: q.id }); await say(q.details || "I don't have notes for this one."); asking = true; await say(q.reprompt || 'Want me to install it? Say yes or no.'); return true; }
      if (OFFER_NO.test(said)) { pending = null; log('offer_no', { id: q.id }); const line = await q.onNo?.(); if (line) await say(line); return true; }
      return false;
    },
  };
}

/**
 * Speak a reply: Kokoro when it is bundled and answers, else Apple's `say`. {done, stop}: stop() cuts it off at
 * once (barge-in), during synthesis or playback.
 */
export function speak(text, { voice = process.env.SOL_GHOST_SAY_VOICE, kokoroVoice = process.env.SOL_GHOST_KOKORO_VOICE || 'af_heart', engine = process.env.SOL_GHOST_TTS || 'kokoro', executable, spawnImpl = spawn } = {}) {
  const line = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 1200);
  if (!line) return { done: Promise.resolve(), stop: () => {} };
  // Any language (lib/lang.mjs): Kokoro speaks English only, so another language speaks with the Mac's voice for it.
  const code = replyLanguage(line);
  if (code !== 'en') {
    const own = voiceFor(code);
    if (own) return speakSay(line, { voice: own });
    onMissingVoice(code);
    return speakSay(line, {});
  }
  if (engine !== 'kokoro') return speakSay(line, { voice });
  let stopped = false;
  let current = null;
  const done = (async () => {
    const exe = executable ?? await defaultKokoroExecutable();
    const wav = exe && existsSync(exe) ? await kokoroSynth(exe, line, kokoroVoice, { spawnImpl, cancelled: () => stopped }).catch(() => null) : null;
    if (stopped) { if (wav) rmSync(wav.dir, { recursive: true, force: true }); return; }
    if (!wav) { current = speakSay(line, { voice }); await current.done; return; }
    const child = spawnImpl('/usr/bin/afplay', [wav.out], { stdio: 'ignore' });
    audibleWhile(child);
    current = { stop: () => { try { child.kill('SIGKILL'); } catch { /* already done */ } } };
    await new Promise((resolve) => { child.once('exit', resolve); child.once('error', resolve); });
    rmSync(wav.dir, { recursive: true, force: true });
  })();
  return { done, stop: () => { stopped = true; current?.stop(); } };
}

/**
 * Barge-in while Kingmaker talks. The mic hears its own voice through the speakers, so the bar is
 * set from that echo: the first `warmupMs` of playback learn the echo level, then speech that stays
 * `ratio`× above it for `holdMs` is you talking over it. Pure: feed it chunk RMS levels with their ms.
 */
// Its own voice through the speakers kept cutting it off (live 2026-10-07, "the voice is hella choppy"): barge-ins
// fired at levels 1444 and 1406, just over the old 900 floor, while the mic clipped; the operator talking over it
// measured 6394. The floor and ratio now sit well above its own echo.
export function createBargeDetector({ ratio = 3, absMin = 3000, warmupMs = 500, holdMs = 300, guardMs = 700, onsetRatio = 2 } = {}) {
  // `say` is silent for its first few hundred ms. Learning the "echo" from that silence made Kingmaker's own
  // voice look like you talking over it, so it cut itself off. Now: room level until playback is audible,
  // then `warmupMs` of the echo itself, and never a barge-in inside the first `guardMs`.
  // `audible` (when the caller knows it): before any sound plays (Kokoro still synthesising) there is no echo to
  // learn, so speech well over the room level for `holdMs` IS a barge-in; the echo is learned only once sound plays
  // (live 2026-10-08: "barge-in works sometimes but not all": talking during synthesis was learned as the echo).
  let elapsed = 0; let room = 0; let roomN = 0; let onset = -1; let echo = 0; let echoN = 0; let over = 0; let quietOver = 0;
  return {
    push(level, ms, audible = null) {
      elapsed += ms;
      if (onset < 0) {
        if (audible === false) {
          if (roomN >= 2 && level > Math.max(room * ratio, absMin)) { quietOver += ms; return quietOver >= holdMs; }
          quietOver = 0; room = (room * roomN + level) / (roomN + 1); roomN += 1; return false;
        }
        if (roomN >= 2 && level > Math.max(room * onsetRatio, absMin / 3)) onset = elapsed;
        else { room = (room * roomN + level) / (roomN + 1); roomN += 1; return false; }
      }
      if (elapsed - onset <= warmupMs) { echo = Math.max(echo, level) * 0.5 + ((echo * echoN + level) / (echoN + 1)) * 0.5; echoN += 1; return false; }
      if (level > Math.max(echo * ratio, absMin)) over += ms; else { over = 0; echo = echo * 0.95 + Math.min(level, echo * ratio) * 0.05; }
      return elapsed - onset >= guardMs && over >= holdMs;
    },
    reset() { elapsed = 0; room = 0; roomN = 0; onset = -1; echo = 0; echoN = 0; over = 0; quietOver = 0; },
  };
}

export function chunkLevel(buffer) {
  const n = Math.floor(buffer.byteLength / 2);
  if (!n) return { level: 0, ms: 0 };
  const a = new Int16Array(buffer.buffer, buffer.byteOffset, n);
  let sum = 0; for (let i = 0; i < n; i += 1) sum += a[i] * a[i];
  return { level: Math.sqrt(sum / n), ms: (n / SAMPLE_RATE) * 1000 };
}

/** The default input device as 16 kHz mono s16le on stdout (sox; ffmpeg avfoundation as the fallback). */
export function openMicrophone({ sox = '/opt/homebrew/bin/sox', ffmpeg = '/opt/homebrew/bin/ffmpeg', exists, probe = false }) {
  // probe: is there a capture tool at all? Answers without opening the microphone.
  if (probe) return exists(sox) || exists(ffmpeg);
  // --buffer: a larger capture buffer, so a busy 8 GB Mac does not drop audio ("coreaudio: unhandled buffer overrun").
  if (exists(sox)) return spawn(sox, ['-q', '--buffer', '8192', '-d', '-t', 'raw', '-r', String(SAMPLE_RATE), '-e', 'signed', '-b', '16', '-c', '1', '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
  if (exists(ffmpeg)) return spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'avfoundation', '-i', ':0', '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 's16le', '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
  return null;
}

/**
 * One captured utterance → at most one governed turn. `utt` = {samples, speechMs, overlap, endedAt, utteranceId}.
 * It is transcribed and, when an owner voice is installed (`embed`/`attest`), the SAME audio is embedded and
 * the owner attestation is minted for exactly the command text that `onCommand` will POST. Only a command is
 * ever sent: a wake or sleep phrase never reaches the engine, so waking can never approve anything. Asleep, an
 * utterance is embedded only once it turns out to be addressed to Ghost. The samples and the embedding are
 * zero-filled before this resolves.
 */
export function createUtteranceHandler({ wake, transcribe: stt, embed = null, attest = null, onCommand, say, onState = () => {}, log = () => {}, resetSegmenter = () => {}, onTurn = () => {}, now = Date.now, onSleep = () => {}, onOff = () => {}, offer = null }) {
  // One voice-turn ledger record per command sent (voice-ledger.mjs): lengths and outcome only, never words.
  const recordTurn = (turn) => { try { onTurn(turn); } catch { /* observation never breaks a turn */ } };
  return async function handle(utt) {
    let early = null;
    let embedding = null;
    const startedAtMs = now();
    try {
      // Awake, nearly every utterance is a command: embed while whisper runs (the token must reach the
      // server within its 15 s age limit). Asleep, nothing heard is analysed beyond the wake check.
      if (embed && wake.awake) early = Promise.resolve(embed(utt)).catch(() => null);
      const heard = await stt(utt.samples);
      if (isNonSpeech(heard)) return { action: 'ignore' };
      const step = wake.handle(heard);
      if (step.action === 'ignore') { log('asleep_ignored', { chars: heard.length }); return step; }
      if (step.action === 'off') { log('off'); await say('Shutting down. Say "Hey Siri, wake Kingmaker" to bring me back.'); onState('asleep'); onOff(); return step; }
      if (step.action === 'sleep') { log('sleep'); await say('Going quiet.'); resetSegmenter(); onState('asleep'); onSleep(); return step; }
      if (step.action === 'wake') { log('wake'); onState('awake'); await say("I'm here."); await offer?.ask(); resetSegmenter(); onState('awake'); return step; }
      // A waiting question (a new update) takes the next words first: only a spoken yes installs it.
      if (offer && await offer.answer(step.text)) { resetSegmenter(); onState('awake'); return { action: 'offer' }; }
      log('heard', { text: step.text, woke: step.woke === true });
      onState('thinking');
      let owner = null;
      if (attest) {
        embedding = early ? await early : (embed ? await Promise.resolve(embed(utt)).catch(() => null) : null);
        early = null;
        owner = attest({ embedding, utt, transcript: step.text });
        log('owner_decision', { reason: owner?.decision?.reason ?? 'none', similarity: owner?.decision?.similarity ?? null, speechMs: utt.speechMs, overlap: utt.overlap === true, attested: Boolean(owner?.token) });
      }
      // The bottom-centre transcript line (Kingmaker.app) shows the words only once the voice check says they are the
      // owner's (operator 2026-10-13): a bystander's words, or any turn with no voice check, are never shown.
      // Keep the newest 280 code points (matching the panel's own defensive trim), so an emoji is never split and a
      // long command still shows its operative ending rather than only its preamble.
      if (owner?.token) {
        const points = Array.from(step.text);
        onState('thinking', { heard: points.length > 280 ? `…${points.slice(-279).join('')}` : step.text });
      }
      let result;
      try {
        result = await onCommand(step.text, { attestation: owner?.token ?? null, decision: owner?.decision ?? null });
      } catch (error) {
        recordTurn({ startedAtMs, outcome: 'failed', reason: 'turn_error', transcriptChars: step.text.length });
        throw error;
      }
      recordTurn({
        startedAtMs,
        outcome: result?.ok === false ? 'failed' : 'completed',
        reason: result?.ok === false ? (result.reason ?? 'turn_failed') : null,
        route: result?.route ?? null,
        disposition: result?.disposition ?? null,
        internetUsed: result?.internetUsed === true,
        transcriptChars: step.text.length,
        answerChars: Number(result?.answerChars) || 0,
        spoke: result?.spoke === true,
      });
      wake.touch();
      resetSegmenter();
      onState(wake.awake ? 'awake' : 'asleep');
      return step;
    } finally {
      utt.samples?.fill?.(0);
      embedding?.fill?.(0);
      if (early) early.then((e) => e?.fill?.(0));
    }
  };
}

/**
 * The live loop. `onCommand(text, {attestation, decision})` runs a governed turn, speaks its reply through
 * `say`, and returns {followUp}. While `isSpeaking()` the mic only listens for barge-in (talking over Kingmaker
 * stops it at once); an utterance that was being captured when Kingmaker started speaking is marked as captured
 * during narration, so it can never be the owner's word. `ownerVoice` (owner-voice.mjs) is optional: without
 * it every turn carries no attestation and stays unverified voice.
 */
export async function runVoiceCommandUnderInteractionLease(text, meta, { interactionOwner = () => null, onSuppressed = () => {}, onCommand }) {
  const owner = interactionOwner();
  if (owner) {
    await onSuppressed({ type: 'voice_command_suppressed', owner, text });
    return { followUp: false, ok: false, spoke: false, suppressed: owner };
  }
  return onCommand(text, meta);
}

export function startVoiceLoop({ paths, exists, onCommand, say, isSpeaking, interrupt = () => {}, onState = () => {}, log = () => {}, language = process.env.SOL_GHOST_LANG || 'auto', ownerVoice = null, onTurn = () => {}, onMic = () => {}, openMic = openMicrophone, onOff = () => {}, listenWhileAsleep = process.env.SOL_GHOST_LISTEN_ASLEEP === '1', install = null, interactionOwner = () => null, onSuppressed = () => {} }) {
  // The cemented wake word (install-config.mjs) and its mishearings; a legacy install also keeps the old Ghost names
  // and the operator's desktop wake word from the spotter file.
  const setup = wakeSetup({ install, env: process.env, spotter: install?.cemented ? [] : readWakePhrases(paths.voice.wakeKeywords) });
  const phrases = setup.phrases;
  const wake = createWakeState({ wakePhrases: phrases, wakeWord: setup.word, names: setup.names, sleepPhrases: setup.sleepPhrases });
  if (!exists(paths.voice.whisper) || !exists(paths.voice.sttModel)) return { ok: false, reason: 'the bundled whisper.cpp or its model is missing from Solomon.app' };
  // The microphone's real state, from what the capture actually delivers (health.mjs createMicProbe).
  const micProbe = createMicProbe({ onChange: (state) => { log('mic_state', { state }); onMic(state); } });
  // ASLEEP = EARS OFF (operator 2026-10-07: "right now it looks always on, which isn't great for my CPU or for
  // people's peace of mind"). The microphone runs only while awake; asleep nothing is captured or transcribed, and
  // "Hey Siri, wake Kingmaker" (kingmaker://wake → wakeNow) opens it again. SOL_GHOST_LISTEN_ASLEEP=1 keeps the old
  // always-listening wake word.
  let mic = null;
  let reopens = [];
  if (!openMic({ exists, probe: true })) { micProbe.unavailable(); return { ok: false, reason: 'no microphone tool (brew install sox)' }; }
  // The reply voice loads now, so the first answer isn't spoken by `say` while Kokoro compiles.
  warmVoice({ exists }).catch(() => {});

  // A question Kingmaker asks the moment it is woken (a new update): spoken consent only (operator 2026-10-08).
  const offerQuestion = createOfferQuestion({ say, log });
  const segmenter = createSegmenter();
  // True when Kingmaker spoke while the utterance now being captured was in progress.
  let capturedOverNarration = false;
  const handle = createUtteranceHandler({
    wake, say, onState, log, onCommand: (text, meta) => runVoiceCommandUnderInteractionLease(text, meta, { interactionOwner, onSuppressed, onCommand }), onTurn, offer: offerQuestion,
    transcribe: (samples) => transcribe(samples, { whisper: paths.voice.whisper, model: paths.voice.sttModel, language }),
    embed: ownerVoice?.embed ?? null,
    attest: ownerVoice?.attest ?? null,
    resetSegmenter: () => { segmenter.reset(); capturedOverNarration = false; },
    onSleep: () => { if (!listenWhileAsleep) closeEars('asleep'); },
    onOff: () => { closeEars('off'); onOff(); },
  });
  let busy = false;
  const queue = [];

  async function drain() {
    if (busy) return;
    busy = true;
    try {
      while (queue.length) {
        const utt = queue.shift();
        try { await handle(utt); } catch (error) { log('utterance_failed', { message: String(error?.message || error).slice(0, 160) }); }
      }
    } finally { busy = false; }
  }

  const barge = createBargeDetector();
  let wasSpeaking = false;
  let lastAwake = false;
  const idleWatch = setInterval(() => {
    if (interactionOwner()) { wake.sleep(); onState('asleep'); closeEars('governed-session'); lastAwake = false; return; }
    if (listenWhileAsleep && !mic) openEars();
    if (lastAwake && !wake.awake) { onState('asleep'); if (!listenWhileAsleep) closeEars('idle'); }
    lastAwake = wake.awake;
  }, 1_000);
  idleWatch.unref?.();
  const ptt = createPushToTalk();
  const onAudio = (chunk) => {
    // Push-to-talk: the whole hold is the command (nothing is segmented, no barge detector: the key already barged in).
    if (ptt.held) { if (micProbe.state !== 'granted') { const { level, ms } = chunkLevel(chunk); micProbe.push(level, ms); } ptt.push(chunk); return; }
    const leaseOwner = interactionOwner();
    if (leaseOwner) { void onSuppressed({ type: 'microphone_suppressed', owner: leaseOwner, text: '' }); wake.sleep(); closeEars('governed-session'); onState('asleep'); return; }
    if (micProbe.state !== 'granted') { const { level, ms } = chunkLevel(chunk); micProbe.push(level, ms); }
    if (isSpeaking()) {
      if (segmenter.inSpeech) capturedOverNarration = true;
      if (!wasSpeaking) { barge.reset(); wasSpeaking = true; }
      const { level, ms } = chunkLevel(chunk);
      if (process.env.SOL_GHOST_BARGE !== '0' && barge.push(level, ms, isAudible())) {
        log('barge_in', { level: Math.round(level) });
        interrupt();
        wake.touch(); // still awake: what you say next is the command
        segmenter.reset();
        capturedOverNarration = false;
      }
      return;
    }
    wasSpeaking = false;
    const before = segmenter.inSpeech;
    if (!before) capturedOverNarration = false; // anything completed in this chunk started after Kingmaker spoke
    for (const { samples, speechMs } of segmenter.push(chunk)) {
      queue.push({ samples, speechMs, overlap: capturedOverNarration, endedAt: Date.now(), utteranceId: ownerVoice?.newUtteranceId?.() ?? null });
      capturedOverNarration = false;
    }
    // The indicator only says "hearing you" while awake; asleep it is listening for the wake phrase alone.
    if (wake.awake && segmenter.inSpeech !== before) onState(segmenter.inSpeech ? 'hearing' : 'awake');
    if (queue.length) void drain();
  };
  function openEars() {
    if (!powered) return false; // OFF from the Kingmaker bar: the microphone stays shut until it's turned on
    const leaseOwner = interactionOwner();
    if (leaseOwner) { void onSuppressed({ type: 'microphone_open_suppressed', owner: leaseOwner, text: '' }); return false; }
    if (mic) return true;
    const m = openMic({ exists });
    if (!m) { micProbe.unavailable(); return false; }
    mic = m;
    segmenter.reset();
    m.stdout.on('data', onAudio);
    m.stderr.on('data', (d) => log('mic_stderr', { line: String(d).trim().slice(0, 200) }));
    m.once('exit', (code, signal) => {
      log('mic_exit', { code, signal });
      if (mic !== m) return;
      mic = null;
      micProbe.exited();
      // Died on its own while awake (a device change, an overrun): reopen, at most 3 times a minute, so it never sits
      // "awake" and deaf. A close we asked for (sleep, off, stop) sets mic to null first and never comes here.
      const at = Date.now();
      reopens = reopens.filter((t) => at - t < 60_000);
      if (wake.awake && !interactionOwner() && reopens.length < 3) {
        reopens.push(at);
        log('mic_reopen', { attempt: reopens.length });
        setTimeout(() => { if (wake.awake && !mic) openEars(); }, 500).unref?.();
      }
    });
    m.once('error', () => { if (mic === m) { mic = null; micProbe.exited(); } });
    log('ears', { open: true });
    return true;
  }
  function closeEars(why) {
    const m = mic;
    if (!m) return;
    mic = null;
    queue.length = 0;
    segmenter.reset();
    try { m.kill('SIGTERM'); } catch { /* gone */ }
    log('ears', { open: false, why });
  }
  // The Kingmaker bar's OFF is a real off: no listening, no wake word, no wake link, until it's turned on again.
  let powered = true;
  if (listenWhileAsleep && !interactionOwner()) openEars();
  onState('asleep');
  // "Hey Siri, wake Kingmaker" → kingmaker://wake → the app → here: ears open, awake, "I'm here.", the next words are the command.
  const wakeNow = async () => {
    if (!powered) { log('wake_ignored', { why: 'off' }); return { off: true }; }
    const leaseOwner = interactionOwner();
    if (leaseOwner) {
      log('wake_suppressed', { owner: leaseOwner });
      await onSuppressed({ type: 'wake_suppressed', owner: leaseOwner, text: '' });
      wake.sleep(); closeEars('governed-session'); onState('asleep');
      return { suppressed: leaseOwner };
    }
    openEars(); wake.wakeNow(); log('wake', { via: 'link' }); onState('awake'); await say("I'm here."); await offerQuestion.ask(); segmenter.reset(); onState('awake');
    return { awake: true };
  };
  const sleepNow = () => { wake.sleep(); onState('asleep'); if (!listenWhileAsleep) closeEars('asked'); };
  const ownerChanged = () => {
    if (interactionOwner()) { wake.sleep(); closeEars('governed-session'); onState('asleep'); }
    else if (listenWhileAsleep && powered) openEars();
  };
  // fn held (the Kingmaker app): Kingmaker stops talking, the microphone opens, and everything said until release is
  // one command — no wake word needed, since holding the key is the address.
  // LIVE DICTATION (operator 2026-10-15: "write out what I'm saying in the search bar as I'm saying it"): while the key
  // is held, the words so far are transcribed on this Mac (the same whisper.cpp) about every 1.2 s and sent to the bar as
  // `partial`; on release `partial: null` clears it and the whole hold goes in as the command, as before.
  let partialTimer = null, partialBusy = false, partialText = '';
  const partialTick = async () => {
    if (!ptt.held || partialBusy) return;
    const samples = ptt.snapshot();
    if (samples.length < SAMPLE_RATE) return; // under a second: nothing worth showing yet
    partialBusy = true;
    try {
      const text = await transcribe(samples, { whisper: paths.voice.whisper, model: paths.voice.sttModel, language });
      if (ptt.held && text && text !== partialText && !isNonSpeech(text)) { partialText = text; onState('hearing', { partial: text }); }
    } catch { /* a missed partial is fine: the final transcript still goes in */ } finally { partialBusy = false; }
  };
  const stopPartials = () => {
    clearInterval(partialTimer); partialTimer = null;
    if (partialText) { partialText = ''; onState('hearing', { partial: null }); }
  };
  const pttDown = () => {
    if (releaseTimer) finishRelease(); // pressed again during the tail: the previous hold goes in first
    if (!powered || interactionOwner()) { log('ptt', { down: true, ignored: !powered ? 'off' : 'governed-session' }); return false; }
    interrupt();
    if (!openEars()) return false;
    ptt.down(); wake.wakeNow(); segmenter.reset(); queue.length = 0;
    log('ptt', { down: true }); onState('hearing');
    partialText = ''; clearInterval(partialTimer); partialTimer = setInterval(() => { void partialTick(); }, 1200); partialTimer.unref?.();
    return true;
  };
  // Releasing fn keeps the mic open a moment longer, so the last words (still in the recorder's buffer) make it in:
  // a 7.3 s hold delivered only 6.1 s of audio and lost "…cloud AI" (2026-10-15). A new press during the tail sends the
  // previous hold first.
  const PTT_TAIL_MS = Number(process.env.SOL_GHOST_PTT_TAIL_MS) || 400;
  let releaseTimer = null;
  const pttUp = () => {
    stopPartials();
    if (!ptt.held) return finishRelease();
    clearTimeout(releaseTimer);
    releaseTimer = setTimeout(finishRelease, PTT_TAIL_MS);
    releaseTimer.unref?.();
    return true;
  };
  const finishRelease = () => {
    clearTimeout(releaseTimer); releaseTimer = null;
    const utt = ptt.up();
    if (!listenWhileAsleep) closeEars('ptt');
    log('ptt', { down: false, sent: Boolean(utt), ...(ptt.last ?? {}) });
    // A second or more of pure silence is macOS withholding the microphone (its permission was reset or is off), not a
    // quiet room: say so, instead of a key that seems to work and does nothing (2026-10-15: peak 1 of 32767 over 10 s).
    if (!utt && (ptt.last?.audioMs ?? 0) >= 1000 && (ptt.last?.peak ?? 0) < 16) {
      log('mic_silent', { audioMs: ptt.last.audioMs, peak: ptt.last.peak });
      void say("I can't hear you: macOS is giving me silence from the microphone. Turn Kingmaker on in System Settings, Privacy and Security, Microphone.");
    }
    if (!utt) { onState(wake.awake ? 'awake' : 'asleep'); return false; }
    queue.push({ samples: utt.samples, speechMs: utt.speechMs, overlap: false, endedAt: Date.now(), utteranceId: ownerVoice?.newUtteranceId?.() ?? null });
    void drain();
    return true;
  };
  const pttCancel = () => { clearTimeout(releaseTimer); releaseTimer = null; if (!ptt.held) return; stopPartials(); ptt.cancel(); if (!listenWhileAsleep) closeEars('ptt'); log('ptt', { cancelled: true }); onState(wake.awake ? 'awake' : 'asleep'); };
  const powerOff = () => { powered = false; clearTimeout(releaseTimer); releaseTimer = null; stopPartials(); ptt.cancel(); wake.sleep(); closeEars('off'); queue.length = 0; log('power', { on: false }); onState('asleep'); };
  const powerOn = () => { powered = true; log('power', { on: true }); if (listenWhileAsleep && !interactionOwner()) openEars(); onState('asleep'); };
  return { ok: true, phrases, word: setup.word, cemented: setup.cemented, listenWhileAsleep, isAwake: () => wake.awake, isListening: () => mic !== null, isOn: () => powered, powerOff, powerOn, wakeNow, pttDown, pttUp, pttCancel, sleepNow, ownerChanged, setOffer: offerQuestion.set, stop: () => { clearInterval(idleWatch); closeEars('stop'); } };
}
