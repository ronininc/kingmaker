/**
 * solidcraft tests — pure contract checks. No binary, no GUI, no network.
 */

import { readFileSync } from 'node:fs';
import {
  SOLID_PIN,
  buildGovernedPrefs,
  validatePrefs,
  validateScriptJob,
  validateLaunchTarget,
  validatePinRecord,
} from '../lib/solidcraft-contract.mjs';

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}`); }
}

const descriptor = JSON.parse(readFileSync(new URL('../descriptor.json', import.meta.url), 'utf8'));
const WS = '/work/fab';

// 1. Pin posture + fork-required recorded.
check('pin ships unpinned on purpose', SOLID_PIN.expectedSha256 === null && SOLID_PIN.status === 'UNPINNED');
check('fork-required minisign fix is recorded', SOLID_PIN.forkRequired.some((f) => /PUBLIC_KEY/.test(f)));
check('descriptor agrees with pin record', descriptor.pin.auditedCommit === SOLID_PIN.auditedCommit && descriptor.forkRequired.length >= 1);
check('pin record validates as well-formed-but-unpinned', (() => { const v = validatePinRecord(); return v.ok && v.pinned === false; })());

// 2. S1 — updates pinned off, and the pin cannot be un-pinned.
const p1 = buildGovernedPrefs();
check('governed prefs pin check_updates=false', p1.ok === true && p1.prefs.check_updates === false);
check('validatePrefs accepts the governed prefs', validatePrefs(p1.prefs).ok === true);
const p2 = validatePrefs({ check_updates: true });
check('check_updates=true refuses (S1)', p2.ok === false && /PUBLIC_KEY = None/.test(p2.reason));
check('missing check_updates is acceptable (contract writes it)', validatePrefs({}).ok === true);

// 3. S1 — GUI is not a governed launch target; CLI/MCP are.
check('GUI launch refuses (S1)', validateLaunchTarget('gui').ok === false && /auto-updater/.test(validateLaunchTarget('gui').reason));
check('CLI launch passes', validateLaunchTarget('cli').ok === true);
check('MCP launch passes', validateLaunchTarget('mcp').ok === true);
check('unknown target refuses', validateLaunchTarget('web').ok === false);

// 4. S2 — script paths confined to the fabrication workspace.
const good = JSON.stringify({ commands: [
  { op: 'doc.new' },
  { op: 'feature.pad', params: { height: 5 } },
  { op: 'export', params: { path: 'bracket.step' } },
] });
const g1 = validateScriptJob({ scriptText: good, workspace: WS, outPath: 'bracket.step' });
check('in-workspace script passes with paths checked', g1.ok === true && g1.pathsChecked >= 1);
const evil = JSON.stringify({ commands: [{ op: 'doc.open', params: { path: '/etc/passwd' } }] });
const e1 = validateScriptJob({ scriptText: evil, workspace: WS });
check('absolute escape path refuses (S2)', e1.ok === false && /outside the fabrication workspace/.test(e1.reason));
const sneaky = JSON.stringify({ commands: [{ op: 'export', params: { out: '../outside.step' } }] });
const e2 = validateScriptJob({ scriptText: sneaky, workspace: WS });
check('.. traversal refuses (S2)', e2.ok === false && /outside the fabrication workspace/.test(e2.reason));
const homeWrite = JSON.stringify({ commands: [{ op: 'export', params: { file: '/home/robbie/evil.step' } }] });
check('home-dir write refuses (S2)', validateScriptJob({ scriptText: homeWrite, workspace: WS }).ok === false);
check('invalid JSON refuses', validateScriptJob({ scriptText: '{nope', workspace: WS }).ok === false);

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail === 0 ? 0 : 1);
