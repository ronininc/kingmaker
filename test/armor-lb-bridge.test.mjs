// Kingmaker → Scripture Armor Little Brother bridge (2026-11-16): Kingmaker discovers the ONE canonical toolkit inside an
// Armor bundle, verifies it with ARMOR'S OWN pinned verifier (lb-toolkit.mjs), registers nothing by copying, and runs
// only through Armor's packaged engine. Synthetic bundle: Armor's real lb-toolkit.mjs / lb-engine.mjs + a stub "nuclei"
// script; the only target is a 127.0.0.1 fixture. Skipped when the Armor source tree is not present.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { discoverArmorToolkit, discoverLittleBrother, armorLittleBrotherEngine, importPinnedArmorModule } from '../lib/armor-toolkit.mjs';

const ARMOR_SRC = process.env.ARMOR_SRC ?? path.join(os.homedir(), 'Documents/Codex/2026-11-16/grok-handoff/worktrees/armor-123-human-gate/scripture-armor');
const have = fs.existsSync(path.join(ARMOR_SRC, 'lb-toolkit.mjs')) && fs.existsSync(path.join(ARMOR_SRC, 'build-standalone.mjs'));
const opts = have ? {} : { skip: `Armor source not found at ${ARMOR_SRC}` };
const sha = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');

async function makeBundle() {
  const { collectBundleRecords } = await import(pathToFileURL(path.join(ARMOR_SRC, 'build-standalone.mjs')).href);
  const { LB_TOOLKIT_SCHEMA, lbBinDir, platformKey, stageLbToolkit } = await import(pathToFileURL(path.join(ARMOR_SRC, 'lb-toolkit.mjs')).href);
  const P = platformKey();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'km-armor-lb-')));
  const src = path.join(root, 'lb-src'), bin = path.join(src, 'bin', P); fs.mkdirSync(bin, { recursive: true }); fs.mkdirSync(path.join(src, 'licenses'));
  const stub = path.join(bin, 'nuclei');
  fs.writeFileSync(stub, `#!${process.execPath}\nconst u = process.argv[process.argv.indexOf('-u') + 1]; const t = await (await fetch(u + '/.env')).text();\nif (t.includes('DB_PASSWORD=')) console.log(JSON.stringify({ 'template-id': 'stub', 'matched-at': u + '/.env', info: { name: 'stub finding', severity: 'high' } }));\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(src, 'licenses', 'nuclei.LICENSE'), 'SYNTHETIC licence text\n');
  fs.writeFileSync(path.join(src, 'toolkit.json'), JSON.stringify({ schema: LB_TOOLKIT_SCHEMA, platform: P, tools: [{ name: 'nuclei', version: 'stub-0.0.1', path: `${lbBinDir(P)}/nuclei`, sha256: sha(stub), size: fs.statSync(stub).size, licence: 'MIT', licenceFile: 'littlebrother/licenses/nuclei.LICENSE', sourceUrl: 'https://example.invalid/nuclei', platforms: [P], role: 'synthetic stub' }] }));
  const out = path.join(root, 'armor'); fs.mkdirSync(out);
  for (const f of ['lb-toolkit.mjs', 'lb-engine.mjs']) fs.copyFileSync(path.join(ARMOR_SRC, f), path.join(out, f));
  stageLbToolkit(src, out);
  fs.writeFileSync(path.join(out, 'BUNDLE.json'), JSON.stringify({ schema: 'scripture-armor.standalone-bundle/1', version: '1.2.3', files: collectBundleRecords(out) }));
  return { root, out, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('Kingmaker verifies the toolkit with Armor\'s pinned verifier, in place (pointers, no copies)', opts, async () => {
  const b = await makeBundle();
  try {
    const found = discoverArmorToolkit({ roots: [b.out] });
    assert.equal(found.status, 'armor-installed'); assert.equal(found.littleBrother.status, 'present-unverified');
    const lb = await discoverLittleBrother({ found });
    assert.equal(lb.status, 'verified', JSON.stringify(lb.reasons));
    assert.equal(lb.tools[0].name, 'lb-nuclei'); assert.ok(lb.tools[0].path.startsWith(b.out), 'points INTO the Armor bundle');
  } finally { b.cleanup(); }
});

test('a modified Armor verifier, a modified tool or an unpinned module is refused', opts, async () => {
  const b = await makeBundle();
  try {
    fs.appendFileSync(path.join(b.out, 'lb-toolkit.mjs'), '\n// tampered\n');
    const r1 = await discoverLittleBrother({ found: discoverArmorToolkit({ roots: [b.out] }) });
    assert.equal(r1.status, 'refused'); assert.match(r1.reasons[0], /lb-toolkit\.mjs is modified/);
    await assert.rejects(importPinnedArmorModule(b.out, 'not-pinned.mjs'), /not pinned/);
  } finally { b.cleanup(); }
  const c = await makeBundle();
  try {
    const bin = fs.readdirSync(path.join(c.out, 'littlebrother', 'bin'))[0];
    fs.appendFileSync(path.join(c.out, 'littlebrother', 'bin', bin, 'nuclei'), '\n// tampered\n');
    const r2 = await discoverLittleBrother({ found: discoverArmorToolkit({ roots: [c.out] }) });
    assert.equal(r2.status, 'refused'); assert.ok(r2.reasons.some((x) => /binary modified/.test(x)));
  } finally { c.cleanup(); }
});

test('runs only through Armor\'s packaged engine, scope-enforced (localhost fixture)', opts, async () => {
  const b = await makeBundle();
  const server = http.createServer((req, res) => { res.writeHead(200); res.end(req.url === '/.env' ? 'DB_PASSWORD=synthetic\n' : 'ok'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r)); const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const authorization = { schema: 'scripture-armor.lb-authorization/1', targets: [origin], purpose: 'synthetic fixture test', approvedBy: 'test owner', expiresAt: new Date(Date.now() + 600000).toISOString() };
    const eng = await armorLittleBrotherEngine({ found: discoverArmorToolkit({ roots: [b.out] }), authorization });
    const rep = await eng.run([{ adapter: 'nuclei', target: origin, template: 'stub' }, { adapter: 'nuclei', target: 'http://127.0.0.2:9', template: 'stub' }]);
    assert.equal(rep.toolkit.packaged, true);
    assert.equal(rep.steps[0].status, 'completed'); assert.equal(rep.findings.length, 1);
    assert.equal(rep.steps[1].status, 'refused', 'out-of-scope target refused by Armor\'s engine');
  } finally { server.closeAllConnections?.(); server.close(); b.cleanup(); }
});
