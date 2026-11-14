// The repo supplier (FIX-G): repo-streamed intelligence for the Brain Library.
// A fixture intelligence repo behind a fetch stub — the same lane layout the seed
// PR creates in ronininc/kingmaker-brain-library (intelligence/<lane>/index.json,
// schemas unchanged, sha256+size pins on every payload) — proves the supplier
// builds the bundled build's ids/kinds plus the skills lane, fetches payloads
// lazily and only where a range overlaps, refuses off-pin payloads, and feeds
// the access layer's hash acceptance and the conductor's repo seam.
// Load order (pre-existing on main, not a FIX-G condition): brain-library-fetch
// reads a brain-library constant at module top level, inside an import cycle
// (brain-library → … → tool-streaming → brain-library-fetch). Entering the graph
// through the fetch module — as the product's own library surface does —
// initializes it safely; importing it first here keeps this suite on that path.
import '../lib/brain-library-fetch.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildCatalogSources, createBrainLibraryAccess, KNOWLEDGE_ID } from '../lib/brain-library-access.mjs';
import { buildRepoCatalogSources, createRepoReadText, libraryRemoteEnabled, normalizeSkillsIndex, repoIndexUrl, SKILLS_SCHEMA } from '../lib/brain-library-repo.mjs';
import { createMethodConductor } from '../lib/method-conductor.mjs';

const sha = (b) => createHash('sha256').update(Buffer.isBuffer(b) ? b : Buffer.from(String(b))).digest('hex');
const BASE = 'https://fixture.invalid/lib';
const TIERS = ['draft', 'community', 'vetted', 'canonical'];

function fixtureRepo({ corruptSkillPin = false, skillsLane = true, padMethod = false } = {}) {
  const methodText = '# Alpha method\n\n```kingmaker-method\n{"id":"alpha","version":"1","steps":[{"n":1,"id":"say","type":"note","text":"alpha ran"}]}\n```\n';
  const part1 = '# Part one\ncontinuity first part body.\n';
  const part2 = '# Part two\nsecond part body, graded.\n';
  const skillText = '# Fixture Skill\n\nThe fixture skill body opens here.\n';
  const manifest = {
    id: 'mod-a', title: 'Module A',
    parts: [
      { id: 'p1', file: 'parts/p1.md', heading: 'One', size: Buffer.byteLength(part1), sha256: sha(part1) },
      { id: 'p2', file: 'parts/p2.md', heading: 'Two', size: Buffer.byteLength(part2), sha256: sha(part2) },
    ],
  };
  const files = new Map([
    [`${BASE}/intelligence/training/index.json`, JSON.stringify({ schema: 'kingmaker.training-modules/1', qualityTiers: TIERS, modules: [{ id: 'mod-a', dir: 'modules/mod-a', title: 'Module A', quality: { tier: 'vetted', score: 80 }, sha256: sha(part1 + part2), size: Buffer.byteLength(part1 + part2) }] })],
    [`${BASE}/intelligence/training/modules/mod-a/module.json`, JSON.stringify(manifest)],
    [`${BASE}/intelligence/training/modules/mod-a/parts/p1.md`, part1],
    [`${BASE}/intelligence/training/modules/mod-a/parts/p2.md`, part2],
    [`${BASE}/intelligence/methods/index.json`, JSON.stringify({ schema: 'kingmaker.methods/1', qualityTiers: TIERS, methods: [{ id: 'alpha', file: 'alpha.method.md', title: 'Alpha', quality: { tier: 'vetted', score: 70 }, size: Buffer.byteLength(methodText), sha256: sha(methodText) }] })],
    [`${BASE}/intelligence/methods/alpha.method.md`, padMethod ? `${methodText}x` : methodText],
    [`${BASE}/intelligence/skills/fixture-skill/SKILL.md`, skillText],
  ]);
  if (skillsLane) {
    files.set(`${BASE}/intelligence/skills/index.json`, JSON.stringify({
      schema: SKILLS_SCHEMA,
      skills: [{ slug: 'fixture-skill', title: 'Fixture Skill', file: 'fixture-skill/SKILL.md', size: Buffer.byteLength(skillText), sha256: corruptSkillPin ? '0'.repeat(64) : sha(skillText), lane: 'shared', quality: { tier: 'community', score: 50 } }],
    }));
  }
  const fetched = [];
  const fetchImpl = async (url) => {
    const u = String(url); fetched.push(u);
    const body = files.get(u);
    return body === undefined ? new Response('not found', { status: 404 }) : new Response(body, { status: 200 });
  };
  return { fetchImpl, fetched, texts: { methodText, part1, part2, skillText } };
}

const accessFor = (sources) => {
  const dir = mkdtempSync(join(tmpdir(), 'repo-access-'));
  return createBrainLibraryAccess({ sources, storeDir: join(dir, 'store'), cacheDir: join(dir, 'cache'), stateDir: join(dir, 'state') });
};

test('repo supplier builds the bundled ids and kinds, plus the skills lane, pins intact', async () => {
  const repo = fixtureRepo();
  const sources = await buildRepoCatalogSources({ baseUrl: BASE, fetchImpl: repo.fetchImpl });
  for (const id of ['method:alpha', 'training:mod-a', 'training-part:mod-a/p1', 'training-part:mod-a/p2', KNOWLEDGE_ID, 'skill:fixture-skill']) {
    assert.ok(sources.has(id), `missing ${id}`);
  }
  assert.equal(sources.get('method:alpha').kind, 'method');
  assert.equal(sources.get('training:mod-a').kind, 'training');
  assert.equal(sources.get(KNOWLEDGE_ID).kind, 'knowledge');
  assert.equal(sources.get('skill:fixture-skill').kind, 'skill');
  assert.equal(sources.get('method:alpha').size, Buffer.byteLength(repo.texts.methodText));
  assert.equal(sources.get('method:alpha').sha256, sha(repo.texts.methodText));
  assert.equal(sources.get(KNOWLEDGE_ID).size, Buffer.byteLength(repo.texts.part1 + repo.texts.part2));
});

test('payloads are lazy: building fetches indexes only, and a range read fetches only the members it overlaps', async () => {
  const repo = fixtureRepo();
  const sources = await buildRepoCatalogSources({ baseUrl: BASE, fetchImpl: repo.fetchImpl });
  assert.ok(repo.fetched.every((u) => u.endsWith('index.json') || u.endsWith('module.json')), `payload fetched at build time: ${repo.fetched}`);
  const training = sources.get('training:mod-a');
  const tail = await training.readRange(Buffer.byteLength(repo.texts.part1), 5);
  assert.equal(tail.toString(), repo.texts.part2.slice(0, 5));
  assert.ok(repo.fetched.some((u) => u.endsWith('parts/p2.md')));
  assert.equal(repo.fetched.some((u) => u.endsWith('parts/p1.md')), false);
  const method = sources.get('method:alpha');
  await method.readRange(0, 4);
  await method.readRange(4, 4);
  assert.equal(repo.fetched.filter((u) => u.endsWith('alpha.method.md')).length, 1);
});

test('a payload that arrives at a different size than its pin is refused, never served', async () => {
  const repo = fixtureRepo({ padMethod: true });
  const sources = await buildRepoCatalogSources({ baseUrl: BASE, fetchImpl: repo.fetchImpl });
  await assert.rejects(() => sources.get('method:alpha').readRange(0, 4), /payload refused/);
});

test('the skills lane is optional: a repo without one builds without skill sources', async () => {
  const repo = fixtureRepo({ skillsLane: false });
  const sources = await buildRepoCatalogSources({ baseUrl: BASE, fetchImpl: repo.fetchImpl });
  assert.equal([...sources.keys()].some((id) => id.startsWith('skill:')), false);
  assert.ok(sources.has('method:alpha'));
});

test('skills index validation: schema and pins are required', () => {
  assert.throws(() => normalizeSkillsIndex({ schema: 'nope', skills: [] }), /not kingmaker\.skills\/1/);
  assert.throws(() => normalizeSkillsIndex({ schema: SKILLS_SCHEMA, skills: [{ slug: 'x', file: 'x/SKILL.md', quality: { tier: 'vetted', score: 1 } }] }), /malformed/);
  assert.equal(repoIndexUrl('methods', { baseUrl: 'https://x.invalid/r/' }), 'https://x.invalid/r/intelligence/methods/index.json');
  assert.equal(libraryRemoteEnabled({}), true);
  assert.equal(libraryRemoteEnabled({ KINGMAKER_LIBRARY_REMOTE: 'off' }), false);
  assert.equal(libraryRemoteEnabled({ KINGMAKER_LIBRARY_REMOTE: 'on' }), true);
});

test('readText: https through fetch, 404 fails closed by name, file:// passes through to disk', async () => {
  const repo = fixtureRepo();
  const readText = createRepoReadText({ baseUrl: BASE, fetchImpl: repo.fetchImpl });
  const index = JSON.parse(await readText(`${BASE}/intelligence/methods/index.json`));
  assert.equal(index.schema, 'kingmaker.methods/1');
  assert.equal(index.methods[0].id, 'alpha');
  await assert.rejects(() => readText(`${BASE}/intelligence/methods/nope.md`), (e) => e.code === 'REPO_FETCH_FAILED');
  const dir = mkdtempSync(join(tmpdir(), 'repo-readtext-'));
  writeFileSync(join(dir, 'local.md'), 'on disk');
  assert.equal(await readText(new URL('local.md', `file://${dir}/`)), 'on disk');
});

test('readText offline floor: a failed repo read retries the bundled catalog, and a floor miss rethrows the repo error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'repo-floor-'));
  mkdirSync(join(dir, 'methods'), { recursive: true });
  writeFileSync(join(dir, 'methods', 'index.json'), '{"schema":"kingmaker.methods/1","methods":[]}');
  const down = async () => { throw new TypeError('fetch failed'); };
  const readText = createRepoReadText({ baseUrl: BASE, fetchImpl: down, fallbackCatalogUrl: `file://${dir}/` });
  assert.equal(await readText(`${BASE}/intelligence/methods/index.json`), '{"schema":"kingmaker.methods/1","methods":[]}');
  await assert.rejects(() => readText(`${BASE}/intelligence/methods/absent.md`), (e) => e.code === 'REPO_FETCH_FAILED');
});

test('the conductor conducts a repo-fetched method through the repo readText seam', async () => {
  const repo = fixtureRepo();
  const conductor = createMethodConductor({
    indexUrl: `${BASE}/intelligence/methods/index.json`,
    readText: createRepoReadText({ baseUrl: BASE, fetchImpl: repo.fetchImpl }),
    toolProvider: null,
  });
  const listed = await conductor.listMethods();
  assert.deepEqual(listed.map((m) => m.id), ['alpha']);
  const workDir = mkdtempSync(join(tmpdir(), 'repo-conduct-'));
  const done = await conductor.conduct('alpha', { workDir });
  assert.equal(done.status, 'completed');
});

test('download mode: a right pin is accepted as a verified resident; a wrong pin is refused and deleted', async () => {
  const good = fixtureRepo();
  const access = accessFor(await buildRepoCatalogSources({ baseUrl: BASE, fetchImpl: good.fetchImpl }));
  const saved = await access.download('method:alpha');
  assert.equal(saved.verified, true);
  assert.equal(saved.sha256, sha(good.texts.methodText));
  const bad = fixtureRepo({ corruptSkillPin: true });
  const access2 = accessFor(await buildRepoCatalogSources({ baseUrl: BASE, fetchImpl: bad.fetchImpl }));
  await assert.rejects(() => access2.download('skill:fixture-skill'), /hash mismatch/);
  assert.equal((await access2.diskState()).storeBytes, 0);
});

test('access merge: repo wins per id, the bundled floor stands for the rest, offline leaves the floor alone', async () => {
  // A miniature bundled catalog on disk: a colliding method + a bundled-only one.
  const dir = mkdtempSync(join(tmpdir(), 'repo-merge-'));
  const catalogDir = join(dir, 'catalog');
  mkdirSync(join(catalogDir, 'methods'), { recursive: true });
  mkdirSync(join(catalogDir, 'training'), { recursive: true });
  writeFileSync(join(catalogDir, 'training', 'index.json'), JSON.stringify({ schema: 'kingmaker.training-modules/1', qualityTiers: TIERS, modules: [] }));
  const bundledAlpha = '# Alpha — the bundled wording, older than the repo.\n';
  writeFileSync(join(catalogDir, 'methods', 'alpha.method.md'), bundledAlpha);
  writeFileSync(join(catalogDir, 'methods', 'bundled-only.method.md'), '# Bundled only\n');
  writeFileSync(join(catalogDir, 'methods', 'index.json'), JSON.stringify({
    schema: 'kingmaker.methods/1', qualityTiers: TIERS,
    methods: [
      { id: 'alpha', file: 'alpha.method.md', title: 'Alpha (bundled)', quality: { tier: 'vetted', score: 60 } },
      { id: 'bundled-only', file: 'bundled-only.method.md', title: 'Bundled only', quality: { tier: 'draft', score: 10 } },
    ],
  }));
  const repo = fixtureRepo();
  const merged = await buildCatalogSources({ catalogDir: `${catalogDir}/`, remote: { baseUrl: BASE, fetchImpl: repo.fetchImpl } });
  assert.equal(merged.remoteError, undefined);
  assert.equal(merged.get('method:alpha').size, Buffer.byteLength(repo.texts.methodText)); // repo wins the collision
  assert.equal(merged.get('method:alpha').sha256, sha(repo.texts.methodText));
  assert.ok(merged.has('method:bundled-only')); // the floor stands
  assert.ok(merged.has('skill:fixture-skill')); // and the repo-only lane arrives

  const offline = await buildCatalogSources({ catalogDir: `${catalogDir}/`, remote: { baseUrl: BASE, fetchImpl: async () => { throw new TypeError('fetch failed'); } } });
  assert.equal(offline.remoteError?.code, 'REPO_FETCH_FAILED');
  assert.equal(offline.get('method:alpha').size, Buffer.byteLength(bundledAlpha)); // bundled bytes, named as bundled
  assert.equal([...offline.keys()].some((id) => id.startsWith('skill:')), false);
});
