/**
 * exifcleaner/lib/exifcleaner-external.mjs (kingmaker-stack)
 *
 * The EXTERNAL registration for ExifCleaner (szTheory/exifcleaner,
 * MIT) — the publishing-hygiene station: photos, video, and PDFs
 * pass through it before they ship, and its before/after diff is
 * the receipt. This module is the whole fold-in:
 *
 *   - ExifCleaner is a desktop GUI app (Electron + a local ExifTool
 *     subprocess). An operator drives it in their own session;
 *     Kingmaker never imports, links, bundles, or redistributes it.
 *     What crosses into Kingmaker is the app's OUTPUT — scrubbed
 *     files, which enter through the Cage like any artifact. The
 *     external posture is a shape choice (GUI app, operator tool),
 *     not a license compulsion: the license is clean MIT.
 *   - The audit behind this registration is the cleanest of its set
 *     (verified 2026-10-20, HEAD 9a52398): zero outbound calls in
 *     src/main; the crash reporter is hard-disabled upstream as a
 *     written non-negotiable ("no telemetry/phone-home"); deps
 *     lockfile-pinned, the ExifTool wrapper exact-pinned.
 *   - RELEASE ARTIFACTS ARE UNSIGNED upstream (the maintainer
 *     documents declining an EV cert). The pin record therefore
 *     carries a release sha256 field that starts EMPTY: Cage
 *     intake records the hash of the exact artifact, obtained
 *     out-of-band, before first run. Unpinned → no governed run.
 *   - guardSpecifier() is the tripwire: any attempt to reference
 *     ExifCleaner as code from another module throws at the call
 *     site, so the external line cannot erode silently.
 */

export const EXIFCLEANER_PIN = Object.freeze({
  repo: 'szTheory/exifcleaner',
  license: 'MIT',
  commit: '9a52398e647ce4e84681cc5fa5a446cc4267cd81',
  release: 'v4.5.0',
  expectedReleaseSha256: null, // Cage intake records it out-of-band. Empty on purpose.
  status: 'UNPINNED',
});

export const EXIFCLEANER_DESCRIPTOR = Object.freeze({
  id: 'exifcleaner',
  repo: 'szTheory/exifcleaner',
  license: 'MIT',
  external: true,
  distribution: 'external-only',
  driveContract: Object.freeze({
    how: 'operator-run desktop app, own session; Kingmaker consumes scrubbed output files only',
    outputsConsumed: Object.freeze(['metadata-scrubbed images', 'metadata-scrubbed video', 'metadata-scrubbed PDFs']),
    intakePath: 'Cage — release artifact hash recorded out-of-band at intake (upstream builds are unsigned)',
  }),
});

const LINKAGE_KEYS = ['importPath', 'packageName', 'npmPackage', 'pipPackage', 'bundlePath', 'vendoredAt', 'linkedLibrary'];

/**
 * Validate an external registration record. Refuses drift toward
 * linkage: linkage fields present, a non-external posture, or a
 * shippable distribution.
 */
export function validateExternalDescriptor(d) {
  const problems = [];
  if (!d || typeof d !== 'object') return { ok: false, problems: ['descriptor missing'] };
  if (d.external !== true) problems.push('external must be true — ExifCleaner is an operator tool, never an internal component');
  if (d.license !== 'MIT' && d.licensePosture?.license !== 'MIT') problems.push('license must read MIT');
  if (d.distribution !== 'external-only' && d.licensePosture?.distribution !== 'EXTERNAL-ONLY — driven, never linked, never shipped') {
    problems.push("distribution must be 'external-only'");
  }
  for (const key of LINKAGE_KEYS) {
    if (key in d) problems.push(`linkage field '${key}' is forbidden on an external registration`);
  }
  return { ok: problems.length === 0, problems };
}

/**
 * Tripwire: throws if a specifier/path would pull ExifCleaner code
 * into the process or the payload. Returns true for anything else.
 */
export function guardSpecifier(spec) {
  const s = String(spec ?? '');
  if (/exifcleaner/i.test(s)) {
    throw new Error(`exifcleaner-external: specifier '${s}' refused — external-only; drive the app, never import it`);
  }
  return true;
}

/** Pin posture: well-formed record + whether the release hash is recorded. */
export function validatePinRecord(pin = EXIFCLEANER_PIN) {
  if (!pin || pin.repo !== EXIFCLEANER_PIN.repo) return { ok: false, pinned: false, reason: 'invalid pin record' };
  if (pin.expectedReleaseSha256 != null && !/^[0-9a-f]{64}$/.test(pin.expectedReleaseSha256)) {
    return { ok: false, pinned: false, reason: 'invalid pin record: expectedReleaseSha256 is not a sha256 hex digest' };
  }
  return { ok: true, pinned: pin.expectedReleaseSha256 != null && pin.status === 'PINNED' };
}
