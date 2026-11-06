// B5 — Stage/layer registry (SPEC §4.2): "the attacked spot", made
// addressable. A spot is {lane, stage, surface} drawn from the lanes and
// the fixed stage order Armor already runs [INV §7a]. Each spot has a
// layer stack manifest listing active layers (shipped + generated) with
// origin, generating cycle, rules/pack version, gate receipt, and the
// prior-state snapshot rollback needs. The registry is descriptive before
// it is executive: it addresses layers AT stages; it does not re-plumb
// the stage order (SPEC §8 non-goal).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const LANES = ['upload', 'repository', 'device', 'intake', 'activation', 'airlock'];
export const STAGES = ['classify', 'format', 'source-scan', 'binary-scan', 'rea', 'sandbox-profile', 'verdict', 'tier-snapshot', 'cell-enforce', 'airlock-enforce'];

// Surfaces are drawn from the proven data surfaces (SPEC §2.2).
export const SURFACES = {
  upload: ['rea-rules', 'sandbox-profile', 'seatbelt-params', 'generated-policy'],
  repository: ['rea-rules', 'scan-pack', 'generated-policy'],
  device: ['device-scan-roots', 'generated-policy'],
  intake: ['rea-rules', 'generated-policy'],
  activation: ['generated-policy', 'attempts-thresholds'],
  airlock: ['dock-profiles', 'generated-policy'],
};

export function spotKey(spot) { return `${spot.lane}__${spot.stage}__${spot.surface}`; }
export function validSpot(spot) {
  return LANES.includes(spot.lane) && STAGES.includes(spot.stage)
    && (SURFACES[spot.lane] || []).includes(spot.surface);
}
export function allSpots() {
  const out = [];
  for (const lane of LANES) for (const surface of SURFACES[lane]) {
    for (const stage of STAGES) out.push({ lane, stage, surface });
  }
  return out;
}

function manifestFile(stateDir, spot) { return path.join(stateDir, 'manifests', `${spotKey(spot)}.json`); }
const snapHash = (snap) => crypto.createHash('sha256').update(JSON.stringify(snap)).digest('hex');

export function readManifest(stateDir, spot) {
  try { return JSON.parse(fs.readFileSync(manifestFile(stateDir, spot), 'utf8')); }
  catch { return { spot, layers: [] }; }
}
function writeManifest(stateDir, spot, manifest) {
  fs.mkdirSync(path.join(stateDir, 'manifests'), { recursive: true });
  fs.writeFileSync(manifestFile(stateDir, spot), JSON.stringify(manifest, null, 2));
}

// Register a deployed layer at a spot. priorState is the exact generated-
// store state the layer replaced/augmented, snapshotted and hashed so a
// tampered snapshot is detectable at rollback time.
export function registerLayer(stateDir, spot, layer) {
  if (!validSpot(spot)) throw new Error(`invalid spot ${spotKey(spot)}`);
  const manifest = readManifest(stateDir, spot);
  const entry = {
    layer_id: layer.layer_id, shape: layer.shape, origin: layer.origin ?? 'generated',
    cycle_id: layer.cycle_id ?? null, rules_version: layer.rules_version ?? null,
    gate_receipt_seq: layer.gate_receipt_seq ?? null,
    deployed_at: new Date().toISOString(),
    prior_state: layer.prior_state ?? null,
    prior_state_hash: layer.prior_state ? snapHash(layer.prior_state) : null,
    active: true,
  };
  manifest.layers = manifest.layers.filter((l) => l.layer_id !== entry.layer_id);
  manifest.layers.push(entry);
  writeManifest(stateDir, spot, manifest);
  return entry;
}

export function layersAt(stateDir, spot) {
  return readManifest(stateDir, spot).layers.filter((l) => l.active);
}
export function allManifests(stateDir) {
  const dir = path.join(stateDir, 'manifests');
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch {}
  return files.map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
}

// Verify a layer's prior-state snapshot hasn't been tampered with.
export function verifySnapshot(entry) {
  if (!entry.prior_state) return { ok: false, reason: 'no snapshot' };
  return snapHash(entry.prior_state) === entry.prior_state_hash
    ? { ok: true } : { ok: false, reason: 'snapshot hash mismatch — snapshot was tampered with' };
}

// Rollback: mark the layer inactive and return its verified prior state
// for the caller to restore into the generated stores. Refuses a tampered
// snapshot (rollback abuse is an attack on the loop; SPEC §5 step 6).
export function rollbackLayer(stateDir, spot, layer_id) {
  const manifest = readManifest(stateDir, spot);
  const entry = manifest.layers.find((l) => l.layer_id === layer_id && l.active);
  if (!entry) return { ok: false, reason: 'no active layer with that id at that spot' };
  const v = verifySnapshot(entry);
  if (!v.ok) return { ok: false, reason: `rollback refused: ${v.reason}` };
  entry.active = false;
  entry.rolled_back_at = new Date().toISOString();
  writeManifest(stateDir, spot, manifest);
  return { ok: true, prior_state: entry.prior_state };
}
