// lib/phone-voice.mjs — the phone's voice: calling Kingmaker from the iPhone, and its walkie-talkie fallback (the owner,
// 2026-10-15: "a call feature and a walkie talkie feature fallback for giving voice commands from the phone").
//
// The phone does the listening (its own mic, its own echo cancelling, its own voice-activity detection) and sends each
// utterance as raw 16 kHz mono 16-bit PCM over the paired HTTPS session; the Mac transcribes it with Kingmaker's own
// whisper (any language), and the words become an ordinary turn (onTurn), so every gate applies. Kingmaker's answers come
// back on the bar's own stream (/events); the phone asks for each one spoken: Kokoro for English, the Mac's voice for the
// language for anything else (lib/lang.mjs). No audio is ever written to disk on either side; the words are in the
// conversation like any typed turn.
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { replyLanguage, voiceFor } from './lang.mjs';

export const PCM_RATE = 16_000;
export const MAX_UTTERANCE_BYTES = PCM_RATE * 2 * 60;   // a minute of speech
export const MAX_SPOKEN_CHARS = 1200;

/** Raw little-endian 16-bit PCM → Int16Array (a copy, never a view on the request's buffer). */
export function pcmSamples(buf) {
  const n = Math.floor(buf.length / 2), out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(i * 2);
  return out;
}

/**
 * The voice the companion uses. deps (all injectable for tests): resolvePaths, transcribe(samples, opts), kokoro(text),
 * say(text, voice) → { bytes, type }.
 */
export function createPhoneVoice({ paths = null, transcribe = null, kokoro = null, say = null } = {}) {
  let p = paths;
  const voicePaths = async () => (p ??= (await import('./paths.mjs')).resolvePaths()).voice;
  const stt = transcribe || (async (samples) => {
    const v = await voicePaths(); const { transcribe: whisper } = await import('./voice.mjs');
    return whisper(samples, { whisper: v.whisper, model: v.sttModel });
  });
  const tts = kokoro || (async (text) => {
    const { synthesizeKokoroWav } = await import('./voice.mjs');
    const r = await synthesizeKokoroWav(text).catch(() => null);
    if (!r) return null;
    try { return { bytes: readFileSync(r.out), type: 'audio/wav' }; } finally { rmSync(r.dir, { recursive: true, force: true }); }
  });
  const macSay = say || ((text, voice) => new Promise((resolve) => {
    const dir = mkdtempSync(join(tmpdir(), 'km-phone-say-')), out = join(dir, 'reply.wav');
    execFile('/usr/bin/say', [...(voice ? ['-v', voice] : []), '--file-format=WAVE', '--data-format=LEI16@22050', '-o', out, text], { timeout: 60_000 }, (err) => {
      try { resolve(err ? null : { bytes: readFileSync(out), type: 'audio/wav' }); } catch { resolve(null); } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  }));
  return {
    /** An utterance from the phone → what was said ('' for silence or noise). */
    async hear(buf) {
      if (!buf?.length || buf.length > MAX_UTTERANCE_BYTES) return '';
      const samples = pcmSamples(buf);
      try { return String(await stt(samples) || '').replace(/\s+/g, ' ').trim(); } finally { samples.fill(0); }
    },
    /** Kingmaker's line, spoken: its own language's voice. → { bytes, type } or null. */
    async speak(text) {
      const line = String(text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_SPOKEN_CHARS);
      if (!line) return null;
      const code = replyLanguage(line);
      if (code === 'en') { const k = await tts(line); if (k) return k; }
      return macSay(line, code === 'en' ? null : voiceFor(code));
    },
  };
}
