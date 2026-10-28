import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { callTool, TOOLS } from '../lib/mcp.mjs';
import { cmdRd, parseRunTail } from '../lib/rd-floor-cli.mjs';
import {
  AUDIT, MODULES, NPM_RUNTIME, REA_PIN, auditText, classifyLicense, findReaBinary, floorEnv, mapText,
  planRun, routeTarget, runAnalysis, versionAdmitted,
} from '../lib/rd-floor.mjs';

const exists = () => true;

test('the licence gate matches the import list, and AGPL is refuse', () => {
  assert.equal(classifyLicense('MIT'), 'allow');
  assert.equal(classifyLicense('Apache-2.0'), 'allow');
  assert.equal(classifyLicense('BSD-3-Clause'), 'allow');
  assert.equal(classifyLicense('(Apache-2.0 AND BSD-3-Clause)'), 'allow');
  assert.equal(classifyLicense('MIT OR WTFPL'), 'allow');
  assert.equal(classifyLicense('(MIT AND Zlib)'), 'allow');
  assert.equal(classifyLicense('MIT OR GPL-3.0'), 'allow');
  assert.equal(classifyLicense('Public-domain'), 'allow');
  assert.equal(classifyLicense('GPL-3.0-or-later'), 'quarantine');
  assert.equal(classifyLicense('LGPL-3.0+'), 'quarantine');
  assert.equal(classifyLicense('LGPL-2.0 WITH WxWindows-exception-3.1'), 'quarantine');
  assert.equal(classifyLicense('GPL-2.0-only WITH Classpath-exception-2.0'), 'quarantine');
  assert.equal(classifyLicense('AGPL-3.0'), 'refuse');
  assert.equal(classifyLicense('AGPL-3.0-only'), 'refuse');
  assert.equal(classifyLicense('proprietary'), 'refuse');
  assert.equal(classifyLicense(''), 'refuse');
  assert.equal(classifyLicense('none'), 'refuse');
  assert.equal(classifyLicense('unknown'), 'quarantine');
});

test('every audited row was classified before import, and nothing was copied in', () => {
  assert.equal(AUDIT.every((row) => row.imported === false), true);
  for (const row of AUDIT) assert.equal(classifyLicense(row.license), row.decision, row.id);
  assert.deepEqual(NPM_RUNTIME.quarantine.map((item) => item.name), ['openpgp@6.3.2', 'frida@17.23.2']);
  assert.equal(NPM_RUNTIME.runtimePackages, NPM_RUNTIME.allow + NPM_RUNTIME.quarantine.length);
  assert.equal(AUDIT.find((row) => row.id === 'rea').decision, 'allow');
  assert.equal(AUDIT.find((row) => row.id === 'hopper').decision, 'refuse');
  assert.equal(AUDIT.find((row) => row.id === 'unicorn').decision, 'quarantine');
  assert.equal(auditText().includes('AGPL'), true);
});

test('the five modules are the order, and a dispatched command is never a quarantined engine', () => {
  assert.deepEqual(MODULES.map((mod) => mod.name), [
    'Analysis Core', 'Mobile & Apps', 'Binary & Low-Level', 'Network & Runtime', 'Rebuild & Verify',
  ]);
  const names = new Set();
  for (const mod of MODULES) {
    for (const command of mod.commands) {
      if (!command.dispatch) continue;
      assert.equal(names.has(command.name), false, command.name);
      names.add(command.name);
      assert.equal(command.licenseDecision, undefined);
      assert.doesNotMatch(command.name, /hopper|jeb|gdb|rizin|frida|objdump|tshark|sigrok|cutter/);
    }
  }
  assert.ok(names.has('analyze') && names.has('inspect-web-network-capture') && names.has('compare'));
  assert.equal(mapText().includes('Analysis Core'), true);
});

test('routing names the module, including a capture the floor will not run', () => {
  assert.deepEqual(routeTarget('/Apps/Demo.apk'), { ok: true, module: 'mobile-apps', command: 'inspect-android-package', dispatch: true, reason: null });
  const pcap = routeTarget('/captures/net.pcap');
  assert.equal(pcap.module, 'network-runtime');
  assert.equal(pcap.command, 'inspect-pcap-capture');
  assert.equal(pcap.dispatch, false);
  assert.match(pcap.reason, /tshark|GPL/i);
  assert.equal(routeTarget('/bin/program.exe').command, 'analyze');
  assert.equal(routeTarget('/tmp/notes.har').command, 'inspect-web-network-capture');
  assert.equal(routeTarget('').ok, false);
});

test('a plan stays on the free engines and drops inherited secrets and Hopper', () => {
  const env = { PATH: '/usr/bin', HOME: '/Users/o', REA_ANALYSIS_PROVIDER: 'hopper', OPENAI_API_KEY: 'sk-secret', REA_JADX_MCP_JAR: '/opt/jadx.jar', REA_HOPPER_PATH: '/Applications/Hopper.app' };
  const plan = planRun({ module: 'binary-low-level', command: 'analyze', targets: ['/opt/app/program'] }, { exists, env });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.argv, ['analyze', '/opt/app/program', '--provider', 'ghidra', '--json']);
  assert.equal(plan.env.PATH, '/usr/bin');
  assert.equal(plan.env.REA_JADX_MCP_JAR, '/opt/jadx.jar');
  assert.equal(plan.env.REA_ANALYSIS_PROVIDER, undefined);
  assert.equal(plan.env.OPENAI_API_KEY, undefined);
  assert.equal(plan.env.REA_HOPPER_PATH, undefined);
  assert.equal(planRun({ module: 'binary-low-level', command: 'analyze', targets: ['/opt/app/program'], provider: 'hopper' }, { exists }).code, 'refused');
  assert.equal(planRun({ module: 'binary-low-level', command: 'analyze', targets: ['/opt/app/program'], provider: 'kuna' }, { exists }).provider, 'kuna');
  assert.equal(planRun({ module: 'binary-low-level', command: 'debug-with-gdb', targets: ['/opt/app/program'] }, { exists }).code, 'quarantine');
  assert.equal(planRun({ module: 'mobile-apps', command: 'decode-android-resources', targets: ['/opt/app.apk'] }, { exists }).code, 'held');
  assert.equal(planRun({ module: 'analysis-core', command: 'doctor', targets: [] }, { exists, env }).argv.includes('--provider'), false);
  assert.match(planRun({ module: 'binary-low-level', command: 'analyze', targets: ['/Users/o/.ssh/id_rsa'] }, { exists }).reason, /credential/);
  assert.match(planRun({ module: 'mobile-apps', command: 'inspect-android-package', targets: ['relative.apk'] }, { exists }).reason, /absolute/);
});

test('the child environment helper is the same boundary the plan uses', () => {
  const env = floorEnv({ PATH: '/bin', AWS_SECRET_ACCESS_KEY: 'x', LC_ALL: 'en_US.UTF-8', REA_TSHARK_COMMAND: '/usr/bin/tshark' });
  assert.equal(env.PATH, '/bin');
  assert.equal(env.LC_ALL, 'en_US.UTF-8');
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(env.REA_TSHARK_COMMAND, undefined);
});

test('run starts only an audited binary, and never downloads one', async () => {
  const missing = await runAnalysis({ module: 'analysis-core', command: 'capabilities', targets: [] }, { findRea: () => null, exists });
  assert.equal(missing.code, 'rea-missing');
  assert.match(missing.reason, /does not download/);
  const stale = await runAnalysis({ module: 'analysis-core', command: 'capabilities', targets: [] }, { findRea: () => '/opt/rea', versionOf: async () => '6.7.0', exists });
  assert.equal(stale.code, 'rea-unaudited');
  let spawned = null;
  const ran = await runAnalysis(
    { module: 'mobile-apps', command: 'inspect-android-package', targets: ['/Apps/Demo.apk'] },
    {
      exists,
      env: { PATH: '/usr/bin', REA_ANALYSIS_PROVIDER: 'ida' },
      findRea: () => '/opt/rea',
      versionOf: async () => 'rea-agents 6.8.0\n',
      spawn: async (bin, argv, opts) => { spawned = { bin, argv, env: opts.env }; return { code: 0, stdout: '{"ok":true}\n', stderr: '', truncated: false }; },
    },
  );
  assert.equal(ran.ok, true);
  assert.equal(spawned.bin, '/opt/rea');
  assert.deepEqual(spawned.argv, ['inspect-android-package', '/Apps/Demo.apk', '--json']);
  assert.equal(spawned.env.REA_ANALYSIS_PROVIDER, undefined);
  assert.equal(versionAdmitted('v6.8.0'), true);
  assert.equal(versionAdmitted('6.8.1'), false);
  assert.equal(versionAdmitted('6.8.0-next'), false);
});

test('findReaBinary ignores npx and honours KINGMAKER_REA', () => {
  const existsAt = (path) => path === '/opt/rea/rea' || path === '/usr/local/bin/npx';
  assert.equal(findReaBinary({ env: { PATH: '/usr/local/bin', KINGMAKER_REA: '/opt/rea/rea' }, exists: existsAt }), '/opt/rea/rea');
  assert.equal(findReaBinary({ env: { PATH: '/usr/local/bin' }, exists: existsAt }), null);
});

test('the terminal command plans, refuses, and prints the audit without spawning', async () => {
  const lines = [];
  const err = [];
  assert.equal(await cmdRd(['map'], { out: (s) => lines.push(s), err: (s) => err.push(s) }), 0);
  assert.match(lines.join('\n'), /Rebuild & Verify/);
  lines.length = 0;
  assert.equal(await cmdRd(['route', '/tmp/app.apk'], { out: (s) => lines.push(s), err: (s) => err.push(s) }), 0);
  assert.match(lines.join('\n'), /mobile-apps inspect-android-package/);
  let requested = null;
  const code = await cmdRd(['run', 'binary-low-level', 'analyze', '--provider', 'ghidra', '/opt/app'], {
    out: (s) => lines.push(s),
    err: (s) => err.push(s),
    run: async (request) => { requested = request; return { ok: false, code: 'refused', reason: 'no' }; },
  });
  assert.equal(code, 2);
  assert.equal(requested.provider, 'ghidra');
  assert.deepEqual(requested.targets, ['/opt/app']);
  const tail = parseRunTail(['--provider', 'kuna', '/opt/app', 'main'], { targets: [1, 1] });
  assert.equal(tail.provider, 'kuna');
  assert.deepEqual(tail.targets, ['/opt/app']);
  assert.deepEqual(tail.extras, ['main']);
});

test('rd_floor on MCP plans and does not claim it ran anything', async () => {
  assert.equal(TOOLS.some((tool) => tool.name === 'rd_floor' && tool.annotations.readOnlyHint === true), true);
  const planned = JSON.parse((await callTool('rd_floor', { action: 'plan', module: 'network-runtime', command: 'inspect-pcap-capture', target: '/tmp/a.pcap' })).content[0].text);
  assert.equal(planned.code, 'quarantine');
  const mapped = await callTool('rd_floor', { action: 'map' });
  assert.match(mapped.content[0].text, /Binary & Low-Level/);
  assert.equal(mapped.isError, undefined);
});

test('kingmaker rd is on the console help, and the operator doc matches the pin', () => {
  const cli = readFileSync(fileURLToPath(new URL('../lib/cli.mjs', import.meta.url)), 'utf8');
  assert.match(cli, /case 'rd':/);
  const help = spawnSync(process.execPath, [fileURLToPath(new URL('../lib/cli.mjs', import.meta.url)), 'help'], {
    encoding: 'utf8',
    env: { ...process.env, KINGMAKER_ADDONS: 'off' },
  });
  assert.match(help.stdout, /kingmaker rd/);
  const doc = readFileSync(fileURLToPath(new URL('../docs/RD-FLOOR.md', import.meta.url)), 'utf8');
  for (const name of ['Analysis Core', 'Mobile & Apps', 'Binary & Low-Level', 'Network & Runtime', 'Rebuild & Verify']) assert.match(doc, new RegExp(name.replace('&', '&')));
  assert.match(doc, new RegExp(REA_PIN.commit));
  assert.match(doc, /openpgp@6\.3\.2/);
  assert.match(doc, /kingmaker rd run/);
  assert.match(doc, /AGPL/);
  assert.match(doc, /does not deploy/);
});
