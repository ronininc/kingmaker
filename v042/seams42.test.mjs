/**
 * seams42.test.mjs — the cross-component truth checks for the 4.2 stack.
 * The per-tool suites prove each fold-in alone; this suite proves the
 * registry, the descriptors, and the code agree with each other:
 *   - the manifest's license posture matches each tool's descriptor
 *   - every registered file exists
 *   - NOTHING in the tree imports a bare (non-relative, non-node:)
 *     specifier — the fold-in is zero-dependency and imports no
 *     upstream code, FreeMoCap's AGPL least of all
 *   - the triage verdict binds through the shared gate
 *   - the AngelSlim descriptor kind == the module's workload kind
 *   - the shared audit chain verifies under independently recomputed
 *     house math (the same math the 4.1 harvester reads)
 *   - verify-42.mjs actually covers all eight suites
 */

import { readFileSync, readdirSync, existsSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { openAuditLog } from './lib/audit-chain.mjs';
import { assertUsable } from './triage/lib/triage.mjs';
import { ANGELSLIM_KIND } from './angelslim/lib/angelslim-job.mjs';

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}`); }
}

const root = new URL('.', import.meta.url).pathname;
const manifest = JSON.parse(readFileSync(join(root, 'stack42-manifest.json'), 'utf8'));
const byId = Object.fromEntries(manifest.components.map((c) => [c.id, c]));
const TOOL_IDS = ['scrapling', 'obscura', 'blender-mcp', 'whatsapp-mcp', 'angelslim', 'freemocap'];

// 1. Registry completeness.
check('manifest registers all eight components', ['scrapling', 'obscura', 'blender-mcp', 'whatsapp-mcp', 'angelslim', 'freemocap', 'triage', 'kingmaker-v042'].every((id) => byId[id]));

// 2. License posture: manifest == descriptor, per tool.
for (const id of TOOL_IDS) {
  const desc = JSON.parse(readFileSync(join(root, id, 'descriptor.json'), 'utf8'));
  check(`${id}: manifest license class == descriptor (${desc.licensePosture.class})`, byId[id].licensePosture.class === desc.licensePosture.class);
}

// 3. FreeMoCap's posture is the registry's only AGPL entry, and external.
check('freemocap is the only agpl-external component',
  manifest.components.filter((c) => c.licensePosture.class === 'agpl-external').map((c) => c.id).join() === 'freemocap');
check('triage is the only unverified component',
  manifest.components.filter((c) => c.licensePosture.class === 'unverified').map((c) => c.id).join() === 'triage');

// 4. Triage records exist and the gate binds on the real files.
for (const rec of byId.triage.records) {
  const r = JSON.parse(readFileSync(join(root, 'triage', rec), 'utf8'));
  let threw = false;
  try { assertUsable(r); } catch { threw = true; }
  check(`triage ${rec}: on-disk record is DO NOT USE through the gate`, threw && r.status === 'UNVERIFIED');
}

// 5. AngelSlim seam: descriptor workload kind == module constant.
const asDesc = JSON.parse(readFileSync(join(root, 'angelslim', 'descriptor.json'), 'utf8'));
check('angelslim descriptor kind == module workload kind', asDesc.workload.kind === ANGELSLIM_KIND);

// 6. WhatsApp seam: the descriptor states the send law the gate enforces.
const waDesc = JSON.parse(readFileSync(join(root, 'whatsapp-mcp', 'descriptor.json'), 'utf8'));
check('whatsapp descriptor states per-batch tap + known contacts',
  /per-batch/i.test(waDesc.governance.sends) && /known contact/i.test(waDesc.governance.sends));

// 7. NOTICE carries the AGPL callout.
const notice = readFileSync(join(root, 'NOTICE'), 'utf8');
check('NOTICE calls out FreeMoCap AGPL external-only', /FreeMoCap/.test(notice) && /AGPL-3\.0/.test(notice) && /EXTERNAL/.test(notice));

// 8. Zero bare imports anywhere in the tree (zero-dependency proof).
function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else if (entry.name.endsWith('.mjs')) yield p;
  }
}
const bare = [];
let files = 0;
for (const file of walk(root)) {
  files++;
  const src = readFileSync(file, 'utf8');
  for (const m of src.matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g)) {
    if (!m[1].startsWith('.') && !m[1].startsWith('node:')) bare.push(`${file.replace(root, '')}: ${m[1]}`);
  }
}
check(`no bare imports in any of ${files} .mjs files`, bare.length === 0);

// 9. Audit-chain interop: independently recomputed house math agrees.
{
  const dir = mkdtempSync(join(tmpdir(), 'km42-seam-'));
  const p = join(dir, 'chain.jsonl');
  const log = openAuditLog(p, { genesisLabel: 'seam' });
  log.append({ actor: 'seam', action: 'one', detail: 'first' });
  log.append({ actor: 'seam', action: 'two', detail: 'second' });
  const lines = readFileSync(p, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  let ok = lines.length === 3;
  for (let i = 0; i < lines.length && ok; i++) {
    const e = lines[i];
    const recomputed = createHash('sha256').update(JSON.stringify({ ...e, hash: undefined }), 'utf8').digest('hex');
    ok = recomputed === e.hash && e.seq === i && (i === 0 ? e.prevHash === '0'.repeat(64) : e.prevHash === lines[i - 1].hash);
  }
  check('shared audit chain verifies under independent recomputation', ok && log.verify().ok === true);
}

// 10. The verifier covers all eight suites.
const verifier = readFileSync(join(root, 'verify-42.mjs'), 'utf8');
check('verify-42 covers every suite', ['scrapling/tests/run-tests.mjs', 'obscura/tests/run-tests.mjs', 'blender-mcp/tests/run-tests.mjs', 'whatsapp-mcp/tests/run-tests.mjs', 'angelslim/tests/run-tests.mjs', 'freemocap/tests/run-tests.mjs', 'triage/tests/run-tests.mjs', 'seams42.test.mjs'].every((s) => verifier.includes(s)));

console.log(`\n${pass}/${pass + fail} seam checks passed`);
process.exit(fail === 0 ? 0 : 1);
