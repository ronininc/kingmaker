/**
 * wordcraft tests — pure contract checks. No binary, no process, no network.
 */

import { readFileSync } from 'node:fs';
import {
  WORDCRAFT_PIN,
  validatePinRecord,
  buildMcpConfig,
  buildConvertArgs,
  buildRunArgs,
} from '../lib/wordcraft-contract.mjs';

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}`); }
}

const descriptor = JSON.parse(readFileSync(new URL('../descriptor.json', import.meta.url), 'utf8'));
const WS = '/work/manuscripts';
const pinned = { ...WORDCRAFT_PIN, expectedSha256: 'b'.repeat(64), status: 'PINNED' };

// 1. Pin posture.
check('pin ships unpinned on purpose', WORDCRAFT_PIN.expectedSha256 === null && WORDCRAFT_PIN.status === 'UNPINNED');
check('descriptor agrees with pin record', descriptor.pin.repo === WORDCRAFT_PIN.repo && descriptor.pin.auditedCommit === WORDCRAFT_PIN.auditedCommit);
check('unpinned record validates as well-formed-but-unpinned', (() => { const v = validatePinRecord(); return v.ok && v.pinned === false; })());

// 2. W1 — unpinned or unconfined launches refuse.
const r1 = buildMcpConfig({ workspace: WS, readRoot: `${WS}/in`, writeRoot: `${WS}/out` });
check('unpinned binary refuses MCP config', r1.ok === false && /not pinned/.test(r1.reason));
const r2 = buildMcpConfig({ pin: pinned, workspace: WS, writeRoot: `${WS}/out` });
check('missing read root refuses (W1)', r2.ok === false && /UNCONFINED/.test(r2.reason));
const r3 = buildMcpConfig({ pin: pinned, workspace: WS, readRoot: `${WS}/in` });
check('missing write root refuses (W1)', r3.ok === false && /UNCONFINED/.test(r3.reason));
const r4 = buildMcpConfig({ pin: pinned, workspace: WS, readRoot: '/etc', writeRoot: `${WS}/out` });
check('root outside workspace refuses', r4.ok === false && /outside the declared workspace/.test(r4.reason));

// 3. A pinned, confined config builds with both roots baked in.
const r5 = buildMcpConfig({ pin: pinned, workspace: WS, readRoot: `${WS}/in`, writeRoot: `${WS}/out` });
check('pinned+confined MCP config builds', r5.ok === true && r5.mcpServers.wordcraft.command === 'wordcraft-cli');
check('config carries both automation roots', r5.mcpServers.wordcraft.args.join(' ').includes('--automation-read-root') && r5.mcpServers.wordcraft.args.join(' ').includes('--automation-write-root'));

// 4. W2 — macro flavors refuse; clean flavors pass.
const c1 = buildConvertArgs({ input: `${WS}/in/report.docm`, output: `${WS}/out/report.pdf`, workspace: WS });
check('.docm convert refuses (W2)', c1.ok === false && /macro documents refused/.test(c1.reason));
const c2 = buildConvertArgs({ input: `${WS}/in/template.dotm`, output: `${WS}/out/t.docx`, workspace: WS });
check('.dotm convert refuses (W2)', c2.ok === false && /macro/.test(c2.reason));
const c3 = buildConvertArgs({ input: `${WS}/in/report.docx`, output: `${WS}/out/report.pdf`, workspace: WS });
check('.docx convert builds', c3.ok === true && c3.args[0] === 'convert');

// 5. W3 — password by value refuses; by file builds.
const c4 = buildConvertArgs({ input: `${WS}/in/a.docx`, output: `${WS}/out/a.pdf`, workspace: WS, password: 'hunter2' });
check('raw --password refuses (W3)', c4.ok === false && /password-file/.test(c4.reason));
const c5 = buildConvertArgs({ input: `${WS}/in/a.docx`, output: `${WS}/out/a.pdf`, workspace: WS, passwordFile: `${WS}/.pw` });
check('--password-file builds', c5.ok === true && c5.args.includes('--password-file'));

// 6. Workspace escape refuses.
const c6 = buildConvertArgs({ input: `${WS}/in/a.docx`, output: '/tmp/evil.pdf', workspace: WS });
check('output outside workspace refuses', c6.ok === false && /outside the declared workspace/.test(c6.reason));

// 7. W4 — run jobs are tap-gated, fail-closed without a verifier.
const j1 = await buildRunArgs({ jobFile: `${WS}/in/job.json`, workspace: WS });
check('run job without tap verifier refuses (W4)', j1.ok === false && /fail-closed|founder tap/.test(j1.reason));
const j2 = await buildRunArgs({ jobFile: `${WS}/in/job.json`, workspace: WS, verifyTap: async (t) => t === 'tap-ok', tapToken: 'nope' });
check('run job with wrong tap refuses', j2.ok === false && j2.refused === true);
const j3 = await buildRunArgs({ jobFile: `${WS}/in/job.json`, workspace: WS, verifyTap: async (t) => t === 'tap-ok', tapToken: 'tap-ok' });
check('run job with founder tap builds', j3.ok === true && j3.args[0] === 'run');

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail === 0 ? 0 : 1);
