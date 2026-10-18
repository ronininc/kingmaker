// Owner voice, hermetic: the engine's REAL owner-voice modules (desktop/owner-voice/*, byte-identical to the ones
// inside the desktop app) with a fake `security` (an in-memory Keychain) and a fake speaker sidecar. The real-model,
// real-server proof is test/owner-voice.proof.mjs.
//
// The modules load from source (plain Node cannot read the app's asar): SOL_GHOST_OWNER_VOICE_DIR, else this checkout's
// imported engine source (desktop/), else an engine source checkout beside it. Absent (the public repo) → these tests are skipped, never passed.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { challengeWords, createConsoleIpc, enrollBlockers, explainRejection, runEnrollment } from '../lib/enroll.mjs';
import { createKeychainSafeStorage } from '../lib/keychain-seal.mjs';
import { attestUtterance, installGhostOwnerVoice, loadOwnerVoiceModules, ownerVoiceForLoop, ownerVoiceLine, toFloat32, wavToFloat32 } from '../lib/owner-voice.mjs';
import { DESKTOP_NONCE_HEADER, VOICE_ATTESTATION_HEADER } from '../lib/profile.mjs';
import { createOwnerSession, resolveVoiceAuthority, turnHeaders, turnWire, VOICE_AUTHORITIES } from '../lib/session.mjs';
import { savedVoiceAuthority } from '../lib/cli.mjs';
import { createUtteranceHandler, createWakeState, wavBytes } from '../lib/voice.mjs';
import { forkLayout } from '../lib/fork.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULES_DIR = process.env.SOL_GHOST_OWNER_VOICE_DIR
  || [forkLayout().desktop, process.env.KINGMAKER_ENGINE_SRC && resolve(process.env.KINGMAKER_ENGINE_SRC, 'desktop')].filter(Boolean).find((d) => existsSync(join(d, 'owner-voice', 'install.mjs')))
  || forkLayout().desktop;
const HAVE_MODULES = existsSync(join(MODULES_DIR, 'owner-voice', 'install.mjs'));
const needs = HAVE_MODULES ? {} : { skip: `the engine's owner-voice modules not found at ${MODULES_DIR}` };
const KEY = 'e'.repeat(64);

// ── fakes ────────────────────────────────────────────────────────────────────
/** An in-memory login Keychain behind the `security` argv/stdin protocol keychain-seal.mjs speaks. */
function fakeSecurity({ locked = false } = {}) {
  const items = new Map();
  const calls = [];
  const run = (args, input) => {
    calls.push({ args: [...args], input });
    if (locked) return { status: 51, stdout: '' };
    const [cmd] = args;
    const opt = (list, flag) => list[list.indexOf(flag) + 1];
    if (cmd === 'find-generic-password') {
      const k = `${opt(args, '-s')}|${opt(args, '-a')}`;
      return items.has(k) ? { status: 0, stdout: `${items.get(k)}\n` } : { status: 44, stdout: '' };
    }
    if (cmd === 'show-keychain-info') return { status: 0, stdout: '' };
    if (cmd === 'delete-generic-password') {
      const k = `${opt(args, '-s')}|${opt(args, '-a')}`;
      return items.delete(k) ? { status: 0, stdout: '' } : { status: 44, stdout: '' };
    }
    if (cmd === '-i') {
      const m = /^add-generic-password -s "([^"]*)" -a "([^"]*)" -l "[^"]*" -w ([0-9a-f]{64})\n$/.exec(String(input));
      if (!m) return { status: 1, stdout: '' };
      const k = `${m[1]}|${m[2]}`;
      if (items.has(k)) return { status: 45, stdout: '' }; // duplicate: security never overwrites without -U
      items.set(k, m[3]);
      return { status: 0, stdout: '' };
    }
    return { status: 1, stdout: '' };
  };
  return { run, calls, items };
}

/** Speaker identity rides in the first PCM sample: 1 = owner, 2 = someone else, 3 = Kingmaker's own voice. */
const SPEAKERS = { 1: 0, 2: 64, 3: 128 };
function voiceVector(speaker, jitter = 0) {
  const v = new Array(192).fill(0.01);
  for (let i = 0; i < 24; i += 1) v[SPEAKERS[speaker] + i] = 1;
  v[191] += jitter; // a little per-utterance variation, still the same voice
  return v;
}
function fakeSpeakerBridge() {
  let n = 0;
  const bridge = {
    alive: true,
    modelId: '3dspeaker-campplus-sv-zh-en',
    checksum: 'a'.repeat(64),
    identify: async ({ captured }) => { n += 1; return { embedding: voiceVector(Math.round(captured[0][0] * 32768), (n % 5) * 0.02), dim: 192 }; },
    whenReady: async () => true,
    onExit: () => () => {},
    dispose() {},
  };
  return () => bridge;
}
/** An utterance of `speaker` lasting `ms` (16 kHz s16; sample 0 carries the speaker id). */
function utterance(speaker, ms = 1400, { overlap = false } = {}) {
  const samples = new Int16Array(16 * ms).fill(900);
  samples[0] = speaker;
  return { samples, speechMs: ms, overlap, endedAt: Date.now(), utteranceId: `utt_${speaker}_${ms}` };
}

function decodeToken(token) {
  const [, b64] = String(token).split('.');
  return JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
}
const sha = (t) => createHash('sha256').update(String(t).normalize('NFC').replace(/\s+/g, ' ').trim(), 'utf8').digest('hex');

async function freshOwnerVoice({ state = mkdtempSync(join(tmpdir(), 'sg-ov-')), keychain = fakeSecurity(), withConsole = false } = {}) {
  const modules = await loadOwnerVoiceModules(MODULES_DIR);
  const seal = createKeychainSafeStorage({ run: keychain.run, service: 'Kingmaker Owner Voice (test)' });
  const ipc = withConsole ? createConsoleIpc() : null;
  const ov = modules.installOwnerVoice({
    ipcMain: ipc?.ipcMain, isAuthoritativeSender: ipc?.isAuthoritativeSender,
    safeStorage: seal, userDataDir: state, attestationKeyHex: KEY, createSpeakerBridge: fakeSpeakerBridge(), log: () => {}, env: {},
  });
  return { ov, modules, seal, ipc, state, keychain };
}

/** Enroll the owner (speaker 1) through the engine's own guided enrollment, as `kingmaker enroll` does. */
async function enrollOwner(ctx, speaker = 1) {
  const IPC = ctx.modules.OWNER_VOICE_IPC;
  let prompt = null;
  const r = await runEnrollment({
    ov: ctx.ov, ipc: ctx.ipc, channels: IPC,
    next: async () => { prompt = ctx.ov.enrollment.progress().currentPrompt; return { kind: 'utterance', utt: { samples: utterance(speaker, 2400).samples, speechMs: 2400 } }; },
    transcribe: async () => prompt, // the owner read the sentence shown
    embed: async (samples) => (await ctx.ov.supervisor.identify([toFloat32(samples)]))?.embedding ?? null,
  });
  return r;
}

// ── Keychain seal ────────────────────────────────────────────────────────────
test('seal: AES-GCM round trip; the sealed bytes never contain the plaintext', () => {
  const kc = fakeSecurity();
  const seal = createKeychainSafeStorage({ run: kc.run });
  assert.equal(seal.isEncryptionAvailable(), true);
  const plain = JSON.stringify({ centroid: [0.1, 0.2, 0.3] });
  const sealed = seal.encryptString(plain);
  assert.ok(Buffer.isBuffer(sealed));
  assert.equal(sealed.subarray(0, 4).toString('ascii'), 'sgv1');
  assert.ok(!sealed.includes(Buffer.from('centroid')), 'no plaintext in the seal');
  assert.equal(seal.decryptString(sealed), plain);
  assert.notDeepEqual(seal.encryptString(plain), sealed, 'a fresh IV per seal');
});

test('seal: the key goes to the Keychain on stdin, never on argv, and is never overwritten', () => {
  const kc = fakeSecurity();
  const seal = createKeychainSafeStorage({ run: kc.run });
  seal.encryptString('x');
  const add = kc.calls.find((c) => c.args[0] === '-i');
  const key = [...kc.items.values()][0];
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.ok(add.input.includes(key), 'the secret is written to stdin');
  assert.ok(kc.calls.every((c) => !c.args.join(' ').includes(key)), 'never on any argv');
  assert.ok(!add.input.includes(' -U'), 'no update flag: an existing key is never replaced');
  // A second sealer (another launch) reads the SAME key instead of minting one.
  const again = createKeychainSafeStorage({ run: kc.run });
  assert.equal(again.decryptString(seal.encryptString('same key')), 'same key');
  assert.equal(kc.calls.filter((c) => c.args[0] === '-i').length, 1);
});

test('seal: tampering, a missing key or a locked Keychain all fail closed', () => {
  const kc = fakeSecurity();
  const seal = createKeychainSafeStorage({ run: kc.run });
  const sealed = seal.encryptString('owner print');
  const flipped = Buffer.from(sealed); flipped[flipped.length - 1] ^= 1;
  assert.throws(() => seal.decryptString(flipped));
  assert.throws(() => seal.decryptString(Buffer.from('plaintext{"centroid":[1]}')), /SEAL_FORMAT/);
  // Crypto-shred: once the key is gone, decrypting never mints a new one.
  assert.deepEqual(seal.destroyKey(), { ok: true, removed: true });
  assert.throws(() => seal.decryptString(sealed), /SEAL_KEY_MISSING/);
  assert.equal(kc.items.size, 0);
  const locked = createKeychainSafeStorage({ run: fakeSecurity({ locked: true }).run });
  assert.equal(locked.isEncryptionAvailable(), false);
  assert.throws(() => locked.encryptString('x'), /KEYCHAIN_UNAVAILABLE/);
});

// ── Enrollment: typed, at the terminal, through the engine's own enrollment ──────
test('enroll gate: only a terminal, never while Kingmaker runs', () => {
  const ok = { stdinTTY: true, stdoutTTY: true, ghostRunningPid: null, micTool: true, sttReady: true, speakerReady: true };
  assert.deepEqual(enrollBlockers(ok), []);
  assert.match(enrollBlockers({ ...ok, stdinTTY: false })[0], /typed by you at a terminal/);
  assert.match(enrollBlockers({ ...ok, stdoutTTY: false })[0], /typed by you at a terminal/);
  assert.match(enrollBlockers({ ...ok, ghostRunningPid: 4242 })[0], /Kingmaker is running \(pid 4242\)/);
  const words = challengeWords();
  assert.match(words, /^[a-z]+ [a-z]+$/);
  assert.notEqual(words.split(' ')[0], words.split(' ')[1]);
  assert.match(explainRejection('matches_self'), /Kingmaker's own voice/);
});

test('enroll: the engine\'s own enrollment seals the print with the Keychain key; no audio, no plaintext on disk', needs, async () => {
  const ctx = await freshOwnerVoice({ withConsole: true });
  try {
    const r = await enrollOwner(ctx);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.sampleCount, 5);
    const file = join(ctx.state, 'owner-voice', 'owner.sealed');
    const bytes = readFileSync(file);
    assert.equal(bytes.subarray(0, 4).toString('ascii'), 'sgv1');
    // Long field names only: random ciphertext contains any given 2-byte pair (like "0.") ~6% of the time.
    for (const field of ['"centroid"', '"threshold"', '"ownerEnrollmentId"', '"embeddingModelId"']) assert.ok(!bytes.includes(Buffer.from(field)), `sealed, no ${field}`);
    assert.throws(() => JSON.parse(bytes.toString('utf8')), 'not JSON');
    // A later launch (a new process) opens it with the same Keychain key.
    const later = await freshOwnerVoice({ state: ctx.state, keychain: ctx.keychain });
    assert.equal(later.ov.status().enrolled, true);
    assert.match(ownerVoiceLine(later.ov.status()), /enrolled \(5 samples/);
    later.ov.dispose();
  } finally { ctx.ov.dispose(); rmSync(ctx.state, { recursive: true, force: true }); }
});

test('enroll: refused for a second voice, for Kingmaker\'s own voice, and from anywhere but this console', needs, async () => {
  const modules = await loadOwnerVoiceModules(MODULES_DIR);
  const IPC = modules.OWNER_VOICE_IPC;
  const state = mkdtempSync(join(tmpdir(), 'sg-ov-'));
  const shim = createConsoleIpc();
  const registered = new Map();
  const ov = modules.installOwnerVoice({
    ipcMain: { handle: (ch, fn) => { registered.set(ch, fn); shim.ipcMain.handle(ch, fn); }, removeHandler: (ch) => { registered.delete(ch); shim.ipcMain.removeHandler(ch); } },
    isAuthoritativeSender: shim.isAuthoritativeSender,
    safeStorage: createKeychainSafeStorage({ run: fakeSecurity().run }), userDataDir: state, attestationKeyHex: KEY, createSpeakerBridge: fakeSpeakerBridge(), log: () => {}, env: {},
  });
  try {
    // install.mjs's own guard: any event but this console's is refused, for every channel.
    const stranger = { sender: { send() {}, isDestroyed: () => false } };
    for (const ch of [IPC.enrollStart, IPC.enrollCommit, IPC.forget]) assert.deepEqual(await registered.get(ch)(stranger), { ok: false, reason: 'UNAUTHORIZED_WINDOW' });
    // Kingmaker's own TTS print, learned first, is rejected as a sample (matches_self); a second voice too.
    ov.setSelfPrint([voiceVector(3)]);
    assert.equal((await shim.invoke(IPC.enrollStart)).ok, true);
    const prompt = () => ov.enrollment.progress().currentPrompt;
    assert.equal(ov.enrollment.addSample({ embedding: voiceVector(3), speechMs: 2400, transcript: prompt() }).reason, 'matches_self');
    assert.equal(ov.enrollment.addSample({ embedding: voiceVector(1), speechMs: 2400, transcript: prompt() }).accepted, true);
    assert.equal(ov.enrollment.addSample({ embedding: voiceVector(2), speechMs: 2400, transcript: prompt() }).reason, 'inconsistent_with_prior');
    assert.equal(ov.enrollment.addSample({ embedding: voiceVector(1), speechMs: 900, transcript: prompt() }).reason, 'too_short');
    assert.equal((await shim.invoke(IPC.enrollCommit)).reason, 'too_few_samples', 'one good sample is not an enrollment');
    await shim.invoke(IPC.enrollCancel);
  } finally { ov.dispose(); rmSync(state, { recursive: true, force: true }); }
});

test('the voice path can never start, commit or forget an enrollment', needs, async () => {
  const modules = await loadOwnerVoiceModules(MODULES_DIR);
  const state = mkdtempSync(join(tmpdir(), 'sg-ov-'));
  const ov = installGhostOwnerVoice({ modules, paths: { state, voice: { speaker: '/nonexistent', speakerModel: '/nonexistent' } }, attestationKeyHex: KEY, safeStorage: createKeychainSafeStorage({ run: fakeSecurity().run }) });
  try {
    assert.deepEqual(Object.keys(ov.enrollment).sort(), ['active', 'addSample', 'progress']);
    assert.equal(ov.enrollment.addSample({ embedding: voiceVector(1), speechMs: 2400, transcript: 'x' }).reason, 'not_enrolling');
  } finally { ov.dispose(); rmSync(state, { recursive: true, force: true }); }
});

// ── Per utterance: the attestation is the gate's word, bound to the text sent ─────
test('attest: the owner\'s utterance mints owner_match bound to the EXACT text sent', needs, async () => {
  const ctx = await freshOwnerVoice({ withConsole: true });
  try {
    await enrollOwner(ctx);
    const loop = ownerVoiceForLoop(ctx.ov, { enrolled: true });
    const utt = utterance(1);
    const embedding = await loop.embed(utt);
    const { decision, token } = loop.attest({ embedding, utt, transcript: 'yes, go ahead' });
    assert.equal(decision.reason, 'owner_match');
    const p = decodeToken(token);
    assert.equal(p.ownerMatch, true);
    assert.equal(p.transcriptSha256, sha('yes, go ahead'));
    assert.notEqual(p.transcriptSha256, sha('ghost, yes, go ahead'), 'the wake phrase is not in the signed text');
    assert.equal(p.capturedAt, new Date(utt.endedAt).toISOString(), 'capturedAt = when the utterance ended');
    assert.equal(p.playbackOverlap, 'NONE');
    assert.equal(JSON.stringify(p).includes('0.01'), false, 'no embedding rides in the token');
  } finally { ctx.ov.dispose(); rmSync(ctx.state, { recursive: true, force: true }); }
});

test('attest: another voice, Kingmaker\'s own echo, speech over Kingmaker, too short, no print — never owner_match', needs, async () => {
  const ctx = await freshOwnerVoice({ withConsole: true });
  try {
    await enrollOwner(ctx);
    ctx.ov.setSelfPrint([voiceVector(3)]);
    const loop = ownerVoiceForLoop(ctx.ov, { enrolled: true });
    const reasonFor = async (utt) => decodeToken(loop.attest({ embedding: await loop.embed(utt), utt, transcript: 'yes go ahead' }).token).reason;
    assert.equal(await reasonFor(utterance(2)), 'owner_mismatch');
    assert.equal(await reasonFor(utterance(3)), 'self_echo');
    assert.equal(await reasonFor(utterance(1, 1400, { overlap: true })), 'captured_during_narration');
    const over = utterance(1, 1400, { overlap: true });
    const overPayload = decodeToken(loop.attest({ embedding: await loop.embed(over), utt: over, transcript: 'yes go ahead' }).token);
    assert.equal(overPayload.capturedDuringNarration, true, 'the server re-checks this field itself');
    assert.equal(overPayload.playbackOverlap, 'OVERLAP');
    assert.equal(await reasonFor(utterance(1, 500)), 'too_short');
    const blank = await freshOwnerVoice();
    const noPrint = ownerVoiceForLoop(blank.ov);
    assert.equal(await noPrint.embed(utterance(1)), null, 'no print → the speaker sidecar is never started');
    assert.equal(decodeToken(noPrint.attest({ embedding: null, utt: utterance(1), transcript: 'yes' }).token).reason, 'owner_not_enrolled');
    blank.ov.dispose();
    // No per-launch key → no token at all (→ no header → unverified voice).
    const keyless = attestUtterance({ ...ctx.ov, mintAttestation: () => null }, { embedding: voiceVector(1), speechMs: 1400, transcript: 'yes', capturedAt: Date.now() });
    assert.equal(keyless.token, null);
  } finally { ctx.ov.dispose(); rmSync(ctx.state, { recursive: true, force: true }); }
});

// ── The loop: the wake phrase is never sent; the command carries its token ───────
test('utterance handler: the wake phrase alone sends nothing; a command carries a token for its own text', async () => {
  const sent = [];
  const attested = [];
  const said = [];
  const wake = createWakeState({ wakePhrases: ['ghost wake up', 'ghost'], idleMs: 60_000 });
  const heard = new Map();
  const handle = createUtteranceHandler({
    wake,
    transcribe: async (samples) => heard.get(samples),
    embed: async () => voiceVector(1),
    attest: ({ transcript }) => { attested.push(transcript); return { token: `solvox2.${Buffer.from(transcript).toString('base64url')}.mac`, decision: { reason: 'owner_match' } }; },
    onCommand: async (text, { attestation }) => { sent.push({ text, attestation }); },
    say: async (line) => { said.push(line); },
  });
  const run = async (text) => { const u = utterance(1); heard.set(u.samples, text); await handle(u); return u; };
  await run('yes, go ahead'); // asleep: ignored, nothing analysed
  const woke = await run('Ghost, wake up.');
  assert.deepEqual(sent, [], 'waking sends nothing to the engine, so it can never approve');
  assert.deepEqual(attested, [], 'and nothing is attested for it');
  assert.deepEqual(said, ["I'm here."]);
  assert.ok(woke.samples.every((x) => x === 0), 'samples zero-filled');
  await run('yes, go ahead');
  assert.deepEqual(sent.map((s) => s.text), ['yes, go ahead']);
  assert.equal(Buffer.from(sent[0].attestation.split('.')[1], 'base64url').toString(), 'yes, go ahead', 'minted for exactly the text sent');
  wake.sleep();
  await run('Ghost, yes go ahead'); // addressed while asleep: the yes is the command, the name is stripped
  assert.equal(sent.at(-1).text, 'yes go ahead');
  assert.equal(attested.at(-1), 'yes go ahead');
});

test('turn headers: the nonce or an attestation, never both; the attestation only under the verified mode', async () => {
  const nonce = 'n'.repeat(64);
  assert.deepEqual(turnHeaders({ owner: true, nonce }), { [DESKTOP_NONCE_HEADER]: nonce });
  assert.deepEqual(turnHeaders({ owner: true, attestation: 'solvox2.a.b', nonce }), { [DESKTOP_NONCE_HEADER]: nonce }, 'never both');
  assert.deepEqual(turnHeaders({ owner: false, attestation: 'solvox2.a.b', nonce }), { [VOICE_ATTESTATION_HEADER]: 'solvox2.a.b' });
  assert.deepEqual(turnHeaders({ owner: false, attestation: null, nonce }), {});
  assert.deepEqual(turnHeaders({ owner: false, attestation: 'forged', nonce }), {});
  assert.deepEqual(turnWire({ mode: 'voice', voiceAuthority: 'verified' }), { mode: 'voice', owner: false, spoken: true, attested: true });
  const sent = async (voiceAuthority) => {
    const calls = [];
    const session = createOwnerSession({ port: 1, secrets: { nonce }, voiceOut: false, out: () => {}, voiceAuthority, turnImpl: async (_port, args) => { calls.push(args); return { ok: true, spoken: '', confirmationRequired: false, raw: {} }; } });
    await session.runTurn('yes, go ahead', { owner: false, mode: 'voice', attestation: 'solvox2.x.y' });
    return calls[0];
  };
  const verified = await sent('verified');
  assert.equal(verified.mode, 'voice');
  assert.equal(verified.text, 'yes, go ahead');
  assert.deepEqual(verified.headers, { [VOICE_ATTESTATION_HEADER]: 'solvox2.x.y' }, 'verified: its own token, never the nonce');
  const owner = await sent('owner');
  assert.deepEqual([owner.mode, owner.headers], ['text', { [DESKTOP_NONCE_HEADER]: nonce }], 'owner (default): the console nonce; a token would demote it to voice');
  const propose = await sent('propose');
  assert.deepEqual([propose.mode, propose.headers], ['text', {}]);
  if (HAVE_MODULES) assert.equal(VOICE_ATTESTATION_HEADER, (await loadOwnerVoiceModules(MODULES_DIR)).VOICE_ATTESTATION_HEADER);
});

test('voice authority: owner by default; the saved choice, then the env var, picks another', () => {
  assert.equal(resolveVoiceAuthority({}), 'owner');
  assert.equal(resolveVoiceAuthority({}, 'verified\n'), 'verified', 'kingmaker voice verified (saved) opts in, for the app too');
  assert.equal(resolveVoiceAuthority({ SOL_GHOST_VOICE_AUTHORITY: 'owner' }, 'verified'), 'owner', 'the env var wins');
  assert.equal(resolveVoiceAuthority({ SOL_GHOST_VOICE_AUTHORITY: 'Verified' }), 'verified');
  assert.equal(resolveVoiceAuthority({}, 'garbage'), 'owner');
  assert.deepEqual(VOICE_AUTHORITIES, ['owner', 'verified', 'propose']);
  const state = mkdtempSync(join(tmpdir(), 'sg-voice-'));
  try {
    assert.equal(savedVoiceAuthority({ state }), '');
    writeFileSync(join(state, 'voice-authority'), 'verified\n');
    assert.equal(savedVoiceAuthority({ state }), 'verified');
  } finally { rmSync(state, { recursive: true, force: true }); }
});

test('say → WAV → samples: only the 16 kHz mono data chunk is read', () => {
  const s = new Int16Array([0, 16384, -16384]);
  const wav = wavBytes(s);
  const withExtraChunk = Buffer.concat([wav.subarray(0, 36), Buffer.from('FLLR'), Buffer.from([4, 0, 0, 0, 0, 0, 0, 0]), wav.subarray(36)]);
  assert.deepEqual([...wavToFloat32(withExtraChunk)], [0, 0.5, -0.5]);
});

test('enroll: a sentence whisper keeps mishearing is set aside, never retried forever', needs, async () => {
  const run = async (badFrom) => {
    const ctx = await freshOwnerVoice({ withConsole: true });
    const said = [];
    let n = 0; let prompt = null;
    try {
      const r = await runEnrollment({
        ov: ctx.ov, ipc: ctx.ipc, channels: ctx.modules.OWNER_VOICE_IPC,
        next: async () => { prompt = ctx.ov.enrollment.progress().currentPrompt; n += 1; return { kind: 'utterance', utt: { samples: utterance(1, 2400).samples, speechMs: 2400 } }; },
        transcribe: async () => (ctx.ov.enrollment.progress().accepted >= badFrom ? 'the small pop nordahole' : prompt),
        embed: async (samples) => (await ctx.ov.supervisor.identify([toFloat32(samples)]))?.embedding ?? null,
        out: (line) => said.push(line),
      });
      return { r, n, said };
    } finally { ctx.ov.dispose(); rmSync(ctx.state, { recursive: true, force: true }); }
  };
  const enough = await run(3); // 3 accepted, then one sentence is misheard
  assert.equal(enough.r.ok, true);
  assert.equal(enough.r.sampleCount, 3, "the engine's own minimum still decides");
  assert.equal(enough.n, 6, '3 accepted + 3 misheard, then it finishes');
  const never = await run(0); // nothing is ever heard right
  assert.equal(never.r.ok, false);
  assert.equal(never.r.reason, 'too_many_attempts');
  assert.equal(never.said.filter((l) => /starting over/.test(l)).length, 2, 'two fresh sets of sentences, then it stops');
});

test('enroll: a keyboard or a cough is not an attempt and never a sample', needs, async () => {
  const ctx = await freshOwnerVoice({ withConsole: true });
  try {
    let n = 0; let prompt = null;
    const r = await runEnrollment({
      ov: ctx.ov, ipc: ctx.ipc, channels: ctx.modules.OWNER_VOICE_IPC, maxAttempts: 5,
      next: async () => { prompt = ctx.ov.enrollment.progress().currentPrompt; n += 1; return { kind: 'utterance', utt: { samples: utterance(1, 2400).samples, speechMs: 2400 } }; },
      transcribe: async () => (n % 2 === 1 ? '(keyboard clicking)' : prompt),
      embed: async (samples) => (await ctx.ov.supervisor.identify([toFloat32(samples)]))?.embedding ?? null,
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.sampleCount, 5, 'five real sentences, the five noises ignored');
    assert.equal(n, 10);
  } finally { ctx.ov.dispose(); rmSync(ctx.state, { recursive: true, force: true }); }
});
