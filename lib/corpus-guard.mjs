// lib/corpus-guard.mjs — the free/paid boundary helpers shared by the user library, the fleet pipeline and the owner
// review queue (2026-11-16).
//
//   corpus guard   Robbie's curated corpus (the paid `library.methods` membership) reaches an install ONLY through
//                  the update host's entitlement-checked /library/methods route (update-host/worker.js), and is cached
//                  in <state>/brain-library/methods. It must never be re-filed into the user's own library
//                  (<state>/abilities/methods) or the fleet store (<state>/fleet/abilities/methods), and never be
//                  proposed to the fleet as someone's "own work". The guard fingerprints each cached corpus method
//                  (its id, and a hash of its canonical executable steps) and refuses a matching method at every one of
//                  those doors. LIMITATION: a hand-paraphrased copy (different steps) is not detectable this way.
//   fleet policy   Whether a FREE install (no verified membership) may install owner-approved fleet abilities is an
//                  OWNER DECISION that is not documented anywhere yet. Until it is made, the conservative default
//                  applies: free installs do not install fleet abilities; a verified membership does. The owner flips
//                  it in <state>/fleet/policy.json (kingmaker.fleet-policy/1). Either way the user's OWN library is
//                  never gated.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const sha = (x) => createHash('sha256').update(x).digest('hex');
const BLOCK = /```kingmaker-method\r?\n([\s\S]*?)```/;

/** JSON with recursively sorted object keys (stable across key order). */
export function stableJson(x) {
  if (Array.isArray(x)) return `[${x.map(stableJson).join(',')}]`;
  if (x && typeof x === 'object') return `{${Object.keys(x).sort().map((k) => `${JSON.stringify(k)}:${stableJson(x[k])}`).join(',')}}`;
  return JSON.stringify(x);
}

/** { id, steps } fingerprint of a method file's executable block, or null when it carries none / does not parse. */
export function methodFingerprint(text) {
  const m = BLOCK.exec(String(text ?? '')); if (!m) return null;
  let spec; try { spec = JSON.parse(m[1]); } catch { return null; }
  if (!spec?.id || !Array.isArray(spec.steps)) return null;
  return { id: String(spec.id), steps: sha(stableJson(spec.steps)) };
}

/** Fingerprints of every method filed in the given corpus stores (default: this install's curated-corpus cache). */
export function corpusFingerprints({ state = null, stores = [] } = {}) {
  const dirs = [...(state ? [join(state, 'brain-library', 'methods')] : []), ...stores];
  const ids = new Set(), steps = new Set();
  for (const dir of dirs) {
    let idx; try { idx = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')); } catch { continue; }
    for (const e of Array.isArray(idx?.methods) ? idx.methods : []) {
      if (e?.id) ids.add(String(e.id));
      if (typeof e?.file !== 'string' || !/^[a-z0-9][a-z0-9._-]*\.method\.md$/i.test(e.file)) continue;
      let text; try { text = readFileSync(join(dir, e.file), 'utf8'); } catch { continue; }
      const fp = methodFingerprint(text); if (fp) { ids.add(fp.id); steps.add(fp.steps); }
    }
  }
  return { ids, steps };
}

/** The reason a method text matches the paid corpus, or null. `fps` defaults to this install's corpus cache. */
export function corpusMatch(text, { state = null, stores = [], fps = null } = {}) {
  const f = fps ?? corpusFingerprints({ state, stores });
  const fp = methodFingerprint(text); if (!fp) return null;
  if (f.steps.has(fp.steps)) return `paid_corpus_item: its executable steps match curated-corpus method content`;
  if (f.ids.has(fp.id)) return `paid_corpus_item: its id "${fp.id}" is a curated-corpus method id`;
  return null;
}

export const FLEET_POLICY_SCHEMA = 'kingmaker.fleet-policy/1';
export const FLEET_POLICY_DEFAULT = Object.freeze({ freeInstallsReceiveFleetAbilities: false });

/** The fleet-ability distribution policy for this install (default: conservative, see header). */
export function fleetPolicy(state) {
  const p = join(state, 'fleet', 'policy.json');
  if (!existsSync(p)) return { ...FLEET_POLICY_DEFAULT, source: 'default (owner decision pending)' };
  try {
    const doc = JSON.parse(readFileSync(p, 'utf8'));
    if (doc?.schema !== FLEET_POLICY_SCHEMA) throw new Error('schema');
    return { freeInstallsReceiveFleetAbilities: doc.freeInstallsReceiveFleetAbilities === true, source: p };
  } catch { return { ...FLEET_POLICY_DEFAULT, source: `default (unreadable ${p})` }; }
}
export function setFleetPolicy(state, { freeInstallsReceiveFleetAbilities }) {
  mkdirSync(join(state, 'fleet'), { recursive: true, mode: 0o700 });
  writeFileSync(join(state, 'fleet', 'policy.json'), JSON.stringify({ schema: FLEET_POLICY_SCHEMA, freeInstallsReceiveFleetAbilities: freeInstallsReceiveFleetAbilities === true }, null, 2), { mode: 0o600 });
}
