// test/opencode-tool.test.mjs — OpenCode as a Brain Library tool + a conducted capability
// (owner order 2026-11-14: "open code in the brain library as well as a tool").
// OpenCode (MIT, anomalyco/opencode) is the fleet's local coding harness. Three layers:
//   (1) CATALOG — the shipped tools index carries a real `opencode` entry: the vendor's
//       current release (v1.19.5) pinned per platform; staged platforms carry whole-archive
//       + part SHA-256 pins that tile exactly; platforms not yet packaged are
//       declared-not-staged with null pins — nothing faked.
//   (2) METHOD — the shipped methods index conducts `opencode-code-task`: a check-tool
//       step for `opencode` and a declared `opencode run …` step, so a node missing the
//       harness pulls it through tool streaming and the step executes for real (the
//       machinery itself is proven by test/tool-streaming.test.mjs).
//   (3) ACCEPTANCE (payload-gated) — when KINGMAKER_TEST_OPENCODE_PAYLOAD_DIR names a
//       payload store holding the staged parts (the packaging step's output; payloads
//       live in the release store, not the repo), a conduction pulls the REAL entry,
//       materializes the REAL binary, registers it, and executes `opencode --version`.
//       Without the store the layer skips — the same posture as the macOS-only suites.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadToolsIndex, planParts, toolForCommand, toolPlatformKey } from '../lib/brain-library.mjs';
import { readToolRegistry } from '../lib/brain-library-fetch.mjs';
import { createToolStreamingProvider } from '../lib/tool-streaming.mjs';
import { createMethodConductor } from '../lib/method-conductor.mjs';

const PLATFORM = toolPlatformKey();
const SHA256_HEX = /^[0-9a-f]{64}$/;

test('layer 1 — catalog: the shipped tools index carries OpenCode, pinned and honest', () => {
  const tools = loadToolsIndex();
  const oc = toolForCommand(tools, 'opencode');
  assert.ok(oc, 'the shipped catalog carries the opencode tool');
  assert.equal(oc.id, 'opencode');
  assert.equal(oc.license, 'mit', 'OpenCode is MIT (LICENSE read from the v1.19.5 tag)');
  assert.equal(oc.version, '1.19.5', 'pinned to the vendor release verified at staging time');
  assert.deepEqual(oc.provides, ['opencode']);
  for (const key of ['linux-x64', 'linux-arm64', 'macos-arm64', 'windows-x64']) {
    const p = oc.platforms[key];
    assert.ok(p, `${key} is declared`);
    assert.equal(p.payloadStatus, 'staged', `${key} was staged by the packaging step`);
    assert.ok(SHA256_HEX.test(p.sha256), `${key} carries a whole-archive pin`);
    assert.equal(p.parts.length, planParts(p.size).length, `${key}: the declared parts are planParts' tiling`);
    assert.equal(p.parts.reduce((a, x) => a + x.size, 0), p.size, `${key}: parts tile the archive exactly`);
    for (const part of p.parts) assert.ok(SHA256_HEX.test(part.sha256), `${key}: every part is pinned`);
  }
  for (const key of ['macos-x64', 'windows-arm64']) {
    const p = oc.platforms[key];
    assert.ok(p, `${key} is declared`);
    assert.equal(p.payloadStatus, 'declared-not-staged', `${key} is declared, not staged — no payload is faked`);
    assert.equal(p.sha256, null);
    assert.deepEqual(p.parts, []);
  }
  assert.equal(oc.platforms['windows-x64'].bin, 'opencode.exe');
  assert.equal(oc.platforms['linux-x64'].bin, 'opencode');
});

test('layer 2 — method: opencode-code-task is listed and conducts its steps on paper', async () => {
  const conductor = createMethodConductor({ toolProvider: null });
  const list = await conductor.listMethods();
  const m = list.find((x) => x.id === 'opencode-code-task');
  assert.ok(m, 'the shipped methods index carries opencode-code-task');
  assert.equal(m.domain, 'code');
  assert.deepEqual(m.inputKeys, ['task', 'model', 'toolPath']);
  // With tool streaming off and no harness installed, the conduction still completes:
  // the job record is written and verified, the run step stays declared — never faked.
  const workDir = await mkdtemp(join(tmpdir(), 'km-opencode-declared-'));
  const r = await conductor.conduct('opencode-code-task', { workDir });
  assert.equal(r.status, 'completed', `trace: ${JSON.stringify(r.trace, null, 1)}`);
  const job = JSON.parse(await readFile(join(workDir, 'opencode-job.json'), 'utf8'));
  assert.equal(job.schema, 'kingmaker.code-job/1');
  assert.equal(job.state, 'task-written-run-declared');
  const check = r.trace.find((t) => t.id === 'check-opencode');
  assert.ok(check, 'the method checks for the opencode tool first');
  if (check.result.found) {
    assert.equal(r.declared.length, 0, 'opencode is on this node: the run executed instead of declaring');
  } else {
    assert.deepEqual(r.declared.map((d) => d.step), ['run-opencode'], 'no harness, no pull: the run stays declared');
  }
});

const PAYLOAD_DIR = process.env.KINGMAKER_TEST_OPENCODE_PAYLOAD_DIR;
test('layer 3 — ACCEPTANCE: conduction pulls the real OpenCode payload and executes it', { skip: PAYLOAD_DIR && process.platform !== 'win32' ? false : 'no payload store (set KINGMAKER_TEST_OPENCODE_PAYLOAD_DIR) or windows host' }, async () => {
  const notOnPath = (() => { try { execFileSync('sh', ['-c', 'command -v opencode'], { stdio: 'pipe' }); return false; } catch { return true; } })();
  assert.ok(notOnPath, 'precondition: opencode is NOT on PATH');
  const tools = loadToolsIndex();
  const oc = toolForCommand(tools, 'opencode');
  const root = await mkdtemp(join(tmpdir(), 'km-opencode-accept-'));
  const stateDir = join(root, 'state');
  const provider = createToolStreamingProvider({ stateDir, toolPayloadDir: PAYLOAD_DIR, toolsIndex: tools });
  // A fixture method in the acceptance suite's shape, driving the REAL catalog entry.
  const libDir = join(root, 'lib');
  const catalogDir = join(libDir, 'catalog');
  await mkdir(catalogDir, { recursive: true });
  const spec = {
    id: 'opencode-version-job', version: '1.0', inputs: {},
    steps: [
      { n: 1, id: 'check-opencode', type: 'check-tool', command: 'opencode', into: 'toolCheck' },
      { n: 2, id: 'run-version', type: 'declare', into: 'runResult', action: 'opencode --version', reason: 'OpenCode is not installed on this node.' },
      { n: 3, id: 'verify-version', type: 'verify', assertions: [{ var: 'runResult', field: 'exitCode', equals: 0 }] },
    ],
  };
  await writeFile(join(catalogDir, 'index.json'), JSON.stringify({ schema: 'kingmaker.methods/1', methods: [{ id: spec.id, title: spec.id, file: 'm.method.md', quality: { tier: 'vetted', score: 80 } }] }));
  await writeFile(join(catalogDir, 'm.method.md'), `# M\n\n\`\`\`kingmaker-method\n${JSON.stringify(spec)}\n\`\`\`\n`);
  const workDir = join(root, 'work');
  await mkdir(workDir, { recursive: true });
  const r = await createMethodConductor({ indexUrl: new URL(`file://${join(catalogDir, 'index.json')}`), toolProvider: provider }).conduct('opencode-version-job', { workDir });
  assert.equal(r.status, 'completed', `trace: ${JSON.stringify(r.trace, null, 1)}`);
  const check = r.trace.find((t) => t.id === 'check-opencode');
  assert.equal(check.result.found, true);
  assert.equal(check.result.via, 'library', 'the harness came from the Brain Library, not PATH');
  assert.equal(check.result.pull.tool, 'opencode');
  assert.deepEqual(r.declared, [], 'nothing stayed declared: the pulled harness executed its step');
  const exec = r.trace.find((t) => t.id === 'run-version');
  assert.equal(exec.status, 'executed');
  assert.equal(exec.result.executedVia, 'library-tool');
  assert.equal(exec.result.exitCode, 0);
  assert.ok(exec.result.stdout.includes('1.19.5'), 'the materialized binary really ran and printed its version');
  const toolsDir = join(stateDir, 'brain-library', 'tools');
  const record = readToolRegistry(toolsDir)[`opencode@${PLATFORM}`];
  assert.ok(record, 'the tool is in the persistent registry');
  assert.equal(record.archiveSha256, oc.platforms[PLATFORM].sha256, 'the registry carries the catalog pin');
  assert.ok(statSync(record.binPath).mode & 0o111, 'the materialized binary is executable');
});
