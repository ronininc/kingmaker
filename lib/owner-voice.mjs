// The owner's voice as authority, with no window. Reuses the engine's own owner-voice modules
// (desktop/owner-voice/*: the sealed print store, the owner gate, guided enrollment, the speaker supervisor
// and the solvox2 mint) straight from the installed Solomon.app, plus its bundled CAM++ speaker sidecar.
// Kingmaker adds only what a process with no Electron needs: the Keychain sealer (keychain-seal.mjs), the
// sidecar spawn, and Kingmaker's own `say` voice as the anti-print.
//
// Per utterance: the SAME audio that is transcribed is embedded (in memory, embed_pcm, never a file), the
// owner gate decides, and a solvox2 token is minted for the EXACT text the turn will POST. The server's
// PrincipalVerifier re-checks everything (key, MAC, age, transcript binding, replay, owner fields). This
// module can only state what the gate decided; it never asserts authority the gate did not grant.
//
// Biometric hygiene: no raw audio is stored anywhere. PCM handed to the sidecar is zero-filled once it is
// embedded. The print is sealed (keychain-seal.mjs); embeddings never leave this process except as the
// rounded similarity the gate reports.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const SPEAKER_MODEL_ID = '3dspeaker-campplus-sv-zh-en';
/** CAM++ measured 1–6 s per utterance on this 8 GB M3 under load. The attestation must still reach the
 *  server within its 15 s age limit, so the budget stays well under that. */
export const EMBED_TIMEOUT_MS = Number(process.env.SOL_GHOST_EMBED_TIMEOUT_MS) > 0 ? Number(process.env.SOL_GHOST_EMBED_TIMEOUT_MS) : 8_000;
/** What Kingmaker's own voice is learned from: lines it actually says, including the confirm prompt. */
export const SELF_PRINT_LINES = Object.freeze([
  'Say yes, go ahead to confirm, or cancel.',
  "I'm here. Going to sleep.",
  'The salt breeze came across from the sea.',
]);

/** The engine's owner-voice modules from `dir` (the installed app's asar `desktop` folder, or an engine source checkout). */
export async function loadOwnerVoiceModules(dir) {
  const url = (rel) => pathToFileURL(join(dir, rel)).href;
  const [install, bridge, attestation] = await Promise.all([
    import(url('owner-voice/install.mjs')),
    import(url('speaker-sidecar-bridge.mjs')),
    import(url('owner-voice/voice-attestation.mjs')),
  ]);
  if (typeof install.installOwnerVoice !== 'function' || typeof bridge.attachSpeakerSidecar !== 'function') throw new Error('OWNER_VOICE_MODULES_INCOMPLETE');
  return { installOwnerVoice: install.installOwnerVoice, OWNER_VOICE_IPC: install.OWNER_VOICE_IPC, attachSpeakerSidecar: bridge.attachSpeakerSidecar, VOICE_ATTESTATION_HEADER: attestation.VOICE_ATTESTATION_HEADER };
}

/**
 * createSpeakerBridge() for the speaker supervisor: spawns the bundled CAM++ sidecar on demand. The bridge's
 * dispose() only fails its pending requests (its owner runs the process), so this owner stops the process.
 */
export function createSpeakerBridgeFactory({ executable, model, attachSpeakerSidecar, spawnImpl = spawn, exists = existsSync, log = () => {} }) {
  return () => {
    if (!exists(executable) || !exists(model)) return null;
    const proc = spawnImpl(executable, [], {
      shell: false,
      env: { ...process.env, SOLOMON_SPEAKER_MODEL: model, SOLOMON_SPEAKER_MODEL_ID: SPEAKER_MODEL_ID },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    proc.stdin?.on('error', () => {});
    proc.stdout?.on('error', () => {});
    proc.stderr?.on('data', (d) => log('speaker_stderr', { line: String(d).trim().slice(0, 200) }));
    proc.on?.('error', (e) => log('speaker_proc_error', { code: e?.code }));
    const bridge = attachSpeakerSidecar(proc, { log: (m, x) => log('speaker', { m, ...(x || {}) }) });
    const owned = Object.create(bridge);
    owned.dispose = () => {
      bridge.dispose();
      try { if (proc.stdin?.writable) proc.stdin.write(`${JSON.stringify({ op: 'shutdown' })}\n`); } catch { /* gone */ }
      const t = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* gone */ } }, 400);
      t.unref?.();
    };
    return owned;
  };
}

/**
 * Install the engine's owner voice for this process. `ipcMain` + `isAuthoritativeSender` are passed only by the
 * typed enrollment console (cli.mjs enroll); the voice loop gets none, so it can never start, commit or
 * forget an enrollment.
 */
export function installGhostOwnerVoice({ modules, paths, attestationKeyHex, safeStorage, ipcMain, isAuthoritativeSender, log = () => {}, env = process.env }) {
  return modules.installOwnerVoice({
    ipcMain,
    safeStorage,
    userDataDir: paths.state,
    attestationKeyHex,
    isAuthoritativeSender,
    createSpeakerBridge: createSpeakerBridgeFactory({ executable: paths.voice.speaker, model: paths.voice.speakerModel, attachSpeakerSidecar: modules.attachSpeakerSidecar, log }),
    log: (tag, detail) => log('owner_voice', { tag, ...detail }),
    env,
  });
}

/**
 * Load the engine's modules, the Keychain sealer and the owner voice in one go. dispose() stops the speaker
 * sidecar and zero-fills the in-memory seal key.
 */
export async function openOwnerVoice({ paths, attestationKeyHex, ipcMain, isAuthoritativeSender, log = () => {}, modulesDir = paths.ownerVoiceModules, safeStorage = null }) {
  const modules = await loadOwnerVoiceModules(modulesDir);
  const { createKeychainSafeStorage } = await import('./keychain-seal.mjs');
  const seal = safeStorage ?? createKeychainSafeStorage();
  const ov = installGhostOwnerVoice({ modules, paths, attestationKeyHex, safeStorage: seal, ipcMain, isAuthoritativeSender, log });
  return { ov, modules, safeStorage: seal, dispose() { try { ov.dispose(); } finally { seal.dispose?.(); } } };
}

/** 16 kHz s16 samples → one Float32Array for embed_pcm. In memory only; the caller zero-fills both. */
export function toFloat32(samples) {
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) out[i] = samples[i] / 32768;
  return out;
}

/** The speaker embedding of one utterance, or null (→ embedding_unavailable, never a match). */
export async function embedUtterance(ownerVoice, samples, { utteranceId, timeoutMs = EMBED_TIMEOUT_MS } = {}) {
  const pcm = toFloat32(samples);
  try {
    const r = await ownerVoice.supervisor.identify([pcm], { timeoutMs, utteranceId });
    return r?.embedding ?? null;
  } catch { return null; } finally { pcm.fill(0); }
}

export const newVoiceSessionId = () => `vs_${randomBytes(12).toString('hex')}`;
export const newUtteranceId = () => `utt_${randomBytes(12).toString('hex')}`;

/**
 * The owner decision for one utterance and its solvox2 token, bound to `transcript` (the exact text the
 * turn will POST). capturedAt is when the utterance ENDED: the broker never lets a spoken reply resolve a
 * proposal created after that. Returns {decision, token}; the decision carries no embedding. token is null
 * when there is no valid per-launch key (→ no header → unverified voice).
 */
export function attestUtterance(ownerVoice, { embedding, speechMs, capturedDuringNarration = false, playbackOverlap = 'NONE', transcript, utteranceId, voiceSessionId, capturedAt }) {
  const pad = 'UNAVAILABLE'; // no presentation-attack model yet: the gate and the server treat it as unknown
  let decision;
  try { decision = ownerVoice.gate.evaluate({ embedding, speechMs, capturedDuringNarration, playbackOverlap, pad }); } catch { decision = null; }
  if (!decision || typeof decision.reason !== 'string') decision = { ownerMatch: false, reason: 'embedding_unavailable', similarity: null, selfSimilarity: null, threshold: 0, ownerEnrollmentId: null };
  const decidedAt = new Date(Number.isFinite(capturedAt) ? capturedAt : Date.now()).toISOString();
  const token = ownerVoice.mintAttestation({ utteranceId, voiceSessionId, transcript, decision: { ...decision, decidedAt }, speechMs, capturedDuringNarration, playbackOverlap, pad });
  return { decision, token: typeof token === 'string' && token.startsWith('solvox2.') ? token : null };
}

/**
 * What the voice loop needs from the owner voice: embed(utt) and attest({embedding, utt, transcript}).
 * Without an enrolled print the gate can only answer owner_not_enrolled, so the speaker sidecar is never
 * started for nothing (87–100 MB resident, measured across its two processes on this 8 GB M3); the turn
 * still carries the honest token.
 */
export function ownerVoiceForLoop(ownerVoice, { voiceSessionId = newVoiceSessionId(), enrolled = ownerVoice.status().enrolled === true } = {}) {
  return {
    voiceSessionId,
    newUtteranceId,
    embed: (utt) => (enrolled ? embedUtterance(ownerVoice, utt.samples, { utteranceId: utt.utteranceId }) : null),
    attest: ({ embedding, utt, transcript }) => attestUtterance(ownerVoice, {
      embedding, transcript, voiceSessionId,
      speechMs: utt.speechMs,
      capturedDuringNarration: utt.overlap === true,
      playbackOverlap: utt.overlap === true ? 'OVERLAP' : 'NONE',
      utteranceId: utt.utteranceId,
      capturedAt: utt.endedAt,
    }),
  };
}

/** 16-bit PCM mono WAV bytes → Float32 samples (data chunk only; `say` writes extra chunks). Pure. */
export function wavToFloat32(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('NOT_WAV');
  let off = 12; let fmt = null; let data = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4); const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') fmt = { channels: buf.readUInt16LE(off + 10), rate: buf.readUInt32LE(off + 12), bits: buf.readUInt16LE(off + 22) };
    if (id === 'data') data = buf.subarray(off + 8, Math.min(buf.length, off + 8 + size));
    off += 8 + size + (size % 2);
  }
  if (!fmt || !data || fmt.channels !== 1 || fmt.bits !== 16 || fmt.rate !== 16_000) throw new Error('WAV_NOT_16K_MONO_S16');
  const out = new Float32Array(Math.floor(data.length / 2));
  for (let i = 0; i < out.length; i += 1) out[i] = data.readInt16LE(i * 2) / 32768;
  return out;
}

/**
 * Kingmaker's OWN voice (Apple `say`, the voice it speaks with) as 16 kHz samples. `say` cannot write to
 * a pipe, so it renders into a private temp folder that is removed at once. This is synthetic speech, never
 * anyone's recorded voice.
 */
export async function synthesizeSay(text, { voice = process.env.SOL_GHOST_SAY_VOICE, spawnImpl = spawn } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sol-ghost-self-'));
  const file = join(dir, 'self.wav');
  try {
    const code = await new Promise((resolve) => {
      const child = spawnImpl('/usr/bin/say', [...(voice ? ['-v', voice] : []), '-o', file, '--file-format=WAVE', '--data-format=LEI16@16000', String(text)], { stdio: 'ignore' });
      child.once('exit', resolve); child.once('error', () => resolve(-1));
    });
    if (code !== 0) return null;
    return wavToFloat32(readFileSync(file));
  } catch { return null; } finally { rmSync(dir, { recursive: true, force: true }); }
}

/**
 * Learn Kingmaker's own voice print (the anti-print) from the voice it speaks with, so its own echo is
 * `self_echo` at the gate and `matches_self` during enrollment. Sealed with the owner record when there is one.
 */
export async function learnSelfPrint(ownerVoice, { voice, lines = SELF_PRINT_LINES, synth = synthesizeSay, timeoutMs = 20_000 } = {}) {
  const embeddings = [];
  for (const line of lines) {
    const pcm = await synth(line, { voice });
    if (!pcm) continue;
    try {
      const r = await ownerVoice.supervisor.identify([pcm], { timeoutMs, utteranceId: `self_${embeddings.length}` });
      if (r?.embedding) embeddings.push(r.embedding);
    } finally { pcm.fill(0); }
  }
  if (!embeddings.length) return { ok: false, reason: 'no_self_embedding' };
  const r = ownerVoice.setSelfPrint(embeddings);
  for (const e of embeddings) e.fill(0);
  return { ...r, samples: embeddings.length };
}

/** One line for doctor / start about the owner's voice. Pure. */
export function ownerVoiceLine(status) {
  if (!status) return 'Owner voice: unavailable in this Kingmaker build. Approve by typing y at the console.';
  if (status.enrolled) return `Owner voice: enrolled (${status.sampleCount} samples, ${String(status.enrolledAt).slice(0, 10)}). A spoken "yes, go ahead" in your voice approves.`;
  if (status.state === 'reenroll_required') return 'Owner voice: the speaker model changed, so your print no longer applies. Run: kingmaker enroll';
  if (status.state === 'corrupt') return 'Owner voice: the sealed print could not be opened (Keychain key missing or file damaged). Run: kingmaker enroll';
  if (status.sealing !== 'available') return 'Owner voice: the login Keychain is not available, so no print can be sealed.';
  return 'Owner voice: not enrolled, so spoken yes cannot approve. Run: kingmaker enroll';
}
