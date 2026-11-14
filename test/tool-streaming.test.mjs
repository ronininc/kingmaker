// test/tool-streaming.test.mjs — tool streaming (2026-11-11): tools as Brain Library items.
// The gap this closes (engine-streaming investigation, 2026-11-11): model weights streamed,
// tools did not exist as a library item type at all — a method step whose tool was missing
// on the node could only be DECLARED (skipped), never pulled. The three layers proven here:
//   (1) CATALOG — lib/brain-library.mjs carries a `tools` item type (kingmaker.tools/1):
//       a tool declares, per platform, a release archive split into hashed parts planned
//       by planParts, the whole archive SHA-256-pinned. The shipped catalog's one real
//       entry (Blender, GPL-3.0) is declared-not-staged: its pull refuses, fail closed,
//       until the packaging step stages real parts — nothing about Blender is faked here.
//   (2) PULL/MATERIALIZE — buildCatalogSources serves a STAGED tool platform as a
//       kind:'tool' source over its part files; the access layer pulls it segment by
//       segment and accepts it only against the catalog hash; lib/brain-library-fetch.mjs
//       materializes it as an unpacked binary tree (extensions-grade unpack safety).
//   (3) REGISTRATION + TRIGGER — the materialized tool lands in the persistent tool
//       registry with an mcp-shaped descriptor and, when injected, the REA/MCP-hub
//       addConnector dep the extensions use; and the method conductor's check-tool →
//       declare branch changes: a missing tool the catalog carries is PULLED on the
//       check, and the declared step then EXECUTES against the materialized binary.
// The acceptance run is end to end on the real code: a fixture tool (a real executable
// shell script, packaged as a catalog item in two hashed parts) is NOT on PATH; the
// conductor must pull it from the library source, materialize it, register it, pass
// check-tool via the library, execute the step, and the produced artifact must verify.
// Tools NOT in the catalog — and Blender while unstaged — keep the declared behavior.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadToolsIndex, normalizeToolsIndex, planParts, toolForCommand, toolPlatformKey } from '../lib/brain-library.mjs';
import { buildCatalogSources, createBrainLibraryAccess } from '../lib/brain-library-access.mjs';
import { materializeTool, readToolRegistry } from '../lib/brain-library-fetch.mjs';
import { createToolStreamingProvider } from '../lib/tool-streaming.mjs';
import { createMethodConductor } from '../lib/method-conductor.mjs';
import { cmdToolsLibrary } from '../lib/bench-cli.mjs';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const PLATFORM = toolPlatformKey();

// ── a minimal stored-zip writer (the fixture tool's packaging) ──
const CRC_TABLE = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function zipStore(entries) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8'), data = e.data, crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    locals.push(local, name, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0, 8); central.writeUInt16LE(0, 10);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt32LE((0o100755 << 16) >>> 0, 38); central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const FIXTURE_SCRIPT = [
  '#!/bin/sh',
  '# fixture-render — the tool-streaming acceptance fixture: a real executable the',
  '# catalog carries as a tool item, so a method can pull it and run it.',
  'if [ "$1" = "--version" ]; then',
  '  echo "fixture-render 1.2.3"',
  '  if [ -n "$2" ]; then printf \'fixture-render 1.2.3\\n\' > "$2"; fi',
  '  exit 0',
  'fi',
  'echo "fixture-render: unknown arguments" >&2',
  'exit 2',
  '',
].join('\n');

/** Package the fixture tool as a staged catalog item: zip → planParts → hashed parts on disk. */
async function fixtureTool() {
  const root = await mkdtemp(join(tmpdir(), 'km-tools-fixture-'));
  const archive = zipStore([{ name: 'fixture-render', data: Buffer.from(FIXTURE_SCRIPT, 'utf8') }]);
  const plan = planParts(archive.length, Math.ceil(archive.length / 2));
  assert.equal(plan.length, 2, 'the fixture archive is carried in two parts');
  const payloadDir = join(root, 'payloads');
  const partDir = join(payloadDir, 'fixture-render', PLATFORM);
  await mkdir(partDir, { recursive: true });
  const parts = [];
  for (const p of plan) {
    const bytes = archive.subarray(p.start, p.start + p.size);
    const name = `fixture-render-1.2.3-${PLATFORM}.zip.part${String(p.index + 1).padStart(2, '0')}`;
    await writeFile(join(partDir, name), bytes);
    parts.push({ name, size: p.size, sha256: sha256(bytes) });
  }
  const tool = {
    id: 'fixture-render', name: 'Fixture Render', version: '1.2.3', license: 'mit',
    homepage: null, provides: ['fixture-render'], note: 'acceptance fixture',
    quality: { tier: 'vetted', score: 80, basis: 'test fixture for the tool-streaming acceptance run' },
    platforms: {
      [PLATFORM]: {
        release: `fixture-render-1.2.3-${PLATFORM}`, archive: `fixture-render-1.2.3-${PLATFORM}.zip`, format: 'zip',
        bin: 'fixture-render', payloadStatus: 'staged', size: archive.length, sha256: sha256(archive), parts,
      },
    },
  };
  return { root, payloadDir, tool, archiveSha: sha256(archive) };
}

/** A one-method library in a temp catalog (the conductor test's mkLib pattern). */
async function fixtureMethodLib(spec) {
  const libDir = await mkdtemp(join(tmpdir(), 'km-tools-method-'));
  const catalogDir = join(libDir, 'catalog');
  await mkdir(catalogDir, { recursive: true });
  await writeFile(join(catalogDir, 'index.json'), JSON.stringify({ schema: 'kingmaker.methods/1', methods: [{ id: spec.id, title: spec.id, file: 'm.method.md', quality: { tier: 'vetted', score: 80 } }] }));
  await writeFile(join(catalogDir, 'm.method.md'), `# M\n\n\`\`\`kingmaker-method\n${JSON.stringify(spec)}\n\`\`\`\n`);
  return new URL(`file://${join(catalogDir, 'index.json')}`);
}

const notOnPath = (command) => {
  try { execFileSync('sh', ['-c', `command -v ${command}`], { stdio: 'pipe' }); return false; } catch { return true; }
};

test('layer 1 — catalog: the tools schema validates staged and declared payloads, and refuses malformed ones', () => {
  const shipped = loadToolsIndex();
  const blender = toolForCommand(shipped, 'blender');
  assert.ok(blender, 'the shipped catalog carries the Blender entry');
  assert.equal(blender.license, 'gpl-3.0');
  for (const p of Object.values(blender.platforms)) {
    assert.equal(p.payloadStatus, 'declared-not-staged', 'Blender is declared, not staged — no payload is faked');
    assert.equal(p.sha256, null); assert.deepEqual(p.parts, []);
  }
  assert.equal(toolForCommand(shipped, 'openscad'), null, 'tools the catalog lacks stay absent');
  const badSum = { schema: 'kingmaker.tools/1', tools: [{ id: 'x', version: '1', license: 'mit', provides: ['x'], quality: { tier: 'vetted', score: 1 }, platforms: { [PLATFORM]: { release: 'r', archive: 'a', format: 'zip', bin: 'x', payloadStatus: 'staged', size: 10, sha256: 'a'.repeat(64), parts: [{ name: 'p1', size: 9, sha256: 'b'.repeat(64) }] } } }] };
  assert.throws(() => normalizeToolsIndex(badSum), /parts sum/, 'staged parts must tile the archive exactly');
  const noHash = { schema: 'kingmaker.tools/1', tools: [{ id: 'x', version: '1', license: 'mit', provides: ['x'], quality: { tier: 'vetted', score: 1 }, platforms: { [PLATFORM]: { release: 'r', archive: 'a', format: 'zip', bin: 'x', payloadStatus: 'staged', size: 9, sha256: null, parts: [{ name: 'p1', size: 9, sha256: 'b'.repeat(64) }] } } }] };
  assert.throws(() => normalizeToolsIndex(noHash), /sha256/, 'a staged payload without the whole-archive pin is refused');
});

test('layer 2 — sources: a staged tool platform is a kind:tool source over its parts; unstaged and unstored are absent', async () => {
  const { payloadDir, tool, archiveSha } = await fixtureTool();
  const sources = await buildCatalogSources({ toolPayloadDir: payloadDir, toolsIndex: [tool] });
  const src = sources.get(`tool:fixture-render@${PLATFORM}`);
  assert.ok(src, 'the staged fixture tool is served');
  assert.equal(src.kind, 'tool');
  assert.equal(src.sha256, archiveSha, 'the source pins the catalog whole-archive hash');
  const whole = await src.readRange(0, src.size);
  assert.equal(sha256(whole), archiveSha, 'range reads over the parts reassemble the archive');
  const noStore = await buildCatalogSources({ toolsIndex: [tool] });
  assert.ok(![...noStore.keys()].some((k) => k.startsWith('tool:')), 'no payload store → no tool sources');
  const blenderOnly = await buildCatalogSources({ toolPayloadDir: payloadDir, toolsIndex: loadToolsIndex() });
  assert.ok(![...blenderOnly.keys()].some((k) => k.startsWith('tool:')), 'declared-not-staged Blender gets NO source — nothing pullable exists');
  // Materializing an unstaged tool refuses, fail closed, before any byte moves.
  const dummyAccess = { download: async () => { throw new Error('must not be called'); } };
  await assert.rejects(() => materializeTool(dummyAccess, loadToolsIndex()[0], { toolsDir: '/tmp/never' }), /declared-not-staged/);
});

test('layers 2+3 — ACCEPTANCE: a method pulls its missing tool from the library, registers it, and EXECUTES the step', async () => {
  assert.ok(notOnPath('fixture-render'), 'precondition: fixture-render is NOT on PATH');
  const { root, payloadDir, tool, archiveSha } = await fixtureTool();
  const stateDir = join(root, 'state');
  const connectorSpecs = [];
  const provider = createToolStreamingProvider({
    stateDir, toolPayloadDir: payloadDir, toolsIndex: [tool],
    addConnector: async (spec) => { connectorSpecs.push(spec); return { ok: true }; },
  });
  const indexUrl = await fixtureMethodLib({
    id: 'fixture-render-job', version: '1.0', inputs: {},
    steps: [
      { n: 1, id: 'check-renderer', type: 'check-tool', command: 'fixture-render', into: 'toolCheck' },
      { n: 2, id: 'render-version', type: 'declare', action: 'fixture-render --version version.txt', reason: 'No fixture renderer is installed on this node, so the render cannot run here.' },
      { n: 3, id: 'verify-version', type: 'verify', assertions: [{ file: 'version.txt', contains: 'fixture-render 1.2.3' }] },
    ],
  });
  const workDir = join(root, 'work');
  await mkdir(workDir, { recursive: true });
  const r = await createMethodConductor({ indexUrl, toolProvider: provider }).conduct('fixture-render-job', { workDir });
  assert.equal(r.status, 'completed', `trace: ${JSON.stringify(r.trace, null, 1)}`);
  // The check passed THROUGH the library: pulled, materialized, re-checked.
  const check = r.trace.find((t) => t.id === 'check-renderer');
  assert.equal(check.result.found, true);
  assert.equal(check.result.via, 'library');
  assert.equal(check.result.pull.tool, 'fixture-render');
  assert.match(check.detail, /streamed from the Brain Library/);
  // The step EXECUTED — it is not in declared[], its trace entry ran, exit 0, real stdout.
  assert.deepEqual(r.declared, [], 'nothing stayed declared: the pulled tool executed its step');
  const exec = r.trace.find((t) => t.id === 'render-version');
  assert.equal(exec.status, 'executed');
  assert.equal(exec.result.executedVia, 'library-tool');
  assert.equal(exec.result.exitCode, 0);
  assert.ok(exec.result.stdout.includes('fixture-render 1.2.3'), 'the materialized binary really ran and printed its version');
  // The artifact the tool produced verifies (step 3 already asserted it in-conduction).
  assert.equal((await readFile(join(workDir, 'version.txt'), 'utf8')).trim(), 'fixture-render 1.2.3');
  // Registration: the MCP-hub dep got the extensions-shaped spec, and the persistent
  // registry + materialization receipt carry the catalog hash.
  assert.equal(connectorSpecs.length, 1);
  assert.equal(connectorSpecs[0].kind, 'mcp');
  assert.equal(connectorSpecs[0].name, 'fixture-render');
  assert.equal(connectorSpecs[0].extension, 'fixture-render');
  assert.ok(connectorSpecs[0].command.endsWith('fixture-render'));
  const toolsDir = join(stateDir, 'brain-library', 'tools');
  const registry = readToolRegistry(toolsDir);
  const record = registry[`fixture-render@${PLATFORM}`];
  assert.ok(record, 'the tool is in the persistent registry');
  assert.equal(record.archiveSha256, archiveSha);
  assert.equal(record.connector.ok, true);
  const receipt = JSON.parse(await readFile(join(toolsDir, 'fixture-render', '1.2.3', PLATFORM, 'materialized.json'), 'utf8'));
  assert.equal(receipt.archiveSha256, archiveSha);
  assert.ok(statSync(record.binPath).mode & 0o111, 'the materialized binary is executable');
  // The pull went through the access layer's resident store, hash-accepted.
  const storeFiles = await readdir(join(stateDir, 'brain-library', 'store'));
  assert.ok(storeFiles.some((f) => f.endsWith('.resident')), 'the archive sits in the access-layer resident store');
});

test('layer 3 — negative: tools NOT in the catalog, and Blender while unstaged, keep the declared behavior exactly', async () => {
  const { root, payloadDir, tool } = await fixtureTool();
  const stateDir = join(root, 'state');
  const provider = createToolStreamingProvider({ stateDir, toolPayloadDir: payloadDir, toolsIndex: [tool, ...loadToolsIndex()] });
  const indexUrl = await fixtureMethodLib({
    id: 'missing-tools-job', version: '1.0', inputs: {},
    steps: [
      { n: 1, id: 'check-absent', type: 'check-tool', command: 'no-such-tool-xyz' },
      { n: 2, id: 'declare-absent', type: 'declare', action: 'no-such-tool-xyz --run job', reason: 'the tool is not on this node' },
      { n: 3, id: 'check-blender', type: 'check-tool', command: 'blender' },
      { n: 4, id: 'declare-blender', type: 'declare', action: 'blender --background --render', reason: 'Blender is not installed on this node' },
    ],
  });
  const workDir = join(root, 'work');
  await mkdir(workDir, { recursive: true });
  const r = await createMethodConductor({ indexUrl, toolProvider: provider }).conduct('missing-tools-job', { workDir });
  assert.equal(r.status, 'completed', `trace: ${JSON.stringify(r.trace, null, 1)}`);
  assert.deepEqual(r.declared.map((d) => d.step), ['declare-absent', 'declare-blender'], 'both steps stayed declared — nothing executed, nothing faked');
  const absent = r.trace.find((t) => t.id === 'check-absent');
  assert.equal(absent.result.found, false);
  assert.ok(!('pull' in absent.result), 'a tool the catalog lacks never reaches the pull path');
  const blenderCheck = r.trace.find((t) => t.id === 'check-blender');
  assert.equal(blenderCheck.result.found, false);
  assert.equal(blenderCheck.result.pull.staged, false, 'Blender is in the catalog but unstaged: recorded honestly in the trace');
  assert.match(blenderCheck.detail, /declared-not-staged/);
});

test('layer 3 — the production wiring: a no-arg conductor (the execution loop path) is unchanged on the shipped catalog', async () => {
  // lib/execution-loop.mjs creates its conductor with no args — the default provider.
  // On the shipped catalog no method's tool is streamable, so conduction must behave
  // exactly as before tool streaming: the OpenCAD export stays declared.
  const workDir = await mkdtemp(join(tmpdir(), 'km-tools-prod-'));
  const r = await createMethodConductor().conduct('opencad-part-spec', { workDir });
  assert.equal(r.status, 'completed', `trace: ${JSON.stringify(r.trace, null, 1)}`);
  assert.deepEqual(r.declared.map((d) => d.step), ['declare-export-stl']);
  const check = r.trace.find((t) => t.id === 'check-openscad');
  assert.ok(!('pull' in check.result) || check.result.pull === null, 'openscad is not a catalog tool: no pull attempted');
});

test('layer 2 — the CLI entry: tools library list works; pulling unstaged Blender refuses with the reason', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'km-tools-cli-'));
  assert.equal(await cmdToolsLibrary({ state: stateDir }, ['list']), 0);
  assert.equal(await cmdToolsLibrary({ state: stateDir }, ['pull', 'blender']), 1, 'unstaged Blender refuses at the CLI too — the packaging step is what remains');
  assert.equal(await cmdToolsLibrary({ state: stateDir }, ['pull', 'no-such-tool']), 1);
});
