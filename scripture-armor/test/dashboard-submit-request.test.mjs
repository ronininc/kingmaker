// "Submit a request to Ronin Inc" — the dashboard (account) surface suite.
// The standalone app's account surface carries the item beside the member's
// account (spec §3.2): a plain request form (presentation: Contact Support),
// filed under the signed-in account only, through the submitter + guarded
// transport seam. The transport here is an injected capture (the fixture
// grade); the CRM remote is the same fixture the account suite uses.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createArmorDashboard } from '../dashboard.mjs';

const PASSWORD = 'synthetic-password', EMAIL = 'member@example.test', OTP = '12345678', COOKIE = `ronin_armor=${'c'.repeat(64)}`;

test('the account surface files a request under the signed-in member — and only then', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'armor-g6-dash-'));
  const identityDir = path.join(temp, 'identity');
  const now = Math.floor(Date.now() / 1000);
  const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
  const sent = [];
  const server = createArmorDashboard({
    sessionStore: null, identityDir,
    submitTransport: async (record) => { sent.push(record); return { delivery: 'sent-to-crm-intake' }; },
    fetchImpl: async (url, options) => {
      const action = new URL(url).pathname.split('/').pop();
      if (action === 'login') return json({ ok: true, emailCodeRequired: true, challengeId: 'fixture', email: EMAIL, purpose: 'login', expiresAt: now + 300 }, 202);
      if (action === 'verify') return JSON.parse(options.body).code !== OTP ? json({ ok: false, error: 'wrong code' }, 403) : json({ ok: true, mfaVerified: true, member: { email: EMAIL, paid: false } }, 200, { 'set-cookie': `${COOKIE}; HttpOnly; Secure; Path=/; SameSite=Strict` });
      if (action === 'me') return json({ ok: true, mfaVerified: true, member: { email: EMAIL, paid: false, mfa_verified_at: now } });
      throw new Error('unexpected endpoint');
    },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const html = await (await fetch(base)).text();
    assert.match(html, /id="requestPanel"/);
    assert.match(html, /SUBMIT A REQUEST TO RONIN INC/);
    assert.match(html, /\/api\/request\/submit/);
    const token = /const TOKEN=("[^"]+")/.exec(html); assert.ok(token);
    const headers = { 'content-type': 'application/json', 'x-scripture-armor-token': JSON.parse(token[1]), origin: base };
    const post = (route, body) => fetch(base + route, { method: 'POST', headers, body: JSON.stringify(body) });
    const form = { type: 'brain', name: 'Fixture Brain', source: 'https://example.invalid/b', description: 'A fixture brain.' };
    // Signed out: the surface refuses — a request is filed under a member or not at all.
    const refused = await post('/api/request/submit', form);
    assert.equal(refused.status, 401);
    assert.equal(sent.length, 0);
    assert.equal(fs.existsSync(path.join(identityDir, 'submit-requests')), false);
    // Sign in (password + email code), as the account suite does.
    await post('/api/account/login', { email: EMAIL, password: PASSWORD });
    const verified = await post('/api/account/verify', { code: OTP });
    assert.equal(JSON.parse(await verified.text()).authenticated, true);
    // A form that tries to file under someone else is filed under the member.
    const res = await post('/api/request/submit', { ...form, email: 'victim@example.test', memberId: 'victim@example.test', requester: { email: 'victim@example.test' } });
    assert.equal(res.status, 200);
    const body = JSON.parse(await res.text());
    assert.equal(body.ok, true);
    assert.equal(body.delivery, 'sent-to-crm-intake');
    assert.match(body.confirmation, /Submit a request to Ronin Inc — received\./);
    assert.match(body.confirmation, /no timeline for review/);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].id, body.id);
    assert.equal(sent[0].schema, 'ronin.submit-request/1');
    assert.equal(sent[0].productOfOrigin, 'scripture-armor');
    assert.equal(sent[0].status, 'PENDING OWNER GATE');
    assert.deepEqual(sent[0].requester, { memberId: EMAIL, email: EMAIL });
    assert.deepEqual(sent[0].acknowledgment, { to: EMAIL, copyStatus: 'PENDING OWNER REVIEW' });
    // Validation still names the problem instead of recording a bad request.
    const invalid = await post('/api/request/submit', { ...form, description: '' });
    assert.equal(invalid.status, 400);
    assert.equal(sent.length, 1);
  } finally { await new Promise((resolve) => server.close(resolve)); fs.rmSync(temp, { recursive: true, force: true }); }
});
