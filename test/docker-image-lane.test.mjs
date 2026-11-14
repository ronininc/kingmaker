// test/docker-image-lane.test.mjs — the docker-image-tar format lane (2026-11-13).
// Tools shipped as Docker images (a `docker save` archive; the catalog `bin` names the
// image) are the Brain Library's second tool format, beside the library zip. Proven here:
//   (1) CATALOG — normalizeToolsIndex accepts a well-formed docker-image-tar platform
//       (the shipped catalog's kali-bench entry is the real one: staged, 7 parts) and
//       refuses malformed ones with the same fail-closed discipline as zip; zip entries
//       normalize exactly as before.
//   (2) ACCESS — a staged docker-image platform surfaces as a kind:'tool' source over
//       its part files, identical to zip; an incomplete part store serves nothing.
//   (3) MATERIALIZE — against a FAKE docker CLI on PATH (a shell script that logs its
//       argv and keeps image presence in a flag file): adoption of an already-local
//       image pulls nothing and loads nothing; a corrupt part refuses BEFORE any
//       docker load (hash verification gates the load — the only pre-verification
//       docker call is the read-only adoption inspect); good parts load only after
//       the hashes pass, presence is re-inspected, and the registry record is honest
//       (image + docker-run execution shape, binPath null — no fabricated path).
//       No docker CLI at all refuses, naming docker as the missing prerequisite.
//   (4) CONDUCTOR — a method whose tool is an image tool: the check pulls + registers
//       the image and records it in the trace, the command stays not-on-PATH, and a
//       declare step for it stays declared (the conductor executes filesystem bins,
//       not images — wiring docker-run execution is a separate, later step).
// This VM has no real docker CLI (`which docker` is empty), so the fake carries the
// logic proof; a real `docker load` of the bench archive is a named seat/host step.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import { loadToolsIndex, normalizeToolsIndex, planParts, toolPlatformKey } from '../lib/brain-library.mjs';
import { buildCatalogSources, createBrainLibraryAccess } from '../lib/brain-library-access.mjs';
import { materializeTool, readToolRegistry } from '../lib/brain-library-fetch.mjs';
import { createToolStreamingProvider } from '../lib/tool-streaming.mjs';
import { createMethodConductor } from '../lib/method-conductor.mjs';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const PLATFORM = toolPlatformKey();
const IMAGE = 'fixture-image:latest';

/** A pure catalog-object fixture (no disk): a well-formed staged docker-image platform. */
const dockerToolObject = () => ({
  id: 'fixture-image', name: 'Fixture Image', version: '2.0.0', license: 'mit', homepage: null,
  provides: ['fixture-image-cmd'], note: 'docker-image-lane fixture',
  quality: { tier: 'vetted', score: 80, basis: 'test fixture' },
  platforms: {
    [PLATFORM]: {
      release: 'fixture-image-2.0.0', archive: 'fixture-image.tar.gz', format: 'docker-image-tar',
      bin: IMAGE, payloadStatus: 'staged', size: 10, sha256: 'a'.repeat(64),
      parts: [{ name: 'p1', size: 10, sha256: 'b'.repeat(64) }],
    },
  },
});

/** The same tool, packaged for real: archive bytes → planParts → hashed parts on disk. */
async function fixtureImageTool({ corrupt = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'km-docker-fixture-'));
  const archive = Buffer.from('fixture docker save archive — not a real tar; the fake docker never parses it\n'.repeat(8));
  const plan = planParts(archive.length, Math.ceil(archive.length / 2));
  assert.equal(plan.length, 2, 'the fixture archive is carried in two parts');
  const payloadDir = join(root, 'payloads');
  const partDir = join(payloadDir, 'fixture-image', PLATFORM);
  await mkdir(partDir, { recursive: true });
  const parts = [];
  for (const p of plan) {
    const good = archive.subarray(p.start, p.start + p.size);
    let bytes = good;
    if (corrupt && p.index === 0) { bytes = Buffer.from(good); bytes[0] ^= 0xff; } // same size, wrong bytes
    const name = `fixture-image-2.0.0-${PLATFORM}.tar.gz.part${String(p.index + 1).padStart(2, '0')}`;
    await writeFile(join(partDir, name), bytes);
    parts.push({ name, size: p.size, sha256: sha256(good) }); // the catalog pins are the GOOD hashes
  }
  const tool = { ...dockerToolObject(), platforms: { [PLATFORM]: { release: 'fixture-image-2.0.0', archive: `fixture-image-2.0.0-${PLATFORM}.tar.gz`, format: 'docker-image-tar', bin: IMAGE, payloadStatus: 'staged', size: archive.length, sha256: sha256(archive), parts } } };
  return { root, payloadDir, tool, archiveSha: sha256(archive) };
}

async function fixtureAccess(root, payloadDir, tool) {
  const sources = await buildCatalogSources({ toolPayloadDir: payloadDir, toolsIndex: [tool] });
  return createBrainLibraryAccess({ sources, storeDir: join(root, 'store'), cacheDir: join(root, 'cache'), stateDir: join(root, 'state') });
}

const FAKE_DOCKER_SCRIPT = [
  '#!/bin/sh',
  '# fake docker — docker-image-lane tests: logs argv, keeps image presence in a flag file.',
  'echo "$@" >> "$FAKE_DOCKER_LOG"',
  'if [ "$1" = "image" ]; then',
  '  if [ -f "$FAKE_DOCKER_FLAG" ]; then echo "[{\\"Id\\":\\"sha256:fake\\"}]"; exit 0; fi',
  '  echo "Error: No such image: $3" >&2; exit 1',
  'fi',
  'if [ "$1" = "load" ]; then',
  '  cat > /dev/null',
  '  if [ "$FAKE_DOCKER_LOAD_FAIL" = "1" ]; then echo "fake docker: load failed" >&2; exit 1; fi',
  '  if [ "$FAKE_DOCKER_LOAD_NOWRITE" != "1" ]; then : > "$FAKE_DOCKER_FLAG"; fi',
  '  echo "Loaded image: fixture-image:latest"; exit 0',
  'fi',
  'exit 0',
  '',
].join('\n');

/** Put the fake docker on PATH. Returns { log, restore } — restore always called (finally). */
async function installFakeDocker({ present = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'km-fake-docker-'));
  const log = join(dir, 'argv.log');
  const flag = join(dir, 'image-present');
  await writeFile(join(dir, 'docker'), FAKE_DOCKER_SCRIPT);
  await chmod(join(dir, 'docker'), 0o755);
  if (present) await writeFile(flag, '');
  const old = { PATH: process.env.PATH, LOG: process.env.FAKE_DOCKER_LOG, FLAG: process.env.FAKE_DOCKER_FLAG };
  process.env.PATH = `${dir}${delimiter}${old.PATH ?? ''}`;
  process.env.FAKE_DOCKER_LOG = log;
  process.env.FAKE_DOCKER_FLAG = flag;
  const restore = () => {
    process.env.PATH = old.PATH;
    if (old.LOG === undefined) delete process.env.FAKE_DOCKER_LOG; else process.env.FAKE_DOCKER_LOG = old.LOG;
    if (old.FLAG === undefined) delete process.env.FAKE_DOCKER_FLAG; else process.env.FAKE_DOCKER_FLAG = old.FLAG;
  };
  return { log, restore };
}

/** A one-method library in a temp catalog (the tool-streaming suite's mkLib pattern). */
async function fixtureMethodLib(spec) {
  const libDir = await mkdtemp(join(tmpdir(), 'km-docker-method-'));
  const catalogDir = join(libDir, 'catalog');
  await mkdir(catalogDir, { recursive: true });
  await writeFile(join(catalogDir, 'index.json'), JSON.stringify({ schema: 'kingmaker.methods/1', methods: [{ id: spec.id, title: spec.id, file: 'm.method.md', quality: { tier: 'vetted', score: 80 } }] }));
  await writeFile(join(catalogDir, 'm.method.md'), `# M\n\n\`\`\`kingmaker-method\n${JSON.stringify(spec)}\n\`\`\`\n`);
  return new URL(`file://${join(catalogDir, 'index.json')}`);
}

test('normalize — a well-formed docker-image-tar platform validates; the shipped catalog carries the bench staged; zip is untouched', () => {
  const [t] = normalizeToolsIndex({ schema: 'kingmaker.tools/1', tools: [dockerToolObject()] });
  assert.equal(t.platforms[PLATFORM].format, 'docker-image-tar');
  assert.equal(t.platforms[PLATFORM].bin, IMAGE);
  assert.equal(t.platforms[PLATFORM].payloadStatus, 'staged');
  const shipped = loadToolsIndex();
  const bench = shipped.find((x) => x.id === 'kali-bench');
  assert.ok(bench, 'the shipped catalog carries the Kali bench entry');
  assert.equal(bench.platforms['linux-arm64'].format, 'docker-image-tar');
  assert.equal(bench.platforms['linux-arm64'].payloadStatus, 'staged');
  assert.equal(bench.platforms['linux-arm64'].bin, 'ronin-kali-bench:latest');
  assert.equal(bench.platforms['linux-arm64'].parts.length, 7);
  const blender = shipped.find((x) => x.id === 'blender');
  for (const p of Object.values(blender.platforms)) assert.equal(p.format, 'zip', 'zip entries normalize exactly as before');
});

test('normalize — malformed docker-image-tar entries are refused with clear errors', () => {
  const base = dockerToolObject();
  const good = base.platforms[PLATFORM];
  const wrap = (p) => ({ schema: 'kingmaker.tools/1', tools: [{ ...base, platforms: { [PLATFORM]: p } }] });
  assert.throws(() => normalizeToolsIndex(wrap({ ...good, bin: undefined })), /needs release, archive and bin/, 'a missing bin (the image name) is refused');
  assert.throws(() => normalizeToolsIndex(wrap({ ...good, sha256: 'not-a-hash' })), /sha256/, 'a staged platform without a real whole-archive pin is refused');
  assert.throws(() => normalizeToolsIndex(wrap({ ...good, format: 'tar' })), /format must be "zip" or "docker-image-tar"/, 'unknown formats still refuse');
  assert.throws(() => normalizeToolsIndex(wrap({ ...good, bin: '/opt/fixture' })), /must name a docker image/, 'a filesystem path as bin is refused');
  assert.throws(() => normalizeToolsIndex(wrap({ ...good, bin: './fixture' })), /must name a docker image/, 'a relative path as bin is refused');
  assert.throws(() => normalizeToolsIndex(wrap({ ...good, parts: [{ name: 'p1', size: 9, sha256: 'b'.repeat(64) }] })), /parts sum/, 'parts must tile the archive exactly, same as zip');
  const [declared] = normalizeToolsIndex(wrap({ release: 'r', archive: 'a.tar.gz', format: 'docker-image-tar', bin: IMAGE, payloadStatus: 'declared-not-staged' }));
  assert.equal(declared.platforms[PLATFORM].format, 'docker-image-tar');
  assert.equal(declared.platforms[PLATFORM].sha256, null);
  assert.deepEqual(declared.platforms[PLATFORM].parts, []);
});

test('access — a staged docker-image platform is a kind:tool source over its parts; an incomplete store serves nothing', async () => {
  const { payloadDir, tool, archiveSha } = await fixtureImageTool();
  const sources = await buildCatalogSources({ toolPayloadDir: payloadDir, toolsIndex: [tool] });
  const src = sources.get(`tool:fixture-image@${PLATFORM}`);
  assert.ok(src, 'the staged docker-image platform is served, exactly like a zip platform');
  assert.equal(src.kind, 'tool');
  assert.equal(src.sha256, archiveSha, 'the source pins the catalog whole-archive hash');
  const emptyDir = await mkdtemp(join(tmpdir(), 'km-docker-nostore-'));
  const noStore = await buildCatalogSources({ toolPayloadDir: emptyDir, toolsIndex: [tool] });
  assert.ok(![...noStore.keys()].some((k) => k.startsWith('tool:')), 'missing part files → no source, never a partial tool');
});

test('materialize — a corrupt part refuses BEFORE any docker load: hash verification gates the load', async () => {
  const fake = await installFakeDocker();
  try {
    const { root, payloadDir, tool } = await fixtureImageTool({ corrupt: true });
    const access = await fixtureAccess(root, payloadDir, tool);
    const toolsDir = join(root, 'tools');
    await assert.rejects(() => materializeTool(access, tool, { toolsDir }), /hash mismatch/, 'the assembled archive fails the catalog hash');
    const log = readFileSync(fake.log, 'utf8');
    assert.ok(!/^load$/m.test(log), `docker load must never run on unverified bytes; docker log was:\n${log}`);
    assert.deepEqual(readToolRegistry(toolsDir), {}, 'nothing registered');
  } finally { fake.restore(); }
});

test('materialize — good parts: probe, hash-verified pull, load, re-probe, honest registry record; re-materialize reuses', async () => {
  const fake = await installFakeDocker();
  try {
    const { root, payloadDir, tool, archiveSha } = await fixtureImageTool();
    const access = await fixtureAccess(root, payloadDir, tool);
    const toolsDir = join(root, 'tools');
    const r = await materializeTool(access, tool, { toolsDir });
    const lines = readFileSync(fake.log, 'utf8').trim().split('\n');
    assert.deepEqual(lines, ['image inspect fixture-image:latest', 'load', 'image inspect fixture-image:latest'], 'inspect (miss) → load → inspect (hit): the load happens only after the hash-verified pull');
    assert.equal(r.image, IMAGE);
    assert.equal(r.binPath, null);
    assert.deepEqual(r.binPaths, {});
    assert.equal(r.connector, null, 'an image is not offered as an MCP connector');
    assert.equal(r.receipt.archiveSha256, archiveSha);
    assert.equal(r.receipt.adopted, false);
    const record = readToolRegistry(toolsDir)[`fixture-image@${PLATFORM}`];
    assert.ok(record, 'the tool is in the persistent registry');
    assert.equal(record.format, 'docker-image-tar');
    assert.equal(record.image, IMAGE);
    assert.equal(record.binPath, null, 'no filesystem bin path is fabricated');
    assert.deepEqual(record.execution, { type: 'docker-run', command: 'docker', args: ['run', '--rm', IMAGE], image: IMAGE });
    assert.equal(record.archiveSha256, archiveSha);
    assert.equal(r.descriptor.image, IMAGE);
    assert.ok(!('binPath' in r.descriptor), 'the descriptor carries no binPath for an image tool');
    assert.match(r.descriptor.description, /Docker image/);
    const r2 = await materializeTool(access, tool, { toolsDir });
    assert.equal(r2.receipt.archiveSha256, archiveSha);
    const loads = readFileSync(fake.log, 'utf8').trim().split('\n').filter((l) => l === 'load');
    assert.equal(loads.length, 1, 'idempotent: the image already local + receipt match → no second load');
  } finally { fake.restore(); }
});

test('materialize — adoption: an already-local image registers with NO pull and NO load', async () => {
  const fake = await installFakeDocker({ present: true });
  try {
    const { root, tool } = await fixtureImageTool();
    const access = { download: async () => { throw new Error('must not be called'); } };
    const toolsDir = join(root, 'tools');
    const r = await materializeTool(access, tool, { toolsDir });
    assert.equal(r.receipt.adopted, true, 'the record says the image was adopted, not pulled');
    const lines = readFileSync(fake.log, 'utf8').trim().split('\n');
    assert.deepEqual(lines, ['image inspect fixture-image:latest'], 'one read-only probe, nothing else — apply-don\'t-redownload');
    const record = readToolRegistry(toolsDir)[`fixture-image@${PLATFORM}`];
    assert.equal(record.adopted, true);
    assert.equal(record.image, IMAGE);
  } finally { fake.restore(); }
});

test('materialize — no docker CLI on PATH refuses, naming docker as the missing prerequisite', async () => {
  const { root, payloadDir, tool } = await fixtureImageTool();
  const access = await fixtureAccess(root, payloadDir, tool);
  const emptyBin = await mkdtemp(join(tmpdir(), 'km-nodocker-'));
  const oldPath = process.env.PATH;
  process.env.PATH = emptyBin;
  try {
    await assert.rejects(() => materializeTool(access, tool, { toolsDir: join(root, 'tools') }), /docker CLI \("docker"\) was not found on PATH/, 'the refusal names the missing prerequisite');
  } finally { process.env.PATH = oldPath; }
  assert.deepEqual(readToolRegistry(join(root, 'tools')), {}, 'nothing registered');
});

test('materialize — a failed load, and a load that does not produce the image, both refuse and register nothing', async () => {
  const fake = await installFakeDocker();
  try {
    const f1 = await fixtureImageTool();
    process.env.FAKE_DOCKER_LOAD_FAIL = '1';
    await assert.rejects(
      async () => materializeTool(await fixtureAccess(f1.root, f1.payloadDir, f1.tool), f1.tool, { toolsDir: join(f1.root, 'tools') }),
      /docker load of .* failed/,
    );
    assert.deepEqual(readToolRegistry(join(f1.root, 'tools')), {});
    delete process.env.FAKE_DOCKER_LOAD_FAIL;
    process.env.FAKE_DOCKER_LOAD_NOWRITE = '1';
    const f2 = await fixtureImageTool();
    await assert.rejects(
      async () => materializeTool(await fixtureAccess(f2.root, f2.payloadDir, f2.tool), f2.tool, { toolsDir: join(f2.root, 'tools') }),
      /not present locally afterward/,
      'a load that does not produce the declared image is refused, fail closed',
    );
    assert.deepEqual(readToolRegistry(join(f2.root, 'tools')), {});
  } finally {
    delete process.env.FAKE_DOCKER_LOAD_FAIL;
    delete process.env.FAKE_DOCKER_LOAD_NOWRITE;
    fake.restore();
  }
});

test('materialize — adoption provenance survives re-materialize: reuse never launders adopted into verified', async () => {
  const fake = await installFakeDocker({ present: true });
  try {
    const { root, tool } = await fixtureImageTool();
    const access = { download: async () => { throw new Error('must not be called'); } };
    const toolsDir = join(root, 'tools');
    const r1 = await materializeTool(access, tool, { toolsDir });
    assert.equal(r1.receipt.adopted, true);
    assert.equal(readToolRegistry(toolsDir)[`fixture-image@${PLATFORM}`].adopted, true);
    const r2 = await materializeTool(access, tool, { toolsDir });
    assert.equal(r2.receipt.adopted, true, 'the reused receipt keeps the adopted provenance');
    const record = readToolRegistry(toolsDir)[`fixture-image@${PLATFORM}`];
    assert.equal(record.adopted, true, 're-materialize must not rewrite an adopted record as pulled-and-hash-verified');
    const lines = readFileSync(fake.log, 'utf8').trim().split('\n');
    assert.ok(lines.every((l) => l === 'image inspect fixture-image:latest'), `adoption + reuse pulls nothing and loads nothing; docker log was:\n${lines.join('\n')}`);
  } finally { fake.restore(); }
  const fake2 = await installFakeDocker();
  try {
    const f = await fixtureImageTool();
    const access = await fixtureAccess(f.root, f.payloadDir, f.tool);
    const toolsDir = join(f.root, 'tools');
    await materializeTool(access, f.tool, { toolsDir });
    await materializeTool(access, f.tool, { toolsDir });
    assert.equal(readToolRegistry(toolsDir)[`fixture-image@${PLATFORM}`].adopted, false, 'the pull path — bytes hash-verified — stays adopted: false across re-materialize');
  } finally { fake2.restore(); }
});

test('conductor — an image-backed tool: the check pulls + registers it, the command stays off PATH, the declare stays declared', async () => {
  const fake = await installFakeDocker();
  try {
    const { root, payloadDir, tool } = await fixtureImageTool();
    const stateDir = join(root, 'state');
    const provider = createToolStreamingProvider({ stateDir, toolPayloadDir: payloadDir, toolsIndex: [tool] });
    const indexUrl = await fixtureMethodLib({
      id: 'image-tool-job', version: '1.0', inputs: {},
      steps: [
        { n: 1, id: 'check-image', type: 'check-tool', command: 'fixture-image-cmd', into: 'toolCheck' },
        { n: 2, id: 'declare-image', type: 'declare', action: 'fixture-image-cmd --run job', reason: 'the tool is not on this node' },
      ],
    });
    const workDir = join(root, 'work');
    await mkdir(workDir, { recursive: true });
    const r = await createMethodConductor({ indexUrl, toolProvider: provider }).conduct('image-tool-job', { workDir });
    assert.equal(r.status, 'completed', `trace: ${JSON.stringify(r.trace, null, 1)}`);
    const check = r.trace.find((t) => t.id === 'check-image');
    assert.equal(check.result.found, false, 'an image tool is not a PATH binary — the check stays a miss, honestly');
    assert.equal(check.result.pull.tool, 'fixture-image');
    assert.equal(check.result.pull.image, IMAGE, 'the trace records that an image was materialized');
    assert.equal(check.result.pull.registered, true);
    assert.deepEqual(r.declared.map((d) => d.step), ['declare-image'], 'the step stayed declared — the conductor executes filesystem bins, not images');
    const record = readToolRegistry(join(stateDir, 'brain-library', 'tools'))[`fixture-image@${PLATFORM}`];
    assert.ok(record, 'the image tool is in the persistent registry');
    assert.equal(record.image, IMAGE);
  } finally { fake.restore(); }
});
