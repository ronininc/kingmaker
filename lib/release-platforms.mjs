// lib/release-platforms.mjs — the per-platform shape of a Kingmaker release.
//
// Until now a release was one platform wearing no name: a macOS app archive,
// split into parts, mirrored under v<version>/, with latest.json pointing at
// it. Enrolled Macs read latest.json's top level — { version, tag,
// engineSha256, archive } — and that contract does not change. What changes
// is that a release now DECLARES its platforms:
//
//   platforms: {
//     macos:   { status: 'ready',       artifacts: [{ name, sha256, size }], signature: 'v0.5.0/kingmaker-manifest.json.sig' },
//     linux:   { status: 'placeholder', artifacts: [],                        signature: null },
//     windows: { status: 'placeholder', artifacts: [],                        signature: null },
//   }
//
// Rules the whole line enforces (here, in lib/release-manifest.mjs's shape
// check, and at the mirror's flip):
//   · macos is required and must be ready — it is the shipping platform.
//   · linux / windows may be placeholder: declared, empty, unsigned. The
//     schema carries them from day one so the day a real build exists it is
//     a data change, not a format change.
//   · a ready platform carries at least one artifact, every artifact is
//     pinned (sha256 + size), and a signature reference names the detached
//     signature that covers the platform's set. Ready without a signature
//     is refused — an unsigned platform download is a spoofing hole.
//   · a placeholder with artifacts or a signature is a contradiction and
//     is refused: placeholders are promises, not payloads.
//
// WHERE THE NON-MAC ARTIFACTS COME FROM: their own build hosts. The macOS
// parts are built by scripts/release-parts.mjs on the release Mac; the
// linux/windows artifacts are built where they run (a Linux box, a Windows
// box) — and for Apple-side pieces built OFF a Mac, xtool (xtool-org/xtool,
// MIT; Robbie's established cross-platform Xcode replacement from the TSS
// work) is the sanctioned tool: it builds and signs SwiftPM/Xcode-shaped
// artifacts from Linux and Windows hosts. Those hosts hand release-parts a
// --platforms pins file; this module is what validates and carries the pins
// from the manifest into latest.json. Nothing here assumes the machine
// running it is a Mac.

const HEX64 = /^[0-9a-f]{64}$/;

export const PLATFORMS = Object.freeze(['macos', 'linux', 'windows']);
export const PLATFORM_STATUS = Object.freeze(['ready', 'placeholder']);

/** Pure: the problems with one platform entry ([] when sound). A missing
 *  entry is only a problem for macos; linux/windows may be absent entirely
 *  (an old release) — but when present they must be well-formed. */
export function platformEntryProblems(platform, entry) {
  const out = [];
  if (!PLATFORMS.includes(platform)) return [`unknown platform "${platform}"`];
  if (entry == null) return platform === 'macos' ? ['platforms.macos is missing: macOS is the shipping platform and must be declared ready'] : [];
  if (!PLATFORM_STATUS.includes(entry.status)) { out.push(`platforms.${platform}.status is ${entry.status ?? 'missing'}, not ready|placeholder`); return out; }
  const artifacts = Array.isArray(entry.artifacts) ? entry.artifacts : null;
  if (!artifacts) { out.push(`platforms.${platform}.artifacts is not a list`); return out; }
  if (entry.status === 'placeholder') {
    if (artifacts.length) out.push(`platforms.${platform} is a placeholder but carries ${artifacts.length} artifact(s): a placeholder is a promise, not a payload`);
    if (entry.signature != null) out.push(`platforms.${platform} is a placeholder but names a signature: placeholders are unsigned by definition`);
    return out;
  }
  // status === 'ready'
  if (!artifacts.length) out.push(`platforms.${platform} is ready but carries no artifacts`);
  const names = new Set();
  for (const [i, a] of artifacts.entries()) {
    if (!/^[\w][\w.-]*$/.test(String(a?.name ?? '')) || names.has(a.name)) out.push(`platforms.${platform} artifact ${i + 1} has a bad or repeated name`);
    names.add(a?.name);
    if (!HEX64.test(String(a?.sha256 ?? ''))) out.push(`platforms.${platform} artifact ${i + 1} (${a?.name ?? '?'}) has no sha256`);
    if (!Number.isSafeInteger(a?.size) || a.size <= 0) out.push(`platforms.${platform} artifact ${i + 1} (${a?.name ?? '?'}) size is missing`);
  }
  if (typeof entry.signature !== 'string' || !entry.signature) out.push(`platforms.${platform} is ready but names no signature reference: a ready platform without a signature is refused`);
  return out;
}

/** Pure: the problems with a whole platforms map ([] when sound). */
export function platformsProblems(platforms) {
  if (platforms == null || typeof platforms !== 'object' || Array.isArray(platforms)) return ['platforms is not a map'];
  const out = [];
  for (const key of Object.keys(platforms)) if (!PLATFORMS.includes(key)) out.push(`platforms.${key}: unknown platform (known: ${PLATFORMS.join(', ')})`);
  for (const p of PLATFORMS) out.push(...platformEntryProblems(p, platforms[p]));
  return out;
}

/** Pure: the macos entry a release's own parts imply — the parts ARE the
 *  macOS artifact set, signed by the manifest's detached signature. */
export function macosEntryFromManifest(manifest, { sigName = 'kingmaker-manifest.json.sig' } = {}) {
  const parts = Array.isArray(manifest?.parts) ? manifest.parts : [];
  return {
    status: 'ready',
    artifacts: parts.map((p) => ({ name: p.name, size: p.size, sha256: p.sha256 })),
    signature: manifest?.tag ? `v${String(manifest.version)}/${sigName}` : sigName,
  };
}

/**
 * Pure: the latest.json object for a release.
 *   manifest   a kingmaker.release/1 manifest (lib/release-manifest.mjs)
 *   platforms  the platforms map to declare; when omitted, the manifest's
 *              own `platforms` is used, and macos is synthesized from the
 *              parts either way when the map doesn't carry it.
 * The legacy top level — version, tag, engineSha256, archive — is written
 * EXACTLY as mirror-v2 has always written it, first, untouched: consumers
 * already in the field (lib/update.mjs on enrolled Macs) read those keys
 * and cross-check them against the signed manifest; `platforms` is an
 * addition they ignore and newer consumers read.
 */
export function buildLatest({ manifest, platforms = undefined, sigName = 'kingmaker-manifest.json.sig' } = {}) {
  if (!manifest) throw new Error('release-platforms: a manifest is required');
  const declared = platforms ?? manifest.platforms ?? null;
  const map = declared ? { ...declared } : {};
  if (!map.macos) map.macos = macosEntryFromManifest(manifest, { sigName });
  const latest = {
    version: String(manifest.version),
    tag: manifest.tag,
    engineSha256: manifest.engine?.sha256 ?? manifest.engineSha256 ?? null,
    archive: manifest.app?.archive ?? manifest.archive ?? null,
    platforms: map,
  };
  return latest;
}

/** Pure: the problems with a latest.json object ([] when sound). The legacy
 *  shape alone is sound — a pre-platforms latest.json (what the host serves
 *  today) passes, so this can gate the flip without stranding old releases. */
export function latestProblems(latest) {
  const out = [];
  if (!latest || typeof latest !== 'object') return ['latest.json is not an object'];
  if (typeof latest.version !== 'string' || !latest.version) out.push('latest.version is missing');
  if (typeof latest.tag !== 'string' || !/^v?[\w.-]+$/.test(latest.tag)) out.push('latest.tag is missing or malformed');
  if (latest.engineSha256 != null && !HEX64.test(String(latest.engineSha256))) out.push('latest.engineSha256 is not a sha256');
  if (latest.platforms !== undefined) out.push(...platformsProblems(latest.platforms));
  return out;
}

/**
 * Pure: the mirror objects a platforms map adds beyond the macOS parts —
 * each ready non-mac artifact, keyed v<version>/<platform>/<name> so it can
 * never collide with a macOS part name. Placeholder platforms add nothing.
 *   version  the release version (no leading v)
 *   dir      the release directory the artifact files sit in, per platform:
 *            <dir>/<platform>/<name>
 */
export function platformObjects({ version, platforms, dir }) {
  const out = [];
  for (const platform of PLATFORMS) {
    if (platform === 'macos') continue; // the parts are already the macOS objects
    const entry = platforms?.[platform];
    if (!entry || entry.status !== 'ready') continue;
    for (const a of entry.artifacts ?? []) {
      out.push({ key: `v${version}/${platform}/${a.name}`, file: `${dir}/${platform}/${a.name}`, sha256: a.sha256, size: a.size, platform });
    }
  }
  return out;
}
