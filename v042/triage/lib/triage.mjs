/**
 * triage/lib/triage.mjs
 *
 * Cage / Housing Bay intake for models that arrive as CLAIMS, not
 * artifacts. A triage record is the paper trail of an unverified
 * candidate: what was claimed, by whom, what has NOT been checked, and
 * the verdict that binds until clearance — DO NOT USE.
 *
 * The binding rules, enforced in code (pipeline FLAG discipline):
 *   - A record is usable ONLY when status is 'CLEARED' and every
 *     clearance requirement is met: license verified AT SOURCE (a
 *     social-media caption is not a license), weights hash recorded
 *     from the actual artifact at intake, Cage scan passed.
 *   - assertUsable() throws otherwise — flipping the status string
 *     alone does not clear a record; the gaps travel with it.
 *   - Nothing here downloads anything. Weights move only through the
 *     model ingestion pipeline, after clearance, with the founder tap
 *     at Cage Stage 4.
 */

const SHA256_RE = /^[0-9a-f]{64}$/;

export function validateTriageRecord(r) {
  const problems = [];
  if (!r || typeof r !== 'object') return { ok: false, problems: ['record missing'] };
  if (!r.id) problems.push('id is required');
  if (r.kind !== 'model') problems.push("kind must be 'model'");
  if (!['UNVERIFIED', 'CLEARED', 'REJECTED'].includes(r.status)) problems.push('status must be UNVERIFIED | CLEARED | REJECTED');
  if (!r.licenseClaim || typeof r.licenseClaim.claimed !== 'string') problems.push('licenseClaim.claimed is required');
  if (r.status === 'UNVERIFIED' && r.verdict !== 'DO NOT USE until cleared') {
    problems.push("an UNVERIFIED record's verdict must be 'DO NOT USE until cleared'");
  }
  if (r.status === 'UNVERIFIED' && r.hashes?.sha256 !== null) {
    problems.push('an UNVERIFIED record carries no hash — hashes are recorded at intake, from the artifact');
  }
  return { ok: problems.length === 0, problems };
}

/**
 * The unmet clearance requirements for a record, in plain language.
 * A record with gaps is not usable, whatever its status string says.
 */
export function clearanceGaps(r) {
  const gaps = [];
  if (!r.licenseClaim?.verified) gaps.push('license not verified at source');
  if (!SHA256_RE.test(r.hashes?.sha256 ?? '')) gaps.push('weights sha256 not recorded');
  if (!Array.isArray(r.clearance?.requires) || r.clearance.requires.length === 0) gaps.push('clearance requirements not recorded');
  if (r.clearance?.requires?.length > 0 && !r.scanPassed) gaps.push('Cage scan not passed');
  if (!r.clearance?.clearedBy) gaps.push('no clearing authority recorded');
  if (r.status !== 'CLEARED') gaps.push(`status is ${r.status ?? 'missing'}, not CLEARED`);
  return gaps;
}

/**
 * The gate every consumer must call before touching a triaged model.
 * Throws with the full gap list — never returns a soft maybe.
 */
export function assertUsable(r) {
  const v = validateTriageRecord(r);
  if (!v.ok) throw new Error(`triage: record '${r?.id ?? '?'}' is malformed: ${v.problems.join('; ')}`);
  const gaps = clearanceGaps(r);
  if (gaps.length > 0) {
    throw new Error(`triage: '${r.id}' is DO NOT USE — clearance gaps: ${gaps.join('; ')}`);
  }
  return true;
}
