import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createArmorDashboard, dashboardContentSecurityPolicy } from '../dashboard.mjs';
import { renderArmorDashboard, escapeHtml } from '../dashboard-view.mjs';
test('escapeHtml neutralizes all HTML-significant characters', () => {
  assert.equal(escapeHtml(`<img src=x onerror="a('b')">&`), '&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt;&amp;');
});
test('render escapes terms, refuses non-https hrefs and non-base64 logo, never takes the token', () => {
  const html = renderArmorDashboard({ token: 'synthetic-token', logo: '"><script>x()</script>', termsText: '<script>alert(1)</script>"\'', checkout: { download: 'javascript:alert(1)', discordMembership: 'https://www.ronininc.org/armor/checkout?purpose=discord-membership' } });
  assert.doesNotMatch(html, /synthetic-token|<script>alert|<script>x\(\)|javascript:alert/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;&quot;&#39;/);
  assert.equal((html.match(/<script>/g) || []).length, 1);
  assert.doesNotMatch(html, /\sstyle="/, 'inline style attributes would need unsafe-inline');
  assert.doesNotMatch(html, /\.innerHTML\s*=/, 'feed and all dynamic values must be assigned as text');
});
test('page CSP is hash-pinned with no unsafe-inline/eval or nonce, and hashes match the shipped inline blocks', () => {
  const html = renderArmorDashboard({ logo: '', termsText: 't', checkout: {} });
  const csp = dashboardContentSecurityPolicy(html);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|nonce-/);
  assert.match(csp, /frame-ancestors 'none'/); assert.match(csp, /default-src 'none'/); assert.match(csp, /object-src 'none'/);
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
  assert(csp.includes(`'sha256-${crypto.createHash('sha256').update(script).digest('base64')}'`));
});
test('every response carries nosniff, DENY framing and a CSP; session cookie stays HttpOnly and out of the page', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'armor-render-hardening-'));
  const server = createArmorDashboard({ identityDir: path.join(temp, 'identity') });
  try {
    await new Promise(r => server.listen(0, '127.0.0.1', r)); const origin = 'http://127.0.0.1:' + server.address().port;
    const page = await fetch(origin); const html = await page.text(); const token = /sa_session=([^;]+)/.exec(page.headers.get('set-cookie'))[1];
    assert.match(page.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/); assert(!html.includes(token));
    for (const r of [page, await fetch(origin + '/api/status'), await fetch(origin + '/missing'), await fetch(origin + '/api/status', { headers: { cookie: 'sa_session=' + token } })]) {
      assert.equal(r.headers.get('x-content-type-options'), 'nosniff'); assert.equal(r.headers.get('x-frame-options'), 'DENY');
      assert.match(r.headers.get('content-security-policy') || '', /frame-ancestors 'none'/); assert(r.headers.get('content-type'));
    }
  } finally { await new Promise(r => server.close(r)); fs.rmSync(temp, { recursive: true, force: true }); }
});
