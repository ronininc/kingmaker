import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { convertFile, corpusInstalled, fetchCorpus, loadManifest, planFetch, recordToMarkdown, recordsOf } from '../lib/security-corpus.mjs';

const manifest = loadManifest();
const sha = (s) => createHash('sha256').update(s).digest('hex');
const tmp = () => mkdtempSync(join(tmpdir(), 'security-corpus-'));

test('the manifest pins a revision, records the unconfirmed rights, and leaves attack folders out', () => {
  assert.match(manifest.source.revision, /^[0-9a-f]{40}$/);
  assert.equal(manifest.license.confirmed, false);
  assert.ok(manifest.license.use.includes('Not redistributed'));
  for (const folder of ['offensive-security', 'red-team', 'penetration-testing', 'malware', 'ransomware', 'botnet-ddos', 'social-engineering', 'phishing']) assert.ok(!manifest.include.includes(folder), folder);
});

test('planFetch takes only included folders, wanted types, files under the limit, and each content once', () => {
  const tree = [
    { type: 'file', path: 'blue-team/hardening.json', size: 100, oid: 'a1' },
    { type: 'file', path: 'blue-team/hardening-copy.json', size: 100, oid: 'a1' },
    { type: 'file', path: 'blue-team/notes__dup1.json', size: 50, oid: 'a2' },
    { type: 'file', path: 'blue-team/table.csv', size: 50, oid: 'a3' },
    { type: 'file', path: 'red-team/attack.json', size: 50, oid: 'a4' },
    { type: 'file', path: 'README.md', size: 50, oid: 'a5' },
    { type: 'file', path: 'vulnerability-intelligence/master.jsonl', size: 5, oid: 'p', lfs: { oid: 'f'.repeat(64), size: 3e9 } },
    { type: 'file', path: 'blue-team/../red-team/x.json', size: 5, oid: 'a6' },
    { type: 'directory', path: 'blue-team', size: 0 },
  ];
  const plan = planFetch(tree, manifest);
  assert.deepEqual(plan.take.map((f) => f.path), ['blue-team/hardening-copy.json']);
  assert.equal(plan.bytes, 100);
  const why = Object.fromEntries(plan.skipped.map((s) => [s.path, s.reason]));
  assert.equal(why['red-team/attack.json'], 'folder not in include list');
  assert.equal(why['README.md'], 'folder not in include list');
  assert.equal(why['blue-team/table.csv'], 'file type not taken');
  assert.equal(why['blue-team/notes__dup1.json'], 'named as a duplicate');
  assert.equal(why['blue-team/hardening.json'], 'same content as a file already taken');
  assert.equal(why['blue-team/../red-team/x.json'], 'unsafe path');
  assert.match(why['vulnerability-intelligence/master.jsonl'], /per-file limit/);
});

test('records of any shape become readable Markdown', () => {
  const md = recordToMarkdown({ title: 'Disable SMBv1', steps: ['Open settings', 'Turn it off'], meta: { severity: 'high', score: 8 } });
  assert.match(md, /^## Disable SMBv1\n/);
  assert.match(md, /steps: Open settings/);
  assert.match(md, /meta\.severity: high/);
  assert.match(md, /meta\.score: 8/);
  assert.equal(recordToMarkdown({ a: null, b: '' }), null);
  assert.equal(recordsOf({ items: [{ a: 1 }, { a: 2 }], count: 2 }).length, 2);
  assert.equal(recordsOf([{ a: 1 }]).length, 1);
  assert.equal(recordsOf({ a: 'one document' }).length, 1);
});

test('convertFile writes Markdown from JSON and JSONL, and refuses a cut-off JSONL', async () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'a.json'), JSON.stringify({ playbooks: [{ name: 'Contain host', body: 'Isolate it.' }, { name: 'Reset keys', body: 'Rotate them.' }] }));
    const a = await convertFile(join(dir, 'a.json'), join(dir, 'out', 'a'), { heading: 'blue-team/a.json' });
    assert.equal(a.records, 2);
    const text = readFileSync(a.files[0], 'utf8');
    assert.match(text, /^# blue-team\/a\.json\n/);
    assert.match(text, /## Contain host/);
    writeFileSync(join(dir, 'b.jsonl'), '{"question":"What is MFA?","answer":"A second factor."}\n\n{"question":"What is a CVE?","answer":"A catalogued flaw."}\n');
    const b = await convertFile(join(dir, 'b.jsonl'), join(dir, 'out', 'b'));
    assert.equal(b.records, 2);
    writeFileSync(join(dir, 'c.jsonl'), '{"question":"ok"}\n{"question":"cut of');
    await assert.rejects(convertFile(join(dir, 'c.jsonl'), join(dir, 'out', 'c')), /line 2 .* not valid JSON/);
    assert.ok(!existsSync(join(dir, 'out', 'c.md')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function fakeHub(files, { refuse = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, auth: init.headers?.authorization ?? null });
    if (refuse) return new Response('no', { status: 401 });
    const path = decodeURIComponent(url.split(`/resolve/${manifest.source.revision}/`)[1] ?? '');
    return path in files ? new Response(files[path]) : new Response('missing', { status: 404 });
  };
  return { fetchImpl, calls };
}

test('fetchCorpus needs a token, sends it only to the hub, checks each file, and writes a receipt', async () => {
  const dir = tmp();
  const sources = join(dir, 'knowledge', 'sources');
  try {
    assert.equal((await fetchCorpus({ manifest, sourcesDir: sources, token: '', tree: [] })).state, 'needs-token');
    const good = JSON.stringify([{ title: 'Log review', text: 'Check auth logs daily.' }]);
    const big = '{"question":"What is least privilege?","answer":"Only the access a task needs."}\n';
    const tree = [
      { type: 'file', path: 'blue-team/log-review.json', size: Buffer.byteLength(good), oid: 'g1' },
      { type: 'file', path: 'identity-access-management/basics.jsonl', size: Buffer.byteLength(big), oid: 'ptr', lfs: { oid: sha(big), size: Buffer.byteLength(big) } },
      { type: 'file', path: 'compliance/tampered.jsonl', size: 10, oid: 'ptr2', lfs: { oid: sha('original 1'), size: 10 } },
      { type: 'file', path: 'red-team/attack.json', size: 10, oid: 'r1' },
    ];
    const hub = fakeHub({ 'blue-team/log-review.json': good, 'identity-access-management/basics.jsonl': big, 'compliance/tampered.jsonl': 'changed!!!', 'red-team/attack.json': '[]' });
    const r = await fetchCorpus({ manifest, sourcesDir: sources, token: 'test-token', tree, fetchImpl: hub.fetchImpl });
    assert.equal(r.state, 'partial');
    assert.deepEqual(r.written.map((w) => w.path).sort(), ['blue-team/log-review.json', 'identity-access-management/basics.jsonl']);
    assert.deepEqual(r.failed, [{ path: 'compliance/tampered.jsonl', reason: 'SHA-256 does not match the listing' }]);
    assert.ok(hub.calls.every((c) => c.url.startsWith('https://huggingface.co/datasets/Vyber07/cyber-security/resolve/') && c.auth === 'Bearer test-token'));
    assert.ok(!hub.calls.some((c) => c.url.includes('red-team')));
    const dest = join(sources, manifest.field, manifest.id);
    assert.match(readFileSync(join(dest, 'blue-team', 'log-review.md'), 'utf8'), /## Log review/);
    assert.ok(existsSync(join(dest, 'identity-access-management', 'basics.md')));
    assert.ok(!existsSync(join(dest, 'compliance')));
    assert.ok(!existsSync(join(dir, 'knowledge', 'downloads', manifest.id)), 'the holding folder is removed');
    const receipt = JSON.parse(readFileSync(join(sources, '.receipts', `${manifest.id}.json`), 'utf8'));
    assert.equal(receipt.license.confirmed, false);
    assert.equal(receipt.revision, manifest.source.revision);
    assert.ok(!JSON.stringify(receipt).includes('test-token'));
    assert.ok(corpusInstalled(manifest, sources));
    const everything = readdirSync(dest, { recursive: true }).map(String);
    assert.ok(everything.every((n) => !/\.(json|jsonl)$/.test(n)), 'only Markdown is left in the sources folder');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a refused token stops the run and says what to do', async () => {
  const dir = tmp();
  try {
    const tree = [{ type: 'file', path: 'blue-team/a.json', size: 2, oid: 'x' }, { type: 'file', path: 'blue-team/b.json', size: 2, oid: 'y' }];
    const hub = fakeHub({}, { refuse: true });
    const r = await fetchCorpus({ manifest, sourcesDir: join(dir, 'sources'), token: 't', tree, fetchImpl: hub.fetchImpl });
    assert.equal(r.state, 'access-refused');
    assert.match(r.reason, /Accept the dataset's terms/);
    assert.equal(hub.calls.length, 1);
    assert.ok(!existsSync(join(dir, 'sources', '.receipts')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a file that fails part-way leaves no Markdown where the knowledge build looks', async () => {
  const { PART_BYTES } = await import('../lib/security-corpus.mjs');
  const dir = tmp();
  try {
    const bigRecord = JSON.stringify({ title: 'Large entry', text: 'x'.repeat(PART_BYTES + 10) });
    writeFileSync(join(dir, 'big.jsonl'), `${bigRecord}\n{"title":"cut of`);
    await assert.rejects(convertFile(join(dir, 'big.jsonl'), join(dir, 'out', 'big')), /line 2 .* not valid JSON/);
    const left = existsSync(join(dir, 'out')) ? readdirSync(join(dir, 'out'), { recursive: true }).map(String) : [];
    assert.deepEqual(left, [], 'nothing was published and the staging folder is gone');
    writeFileSync(join(dir, 'ok.jsonl'), `${bigRecord}\n{"title":"Second"}\n`);
    const ok = await convertFile(join(dir, 'ok.jsonl'), join(dir, 'out', 'ok'));
    assert.deepEqual(readdirSync(join(dir, 'out')).sort(), ['ok.md', 'ok.part2.md']);
    assert.equal(ok.records, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('buildShard runs the engine\'s extract and index steps for this one field and produces the SQLite shard', async () => {
  const { buildShard } = await import('../lib/security-corpus.mjs');
  const { DatabaseSync } = await import('node:sqlite');
  const dir = tmp();
  const sources = join(dir, 'knowledge', 'sources');
  try {
    const doc = JSON.stringify([{ title: 'Detect password spraying', text: 'Look for many accounts failing sign-in from one address inside a short window.' }]);
    const tree = [{ type: 'file', path: 'blue-team/detections.json', size: Buffer.byteLength(doc), oid: 'd1' }];
    await fetchCorpus({ manifest, sourcesDir: sources, token: 't', tree, fetchImpl: fakeHub({ 'blue-team/detections.json': doc }).fetchImpl });
    const env = { PATH: process.env.PATH, HOME: dir };
    const built = buildShard({ manifest, sourcesDir: sources, env });
    assert.equal(built.state, 'built', JSON.stringify(built));
    assert.equal(built.shard, join(dir, 'knowledge', 'index', 'security-diagnostics.db'));
    const db = new DatabaseSync(built.shard, { readOnly: true });
    const rows = db.prepare('SELECT text FROM chunks WHERE chunks MATCH ?').all('spraying');
    db.close();
    assert.equal(rows.length, 1);
    assert.match(rows[0].text, /failing sign-in/);
    assert.equal(buildShard({ manifest, sourcesDir: sources, env, scriptsDir: join(dir, 'nowhere') }).state, 'failed');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the engine\'s field contract routes security questions to this field, as an optional field', async () => {
  const { applyFieldRoute } = await import('../lib/security-corpus.mjs');
  const { fileURLToPath } = await import('node:url');
  const contractPath = fileURLToPath(new URL('../solomon/contracts/knowledge-fields.json', import.meta.url));
  const original = readFileSync(contractPath, 'utf8');
  const entry = JSON.parse(original).fields.find((f) => f.field === manifest.field);
  assert.ok(entry, 'the route is in the committed contract; an engine import must put it back (scripts/import-solomon.mjs does)');
  assert.equal(entry.optional, true, 'optional, so a library without the corpus still counts as complete');
  const rx = new RegExp(entry.triggers, 'i');
  for (const q of ['How do I diagnose API authentication failures?', 'Kubernetes security hardening checklist', 'what does security compliance require for access control', 'is this CVE exploitable']) assert.ok(rx.test(q), q);
  for (const q of ['What happens to Hector at the end of the Iliad?', 'write a python function to sort a list', 'make a poster for the taco truck']) assert.ok(!rx.test(q), q);
  const dir = tmp();
  try {
    const copy = join(dir, 'knowledge-fields.json');
    const without = JSON.parse(original); without.fields = without.fields.filter((f) => f.field !== manifest.field);
    writeFileSync(copy, `${JSON.stringify(without, null, 2)}\n`);
    assert.equal(applyFieldRoute(copy, manifest), true);
    assert.equal(applyFieldRoute(copy, manifest), false, 'a second run changes nothing');
    const after = JSON.parse(readFileSync(copy, 'utf8'));
    assert.equal(after.fields.length, without.fields.length + 1);
    assert.deepEqual(after.fields.at(-1), entry);
    assert.equal(applyFieldRoute(copy, { ...manifest, route: { ...manifest.route, description: 'changed' } }), true);
    const changed = JSON.parse(readFileSync(copy, 'utf8'));
    assert.equal(changed.fields.length, after.fields.length);
    assert.equal(changed.fields.at(-1).description, 'changed');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
