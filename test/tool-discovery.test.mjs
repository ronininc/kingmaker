// Tool discovery → selection → sourced draft → safe validation → store → plain-language use with live output → reuse;
// plus decline/skip, approval refusal, unverified draft, secret redaction and rescan behavior. Isolated profiles only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adoptTool, scanPath, capabilitiesFromHelp } from '../lib/tool-discovery.mjs';
import { createToolRunner, redact } from '../lib/tool-runner.mjs';
import { createLocalBrain, handleMethodRequest } from '../lib/method-request.mjs';

function fixtureTool(dir, name, { version = '2.1.0', fail = false } = {}) {
  const marker = join(dir, `${name}.ran`);
  writeFileSync(join(dir, name), `#!/bin/sh\necho "$@" >> "${marker}"\n${fail ? 'exit 3\n' : ''}case "$1" in\n  --version) echo "${name} ${version}";;\n  --help) printf 'usage: ${name} [options] FILE\\n${name} - counts widgets in a file\\n  --count FILE    count widgets\\n  --verbose       more output\\n';;\n  --count) echo "widgets: 3"; echo "token=ghp_ABCDEFGHIJKLMNOPQRSTUVWX123456" ;;\n  *) echo "unknown" >&2; exit 2;;\nesac\n`);
  chmodSync(join(dir, name), 0o755);
  return marker;
}
const profile = () => mkdtempSync(join(tmpdir(), 'km-tools-'));

test('scan lists installed tools on PATH and executes none of them', () => {
  const bin = profile(); const marker = fixtureTool(bin, 'widgetctl');
  try {
    const found = scanPath({ pathEnv: bin });
    assert.deepEqual(found.map((t) => [t.name, t.evidence]), [['widgetctl', 'installed (on PATH)']]);
    assert.equal(existsSync(marker), false, 'discovery ran nothing');
  } finally { rmSync(bin, { recursive: true, force: true }); }
});

test('adopt: read-only probe → sourced draft → validated version check → stored in the user library; rescan reuses; a changed binary keeps the prior version; a user edit is never overwritten', async () => {
  const bin = profile(); const state = profile(); const marker = fixtureTool(bin, 'widgetctl');
  try {
    const a = await adoptTool({ name: 'widgetctl', path: join(bin, 'widgetctl'), state });
    assert.equal(a.methodStatus, 'tested'); assert.equal(a.validation.status, 'completed');
    assert.deepEqual(readFileSync(marker, 'utf8').trim().split('\n'), ['--version', '--help', '--version'], 'only read-only probes + the validation version check ran');
    const md = readFileSync(a.path, 'utf8');
    for (const section of ['## Identity', '## Sources', '[official-local] widgetctl --version', '[expert-or-web] not consulted', '## Capabilities', '`--count FILE` — count widgets', '## Permissions, risks, approval boundaries', '## Validation', 'task workflow: unverified']) assert(md.includes(section), section);
    const reg = JSON.parse(readFileSync(join(state, 'abilities', 'tools.json'), 'utf8'));
    assert.equal(reg.tools.widgetctl.usage, 'not confirmed', 'installed/selected is not usage');
    assert.equal((await adoptTool({ name: 'widgetctl', path: join(bin, 'widgetctl'), state })).status, 'unchanged');
    fixtureTool(bin, 'widgetctl', { version: '2.2.0' });
    const b = await adoptTool({ name: 'widgetctl', path: join(bin, 'widgetctl'), state });
    assert.equal(b.status, 'updated (prior version kept)'); assert(existsSync(join(state, 'abilities', 'methods', 'tool-widgetctl.v2.1.0.method.md')));
    writeFileSync(a.path, `${readFileSync(a.path, 'utf8')}\n<!-- my own notes -->\n`);
    fixtureTool(bin, 'widgetctl', { version: '2.3.0' });
    const c = await adoptTool({ name: 'widgetctl', path: join(bin, 'widgetctl'), state });
    assert.match(c.status, /proposed/); assert.match(readFileSync(a.path, 'utf8'), /my own notes/); assert(existsSync(`${a.path}.proposed`));
  } finally { rmSync(bin, { recursive: true, force: true }); rmSync(state, { recursive: true, force: true }); }
});

test('a tool whose version check fails is stored as an UNVERIFIED draft, not tested', async () => {
  const bin = profile(); const state = profile(); fixtureTool(bin, 'brokentool', { fail: true });
  try {
    const a = await adoptTool({ name: 'brokentool', path: join(bin, 'brokentool'), state });
    assert.equal(a.methodStatus, 'draft'); assert.match(readFileSync(a.path, 'utf8'), /Status: \*\*draft\*\*/);
  } finally { rmSync(bin, { recursive: true, force: true }); rmSync(state, { recursive: true, force: true }); }
});

test('plain-language request → tool method → approval → real execution with ordered live output and exit code → reuse; unapproved run stops clearly; secrets redacted', async () => {
  const bin = profile(); const state = profile(); fixtureTool(bin, 'widgetctl');
  try {
    await adoptTool({ name: 'widgetctl', path: join(bin, 'widgetctl'), state });
    const reasoner = async () => '["--count", "inventory.txt"]';
    const brain = () => createLocalBrain({ state, remote: false, reasoner });
    const work = (n) => { const d = join(state, 'tasks', n); mkdirSync(d, { recursive: true }); return d; };
    const refused = await handleMethodRequest('Kingmaker, use widgetctl to count widgets in inventory.txt', { brain: brain(), workDir: work('a') });
    assert.equal(refused.method.id, 'tool-widgetctl'); assert.notEqual(refused.outcome, 'completed');
    assert.match(refused.lines.join('\n'), /Stopped: run: not run: approval required to run widgetctl --count inventory.txt/);
    const live = []; const approvals = [];
    const ok = await handleMethodRequest('Kingmaker, use widgetctl to count widgets in inventory.txt', { brain: brain(), workDir: work('b'), approve: async (x) => { approvals.push(x.args); return true; }, onOutput: (s, l) => live.push([s, l]) });
    assert.equal(ok.outcome, 'completed', ok.lines.join('\n'));
    assert.deepEqual(approvals, [['--count', 'inventory.txt']], 'exact argv shown for approval');
    assert.deepEqual(live.map(([, l]) => l), ['widgetctl 2.1.0', 'widgets: 3', 'token=[redacted]'], 'live, ordered, redacted');
    assert.equal(ok.toolRuns.at(-1).exitCode, 0);
    assert.match(ok.lines.join('\n'), /\| widgets: 3/); assert.doesNotMatch(JSON.stringify(ok), /ghp_ABCDEF/);
    const again = await handleMethodRequest('use widgetctl to count widgets in inventory.txt', { brain: brain(), workDir: work('c'), approve: async () => true });
    assert.equal(again.outcome, 'completed'); assert.equal(again.method.layer, 'your abilities'); assert.equal(again.network.external, 0);
  } finally { rmSync(bin, { recursive: true, force: true }); rmSync(state, { recursive: true, force: true }); }
});

test('the runner refuses tools the user did not select, and never uses a shell', async () => {
  const run = createToolRunner({ registry: { tools: { echo: { path: '/bin/echo' } } } });
  assert.match((await run({ tool: 'rm', args: ['-rf', '/tmp/x'], readOnly: true, cwd: tmpdir() })).refused, /not one of the tools you selected/);
  const r = await run({ tool: 'echo', args: ['$(whoami)', '; ls'], readOnly: true, cwd: tmpdir() });
  assert.equal(r.stdout.trim(), '$(whoami) ; ls');
  assert.equal(redact('password=hunter2 sk-abcdefghijklmnopqrstuvwxyz'), 'password=[redacted] [redacted]');
});

test('capabilities are parsed from real help text', () => {
  assert.deepEqual(capabilitiesFromHelp('  -n, --null-input    use null as input\n  --tab               use tabs\n'), [{ usage: '-n, --null-input', summary: 'use null as input' }, { usage: '--tab', summary: 'use tabs' }]);
});
