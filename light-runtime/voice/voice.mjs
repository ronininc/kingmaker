// light-runtime/voice/voice.mjs — THE VOICE of the light runtime: an ear and a mouth that
// run IN the tab, beside the browser seat (Robbie's order, 2026-10-28: voice ingestion as
// text and Kokoro speech must work inside the browser seat, even on 8 GB — and Scripture
// Armor's sealed delivery is what allows it: the models arrive sealed, their pins verified,
// unsealed in memory only, the same avenue as the LLM seat).
//
// This module reaches the page ONLY through the device layer's verified session handoff
// (light-runtime/voice-artifact.mjs): it is sealed INTO the voice artifact's bundle, and
// everything it runs is pinned in that bundle's manifest, sha-verified before use:
//
//   EAR    whisper-tiny.en (q8, ONNX) via the vendored transformers.js on ONE shared
//          onnxruntime-web build (1.22.0-dev.20250409 — the pairing the feasibility test
//          pinned: the 1.21 wasm set fails session creation in kokoro's stack). The two
//          ONNX weights are sha-verified in-page against the sealed manifest before the
//          pipeline is built; the model loads from the session leg with remote models
//          DISABLED — a missing local file is a hard failure, never a trip to a hub.
//   MOUTH  Kokoro-82M (q8, ONNX) via the vendored kokoro-js, PER-SENTENCE generate() ONLY.
//          kokoro-js's stream() never yields in its 1.2.1 web build (feasibility report
//          §4.2, reproduced three times) and is never called here. kokoro-js's loaders
//          cannot be pointed at a local path through its public env — but its model
//          loader consults the 'transformers-cache' Cache Storage before any fetch, and
//          its voice loader checks 'kokoro-voices' before fetching its hard-coded hub
//          URL. So the voice's files are sha-verified against the sealed pins and placed
//          in those caches under the exact URLs the loaders will request: the library
//          runs unmodified and never touches the network.
//
// THE SPOKEN ASK PATH: microphone (getUserMedia) → transcription in-tab → the transcript
// enters the wall's ask pipeline through the page's own submit, labelled surface 'voice'
// — the same routeLane seam, the same turn-feed stages, the same cards as a typed ask.
// The card's question IS the transcript: the owner sees what was heard. A failure BEFORE
// a transcript exists (no mic, the ear will not load, an empty transcription) is reported
// through onFailure so the wall records it as a FAILED card with the true reason — voice
// never fails silently, and a spoken ask is never dressed as a typed one (or vice versa).
//
// SPOKEN ANSWERS are a readback, not the record: the card always carries the full text.
// Speech is capped (SPOKEN_MAX_WORDS), synthesized one sentence ahead of playback, and
// stoppable; on a floor CPU synthesis runs slower than real time (feasibility report §4),
// so sentences may arrive with gaps — the queue tolerates that and never wedges the tab
// (a per-sentence watchdog stops speech rather than hang). A speech failure is a note on
// the card; it never fails the ask, whose answer already stands in text.
//
// THE DEGRADATION LADDER (feasibility report §7), implemented:
//   1. the ear loads ON DEMAND (first mic press) and unloads after the turn — a short
//      grace, a hidden tab, or heap pressure sheds it; it is never resident by default;
//   2. the mouth synthesizes only when speech is requested, one sentence ahead, capped;
//   3. whisper-base is omitted entirely — tiny is the ear (base remains a store drop-in
//      the manifest discipline would pin, but no code here loads it);
//   4. loads are STAGGERED through one serialized chain — ear, mouth and the seat never
//      stack a load spike, and NO voice load ever sits on an ask's critical path: the
//      ear loads while the owner is still speaking, and submitAsk never waits on voice;
//   5. under pressure, voice yields FIRST (the governed turn's own shedding — the native
//      side's PRESSURE_SHED — is untouched by anything here).

export const VOICE_SCHEMA = 'kingmaker.light-voice/1';
export const STT_MODEL_ID = 'onnx-community/whisper-tiny.en';
export const TTS_MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
export const TTS_VOICE = 'af_heart';
/** The hub base kokoro-js's loaders hard-code. Used ONLY as Cache Storage keys — the
 *  verified local bytes are placed under these URLs so the loaders' cache-first reads
 *  hit them. Nothing is ever fetched from this origin. */
export const TTS_HUB_BASE = `https://huggingface.co/${TTS_MODEL_ID}/resolve/main/`;
/** Spoken-length cap (ladder rung 2): speech beyond this many words is not synthesized;
 *  the text on the card is never truncated. ≈50 s of speech at a normal pace. */
export const SPOKEN_MAX_WORDS = 120;
/** Ladder rung 1: the ear is shed this long after a transcription completes. */
export const EAR_IDLE_UNLOAD_MS = 20_000;
/** The mouth's references are dropped this long after speech ends (kokoro-js exposes no
 *  dispose; its caches persist in storage, so a later load is warm and cheap). */
export const VOICE_IDLE_UNLOAD_MS = 60_000;
/** The heap tripwire (performance.memory, where the browser offers it): above this, the
 *  resident voice models are shed before anything else is asked to make room. */
export const HEAP_SHED_BYTES = 1_500_000_000;
/** One sentence's synthesis may take this long before speech stops instead of wedging. */
export const SENTENCE_SYNTH_WATCHDOG_MS = 120_000;

const WHISPER_ONNX = ['onnx/encoder_model_quantized.onnx', 'onnx/decoder_model_merged_quantized.onnx'];
const KOKORO_CACHE_FILES = ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx'];

/** Pure: split text into speakable sentences (the feasibility POC's splitter, plus one
 *  production correction: a trailing fragment with no terminal punctuation — the shape
 *  model answers often end in — is kept as a final sentence, never dropped). */
export function splitSentences(text) {
  const s = String(text ?? '');
  const out = [];
  const re = /[^.!?]+[.!?]+["']?\s*/g;
  let consumed = 0, m;
  while ((m = re.exec(s))) { const t = m[0].trim(); if (t) out.push(t); consumed = re.lastIndex; }
  const rest = s.slice(consumed).trim();
  if (rest) out.push(rest);
  return out;
}

const wordCount = (s) => String(s).split(/\s+/).filter(Boolean).length;

/**
 * Pure: the spoken plan for an answer — whole sentences up to the word cap (the first
 * sentence is always taken whole, even if it alone exceeds the cap: a spoken answer that
 * starts must be able to finish its first thought). `capped` says the speech will NOT
 * cover the full text; the card's text is unaffected either way.
 */
export function planSpeech(text, { maxWords = SPOKEN_MAX_WORDS } = {}) {
  const sentences = splitSentences(text);
  const picked = [];
  let used = 0;
  for (const s of sentences) {
    const w = wordCount(s);
    if (picked.length && used + w > maxWords) break;
    picked.push(s); used += w;
  }
  return { sentences: picked, capped: picked.length < sentences.length, words: used, totalSentences: sentences.length };
}

const sha256Hex = async (buf) => {
  const h = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
};
const getJson = async (path) => (await (await fetch(path, { cache: 'no-store' })).json());

/**
 * Start the voice. Callbacks (all optional, all guarded — a broken callback never breaks
 * the voice):
 *   onStatus(state)          the voice's own state line for the wall (ear/speech states,
 *                            availability, the last speech's scheduling record)
 *   onTranscript(text)       a spoken ask's transcript, ready for the ask pipeline
 *   onFailure({stage,error}) a failure BEFORE any transcript existed — the wall records
 *                            it as a FAILED card; voice never fails silently
 *   onSpeech(askId, event)   a spoken answer's state for its card (loading / speaking /
 *                            done / stopped / failed + a plain-words detail)
 * Returns the voice's controls: { startListening, stopListening, speak, stopSpeech,
 * transcribeSamples, synthesizeSamples, state }.
 */
export function startVoice({ onStatus = () => {}, onTranscript = () => {}, onFailure = () => {}, onSpeech = () => {} } = {}) {
  const S = {
    manifest: null,
    // The ear has TWO lifecycles that must never clobber each other: the MODEL's
    // (absent → idle → loading → ready — it loads while the owner speaks) and the
    // CAPTURE's (listening → transcribing, while a spoken ask is being made). The wall
    // shows the capture while one is live, else the model's state.
    earModel: 'boot', capture: null,
    speech: 'idle', detail: 'the voice module is starting',
    transcriber: null, earLoad: null,
    tts: null, ttsLoad: null,
    stream: null, recorder: null, chunks: [],
    actx: null, speechToken: 0, speakingAskId: null,
    earUnloadTimer: null, voiceUnloadTimer: null,
    lastSpeech: null,
  };
  const earShown = () => S.capture ?? S.earModel;
  const emit = () => {
    try {
      onStatus({
        ear: earShown(), earModel: S.earModel, capture: S.capture,
        speech: S.speech, detail: S.detail,
        sttAvailable: S.manifest ? Boolean(S.manifest.stt) : null,
        ttsAvailable: S.manifest ? Boolean(S.manifest.tts) : null,
        lastSpeech: S.lastSpeech,
      });
    } catch { /* the wall's paint never breaks the voice */ }
  };
  const setEarModel = (earModel, detail) => { S.earModel = earModel; if (detail) S.detail = detail; emit(); };
  const setCapture = (capture, detail) => { S.capture = capture; if (detail) S.detail = detail; emit(); };
  const setSpeech = (speech, detail) => { S.speech = speech; if (detail) S.detail = detail; emit(); };
  const emitSpeech = (askId, state, detail) => { try { onSpeech(askId, { state, detail }); } catch { /* as above */ } };

  // ── Loads are staggered through ONE chain (ladder rung 4): ear, mouth, never stacked. ──
  let loadChain = Promise.resolve();
  const serialized = (fn) => { const run = loadChain.then(fn, fn); loadChain = run.then(() => {}, () => {}); return run; };

  async function getManifest() {
    if (!S.manifest) {
      S.manifest = await getJson('/voice/manifest');
      if (!S.manifest?.stt && S.earModel === 'boot') setEarModel('absent', absentReason(S.manifest, 'stt'));
      else if (S.earModel === 'boot') setEarModel('idle', 'the ear is installed — it loads on the first mic press');
    }
    return S.manifest;
  }
  function absentReason(m, which) {
    const id = which === 'stt' ? STT_MODEL_ID : TTS_MODEL_ID;
    const name = which === 'stt' ? 'the speech-to-text model (whisper-tiny.en)' : 'the text-to-speech model (Kokoro-82M)';
    const missing = (m?.incomplete ?? []).filter((p) => p.startsWith(`${id}/`));
    return missing.length
      ? `${name} is incompletely installed on this device — missing ${missing.join(', ')}`
      : `${name} is not installed on this device (no voice models in the light voice store)`;
  }
  const pinOf = (m, path) => [...(m.pinned ?? []), ...(m.bundle ?? [])].find((p) => p.path === path);
  /** Fetch bytes and REFUSE them unless they match the sealed manifest's pin — the seat's
   *  step 2. A mismatch is a refusal, not a warning. */
  async function fetchVerified(url, pin, what) {
    const buf = await (await fetch(url, { cache: 'no-store' })).arrayBuffer();
    if (!pin) throw new Error(`the voice manifest pins no ${what} — refusing to run unpinned bytes`);
    const digest = await sha256Hex(buf);
    if (digest !== pin.sha256 || buf.byteLength !== pin.bytes) {
      throw new Error(`pin mismatch for ${what}: manifest ${pin.sha256} vs fetched ${digest}`);
    }
    return buf;
  }

  // ── The ear ────────────────────────────────────────────────────────────────────
  function loadEar() {
    if (S.transcriber) return Promise.resolve(S.transcriber);
    if (S.earLoad) return S.earLoad;
    S.earLoad = serialized(async () => {
      if (S.transcriber) return S.transcriber;
      const m = await getManifest();
      if (!m.stt) { const e = new Error(absentReason(m, 'stt')); e.code = 'VOICE_EAR_ABSENT'; throw e; }
      setEarModel('loading', 'loading the ear — whisper-tiny.en, in-tab');
      await fetchVerified('/voice/file/vendor/transformers/transformers.js', pinOf(m, 'vendor/transformers/transformers.js'), 'the transformers runtime');
      const tf = await import('/voice/file/vendor/transformers/transformers.js');
      tf.env.allowRemoteModels = false;
      tf.env.allowLocalModels = true;
      tf.env.localModelPath = '/voice/session/';
      if (tf.env.backends?.onnx?.wasm) {
        // THE ORT PIN: the 1.22.0-dev.20250409 wasm set — the same build Kokoro's bundled
        // transformers requires; both voice models share this one ORT in the tab. The
        // prefix is the pinned vendor path itself: ORT appends its file names to it.
        tf.env.backends.onnx.wasm.wasmPaths = '/voice/file/vendor/ort/';
        tf.env.backends.onnx.wasm.numThreads = Math.min(4, navigator.hardwareConcurrency || 1);
      }
      for (const rel of WHISPER_ONNX) {
        const path = `${STT_MODEL_ID}/${rel}`;
        await fetchVerified(`/voice/session/${path}`, pinOf(m, path), `the ear's weights (${rel})`);
      }
      S.transcriber = await tf.pipeline('automatic-speech-recognition', STT_MODEL_ID, { dtype: 'q8', device: 'wasm' });
      setEarModel('ready', 'the ear is loaded — whisper-tiny.en, in-tab, Wasm');
      return S.transcriber;
    }).then((v) => { S.earLoad = null; return v; }, (e) => { S.earLoad = null; throw e; });
    return S.earLoad;
  }
  function unloadEar() {
    clearTimeout(S.earUnloadTimer);
    if (S.capture) { S.earUnloadTimer = setTimeout(unloadEar, 5000); return; } // never shed mid-capture — retry shortly
    if (S.transcriber) { try { S.transcriber.dispose?.(); } catch { /* disposal is best-effort */ } S.transcriber = null; }
    setEarModel(S.manifest?.stt ? 'idle' : 'absent', 'the ear was unloaded — it loads on demand (degradation ladder)');
  }
  const scheduleEarUnload = () => { clearTimeout(S.earUnloadTimer); S.earUnloadTimer = setTimeout(unloadEar, EAR_IDLE_UNLOAD_MS); };

  /** Ladder rung 5: under heap pressure voice yields first — shed the ear, then the mouth
   *  (never mid-speech). Returns true when something was shed. */
  function shedUnderPressure() {
    try {
      const used = performance?.memory?.usedJSHeapSize;
      if (typeof used === 'number' && used > HEAP_SHED_BYTES) {
        unloadEar();
        if (S.speech !== 'speaking') unloadVoice();
        return true;
      }
    } catch { /* no memory instrument — the idle timers still bound residency */ }
    return false;
  }

  async function resampleTo16k(samples, sampleRate) {
    if (sampleRate === 16000) return samples;
    const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const off = new Ctx(1, Math.max(1, Math.ceil((samples.length * 16000) / sampleRate)), 16000);
    const buf = off.createBuffer(1, samples.length, sampleRate);
    buf.getChannelData(0).set(samples);
    const src = off.createBufferSource(); src.buffer = buf; src.connect(off.destination); src.start();
    const rendered = await off.startRendering();
    return rendered.getChannelData(0);
  }
  async function decodeToSamples(arrayBuffer) {
    const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const ctx = new Ctx(1, 16000, 16000);
    const audio = await ctx.decodeAudioData(arrayBuffer);
    return audio.getChannelData(0).slice();
  }

  /** Transcribe raw samples (16 kHz, or resampled from `sampleRate`) with the in-tab ear. */
  async function transcribeSamples(input, sampleRate = 16000) {
    const ear = await loadEar();
    const samples = await resampleTo16k(input instanceof Float32Array ? input : new Float32Array(input), sampleRate);
    const out = await ear(samples);
    return String(out?.text ?? '').trim();
  }

  const stopTracks = () => { try { S.stream?.getTracks().forEach((t) => t.stop()); } catch { /* already stopped */ } S.stream = null; };
  function fail(stage, e) {
    const msg = String(e?.message ?? e);
    S.capture = null;
    if (stage === 'microphone' || stage === 'transcription' || stage === 'speech-to-text') {
      setEarModel('failed', `${stage}: ${msg}`);
    }
    try { onFailure({ stage, error: msg, code: e?.code ?? null }); } catch { /* the wall records it; a broken sink is not a second failure */ }
  }

  async function startListening() {
    if (S.capture) return;
    stopSpeech();
    clearTimeout(S.earUnloadTimer);
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        const e = new Error('this browser exposes no microphone (getUserMedia is unavailable)');
        e.code = 'MIC_UNAVAILABLE'; throw e;
      }
      S.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) { fail('microphone', e); return; }
    // The ear loads WHILE the owner speaks — staggered behind any load already running,
    // never stacked, and never in front of the recording. The ask itself will not wait
    // on any of this: transcription is the ask's input, not its bookkeeping.
    loadEar().catch(() => { /* the failure is reported at stop, where it is acted on */ });
    S.chunks = [];
    try {
      S.recorder = new MediaRecorder(S.stream);
      S.recorder.ondataavailable = (ev) => { if (ev.data?.size) S.chunks.push(ev.data); };
      S.recorder.start();
    } catch (e) { stopTracks(); fail('microphone', e); return; }
    setCapture('listening', 'listening — speak the ask, then press stop');
  }

  async function stopListening() {
    if (S.capture !== 'listening' || !S.recorder) return;
    const stopped = new Promise((r) => { S.recorder.onstop = r; });
    try { S.recorder.stop(); } catch { /* onstop may never fire; the race below bounds it */ }
    await Promise.race([stopped, new Promise((r) => setTimeout(r, 2000))]);
    stopTracks(); S.recorder = null;
    setCapture('transcribing', 'transcribing in-tab…');
    try {
      const blob = new Blob(S.chunks, { type: S.chunks[0]?.type || 'audio/webm' });
      S.chunks = [];
      const samples = await decodeToSamples(await blob.arrayBuffer());
      const text = await transcribeSamples(samples);
      if (!text) { fail('transcription', new Error('the transcription came back empty — nothing was heard well enough to submit')); return; }
      S.capture = null;
      setEarModel('ready', 'heard and transcribed in-tab — the transcript is the ask, on its card');
      try { onTranscript(text); } catch { /* the page's submit is its own concern */ }
      scheduleEarUnload();
      shedUnderPressure();
    } catch (e) { fail('transcription', e); }
  }

  // ── The mouth ──────────────────────────────────────────────────────────────────
  function loadVoice() {
    if (S.tts) return Promise.resolve(S.tts);
    if (S.ttsLoad) return S.ttsLoad;
    S.ttsLoad = serialized(async () => {
      if (S.tts) return S.tts;
      const m = await getManifest();
      if (!m.tts) { const e = new Error(absentReason(m, 'tts')); e.code = 'VOICE_TTS_ABSENT'; throw e; }
      setSpeech('loading', 'loading the voice — Kokoro-82M, in-tab');
      await fetchVerified('/voice/file/vendor/kokoro/kokoro.web.js', pinOf(m, 'vendor/kokoro/kokoro.web.js'), 'the kokoro runtime');
      const kokoro = await import('/voice/file/vendor/kokoro/kokoro.web.js');
      // kokoro's exported env is a wasmPaths-only facade onto its bundled transformers —
      // the SAME ort pin as the ear's, so one ORT build serves both models in the tab.
      kokoro.env.wasmPaths = '/voice/file/vendor/ort/';
      await seedKokoroCaches(m);
      S.tts = await kokoro.KokoroTTS.from_pretrained(TTS_MODEL_ID, { dtype: 'q8', device: 'wasm' });
      setSpeech('idle', 'the voice is loaded — Kokoro-82M, af_heart, in-tab');
      return S.tts;
    }).then((v) => { S.ttsLoad = null; return v; }, (e) => { S.ttsLoad = null; throw e; });
    return S.ttsLoad;
  }

  /** kokoro-js cannot be configured to a local path (its public env exposes only
   *  wasmPaths) — but both of its loaders are cache-first: the model loader consults the
   *  'transformers-cache' Cache Storage before any fetch, and the voice loader checks
   *  'kokoro-voices' before fetching its hard-coded hub URL. So every file the loaders
   *  will request is fetched from the voice legs, sha-verified against the sealed
   *  manifest's pins, and placed in those caches under the exact request URLs. The
   *  library runs unmodified; no byte comes from the network. */
  async function seedKokoroCaches(m) {
    const modelCache = await caches.open('transformers-cache');
    for (const rel of KOKORO_CACHE_FILES) {
      const path = `${TTS_MODEL_ID}/${rel}`;
      const buf = await fetchVerified(`/voice/session/${path}`, pinOf(m, path), `the voice's file (${rel})`);
      await modelCache.put(TTS_HUB_BASE + rel, new Response(buf, { headers: { 'content-type': 'application/octet-stream' } }));
    }
    const voiceRel = `voices/${TTS_VOICE}.bin`;
    const vPath = `${TTS_MODEL_ID}/${voiceRel}`;
    const vBuf = await fetchVerified(`/voice/session/${vPath}`, pinOf(m, vPath), 'the voice vector (af_heart)');
    const voiceCache = await caches.open('kokoro-voices');
    await voiceCache.put(TTS_HUB_BASE + voiceRel, new Response(vBuf, { headers: { 'content-type': 'application/octet-stream' } }));
  }

  function unloadVoice() {
    clearTimeout(S.voiceUnloadTimer);
    // kokoro-js exposes no dispose: unloading drops our references (the tab reclaims the
    // session); the seeded caches persist in storage, so a later load is warm and cheap.
    S.tts = null;
    if (S.speech !== 'speaking' && S.speech !== 'loading') setSpeech(S.manifest?.tts ? 'idle' : 'absent', 'the voice was unloaded — it loads on demand (degradation ladder)');
  }
  const scheduleVoiceUnload = () => { clearTimeout(S.voiceUnloadTimer); S.voiceUnloadTimer = setTimeout(unloadVoice, VOICE_IDLE_UNLOAD_MS); };

  /** Synthesize text to raw samples without playback (per-sentence generate() only). */
  async function synthesizeSamples(text) {
    const tts = await loadVoice();
    const plan = planSpeech(text);
    const parts = [];
    let rate = 24000;
    for (const sentence of plan.sentences) {
      const audio = await tts.generate(sentence, { voice: TTS_VOICE });
      rate = audio.sampling_rate ?? 24000;
      parts.push(audio.audio ?? audio.data);
    }
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Float32Array(total);
    let off = 0;
    for (const p of parts) { out.set(p, off); off += p.length; }
    return { samples: out, sampleRate: rate, capped: plan.capped, words: plan.words, sentences: plan.sentences.length };
  }

  const withWatchdog = (promise, ms, what) => Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`synthesizing one sentence exceeded ${Math.round(ms / 1000)} s (${what}) — speech stopped rather than wedge the tab`)), ms)),
  ]);

  const cappedNote = (plan) => `spoken readback capped at ${plan.words} of the answer's words (${plan.sentences.length} of ${plan.totalSentences} sentences) — the full answer is the text on the card`;

  /** Speak an answer: per-sentence generate(), scheduled back-to-back into an
   *  AudioContext, one sentence ahead of playback. Slower-than-realtime synthesis on a
   *  floor CPU produces gaps between sentences, never a wedge. */
  async function speak(askId, text) {
    stopSpeech();
    shedUnderPressure();
    const token = ++S.speechToken;
    S.speakingAskId = askId;
    const plan = planSpeech(text);
    S.lastSpeech = { askId, scheduled: 0, capped: plan.capped, words: plan.words, sentences: plan.sentences.length, totalSentences: plan.totalSentences };
    emitSpeech(askId, 'loading', plan.capped ? cappedNote(plan) : 'loading the voice…');
    let tts;
    try { tts = await loadVoice(); }
    catch (e) {
      if (token !== S.speechToken) return;
      S.speakingAskId = null;
      emitSpeech(askId, 'failed', `speech unavailable: ${String(e?.message ?? e)} — the answer stands in text on the card`);
      setSpeech('failed', `speech unavailable: ${String(e?.message ?? e)}`);
      return;
    }
    if (token !== S.speechToken) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    const actx = new AC({ sampleRate: 24000 });
    S.actx = actx;
    await actx.resume().catch(() => { /* headless scheduling still proves the queue */ });
    emitSpeech(askId, 'speaking', plan.capped ? cappedNote(plan) : `speaking ${plan.sentences.length} sentence(s)`);
    setSpeech('speaking', 'speaking the answer — per-sentence, in-tab');
    let nextTime = actx.currentTime + 0.05;
    try {
      for (const [i, sentence] of plan.sentences.entries()) {
        if (token !== S.speechToken) return;
        const audio = await withWatchdog(tts.generate(sentence, { voice: TTS_VOICE }), SENTENCE_SYNTH_WATCHDOG_MS, `sentence ${i + 1} of ${plan.sentences.length}`);
        if (token !== S.speechToken) return;
        const samples = audio.audio ?? audio.data;
        const rate = audio.sampling_rate ?? 24000;
        const buf = actx.createBuffer(1, samples.length, rate);
        buf.getChannelData(0).set(samples);
        const src = actx.createBufferSource();
        src.buffer = buf; src.connect(actx.destination);
        const startAt = Math.max(nextTime, actx.currentTime + 0.02);
        src.start(startAt);
        nextTime = startAt + samples.length / rate;
        S.lastSpeech = { ...S.lastSpeech, scheduled: i + 1 };
        emit();
      }
      S.speakingAskId = null;
      emitSpeech(askId, 'done', `spoken — ${S.lastSpeech.scheduled} sentence(s) scheduled for playback`);
      setSpeech('done', 'the answer was spoken');
      scheduleVoiceUnload();
    } catch (e) {
      if (token !== S.speechToken) return;
      S.speakingAskId = null;
      emitSpeech(askId, 'failed', `speech failed: ${String(e?.message ?? e)} — the answer stands in text on the card`);
      setSpeech('failed', `speech failed: ${String(e?.message ?? e)}`);
    }
  }

  function stopSpeech() {
    S.speechToken += 1;
    if (S.actx) { try { S.actx.close(); } catch { /* already closed */ } S.actx = null; }
    if (S.speakingAskId) { const id = S.speakingAskId; S.speakingAskId = null; emitSpeech(id, 'stopped', 'speech stopped by the owner'); }
    if (S.speech === 'speaking' || S.speech === 'loading') setSpeech('stopped', 'speech stopped by the owner');
  }

  // A hidden tab sheds the ear (ladder rung 1): nobody is speaking to a wall they
  // cannot see, and the residency is returned until the next mic press.
  try { document.addEventListener('visibilitychange', () => { if (document.hidden) unloadEar(); }); } catch { /* no document in a test context */ }

  getManifest().catch((e) => { S.detail = `the voice manifest could not be read (${String(e?.message ?? e)}) — typed asks are unaffected`; emit(); });
  emit();

  return {
    startListening, stopListening, speak, stopSpeech,
    transcribeSamples, synthesizeSamples,
    state: () => ({
      ear: earShown(), earModel: S.earModel, capture: S.capture,
      speech: S.speech, detail: S.detail,
      sttAvailable: S.manifest ? Boolean(S.manifest.stt) : null,
      ttsAvailable: S.manifest ? Boolean(S.manifest.tts) : null,
      lastSpeech: S.lastSpeech,
    }),
    dispose: () => { stopSpeech(); stopTracks(); unloadEar(); unloadVoice(); },
  };
}
