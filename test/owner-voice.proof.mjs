// OWNER-VOICE AUTHORITY PROOF — real models, real authority, nothing faked between the mic and the broker.
//
//   audio      Apple `say` voices stand in for people (no human is recorded): Daniel = the owner, Karen =
//              someone else, the default `say` voice = Kingmaker itself (the voice it speaks with).
//   Sol Ghost  its real pipeline: segmenter (speechMs), whisper.cpp via stdin, the CAM++ sidecar from
//              Solomon.app, the utterance handler (wake state), the mint for the exact text sent.
//   engine     its real owner-voice modules (desktop/owner-voice/*: guided enrollment, the sealed store, the
//              gate, solvox2) sealed by Sol Ghost's Keychain sealer in a THROWAWAY Keychain item (deleted at
//              the end), and its real authority: resolveTurnPrincipal → PrincipalVerifier (rule a) → the turn
//              interceptor → the ActionBroker, on a scratch SQLite. Not the HTTP route itself.
//
// Run:   npm run proof:owner-voice
//        (= node --experimental-sqlite with tsx from the engine source checkout's server/node_modules)
// Needs: an engine source checkout (KINGMAKER_ENGINE_SRC) and Solomon.app's voice runtime. Absent → exit 2 (SKIP,
// never a PASS). Exit 0 only when every check holds.

import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConsoleIpc, runEnrollment } from '../lib/enroll.mjs';
import { createKeychainSafeStorage } from '../lib/keychain-seal.mjs';
import { embedUtterance, learnSelfPrint, newUtteranceId, openOwnerVoice, ownerVoiceForLoop, synthesizeSay } from '../lib/owner-voice.mjs';
import { resolvePaths } from '../lib/paths.mjs';
import { turnHeaders, turnWire } from '../lib/session.mjs';
import { createSegmenter, createUtteranceHandler, createWakeState, transcribe } from '../lib/voice.mjs';
import { forkLayout } from '../lib/fork.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE_SRC = (process.env.KINGMAKER_ENGINE_SRC ? resolve(process.env.KINGMAKER_ENGINE_SRC) : forkLayout().root);
const OWNER = process.env.SOL_GHOST_PROOF_OWNER_VOICE || 'Daniel';
const OTHER = process.env.SOL_GHOST_PROOF_OTHER_VOICE || 'Karen';
const T = 'primary';
const U = 'owner';

const state = mkdtempSync(join(tmpdir(), 'sol-ghost-proof-'));
const blankState = mkdtempSync(join(tmpdir(), 'sol-ghost-proof-blank-'));
const paths = resolvePaths({ ...process.env, SOL_GHOST_HOME: state });
function skip(reason) { console.log(`SKIP owner-voice proof: ${reason}`); process.exit(2); }
if (!existsSync(join(ENGINE_SRC, 'desktop', 'owner-voice', 'install.mjs'))) skip(`no engine source checkout at ${ENGINE_SRC}`);
for (const p of [paths.voice.whisper, paths.voice.sttModel, paths.voice.speaker, paths.voice.speakerModel]) if (!existsSync(p)) skip(`missing ${p}`);

const results = [];
let failed = 0;
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

// ── the engine's authority spine on a scratch database ──────────────────────────
process.env.NODE_ENV = 'test';
const KEY = randomBytes(32).toString('hex');
process.env.SOLOMON_VOICE_ATTESTATION_KEY = KEY; // this launch's key, as Sol Ghost hands it to the backend
process.env.SOLOMON_DESKTOP_CONTROL_NONCE = randomBytes(32).toString('hex');
const setup = await import(`${ENGINE_SRC}/tests/meta-governance/setup.ts`);
setup.initMetaGovernanceTestRuntime('sol-ghost-owner-voice-proof-');
await setup.bootstrapMetaGovernanceStorage();
const C = await import(`${ENGINE_SRC}/server/src/runtime/control-surface/contracts.ts`);
const { registerAuthoritySpine } = await import(`${ENGINE_SRC}/server/src/runtime/control-surface/authority/register.ts`);
const { fixtureDescriptor } = await import(`${ENGINE_SRC}/server/src/runtime/control-surface/authority/effect-model.ts`);
const { resolveTurnPrincipal } = await import(`${ENGINE_SRC}/server/src/runtime/control-surface/integration/principal.ts`);
const { createTurnInterceptor } = await import(`${ENGINE_SRC}/server/src/runtime/control-surface/integration/interceptor.ts`);
const spine = registerAuthoritySpine({ env: process.env, startTimers: false });
const interceptor = createTurnInterceptor();
const runs = [];
spine.broker.registerContinuation('sol-ghost-proof', async (p, approvalId, principal) => {
  runs.push({ proposalId: p.proposalId, principal: principal.kind });
  return { spoken: `Done: ${p.summary}`, status: 'EXECUTED', verified: true };
});
const requester = { ...C.nonePrincipal(T, U, 'desktop_nonce', true), kind: 'operator_typed' };
async function propose(conversationId, what) {
  const descriptor = fixtureDescriptor('proof.write', 'YELLOW');
  const call = { toolId: 'proof.write', args: { what } };
  const d = await spine.broker.propose({ tenantId: T, userId: U, conversationId, origin: 'sol-ghost-proof', toolCall: call, descriptor, verdict: spine.effect.classify(descriptor, call), summary: `Write the ${what} note.`, requester, plannerSource: 'local_llm' });
  if (d.kind !== 'PROPOSED') throw new Error(`proposal not created: ${d.kind}`);
  return d.proposal.proposalId;
}
const statusOf = (id) => spine.store.getProposal(T, id)?.status;
/** One spoken turn as Sol Ghost's session puts it on the wire (turnWire + turnHeaders, per voice authority),
 *  then as the route resolves it: the headers + the RAW userText → principal → interceptor. */
async function serverTurn({ text, attestation, conversationId, voiceAuthority = 'verified' }) {
  const wire = turnWire({ owner: false, mode: 'voice', voiceAuthority });
  const headers = turnHeaders({ owner: wire.owner, attestation: wire.attested ? attestation : null, nonce: process.env.SOLOMON_DESKTOP_CONTROL_NONCE });
  const req = { headers, socket: { remoteAddress: '127.0.0.1' }, body: { userText: text, mode: wire.mode }, path: '/api/conversation/turn' };
  const principal = resolveTurnPrincipal({ req, tenantId: T, userId: U, mode: wire.mode, rawUserText: text });
  const result = await interceptor.intercept({ tenantId: T, userId: U, conversationId, utterance: text, mode: 'voice', principal, regexRoute: null });
  return { principal, result };
}

// ── Sol Ghost's owner voice: the real wiring, a throwaway Keychain item ─────────────
const service = `Sol Ghost Owner Voice (proof ${process.pid})`;
const seal = createKeychainSafeStorage({ service });
const ipc = createConsoleIpc();
const owner = await openOwnerVoice({ paths, attestationKeyHex: KEY, ipcMain: ipc.ipcMain, isAuthoritativeSender: ipc.isAuthoritativeSender, modulesDir: join(ENGINE_SRC, 'desktop'), safeStorage: seal, log: () => {} });
const blankSeal = createKeychainSafeStorage({ service: `${service} blank` });
const blank = await openOwnerVoice({ paths: { ...paths, state: blankState }, attestationKeyHex: KEY, modulesDir: join(ENGINE_SRC, 'desktop'), safeStorage: blankSeal });
const IPC = owner.modules.OWNER_VOICE_IPC;

/** `say` audio → Sol Ghost's own segmenter (as the mic loop feeds it) → {samples, speechMs}. */
async function speech(text, voice, { endSilenceMs } = {}) {
  const pcm = await synthesizeSay(text, { voice });
  if (!pcm) throw new Error(`say -v ${voice} failed`);
  const lead = new Int16Array(16 * 600); const tail = new Int16Array(16 * 1500);
  const body = new Int16Array(pcm.length);
  for (let i = 0; i < pcm.length; i += 1) body[i] = Math.max(-32768, Math.min(32767, Math.round(pcm[i] * 32767)));
  pcm.fill(0);
  const all = new Int16Array(lead.length + body.length + tail.length); all.set(lead); all.set(body, lead.length);
  body.fill(0);
  const seg = createSegmenter(endSilenceMs ? { endSilenceMs } : {});
  const out = [];
  for (let at = 0; at < all.length; at += 1600) out.push(...seg.push(Buffer.from(all.slice(at, at + 1600).buffer)));
  all.fill(0);
  if (out.length === 0) throw new Error(`segmenter heard nothing in "${text}"`);
  if (out.length === 1) return out[0];
  // A long pause split it: join the pieces (the mic loop would have sent two utterances).
  const samples = new Int16Array(out.reduce((n, u) => n + u.samples.length, 0)); let o = 0;
  for (const u of out) { samples.set(u.samples, o); o += u.samples.length; u.samples.fill(0); }
  return { samples, speechMs: out.reduce((n, u) => n + u.speechMs, 0) };
}
const stt = (samples) => transcribe(samples, { whisper: paths.voice.whisper, model: paths.voice.sttModel });

/** Run one spoken utterance through Sol Ghost's handler; returns what it sent (or nothing). */
async function speak(ov, wake, text, voice, { overlap = false } = {}) {
  const loop = ownerVoiceForLoop(ov);
  const sent = [];
  let decision = null;
  const handle = createUtteranceHandler({
    wake, transcribe: stt, embed: loop.embed,
    attest: (args) => { const r = loop.attest(args); decision = r.decision; return r; },
    onCommand: async (t, { attestation }) => { sent.push({ text: t, attestation }); },
    say: async () => {},
  });
  const s = await speech(text, voice);
  const step = await handle({ ...s, overlap, endedAt: Date.now(), utteranceId: newUtteranceId() });
  return { step, sent: sent[0] ?? null, decision, speechMs: s.speechMs };
}

let exitCode = 1;
try {
  // ── 0. The anti-print and the owner's enrollment ──────────────────────────────
  const warm = await owner.ov.supervisor.warm({ timeoutMs: 90_000 });
  check('speaker model (CAM++) loads from Solomon.app', warm.ok, JSON.stringify(warm));
  const self = await learnSelfPrint(owner.ov);
  check("Kingmaker's own voice learned as the anti-print", self.ok, `${self.samples ?? 0} samples`);
  let prompt = null;
  const enrolled = await runEnrollment({
    ov: owner.ov, ipc, channels: IPC,
    next: async () => { prompt = owner.ov.enrollment.progress().currentPrompt; return { kind: 'utterance', utt: await speech(prompt, OWNER, { endSilenceMs: 900 }) }; },
    transcribe: stt,
    embed: (samples) => embedUtterance(owner.ov, samples, { timeoutMs: 20_000 }),
    out: (line) => console.log(line),
  });
  check(`owner (${OWNER}) enrolled through the engine's guided enrollment`, enrolled.ok, JSON.stringify({ samples: enrolled.sampleCount, mean: enrolled.meanPairwise, min: enrolled.minPairwise, reason: enrolled.reason }));
  check('the print is sealed with the Keychain key (sgv1, not JSON)', (await import('node:fs')).readFileSync(join(state, 'owner-voice', 'owner.sealed')).subarray(0, 4).toString() === 'sgv1');

  const wake = createWakeState({ idleMs: 600_000 });

  // ── 5a. The wake phrase alone never approves: it is never even sent ───────────────
  const pWake = await propose('c-wake', 'wake');
  const w = await speak(owner.ov, wake, 'Ghost, wake up.', OWNER);
  check('wake phrase alone (owner voice): nothing sent to the engine', w.step.action === 'wake' && w.sent === null, `action=${w.step.action}`);
  check('wake phrase alone: the proposal is still waiting', statusOf(pWake) === 'PENDING', statusOf(pWake));

  // ── 1. The owner's attested yes confirms ──────────────────────────────────────
  const pOwner = await propose('c-owner', 'owner');
  const pReplay = await propose('c-replay', 'replay'); // created BEFORE the yes is heard, so only replay can stop it
  const yes = await speak(owner.ov, wake, 'Yes, go ahead.', OWNER);
  const t1 = await serverTurn({ text: yes.sent.text, attestation: yes.sent.attestation, conversationId: 'c-owner' });
  check('owner yes: gate says owner_match', yes.decision?.reason === 'owner_match', `similarity ${yes.decision?.similarity} ≥ ${yes.decision?.threshold}, speechMs ${yes.speechMs}, heard "${yes.sent.text}"`);
  check('owner yes: server verifies owner_voice', t1.principal.kind === 'owner_voice', `${t1.principal.kind}/${t1.principal.reason}`);
  check('owner yes: the proposal is confirmed and runs once', ['CONFIRMED', 'EXECUTED'].includes(statusOf(pOwner)) && runs.filter((r) => r.proposalId === pOwner).length === 1, `${statusOf(pOwner)}, "${t1.result?.spoken}"`);

  // ── 3. A replayed token cannot ────────────────────────────────────────────────
  const t3 = await serverTurn({ text: yes.sent.text, attestation: yes.sent.attestation, conversationId: 'c-replay' });
  check('replayed token: server refuses it (replayed)', t3.principal.kind === 'unverified_voice' && t3.principal.reason === 'replayed', `${t3.principal.kind}/${t3.principal.reason}`);
  check('replayed token: nothing confirmed, nothing ran', statusOf(pReplay) === 'PENDING' && runs.every((r) => r.proposalId !== pReplay), `${statusOf(pReplay)}, "${t3.result?.spoken}"`);
  const forged = await serverTurn({ text: 'Yes, go ahead, and send it.', attestation: yes.sent.attestation, conversationId: 'c-replay' });
  check('a token on different text is refused (transcript binding)', forged.principal.kind === 'unverified_voice' && ['transcript_mismatch', 'replayed'].includes(forged.principal.reason), `${forged.principal.kind}/${forged.principal.reason}`);

  // ── 2. An unenrolled print or another speaker cannot ─────────────────────────────
  const pBlank = await propose('c-blank', 'blank');
  const nb = await speak(blank.ov, createWakeState({ idleMs: 600_000 }), 'Ghost, yes go ahead.', OWNER);
  const t2a = await serverTurn({ text: nb.sent.text, attestation: nb.sent.attestation, conversationId: 'c-blank' });
  check('no print enrolled: the gate says owner_not_enrolled', nb.decision?.reason === 'owner_not_enrolled', nb.decision?.reason);
  check('no print enrolled: server keeps it unverified, nothing confirmed', t2a.principal.kind === 'unverified_voice' && statusOf(pBlank) === 'PENDING', `${t2a.principal.kind}/${t2a.principal.reason}, ${statusOf(pBlank)}`);
  const pOther = await propose('c-other', 'other');
  const other = await speak(owner.ov, wake, 'Yes, go ahead.', OTHER);
  const t2b = await serverTurn({ text: other.sent.text, attestation: other.sent.attestation, conversationId: 'c-other' });
  check(`another speaker (${OTHER}): the gate says owner_mismatch`, other.decision?.reason === 'owner_mismatch', `similarity ${other.decision?.similarity} < ${other.decision?.threshold}`);
  check('another speaker: server keeps it unverified, nothing confirmed', t2b.principal.kind === 'unverified_voice' && statusOf(pOther) === 'PENDING', `${t2b.principal.kind}/${t2b.principal.reason}, ${statusOf(pOther)}`);

  // ── 4. Kingmaker's own TTS echo cannot (the anti-print), nor the owner over Kingmaker ─
  const pEcho = await propose('c-echo', 'echo');
  const echo = await speak(owner.ov, wake, 'Yes, go ahead.', undefined);
  const t4 = await serverTurn({ text: echo.sent.text, attestation: echo.sent.attestation, conversationId: 'c-echo' });
  check("Kingmaker's own voice: the gate says self_echo", echo.decision?.reason === 'self_echo', `self-similarity ${echo.decision?.selfSimilarity}, owner similarity ${echo.decision?.similarity}`);
  check("Kingmaker's own voice: server keeps it unverified, nothing confirmed", t4.principal.kind === 'unverified_voice' && statusOf(pEcho) === 'PENDING', `${t4.principal.kind}/${t4.principal.reason}, ${statusOf(pEcho)}`);
  const pOver = await propose('c-over', 'over');
  const over = await speak(owner.ov, wake, 'Yes, go ahead.', OWNER, { overlap: true });
  const t4b = await serverTurn({ text: over.sent.text, attestation: over.sent.attestation, conversationId: 'c-over' });
  check('owner speaking over Kingmaker: captured_during_narration, nothing confirmed', over.decision?.reason === 'captured_during_narration' && t4b.principal.kind === 'unverified_voice' && statusOf(pOver) === 'PENDING', `${over.decision?.reason} → ${t4b.principal.kind}/${t4b.principal.reason}, ${statusOf(pOver)}`);

  // ── 5b. Even attested as the owner, the wake phrase is not a yes ──────────────────
  const wakeTok = await (async () => {
    const s = await speech('Ghost, wake up.', OWNER);
    const loop = ownerVoiceForLoop(owner.ov);
    const utt = { ...s, overlap: false, endedAt: Date.now(), utteranceId: newUtteranceId() };
    const r = loop.attest({ embedding: await loop.embed(utt), utt, transcript: 'Ghost, wake up.' });
    s.samples.fill(0);
    return r;
  })();
  const t5 = await serverTurn({ text: 'Ghost, wake up.', attestation: wakeTok.token, conversationId: 'c-wake' });
  check('wake phrase posted with a valid owner token: still not an approval', statusOf(pWake) === 'PENDING' && runs.every((r) => r.proposalId !== pWake), `${t5.principal.kind}/${t5.principal.reason}, handled=${Boolean(t5.result?.handled)}, ${statusOf(pWake)}`);

  // ── 6. "Ghost, yes go ahead" in one breath: the yes is the authority, the name only wakes ──
  wake.sleep();
  const pOne = await propose('c-onebreath', 'one-breath');
  const one = await speak(owner.ov, wake, 'Ghost, yes go ahead.', OWNER);
  const t6 = one.sent ? await serverTurn({ text: one.sent.text, attestation: one.sent.attestation, conversationId: 'c-onebreath' }) : null;
  check('asleep, "Ghost, yes go ahead" (owner): only "yes go ahead" is sent, attested, and confirms', one.sent && !/ghost/i.test(one.sent.text) && t6?.principal.kind === 'owner_voice' && ['CONFIRMED', 'EXECUTED'].includes(statusOf(pOne)), `sent "${one.sent?.text}", ${t6?.principal.kind}/${t6?.principal.reason}, ${statusOf(pOne)}, speechMs ${one.speechMs}`);

  check('verified mode: continuations ran exactly for the two owner yeses', runs.length === 2 && runs.every((r) => r.principal === 'owner_voice'), JSON.stringify(runs.map((r) => r.principal)));

  // ── 7. The default 'owner' mode (Sol Ghost's own rule): awake, any voice is the owner's word ─────
  const pDefault = await propose('c-default', 'default');
  const anyone = await speak(owner.ov, wake, 'Yes, go ahead.', OTHER);
  const t7 = await serverTurn({ text: anyone.sent.text, attestation: anyone.sent.attestation, conversationId: 'c-default', voiceAuthority: 'owner' });
  check(`owner mode (default): ${OTHER}'s spoken yes goes with the console nonce and confirms, no token sent`, t7.principal.kind === 'operator_typed' && ['CONFIRMED', 'EXECUTED'].includes(statusOf(pDefault)), `${t7.principal.kind}/${t7.principal.reason}, ${statusOf(pDefault)}`);
  const pPropose = await propose('c-propose', 'propose');
  const t8 = await serverTurn({ text: 'Yes, go ahead.', attestation: null, conversationId: 'c-propose', voiceAuthority: 'propose' });
  check('propose mode: a spoken yes is a local program and confirms nothing', t8.principal.kind === 'local_process' && statusOf(pPropose) === 'PENDING', `${t8.principal.kind}/${t8.principal.reason}, ${statusOf(pPropose)}`);
  exitCode = failed === 0 ? 0 : 1;
} catch (error) {
  check('proof ran to the end', false, String(error?.stack || error).slice(0, 600));
  exitCode = 1;
} finally {
  try { await ipc.invoke(IPC.forget); } catch { /* */ }
  owner.dispose(); blank.dispose(); spine.stop();
  const k1 = seal.destroyKey(); const k2 = blankSeal.destroyKey();
  rmSync(state, { recursive: true, force: true }); rmSync(blankState, { recursive: true, force: true });
  console.log(`\nthrowaway Keychain items deleted: ${k1.ok && k2.ok}`);
  console.log(`${results.filter((r) => r.ok).length}/${results.length} checks passed`);
}
process.exit(exitCode);
