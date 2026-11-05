// light-runtime/voice-artifact.mjs — THE VOICE ARTIFACT of the light runtime: the in-tab
// ear (Whisper speech-to-text) and mouth (Kokoro text-to-speech) delivered in the same
// three-layer shape as the engine artifact (light-runtime/artifact.mjs), because the same
// ruling put them in the tab (Robbie, 2026-10-28): models may execute in the browser ONLY
// because Scripture Armor's sealed delivery is what carries them there — pinned, sealed,
// unsealed in memory only, never fetched from a hub and never exposed as loose code.
//
//   HOSTED         the voice artifact is a Scripture Armor package (scripture-armor/armor.mjs,
//                  the tree's own v4 format). Its sealed manifest pins the sha256 of EVERY
//                  byte the voice runs: the vendored runtimes (transformers.js, kokoro-js,
//                  the onnxruntime-web wasm set), the model meta files, the ONNX weights.
//   DEVICE CUSTODY the keys never leave this layer (the same device identity the engine
//                  artifact uses — one light host, two artifacts). This layer verifies the
//                  package — frame signature AND sender pin — and opens it in memory before
//                  a single byte is served.
//   BROWSER        the voice module (light-runtime/voice/voice.mjs, itself sealed INTO this
//   EXECUTION      bundle) re-verifies the sha256 of the runtimes and the weights against the
//                  opened manifest's pins before it instantiates anything — the seat's
//                  step 2, applied to ONNX files.
//
// THE SPLIT — which treatment each file gets, and why (the feasibility report's §6 shape,
// which mirrors the seat's treatment of the GGUF):
//   • voice.mjs + the model META files (tokenizers, configs, the Kokoro voice vector) are
//     sealed INTO the bundle: small, and the code is the thing whose integrity anchors the
//     session — exactly why seat.mjs is sealed into the engine bundle.
//   • the ONNX WEIGHTS (Whisper encoder/decoder, the Kokoro model) are NOT sealed in: their
//     sha256 + byte pins ride in the sealed manifest and the device layer serves the bytes
//     from the device-held store per request — exactly the GGUF precedent, for the same
//     reason (sealing 133 MB into a JSON bundle would buy nothing the pin does not).
//   • the vendored RUNTIMES are pinned the same way and served from the tree per request;
//     the page sha-verifies them before import, like the seat verifies the wllama runtime.
//
// THE STORE: model files are device-held data, never tree files — they live in the voice
// models store (default <light state>/voice-models, KINGMAKER_LIGHT_VOICE_MODELS), laid out
// by hub id: onnx-community/whisper-tiny.en/… and onnx-community/Kokoro-82M-v1.0-ONNX/….
// A model whose files are ALL present is offered; a model with SOME files present is
// reported incomplete (its missing files are named in the manifest); a model with none is
// simply absent. The ear and the mouth are independent: either can be installed without
// the other, and the page says which, truthfully.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  parsePublicBlock, publicBlock, sealPlaintext, parseScriptureFile, verifyFrameSignature,
  unsealFileKey, openSealedFile, armorDecode,
} from '../scripture-armor/armor.mjs';
import { ensureDeviceIdentity, readTreeFiles } from './artifact.mjs';

export const VOICE_MANIFEST_SCHEMA = 'kingmaker.light-voice/1';
export const WHISPER_TINY_ID = 'onnx-community/whisper-tiny.en';
export const KOKORO_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
export const KOKORO_VOICE_NAME = 'af_heart';

/** The ear's files, by treatment. Bundle = sealed in; pinned = pin in the manifest, bytes
 *  served from the store. The dtype is q8 throughout (the feasibility report's measured set). */
export const WHISPER_BUNDLE_FILES = Object.freeze([
  'config.json', 'generation_config.json', 'preprocessor_config.json', 'tokenizer.json',
  'tokenizer_config.json', 'special_tokens_map.json', 'vocab.json', 'merges.txt',
  'normalizer.json', 'added_tokens.json',
]);
export const WHISPER_PINNED_FILES = Object.freeze([
  'onnx/encoder_model_quantized.onnx', 'onnx/decoder_model_merged_quantized.onnx',
]);
/** The mouth's files, same split. Only the af_heart voice ships: it is the voice the
 *  feasibility test measured and loop-verified; each further voice is +522,240 B of store. */
export const KOKORO_BUNDLE_FILES = Object.freeze([
  'config.json', 'tokenizer.json', 'tokenizer_config.json', `voices/${KOKORO_VOICE_NAME}.bin`,
]);
export const KOKORO_PINNED_FILES = Object.freeze(['onnx/model_quantized.onnx']);

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const filePin = (path, buf) => ({ path, sha256: sha256(buf), bytes: buf.length });

/**
 * Build the sealed voice artifact. `bundleFiles` are sealed INTO the package (voice.mjs +
 * model meta); `pinnedFiles` are NOT — their pins ride in the sealed manifest and the device
 * layer serves the bytes. `stt` / `tts` are the manifest's per-model offers (null = absent).
 */
export function buildVoiceArtifact({ identity, bundleFiles = [], pinnedFiles = [], stt = null, tts = null, now = new Date() } = {}) {
  const manifest = {
    schema: VOICE_MANIFEST_SCHEMA,
    created: now.toISOString(),
    signer: { label: identity.label, signFp: identity.signFp, sealFp: identity.sealFp },
    stt, tts,
    bundle: bundleFiles.map((f) => filePin(f.path, f.bytes)),
    pinned: pinnedFiles.map((f) => filePin(f.path, f.bytes)),
  };
  const bundle = {
    manifest,
    files: Object.fromEntries(bundleFiles.map((f) => [f.path, f.bytes.toString('base64')])),
  };
  const peer = parsePublicBlock(publicBlock(identity));
  const { text } = sealPlaintext(Buffer.from(JSON.stringify(bundle), 'utf8'), identity, peer);
  return { text, manifest, artifactSha256: sha256(Buffer.from(text, 'utf8')) };
}

/**
 * Verify and open a sealed voice artifact, device-side. Same refusal codes as the engine
 * artifact (artifact.mjs): a package that does not parse, whose frame signature fails,
 * whose sender is not the pinned signer, or whose bundle files fail their own manifest
 * pins is refused, never served. Returns { manifest, files: Map<path, Buffer> }.
 */
export function verifyAndOpenVoiceArtifact({ identity, text, pinSignFp } = {}) {
  const fail = (code, msg) => { const e = new Error(msg || code); e.code = code; throw e; };
  let parsed;
  try { parsed = parseScriptureFile(String(text ?? '')); } catch (e) { fail('ARTIFACT_PARSE', e.message); }
  const { frame, body } = parsed;
  if (!verifyFrameSignature(frame, body)) fail('ARTIFACT_SIGNATURE', 'the frame signature (Ed25519 + ML-DSA-65) does not verify');
  if (pinSignFp && frame.sender_sign_fp !== pinSignFp) fail('ARTIFACT_PIN', `sender ${frame.sender_sign_fp} is not the pinned signer ${pinSignFp}`);
  if (frame.recipient_seal_fp !== identity.sealFp) fail('ARTIFACT_RECIPIENT', 'the package was not sealed to this device identity');
  let bundle;
  try {
    const fileKey = unsealFileKey(identity, frame);
    const plain = openSealedFile(fileKey, frame, armorDecode(body, Buffer.from(frame.armor_seed, 'base64')));
    bundle = JSON.parse(plain.toString('utf8'));
  } catch (e) { fail('ARTIFACT_OPEN', e.message); }
  if (bundle?.manifest?.schema !== VOICE_MANIFEST_SCHEMA) fail('ARTIFACT_SCHEMA', 'the opened bundle is not a light-voice manifest');
  const files = new Map();
  for (const pin of bundle.manifest.bundle ?? []) {
    const b64 = bundle.files?.[pin.path];
    if (!b64) fail('ARTIFACT_BUNDLE', `bundle file missing: ${pin.path}`);
    const bytes = Buffer.from(b64, 'base64');
    if (sha256(bytes) !== pin.sha256 || bytes.length !== pin.bytes) fail('ARTIFACT_BUNDLE', `bundle file fails its manifest pin: ${pin.path}`);
    files.set(pin.path, bytes);
  }
  return { manifest: bundle.manifest, files };
}

/** One model's presence in the store: 'present' (every file), 'incomplete' (some — the
 *  missing are named), or 'absent' (none). Presence is all-or-nothing per model because a
 *  partial model cannot run, and the manifest must say which state it is in. */
function modelPresence(storeDir, id, relFiles) {
  const missing = relFiles.filter((rel) => !existsSync(join(storeDir, id, rel)));
  if (missing.length === 0) return { state: 'present', missing: [] };
  if (missing.length === relFiles.length) return { state: 'absent', missing };
  return { state: 'incomplete', missing: missing.map((rel) => `${id}/${rel}`) };
}

/**
 * The voice artifact service one light server runs — the artifact.mjs service shape, for
 * voice. Builds the artifact from this installation's voice module + vendored runtimes +
 * device-held model store, verifies and opens its own package before serving anything
 * from it, and serves the legs the page consumes:
 *   voiceDir:   light-runtime/voice (voice.mjs is the bundle's code; vendor/ is pinned, served)
 *   storeDir:   the device-held voice models store (may be absent/empty — voice is then
 *               honestly unavailable, and the manifest says so per model)
 *   identityDir: the light host's device identity store (shared with the engine artifact)
 */
export function createVoiceArtifactService({ voiceDir, storeDir = null, identityDir } = {}) {
  let cache = null;
  function build() {
    if (cache) return cache;
    const identity = ensureDeviceIdentity(identityDir);
    const bundleFiles = [];
    const voicePath = join(voiceDir, 'voice.mjs');
    if (existsSync(voicePath)) bundleFiles.push({ path: 'voice.mjs', bytes: readFileSync(voicePath) });

    // Pinned bytes are read ONCE here to take their pins, then dropped and re-read from
    // their root per request — the weights are never held in this process's memory (an 8 GB
    // Mac is the design target), exactly as artifact.mjs treats the GGUF.
    const pinnedRoots = new Map();   // manifest path → absolute file it is served from
    const pinnedFiles = [];
    const pinFrom = (manifestPath, absPath) => {
      pinnedFiles.push({ path: manifestPath, bytes: readFileSync(absPath) });
      pinnedRoots.set(manifestPath, absPath);
    };
    const vendorDir = join(voiceDir, 'vendor');
    if (existsSync(vendorDir)) {
      for (const f of readTreeFiles(vendorDir)) pinFrom(`vendor/${f.path}`, join(vendorDir, f.path));
    }

    let stt = null, tts = null;
    const incomplete = [];
    if (storeDir) {
      const w = modelPresence(storeDir, WHISPER_TINY_ID, [...WHISPER_BUNDLE_FILES, ...WHISPER_PINNED_FILES]);
      if (w.state === 'present') {
        for (const rel of WHISPER_BUNDLE_FILES) bundleFiles.push({ path: `${WHISPER_TINY_ID}/${rel}`, bytes: readFileSync(join(storeDir, WHISPER_TINY_ID, rel)) });
        for (const rel of WHISPER_PINNED_FILES) pinFrom(`${WHISPER_TINY_ID}/${rel}`, join(storeDir, WHISPER_TINY_ID, rel));
        stt = { id: WHISPER_TINY_ID, dtype: 'q8', device: 'wasm' };
      } else if (w.state === 'incomplete') incomplete.push(...w.missing);
      const k = modelPresence(storeDir, KOKORO_ID, [...KOKORO_BUNDLE_FILES, ...KOKORO_PINNED_FILES]);
      if (k.state === 'present') {
        for (const rel of KOKORO_BUNDLE_FILES) bundleFiles.push({ path: `${KOKORO_ID}/${rel}`, bytes: readFileSync(join(storeDir, KOKORO_ID, rel)) });
        for (const rel of KOKORO_PINNED_FILES) pinFrom(`${KOKORO_ID}/${rel}`, join(storeDir, KOKORO_ID, rel));
        tts = { id: KOKORO_ID, dtype: 'q8', device: 'wasm', voice: KOKORO_VOICE_NAME };
      } else if (k.state === 'incomplete') incomplete.push(...k.missing);
    }

    const built = buildVoiceArtifact({ identity, bundleFiles, pinnedFiles, stt, tts });
    // Verify our own package before a single byte is served from it: same gate a foreign
    // host's package would face, same refusal.
    const opened = verifyAndOpenVoiceArtifact({ identity, text: built.text, pinSignFp: identity.signFp });
    cache = {
      identity, text: built.text, artifactSha256: built.artifactSha256,
      manifest: { ...opened.manifest, ...(incomplete.length ? { incomplete } : {}) },
      bundleFiles: opened.files, pinnedRoots,
    };
    return cache;
  }
  return {
    /** The public manifest: pins + signer + the per-model offers. Carries no key material. */
    manifest() {
      const c = build();
      return { ...c.manifest, artifactSha256: c.artifactSha256, sealed: true, custody: 'signer and keys held by the device layer; the page receives the opened bundle for its session only' };
    },
    /** The sealed package itself (the host stand-in leg). */
    sealedText() { return build().text; },
    /** One file for the page's session: an opened bundle file if the path is in the sealed
     *  set, else a manifest-pinned byte stream (the model weights ride this leg too — the
     *  page's model loaders address everything under one prefix), else null. */
    sessionFile(path) {
      const c = build();
      return c.bundleFiles.get(path) ?? this.pinnedFile(path);
    },
    /** One pinned byte stream (a vendored runtime or a model weight), read from its root
     *  per call, or null. Manifest-pinned paths only — the pin list is the whole catalogue. */
    pinnedFile(path) {
      const c = build();
      const abs = c.pinnedRoots.get(path);
      if (!abs || !existsSync(abs)) return null;
      return readFileSync(abs);
    },
  };
}
