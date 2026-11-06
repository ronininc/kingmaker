// B1 per-lane collection adapters (SPEC §3.1). The upload lane's adapter
// is the review harness (review-harness.mjs: record emitted before the
// disposable workspace is destroyed). These are the remaining lanes:
// mirroring for streams that already persist (beacon, activations), the
// repository lane's unfiltered emission (the severity != info filter is
// bypassed for the ledger only), and the device lane's flush of records
// that today live only in process memory.
import fs from 'node:fs';
import path from 'node:path';
import { emitBeacon, emitActivation, emitDeviceFindings, appendRecord } from './shield-ledger.mjs';
import { armorHome } from './shield-aggregator.mjs';

// Beacon: mirror events into the ledger as they stand (already retained
// on disk; mirroring puts attack testimony in the same stream).
export function mirrorBeacon(identityDir, home = armorHome()) {
  const file = path.join(home, 'beacon.log');
  let n = 0;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    emitBeacon(identityDir, JSON.parse(line));
    n++;
  }
  return n;
}

// Activation/daemon: activation records already persist in registry
// entries' activations[]; the aggregator's stream needs them in the
// ledger too — including refused outcomes and incidents.
export function mirrorActivations(identityDir, { limit = 50, home = armorHome() } = {}) {
  const reg = JSON.parse(fs.readFileSync(path.join(home, 'registry.json'), 'utf8'));
  let n = 0;
  for (const [canary, entry] of Object.entries(reg.entries || {})) {
    for (const act of entry.activations || []) {
      if (n >= limit) return n;
      emitActivation(identityDir, { canary, ...act }, canary);
      n++;
    }
  }
  return n;
}

// Repository lane: emit a per-file record UNFILTERED. The shipped engine
// stores only severity != 'info' [INV §2a]; the ledger keeps the info
// band too (LB enrichment, low-grade recurrence) with severity preserved.
export function collectRepoFileRecord(identityDir, fileRecord, jobId) {
  return appendRecord(identityDir, {
    lane: 'repository', source_id: jobId, rules_version: 'scan-rules/1',
    record: fileRecord,
  });
}
// What the shipped corpus filter does to the same record (for contrast
// evidence): returns only the findings the corpus would have stored.
export function shippedCorpusView(fileRecord) {
  return (fileRecord.findings || []).filter((f) => f.severity !== 'info');
}

// Device lane: flush every finding record + a counters snapshot — the
// records device-protection.mjs keeps in a process Map today [INV §1c].
export function collectDeviceFindings(identityDir, { findings, counters }, source_id) {
  return emitDeviceFindings(identityDir, {
    schema: 'scripture-armor.device-findings/1', findings, counters,
  }, source_id);
}
