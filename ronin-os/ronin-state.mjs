// ronin-state.mjs — RONIN OS surface contract v1 (DESIGN §11 Phase 0).
// Generalizes the light-runtime contract (kingmaker-lightui-build/light-runtime/state-schema.mjs):
// engine-owned state records the surface READS; the surface writes only intent + session prefs.
// Files in the state dir:
//   ronin-state.json   — the assembled posture record: { schema, at, posture: {state, density, trust, since, recordSeq},
//                          lanes: { <lane>: { summary, at, source } }, core: { mode }, approvals: [ ... ] }
//   audit chain lives engine-side (audit-chain.mjs); the posture record carries the seq of the audit
//   entry that established the current state — the surface renders state ONLY from a record whose
//   recordSeq resolves in the chain (§2.3: a readout doesn't freelance).
export const RONIN_SCHEMA = 1;
export const STATES = {
  OPS:        { hue: 'blue',       hex: '#2e6bff', pattern: 'segments-6', ownerNamed: true,  kind: 'declared' },
  RED:        { hue: 'red',        hex: '#ff2e2e', pattern: 'segments-3-tri', ownerNamed: true, kind: 'declared' },
  CONTAINMENT:{ hue: 'red-violet', hex: '#c02eff', pattern: 'segments-8-strobe-edge', ownerNamed: false, kind: 'condition' },
  SEALED:     { hue: 'indigo',     hex: '#2a2a72', pattern: 'segments-6-dim', ownerNamed: false, kind: 'condition' },
  FORGE:      { hue: 'green',      hex: '#2eff7a', pattern: 'segments-5', ownerNamed: false, kind: 'declared' },
  SETTLE:     { hue: 'gold',       hex: '#ffb52e', pattern: 'segments-4', ownerNamed: false, kind: 'declared' },
};
export const AMBER = '#f5c518'; // §2.5 the attention/evidence channel — orthogonal to state hue, never decoration
export const LANES = ['mesh', 'brains', 'library', 'money', 'security', 'media', 'system'];
export const TRUST = ['ATTESTED', 'SEALED-ENTRY', 'SEALED', 'UNVERIFIED'];
export const DENSITIES = ['HOME', 'WALL'];

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const isStr = (v) => typeof v === 'string' && v.length > 0;

export function validatePostureRecord(v) {
  const errors = [];
  if (!isObj(v)) return { ok: false, errors: ['record must be an object'], value: null };
  if (v.schema !== RONIN_SCHEMA) errors.push(`schema must be ${RONIN_SCHEMA}`);
  if (!isStr(v.at) || Number.isNaN(Date.parse(v.at))) errors.push('at must be an ISO time');
  const p = v.posture;
  if (!isObj(p)) errors.push('posture must be an object');
  else {
    if (!STATES[p.state]) errors.push(`posture.state must be one of ${Object.keys(STATES).join('/')}, got ${JSON.stringify(p.state)}`);
    if (!DENSITIES.includes(p.density)) errors.push(`posture.density must be HOME|WALL`);
    if (!TRUST.includes(p.trust)) errors.push(`posture.trust must be one of ${TRUST.join('/')}`);
    if (!Number.isInteger(p.recordSeq) || p.recordSeq < 1) errors.push('posture.recordSeq must be a positive integer (the audit entry that established this state)');
  }
  if (!isObj(v.lanes)) errors.push('lanes must be an object');
  else for (const [k, lane] of Object.entries(v.lanes)) {
    if (!LANES.includes(k)) errors.push(`unknown lane ${k}`);
    else if (!isObj(lane) || !('summary' in lane) || !isStr(lane.at)) errors.push(`lane ${k}: needs { summary, at }`);
  }
  if (v.approvals !== undefined && !Array.isArray(v.approvals)) errors.push('approvals must be an array');
  return { ok: errors.length === 0, errors, value: errors.length === 0 ? v : null };
}

/** What the surface is allowed to derive from a posture record — computed, never read from the record:
 *  hue/pattern/name come from the taxonomy (§2.4 redundancy: name + pattern + hue, never hue alone). */
export function renderFacts(record) {
  const s = STATES[record.posture.state];
  return {
    state: record.posture.state, stateLabel: record.posture.state + (record.posture.scopeId ? ` — SCOPE: ${record.posture.scopeId}` : ''),
    hue: s.hue, hex: s.hex, pattern: s.pattern, density: record.posture.density,
    trust: record.posture.trust, amber: AMBER,
  };
}

/** Truthfulness rule (§2.3/§7.2): the record is only renderable if its recordSeq resolves in the audit
 *  chain to a state-transition entry for the same state. A forged or orphaned record fails closed. */
export function verifyAgainstChain(record, chainEntries) {
  const e = chainEntries.find((x) => x.seq === record?.posture?.recordSeq);
  if (!e) return { ok: false, why: `no audit entry at seq ${record?.posture?.recordSeq}` };
  if (e.kind !== 'state-transition') return { ok: false, why: `audit entry ${e.seq} is ${e.kind}, not a state transition` };
  if (e.body?.to !== record.posture.state) return { ok: false, why: `audit says ${e.body?.to}, record says ${record.posture.state}` };
  return { ok: true, entry: e };
}
