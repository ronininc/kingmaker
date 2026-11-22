/**
 * freemocap/lib/freemocap-external.mjs
 *
 * The EXTERNAL-ONLY registration for FreeMoCap (freemocap/freemocap,
 * AGPL-3.0). This module is the whole fold-in, and it is deliberately
 * almost nothing:
 *
 *   - AGPL-3.0 code is never imported, linked, vendored, or shipped —
 *     the heretic/AGPL house rule (AGPL engines are driven as external
 *     processes by the operator, never absorbed). FreeMoCap goes one
 *     step further than subprocess-driven: Kingmaker does not even
 *     start it. An operator runs it in their own session; Kingmaker
 *     consumes only its EXPORTED FILES (.blend / .csv), which enter
 *     through the Cage like any other external artifact.
 *   - OUT OF SOLOMON. The commercial build never carries this
 *     registration's capability; the descriptor says so in data, and
 *     validateExternalDescriptor refuses any record that drifts
 *     toward linkage or shipment.
 *   - guardSpecifier() is a tripwire for future wiring mistakes: any
 *     module specifier or path that would pull FreeMoCap in throws,
 *     loudly, at the call site.
 *
 * This file imports nothing from FreeMoCap (there is nothing to
 * import — that is the point), and its test suite scans this
 * component's own sources to keep it that way.
 */

export const FREEMOCAP_DESCRIPTOR = Object.freeze({
  id: 'freemocap',
  repo: 'freemocap/freemocap',
  license: 'AGPL-3.0',
  external: true,
  distribution: 'external-only',
  solomon: 'excluded',
  driveContract: Object.freeze({
    how: 'operator-run, own session; Kingmaker consumes exported files only',
    exportsConsumed: Object.freeze(['.blend', '.csv']),
    intakePath: 'Cage — hash recorded at intake like any external artifact',
  }),
});

const LINKAGE_KEYS = ['importPath', 'packageName', 'npmPackage', 'pipPackage', 'bundlePath', 'vendoredAt', 'linkedLibrary'];

/**
 * Validate an external registration record. Refuses any drift toward
 * the exact things AGPL forbids here: linkage fields, a non-external
 * posture, a shippable distribution, or a Solomon presence.
 */
export function validateExternalDescriptor(d) {
  const problems = [];
  if (!d || typeof d !== 'object') return { ok: false, problems: ['descriptor missing'] };
  if (d.external !== true) problems.push('external must be true — FreeMoCap is never an internal component');
  if (d.license !== 'AGPL-3.0') problems.push('license must read AGPL-3.0');
  if (d.distribution !== 'external-only') problems.push("distribution must be 'external-only'");
  if (d.solomon !== 'excluded') problems.push("solomon must be 'excluded'");
  for (const key of LINKAGE_KEYS) {
    if (key in d) problems.push(`linkage field '${key}' is forbidden on an external-only registration`);
  }
  return { ok: problems.length === 0, problems };
}

/**
 * Tripwire: throws if a specifier/path would pull FreeMoCap code into
 * the process or the payload. Returns true for anything else.
 */
export function guardSpecifier(spec) {
  const s = String(spec ?? '');
  if (/freemocap/i.test(s)) {
    throw new Error(`freemocap-external: specifier '${s}' refused — AGPL external-only; drive it, never import it`);
  }
  return true;
}
