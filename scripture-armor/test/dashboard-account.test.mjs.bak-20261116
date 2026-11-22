import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createArmorDashboard } from '../dashboard.mjs';

const PASSWORD = 'synthetic-password', EMAIL = 'member@example.test', OTP = '12345678', COOKIE = `ronin_armor=${'b'.repeat(64)}`;
test('loopback HTTP requires origin + process token, completes password/OTP transport, and never accepts body cookie/seat-key bypass', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'armor-local-auth-'));
  const identityDir = path.join(temp, 'identity'); let remoteCalls = 0, expired = false;
  const now = Math.floor(Date.now() / 1000);
  const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
  const server = createArmorDashboard({sessionStore:null, identityDir, fetchImpl: async (url, options) => {
    remoteCalls++; assert.equal(new URL(url).origin, 'https://www.ronininc.org'); assert.equal(options.redirect, 'manual');
    const action = new URL(url).pathname.split('/').pop();
    if (action === 'login') return json({ ok: true, emailCodeRequired: true, challengeId: 'fixture', email: EMAIL, purpose: 'login', expiresAt: now + 300 }, 202);
    if (action === 'verify') return JSON.parse(options.body).code !== OTP ? json({ ok: false, error: PASSWORD }, 403) : json({ ok: true, mfaVerified: true, member: { email: EMAIL, paid: false } }, 200, { 'set-cookie': `${COOKIE}; HttpOnly; Secure; Path=/; SameSite=Strict` });
    if (action === 'me') { assert.equal(options.headers.cookie, COOKIE); return expired ? json({ ok: false, member: null }, 401) : json({ ok: true, mfaVerified: true, member: { email: EMAIL, paid: false, mfa_verified_at: now } }); }
    if (action === 'logout') return json({ ok: true });
    throw new Error('unexpected endpoint');
  } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const html = await (await fetch(base)).text();
    const token = /const TOKEN=("[^"]+")/.exec(html); assert.ok(token);
    const headers = { 'content-type': 'application/json', 'x-scripture-armor-token': JSON.parse(token[1]), origin: base };
    const post = (route, body, override = {}) => fetch(base + route, { method: 'POST', headers: { ...headers, ...override }, body: JSON.stringify(body) });
    assert.equal((await post('/api/account/login', { email: EMAIL, password: PASSWORD }, { origin: 'https://attacker.invalid' })).status, 403);
    assert.equal((await post('/api/account/login', { email: EMAIL, password: PASSWORD }, { 'x-scripture-armor-token': 'wrong' })).status, 403);
    const missingOrigin = { ...headers }; delete missingOrigin.origin;
    assert.equal((await fetch(base + '/api/account/login', { method: 'POST', headers: missingOrigin, body: JSON.stringify({ email: EMAIL, password: PASSWORD }) })).status, 403);
    const malformed = await fetch(base + '/api/account/login', { method: 'POST', headers, body: '{ password: ' + PASSWORD });
    assert.equal((await malformed.text()).includes(PASSWORD), false);
    assert.equal(remoteCalls, 0);
    const bypass = await post('/api/activate', { acceptTerms: true, confirmMigration: true, seat_key: 'old-seat-key', authCookie: COOKIE }); assert.equal(bypass.status, 401); assert.equal(fs.existsSync(identityDir), false);
    const challenge = await post('/api/account/login', { email: EMAIL, password: PASSWORD });
    const challengeBody = await challenge.text(); assert.equal(JSON.parse(challengeBody).authenticated, false);
    const beforeOtp = await post('/api/activate', { acceptTerms: true, confirmMigration: true }); assert.equal(beforeOtp.status, 401); assert.equal(fs.existsSync(identityDir), false);
    const wrong = await post('/api/account/verify', { code: '00000000' }); assert.equal(wrong.status, 403); assert.equal(fs.existsSync(identityDir), false);
    const verified = await post('/api/account/verify', { code: OTP }); const verifiedBody = await verified.text(); assert.equal(JSON.parse(verifiedBody).authenticated, true);
    assert.equal(verified.headers.get('set-cookie'), null);
    for (const text of [challengeBody, verifiedBody, html]) for (const secret of [PASSWORD, COOKIE, OTP]) assert.equal(text.includes(secret), false);
    assert.equal(fs.existsSync(identityDir), false, 'OTP never activates or migrates by itself');
    expired = true;
    const noSession = await post('/api/activate', { acceptTerms: true, confirmMigration: true }); assert.equal(noSession.status, 401);
    const status = await (await fetch(base + '/api/status', { headers })).json(); assert.equal(status.account.authenticated, false); assert.equal(status.activated, false);
    assert.equal(fs.existsSync(identityDir), false);
    assert.doesNotMatch(html, /id="(?:memberCode|seatKey)"|localStorage|sessionStorage/);
    assert.match(html, /id="accountPassword"[^>]*type="password"|type="password"[^>]*id="accountPassword"/);
    const script = /<script>([\s\S]*)<\/script>/.exec(html)[1]; new vm.Script(script);
    assert.ok(script.indexOf("q('#accountPassword').value=''" ) < script.indexOf("await call('/api/account/'+action"));
  } finally { await new Promise((resolve) => server.close(resolve)); fs.rmSync(temp, { recursive: true, force: true }); }
});
