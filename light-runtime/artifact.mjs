// light-runtime/artifact.mjs — THE HOSTED LAYER of the light runtime's browser engines
// (Robbie's three-layer split, 2026-10-28; kingmaker-browser-runtime-spec.md v0.2):
//
//   HOSTED         the engine artifact — the seat's code plus a manifest pinning the sha256 of
//                  every byte the seat runs (the wllama runtime, its wasm, the weights) — is a
//                  Scripture Armor package (scripture-armor/armor.mjs sealPlaintext, the tree's
//                  own v4 format: X25519+ML-KEM-768 key wrap, AEAD body, Ed25519+ML-DSA-65
//                  dual signature). A host serves these sealed bytes and nothing else; a
//                  non-member who fetches them holds ciphertext.
//   DEVICE CUSTODY the keys never leave this layer. The artifact's signer is an armor identity
//                  held in the light state dir on the device (created on first use, 0600 store);
//                  the browser page never sees it, never sees a private key of any kind, and
//                  never receives the sealed bytes' key material. This layer verifies the
//                  package — frame signature (both signatures) AND the sender fingerprint
//                  against the pin recorded when the artifact was built — and only then opens
//                  it, in memory. The page is handed the opened bundle for its session.
//   BROWSER        the seat (light-runtime/seat/seat.mjs) re-verifies the sha256 of the
//   EXECUTION      weights and the runtime wasm against the opened manifest's pins before it
//                  instantiates anything, then runs the model in the tab.
//
// What the pin is, precisely: the artifact is self-sealed by the device identity for this
// proof (the light server stands in for the host, per the build order). The manifest carries
// the signer's fingerprints; verification refuses any package whose frame signature fails or
// whose sender fingerprint differs from the pin. In the hosted production shape the same code
// verifies a package sealed by the release host's identity, pinned the same way — the pin is a
// fingerprint, not a location, and no claim is made here that this proof's signer is the
// release signer.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import {
  createIdentity, loadIdentity, publicBlock, parsePublicBlock, sealPlaintext,
  parseScriptureFile, verifyFrameSignature, unsealFileKey, openSealedFile, armorDecode,
} from '../scripture-armor/armor.mjs';

export const ENGINE_MANIFEST_SCHEMA = 'kingmaker.light-engine/1';
export const DEVICE_IDENTITY_LABEL = 'kingmaker-light-host';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const filePin = (path, buf) => ({ path, sha256: sha256(buf), bytes: buf.length });

/** The device-side armor identity for the light host: loaded from the identity dir, created
 *  there on first use. Keys live in armor's own 0600 store and never leave this process. */
export function ensureDeviceIdentity(identityDir) {
  if (existsSync(join(identityDir, 'identity.json'))) return loadIdentity(identityDir);
  return createIdentity(identityDir, DEVICE_IDENTITY_LABEL);
}

/** Every regular file under `dir`, as { path ('/'-separated, relative), bytes } — sorted. */
export function readTreeFiles(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...readTreeFiles(p, base));
    else out.push({ path: relative(base, p).split(sep).join('/'), bytes: readFileSync(p) });
  }
  return out;
}

/**
 * Build the sealed engine artifact. `bundleFiles` are sealed INTO the package (the seat code —
 * small, and the thing whose integrity anchors the session). `pinnedFiles` (the wllama
 * runtime) and `weights` are NOT sealed in: their sha256 pins ride in the sealed manifest and
 * the device layer serves the bytes themselves (they are device-held data; the seat verifies
 * the pins in-page before running them). Returns { text, manifest } — the text is the complete
 * .scripture package a host would serve.
 */
export function buildEngineArtifact({ identity, bundleFiles = [], pinnedFiles = [], weights = null, model = null, now = new Date() } = {}) {
  const manifest = {
    schema: ENGINE_MANIFEST_SCHEMA,
    created: now.toISOString(),
    signer: { label: identity.label, signFp: identity.signFp, sealFp: identity.sealFp },
    model,
    bundle: bundleFiles.map((f) => filePin(f.path, f.bytes)),
    pinned: pinnedFiles.map((f) => filePin(f.path, f.bytes)),
    weights: weights ? { name: weights.name, sha256: sha256(weights.bytes), bytes: weights.bytes.length } : null,
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
 * Verify and open a sealed engine artifact, device-side. Refuses (throws { code }) when the
 * package does not parse, when either frame signature fails, when the sender fingerprint is
 * not the pinned signer, or when an opened bundle file's bytes do not match the manifest pin
 * inside the same package. Returns { manifest, files: Map<path, Buffer> }.
 */
export function verifyAndOpenArtifact({ identity, text, pinSignFp } = {}) {
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
  if (bundle?.manifest?.schema !== ENGINE_MANIFEST_SCHEMA) fail('ARTIFACT_SCHEMA', 'the opened bundle is not a light-engine manifest');
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

/**
 * The artifact service one light server runs: builds the artifact from this installation's
 * seat files + artifact store, verifies and opens its own package before serving anything
 * from it (a package this layer cannot verify is a package the page never hears about), and
 * serves the two legs — the sealed text for the host stand-in, the opened bundle + pinned
 * bytes for the device's own page.
 *   seatDir:       light-runtime/seat (seat.mjs is the bundle; vendor/ is pinned, served)
 *   artifactsDir:  device-held engine data (weights *.gguf) — may be absent/empty
 *   identityDir:   the device identity's store
 */
export function createArtifactService({ seatDir, artifactsDir, identityDir, model = null } = {}) {
  let cache = null;
  function build() {
    if (cache) return cache;
    const identity = ensureDeviceIdentity(identityDir);
    const seatPath = join(seatDir, 'seat.mjs');
    const bundleFiles = existsSync(seatPath) ? [{ path: 'seat.mjs', bytes: readFileSync(seatPath) }] : [];
    const vendorDir = join(seatDir, 'vendor');
    const pinnedFiles = existsSync(vendorDir)
      ? readTreeFiles(vendorDir).map((f) => ({ path: `vendor/${f.path}`, bytes: f.bytes }))
      : [];
    let weights = null, weightsFile = null;
    if (artifactsDir && existsSync(artifactsDir)) {
      const gguf = readdirSync(artifactsDir).filter((n) => n.endsWith('.gguf')).sort()[0];
      // Read once to take the pin, then dropped: the weights are served from disk per
      // request, never held in this process's memory (an 8 GB Mac is the design target).
      if (gguf) { weightsFile = join(artifactsDir, gguf); weights = { name: gguf, bytes: readFileSync(weightsFile) }; }
    }
    const built = buildEngineArtifact({ identity, bundleFiles, pinnedFiles, weights, model: model ?? (weights ? weights.name.replace(/\.gguf$/, '') : null) });
    weights = null;
    // Verify our own package before a single byte is served from it: same gate a foreign
    // host's package would face, same refusal.
    const opened = verifyAndOpenArtifact({ identity, text: built.text, pinSignFp: identity.signFp });
    const pinnedBytes = new Map(pinnedFiles.map((f) => [f.path, f.bytes]));
    cache = {
      identity, text: built.text, artifactSha256: built.artifactSha256,
      manifest: opened.manifest, bundleFiles: opened.files, pinnedBytes, weightsFile,
    };
    return cache;
  }
  return {
    /** The public manifest: pins + signer + artifact digest. Carries no key material. */
    manifest() {
      const c = build();
      return { ...c.manifest, artifactSha256: c.artifactSha256, sealed: true, custody: 'signer and keys held by the device layer; the page receives the opened bundle for its session only' };
    },
    /** The sealed package itself (the host stand-in leg). */
    sealedText() { return build().text; },
    /** One opened bundle file (the session handoff), or null. Bundle paths only — the sealed
     *  set, never the filesystem. */
    sessionFile(path) { return build().bundleFiles.get(path) ?? null; },
    /** One pinned byte stream (runtime or weights), or null. Manifest-pinned paths only.
     *  Weights are read from the device store per call (see build()). */
    pinnedFile(path) {
      const c = build();
      const hit = c.pinnedBytes.get(path);
      if (hit) return hit;
      if (c.weightsFile && path === `weights/${c.manifest.weights?.name}`) return readFileSync(c.weightsFile);
      return null;
    },
  };
}
