// lb-wiring-driver.mjs — child-process driver for the LB wiring
// persistence proof (test/lb-wiring.test.mjs). Each invocation is a
// separate process: `drive` enriches a fixed endpoint-bearing record
// through the host wiring, `append` performs one more lookup, and
// `verify` only opens the bridge (which re-opens and re-verifies the
// persisted audit chain from disk). State lives entirely in the
// identity dir named by argv — nothing is shared through this process.
//
// usage: node lb-wiring-driver.mjs <identityDir> <modulePath> <mode>
import fs from 'node:fs';
import { createHostLittleBrother, lbAuditPath } from '../lb-host.mjs';

const [identityDir, modulePath, mode] = process.argv.slice(2);
process.env.SCRIPTURE_ARMOR_LB_MODULE = modulePath;

function auditState() {
  const raw = fs.readFileSync(lbAuditPath(identityDir), 'utf8').trim();
  const lines = raw ? raw.split('\n') : [];
  const last = lines.length ? JSON.parse(lines[lines.length - 1]) : null;
  return { entries: lines.length, lastHash: last?.hash ?? null, lastPrevHash: last?.prevHash ?? null };
}

try {
  const lb = await createHostLittleBrother({ identityDir });
  if (mode === 'drive') {
    const record = { findings: [
      { rule: 'embedded-endpoint', detail: 'embedded endpoint string: https://evil.example.com:8443/x' },
      { rule: 'embedded-endpoint', detail: 'embedded endpoint string: 203.0.113.7:9001' },
    ] };
    const out = await lb.enrichScanRecord(record);
    console.log(JSON.stringify({ wired: lb.wired, results: out.enrichment?.results?.length ?? 0, audit: lb.verifyAudit(), ...auditState() }));
  } else if (mode === 'append') {
    const res = await lb.lookup('ipLookup', '203.0.113.7');
    console.log(JSON.stringify({ wired: lb.wired, lookupOk: res?.ok === true, audit: lb.verifyAudit(), ...auditState() }));
  } else if (mode === 'verify') {
    console.log(JSON.stringify({ wired: lb.wired, audit: lb.verifyAudit(), ...auditState() }));
  } else {
    throw new Error(`unknown mode '${mode}'`);
  }
} catch (error) {
  console.log(JSON.stringify({ error: error.message }));
  process.exit(3);
}
