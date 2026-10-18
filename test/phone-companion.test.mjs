// The iPhone companion inside Kingmaker (lib/phone-companion.mjs) and its bridge to the Ronin launcher
// (~/Projects/ronin-launcher/docs/kingmaker-bridge.md): loopback-only /admin, status, pairing that rotates, unpair that
// cuts a phone off mid-stream, and kingmaker://companion → the engine's control line.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { get as httpGet } from 'node:http';
import { request } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CA_DAYS, PAIR_CODE_TTL_MS, PAIR_LOCK_MS, caConfig, companionControl, companionWanted, createCompanion, ensureTls, deviceStore, isLoopback, lanIp, setCompanionWanted, tailscalePeer } from '../lib/phone-companion.mjs';

const at = (p) => new URL(`../${p}`, import.meta.url);

/** One HTTPS call to the companion, trusting only the Ronin Local CA (the way the launcher pins it). */
function call(ca, { host = '127.0.0.1', port, method = 'GET', path, body = null, cookie = null }) {
  return new Promise((resolve, reject) => {
    const req = request({ host, port, method, path, ca, agent: false, headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) } }, (res) => {
      let data = ''; res.setEncoding('utf8'); res.on('data', (d) => { data += d; });
      res.on('end', () => { let json = null; try { json = JSON.parse(data); } catch { /* not JSON */ } resolve({ status: res.statusCode, headers: res.headers, text: data, json }); });
    });
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}
const cookieFrom = (res) => /km=[a-f0-9]{48}/.exec(String(res.headers['set-cookie'] || ''))?.[0] || null;

test('the control line and the loopback rule are exact', () => {
  assert.equal(companionControl('companion start'), 'start');
  assert.equal(companionControl('companion stop'), 'stop');
  assert.equal(companionControl('  companion status '), 'status');
  for (const no of ['companion', 'companion restart', 'companion start now', 'companionstart', 'pair', 'xcompanion start']) assert.equal(companionControl(no), null, no);
  for (const yes of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) assert.equal(isLoopback(yes), true, yes);
  for (const no of ['192.168.1.20', '10.0.0.2', '::ffff:192.168.1.20', 'fe80::1', '', undefined]) assert.equal(isLoopback(no), false, String(no));
});

test('on/off is remembered in the data folder', () => {
  const state = mkdtempSync(join(tmpdir(), 'km-companion-on-'));
  try {
    assert.equal(companionWanted(state), false);
    setCompanionWanted(state, true); assert.equal(companionWanted(state), true);
    setCompanionWanted(state, false); assert.equal(companionWanted(state), false);
  } finally { rmSync(state, { recursive: true, force: true }); }
});

test('tailscalePeer reads the Mac Tailscale identity, stays off when told, and never throws', () => {
  const running = JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'mac.tail1234.ts.net.', TailscaleIPs: ['fd7a:115c::1', '100.64.0.7'] } });
  const base = { env: {}, clis: ['/x/tailscale'], exists: () => true, run: () => running };
  // The MagicDNS name (trailing dot stripped) and the 100.x IPv4.
  assert.deepEqual(tailscalePeer(base), { name: 'mac.tail1234.ts.net', ip: '100.64.0.7' });
  // Off by the governance switch, like God's Eye.
  assert.equal(tailscalePeer({ ...base, env: { SOL_GHOST_TAILSCALE: '0' } }), null);
  // No CLI installed → home-only.
  assert.equal(tailscalePeer({ ...base, exists: () => false }), null);
  // Backend down → null (no cellular reach).
  assert.equal(tailscalePeer({ ...base, run: () => JSON.stringify({ BackendState: 'Stopped' }) }), null);
  // A wedged CLI (bad JSON) falls through to the next path; a second good one still answers.
  let calls = 0;
  const twoClis = { ...base, clis: ['/a/tailscale', '/b/tailscale'], run: () => (++calls === 1 ? 'not json' : running) };
  assert.deepEqual(tailscalePeer(twoClis), { name: 'mac.tail1234.ts.net', ip: '100.64.0.7' });
  // Running but no 100.x address → null, not a half-answer.
  assert.equal(tailscalePeer({ ...base, run: () => JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'm.ts.net.', TailscaleIPs: ['fd7a::2'] } }) }), null);
});

test('the bridge: status, pair-link rotation, devices, unpair cutting off /events, loopback only', { timeout: 60_000 }, async (t) => {
  const state = mkdtempSync(join(tmpdir(), 'km-companion-'));
  const opened = [], events = [];
  let clock = Date.now();
  const companion = createCompanion({ state, port: 0, setupPort: 0, host: 'localhost', icon: null, now: () => clock, log: (e, d) => events.push([e, d]), openUrl: (url, done) => { opened.push(url); done(null); }, tailscale: () => null });
  t.after(async () => { await companion.stop(); rmSync(state, { recursive: true, force: true }); });
  assert.equal(companion.status().running, false);
  const up = await companion.start();
  const port = Number(new URL(up.app).port), ca = readFileSync(join(state, 'phone-tls', 'ca.pem'));
  assert.ok(existsSync(join(state, 'bar-link.key')), 'the bar link key is there for /turn');

  // GET /admin/status: exactly the doc's fields.
  const s = await call(ca, { port, path: '/admin/status' });
  assert.equal(s.status, 200);
  assert.deepEqual(Object.keys(s.json).sort(), ['app', 'devices', 'host', 'ip', 'remote', 'running', 'setup']);
  assert.equal(s.json.remote, null, 'no Tailscale in the test host → home-only, remote is null');
  assert.equal(s.json.running, true); assert.equal(s.json.devices, 0); assert.equal(s.json.host, 'localhost');
  assert.equal(s.json.app, `https://localhost:${port}`); assert.match(s.json.setup, /^http:\/\/localhost:\d+\/setup$/);

  // POST /admin/pair-link: fresh each time; ?fresh=0 gives the current one.
  const a = (await call(ca, { port, method: 'POST', path: '/admin/pair-link' })).json;
  assert.deepEqual(Object.keys(a).sort(), ['app', 'appLink', 'code', 'link', 'setupUrl']);
  assert.match(a.code, /^\d{6}$/); assert.match(a.link, /\/setup#pair=[a-f0-9]{32}$/); assert.equal(a.app, s.json.app);
  assert.equal(a.setupUrl, a.link, 'setupUrl is the QR-1 cert page (same value as the legacy link)');
  // appLink is the app origin + the same pairing token (QR 2: opens the app and pairs on open).
  assert.equal(a.appLink, `${a.app}/?pair=${a.link.split('#pair=')[1]}`);
  const b = (await call(ca, { port, method: 'POST', path: '/admin/pair-link' })).json;
  assert.notEqual(b.link, a.link);
  assert.deepEqual((await call(ca, { port, method: 'POST', path: '/admin/pair-link?fresh=0' })).json, b);
  assert.equal((await call(ca, { port, path: '/admin/pair-link' })).status, 404, 'pair-link is a POST');

  // Pairing by the QR's link: the old link is dead, the link rotates after a pairing.
  const token = (l) => /#pair=([a-f0-9]{32})$/.exec(l)[1];

  // The setup page (plain HTTP on the Wi-Fi) never carries the token: it lives in the link's #fragment, which a browser
  // never sends; the page reads it on the phone and hands it on only over TLS (https://…/?pair=).
  const setupPage = (q = '') => new Promise((resolve, reject) => {
    const u = new URL(s.json.setup);
    httpGet({ host: '127.0.0.1', port: u.port, path: `/setup${q}`, agent: false }, (res) => { let h = ''; res.setEncoding('utf8'); res.on('data', (x) => { h += x; }); res.on('end', () => resolve({ status: res.statusCode, html: h })); }).on('error', reject);
  });
  for (const q of ['', `?pair=${token(b.link)}`]) {
    const page = await setupPage(q);
    assert.equal(page.status, 200);
    assert.ok(!page.html.includes(token(b.link)), `the setup HTML has no token (${q || 'plain'})`);
    assert.match(page.html, /location\.hash/); assert.match(page.html, /'\/\?pair='\+pair/); assert.match(page.html, /six-digit pairing code/);
  }
  assert.equal((await call(ca, { port, path: `/?pair=${token(a.link)}` })).status, 403, 'a replaced link no longer pairs');
  const byLink = await call(ca, { port, path: `/?pair=${token(b.link)}` });
  assert.equal(byLink.status, 302); const phoneA = cookieFrom(byLink); assert.ok(phoneA);
  assert.equal((await call(ca, { port, path: `/?pair=${token(b.link)}` })).status, 403, 'a link pairs once');
  const c = (await call(ca, { port, method: 'POST', path: '/admin/pair-link?fresh=0' })).json;
  assert.notEqual(c.link, b.link, 'a pairing rotates the link');

  // Five wrong codes lock pairing for fifteen minutes (even the right code is refused), then a fresh code pairs.
  // (the dead link tried just above already counted as a miss, so the lock lands on the fourth wrong code)
  for (let i = 0; i < 5; i++) assert.ok([403, 429].includes((await call(ca, { port, method: 'POST', path: '/pair-code', body: { code: c.code === '000000' ? '000001' : '000000' } })).status));
  assert.equal((await call(ca, { port, method: 'POST', path: '/pair-code', body: { code: c.code } })).status, 429, 'locked: the right code is refused too');
  clock += 16 * 60_000;
  const d = (await call(ca, { port, method: 'POST', path: '/admin/pair-link?fresh=0' })).json;
  assert.notEqual(d.code, c.code, 'five wrong tries replace the code');
  const byCode = await call(ca, { port, method: 'POST', path: '/pair-code', body: { code: d.code } });
  assert.equal(byCode.status, 200); const phoneB = cookieFrom(byCode); assert.ok(phoneB);

  // GET /admin/devices: never the cookie hashes.
  const devs = (await call(ca, { port, path: '/admin/devices' })).json;
  assert.equal(devs.length, 2);
  for (const dev of devs) assert.deepEqual(Object.keys(dev).sort(), ['id', 'ip', 'lastSeen', 'name', 'pairedAt']);
  assert.equal((await call(ca, { port, path: '/admin/status' })).json.devices, 2);
  assert.ok(!JSON.stringify(devs).includes(phoneA.slice(3)) && !/hash/.test(JSON.stringify(devs)));
  const logged = JSON.stringify(events), barKey = readFileSync(join(state, 'bar-link.key'), 'utf8').trim();
  for (const secret of [a, b, c, d].flatMap((x) => [x.code, token(x.link)]).concat([phoneA.slice(3), phoneB.slice(3), barKey])) assert.ok(!logged.includes(secret), 'the log never carries a code, a token, a cookie or the bar key');

  // A phone's turn goes into the bar with the bar's key; a location lands, and /admin/locations shows the latest.
  assert.equal((await call(ca, { port, method: 'POST', path: '/turn', cookie: phoneB, body: { text: 'hello from the field' } })).status, 200);
  assert.match(opened.at(-1), new RegExp(`^kingmaker://bar\\?text=hello%20from%20the%20field&key=${readFileSync(join(state, 'bar-link.key'), 'utf8').trim()}$`));
  assert.equal((await call(ca, { port, method: 'POST', path: '/field/location', cookie: phoneB, body: { lat: 33.4, lon: -112.1, acc: 8 } })).status, 200);
  const locs = (await call(ca, { port, path: '/admin/locations' })).json;
  assert.equal(locs.length, 1); assert.deepEqual(Object.keys(locs[0]).sort(), ['accuracy', 'at', 'device', 'lat', 'lon']);

  // Unpair cuts the phone off at once, mid-stream: /events says `unpaired` and closes; the cookie is dead.
  const idA = devs.find((x) => x.id !== locs[0].device).id;
  mkdirSync(join(state, 'logs'), { recursive: true });
  writeFileSync(join(state, 'logs', 'bar.log'), `${new Date().toISOString()} Kingmaker: hello\n`);
  let t0 = 0;
  const ended = await new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/events', ca, headers: { cookie: phoneA } }, (res) => {
      let data = ''; res.setEncoding('utf8');
      res.on('data', (x) => {
        data += x;
        if (!t0) { t0 = Date.now(); call(ca, { port, method: 'POST', path: `/admin/unpair?id=${idA}` }).then((r) => assert.deepEqual(r.json, { unpaired: 1 })).catch(reject); }
      });
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    req.on('error', reject); req.end();
  });
  assert.match(ended.data, /"who":"Kingmaker","text":"hello"/, 'the stream was live first');
  assert.equal(ended.status, 200); assert.match(ended.data, /event: unpaired/);
  assert.ok(Date.now() - t0 < 5_000, 'cut off within seconds');
  assert.equal((await call(ca, { port, path: '/events', cookie: phoneA })).status, 401);
  assert.equal((await call(ca, { port, method: 'POST', path: '/turn', cookie: phoneA, body: { text: 'x' } })).status, 401);
  assert.deepEqual((await call(ca, { port, method: 'POST', path: '/admin/unpair?id=all' })).json, { unpaired: 1 });
  assert.equal((await call(ca, { port, path: '/admin/status' })).json.devices, 0);

  // Anything not from loopback gets 403 on every /admin route (reached over this Mac's LAN address).
  const ip = lanIp();
  if (ip === '127.0.0.1') t.diagnostic('no LAN address: the non-loopback check ran on the predicate only');
  else {
    for (const [method, path] of [['GET', '/admin/status'], ['POST', '/admin/pair-link'], ['GET', '/admin/devices'], ['POST', '/admin/unpair?id=all'], ['GET', '/admin/locations']]) {
      const r = await call(ca, { host: ip, port, method, path });
      assert.equal(r.status, 403, `${method} ${path} from ${ip}`);
    }
    assert.equal((await call(ca, { host: ip, port, path: '/ping' })).status, 200, 'the phone side still answers on the LAN');
  }

  // Stop: the port is closed and status says so.
  const down = await companion.stop();
  assert.equal(down.running, false); assert.equal(down.app, null);
  await assert.rejects(call(ca, { port, path: '/admin/status' }), /ECONNREFUSED/);
});

test('a taken port fails the start cleanly, and the companion can start after', { timeout: 30_000 }, async (t) => {
  const state = mkdtempSync(join(tmpdir(), 'km-companion-port-'));
  const first = createCompanion({ state, port: 0, setupPort: 0, host: 'localhost', icon: null });
  t.after(async () => { await first.stop(); rmSync(state, { recursive: true, force: true }); });
  const port = Number(new URL((await first.start()).app).port);
  const second = createCompanion({ state, port, setupPort: 0, host: 'localhost', icon: null });
  await assert.rejects(second.start(), (e) => e.code === 'EADDRINUSE');
  assert.equal(second.status().running, false);
  await first.stop();
  const again = await second.start(); assert.equal(again.running, true);
  await second.stop();
});

test('the engine runs the companion: control line, remembered on/off, stop on shutdown', () => {
  const cli = readFileSync(at('lib/cli.mjs'), 'utf8');
  assert.match(cli, /import \{ companionControl, companionWanted, createCompanion, setCompanionWanted \} from '\.\/phone-companion\.mjs'/);
  assert.match(cli, /else if \(companionControl\(said\)\) void companionOp\(companionControl\(said\)\)\.then\(\(s\) => process\.stdout\.write\(`@@ghost \$\{JSON\.stringify\(\{ companion: s \}\)\}\\n`\)\)/);
  assert.match(cli, /if \(op === 'start'\) \{ setCompanionWanted\(paths\.state, true\)/);
  assert.match(cli, /else if \(op === 'stop'\) \{ setCompanionWanted\(paths\.state, false\)/);
  assert.match(cli, /if \(companionWanted\(paths\.state\)\) void companionOp\('start'\)/);
  assert.match(cli, /await companionStop\(\)\.catch/);
  // A phone's turn is the engine's own typed-turn line, in-process: no URL, no open, no key. It carries the phone's
  // stable conversationId (a resuming thread) and the latest field photo as `image`, both forwarded in the payload.
  assert.match(cli, /onTurn: async \(text, meta\) => \{ if \(!phoneTurn\) throw new Error\('Kingmaker runs without its bar'\); phoneTurn\(text, meta\); \}/);
  assert.match(cli, /phoneTurn = \(text, meta = \{\}\) => onControlLines\(`typed-turn \$\{Buffer\.from\(JSON\.stringify\(\{ text, model: 'auto', \.\.\.\(meta\?\.conversationId \? \{ conversationId: meta\.conversationId \} : \{\}\), \.\.\.\(meta\?\.image \? \{ image: meta\.image \} : \{\}\) \}\)/);
  assert.match(cli, /process\.stdin\.on\('data', onControlLines\)/);
  assert.ok(!/bar-link\.key|kingmaker:\/\/bar\?/.test(cli), 'the engine never builds a bar link or reads its key');
  // The companion line is the last branch, so no earlier control line (stop, pair…) can swallow it.
  const branch = cli.indexOf('else if (companionControl(said))');
  assert.ok(branch > cli.indexOf("else if (/^pair\\b/.test(said))") && branch > cli.indexOf("else if (/^stop\\b/.test(said))"));
});

test('kingmaker://companion → the control line, never the bar or focus', { timeout: 120_000 }, (t) => {
  const swift = readFileSync(at('app/Kingmaker.swift'), 'utf8');
  assert.match(swift, /case "companion": if let line = companionControlLine\(url\) \{ requestCompanion\(line\) \}/);
  const handler = swift.slice(swift.indexOf('private func requestCompanion('), swift.indexOf('private func requestPair('));
  assert.ok(handler.length > 0 && !/bar\.|activate|makeKeyAndOrderFront|orderFront|show\(/.test(handler), 'requestCompanion only writes the line');
  assert.match(swift, /if let line = pendingCompanion, let pipe = stdinPipe \{\s*pendingCompanion = nil\s*pipe\.fileHandleForWriting\.write\("\\\(line\)\\n"/);

  // The mapping itself, run by Swift.
  const fn = /\/\/ BEGIN companionControlLine[^\n]*\n([\s\S]*?)\/\/ END companionControlLine/.exec(swift)?.[1];
  assert.ok(fn, 'companionControlLine is marked');
  const swiftBin = ['/usr/bin/swift', '/usr/local/bin/swift'].find((p) => existsSync(p));
  if (!swiftBin) { t.skip('no swift on this Mac'); return; }
  const dir = mkdtempSync(join(tmpdir(), 'km-companion-swift-'));
  try {
    const cases = ['kingmaker://companion?op=start', 'kingmaker://companion?op=stop', 'kingmaker://companion?op=STATUS', 'solghost://companion?op=start',
      'kingmaker://companion?op=restart', 'kingmaker://companion', 'kingmaker://bar?op=start', 'https://companion?op=start', 'kingmaker://companion?op=start%0Aquit'];
    writeFileSync(join(dir, 'main.swift'), `import Foundation\n${fn}\nfor s in ${JSON.stringify(cases)} { print(companionControlLine(URL(string: s)!) ?? "nil") }\n`);
    const out = execFileSync(swiftBin, [join(dir, 'main.swift')], { encoding: 'utf8', timeout: 110_000 }).trim().split('\n');
    assert.deepEqual(out, ['companion start', 'companion stop', 'companion status', 'companion start', 'nil', 'nil', 'nil', 'nil', 'nil']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('scripts/phone-companion.mjs is a thin wrapper with devices and unpair', () => {
  const state = mkdtempSync(join(tmpdir(), 'km-companion-cli-'));
  const run = (...a) => { try { return { code: 0, out: execFileSync(process.execPath, [at('scripts/phone-companion.mjs').pathname, ...a], { encoding: 'utf8', env: { ...process.env, SOL_GHOST_HOME: state } }) }; } catch (e) { return { code: e.status, out: `${e.stdout}${e.stderr}` }; } };
  try {
    assert.match(run('devices').out, /No phones paired\./);
    deviceStore(state).save([{ id: 'abc123', hashes: ['x'], name: 'iPhone (iOS 26.1)', ip: '192.168.1.9', pairedAt: '2026-10-15T00:00:00Z', lastSeen: null }, { id: 'def456', hashes: ['y'], name: 'iPad', ip: '192.168.1.10', pairedAt: '2026-10-15T00:00:00Z' }]);
    const listed = run('devices').out;
    assert.match(listed, /abc123 {2}iPhone \(iOS 26\.1\)/); assert.ok(!/hashes|"x"/.test(listed));
    assert.equal(run('unpair').code, 2);
    assert.equal(run('unpair', 'nope').code, 1);
    assert.match(run('unpair', 'abc123').out, /Unpaired abc123\./);
    assert.match(run('unpair', 'all').out, /Unpaired 1 phone\./);
    assert.equal(deviceStore(state).load().length, 0);
  } finally { rmSync(state, { recursive: true, force: true }); }
});

// ── Pairing: ten-minute single-use code, a lock after five misses, attempts logged without the code, a paired phone keeps access.
test('pairing: the code expires after ten minutes, is single use, locks after five misses for fifteen minutes, logs no secret, and a paired phone keeps its access', { timeout: 60_000 }, async (t) => {
  const state = mkdtempSync(join(tmpdir(), 'km-companion-pair-'));
  const events = []; let clock = Date.now();
  const companion = createCompanion({ state, port: 0, setupPort: 0, host: 'localhost', icon: null, now: () => clock, log: (e, d) => events.push([e, d]), tailscale: () => null });
  t.after(async () => { await companion.stop(); rmSync(state, { recursive: true, force: true }); });
  const up = await companion.start();
  const port = Number(new URL(up.app).port), ca = readFileSync(join(state, 'phone-tls', 'ca.pem'));
  const code = (x) => call(ca, { port, method: 'POST', path: '/pair-code', body: { code: x } });
  const fresh = async () => (await call(ca, { port, method: 'POST', path: '/admin/pair-link' })).json;
  const wrong = (c) => (c === '000000' ? '000001' : '000000');

  // Single use: the code pairs once, and the same code pairs nobody else.
  let p = await fresh();
  const first = await code(p.code); assert.equal(first.status, 200);
  const phone = cookieFrom(first); assert.ok(phone);
  assert.equal((await code(p.code)).status, 403, 'a used code is dead');

  // Expiry: nine minutes is fine, eleven is not; a fresh code is made on demand.
  p = await fresh(); clock += PAIR_CODE_TTL_MS - 60_000;
  assert.equal((await code(wrong(p.code))).status, 403);
  clock += 2 * 60_000;
  const late = await code(p.code);
  assert.equal(late.status, 403); assert.equal(late.json.expired, true, 'ten minutes on, the code is refused as expired');
  const renewed = (await call(ca, { port, method: 'POST', path: '/admin/pair-link?fresh=0' })).json;
  assert.notEqual(renewed.code, p.code, 'asking again after expiry gives a new code');
  assert.equal(renewed.link, p.link, 'the link token is unchanged');

  // Throttle: five wrong tries lock BOTH the code and the link for fifteen minutes.
  p = await fresh();
  for (let i = 0; i < 5; i++) assert.equal((await code(wrong(p.code))).status, 403);
  const locked = await code(p.code);
  assert.equal(locked.status, 429); assert.ok(Number(locked.headers['retry-after']) > 0);
  const tok = (l) => /#pair=([a-f0-9]{32})$/.exec(l)[1];
  const lockedLink = await call(ca, { port, path: `/?pair=${tok((await fresh()).link)}` });
  assert.equal(lockedLink.status, 429, 'the link is locked too');
  clock += PAIR_LOCK_MS - 60_000;
  assert.equal((await code((await fresh()).code)).status, 429, 'still locked at fourteen minutes');
  clock += 2 * 60_000;
  p = await fresh();
  assert.equal((await code(p.code)).status, 200, 'pairing works again after fifteen minutes');

  // A phone that is already paired is never locked out or expired: its cookie keeps working through all of it.
  for (let i = 0; i < 5; i++) await code(wrong('123456'));
  clock += 30 * 24 * 3600_000 / 4;
  assert.equal((await call(ca, { port, path: '/push/key', cookie: phone })).status, 200, 'the first phone still has its access');
  assert.equal((await call(ca, { port, path: '/push/key' })).status, 401, 'while an unpaired caller has none');
  assert.equal((await call(ca, { port, path: '/admin/status' })).json.devices, 2);

  // Attempts are logged (who, how, whether), the code and the token never.
  const attempts = events.filter(([e]) => e === 'pair_attempt');
  assert.ok(attempts.length >= 12 && attempts.some(([, d]) => d.ok === true) && attempts.some(([, d]) => d.why === 'wrong code') && attempts.some(([, d]) => d.why === 'locked') && attempts.some(([, d]) => d.why === 'expired'));
  assert.ok(events.some(([e]) => e === 'pairing_locked'));
  assert.ok(attempts.every(([, d]) => typeof d.ip === 'string' || d.via === 'paired'));
  const logged = JSON.stringify(events);
  for (const secret of [p.code, renewed.code, tok(p.link)]) assert.ok(!logged.includes(secret), 'no code or token in the log');
});

// ── The Local CA: constrained, short-lived, 0600 key; a certificate for any other name does not verify under it.
test('the Local CA carries critical nameConstraints and a two-year life, keeps its key 0600, and will not vouch for a public site', { timeout: 60_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'km-ca-'));
  const ssl = (...args) => execFileSync('/usr/bin/openssl', args, { stdio: ['pipe', 'pipe', 'pipe'] }).toString();
  try {
    const tls = join(dir, 'tls');
    ensureTls(tls, 'testmac.local', ['DNS:mac.tail1234.ts.net', 'IP:100.101.102.103']);
    const text = ssl('x509', '-in', join(tls, 'ca.pem'), '-noout', '-text');
    assert.match(text, /Name Constraints: critical/); assert.match(text, /DNS:\.local/); assert.match(text, /IP:192\.168\.0\.0\/255\.255\.0\.0/);
    const days = (new Date(/Not After : (.*)/.exec(text)[1]) - new Date(/Not Before: (.*)/.exec(text)[1])) / 86_400_000;
    assert.ok(days <= 731 && CA_DAYS <= 730, `CA life ${days} days`);
    assert.equal(statSync(join(tls, 'ca.key')).mode & 0o777, 0o600, 'the CA key is 0600');
    assert.equal(statSync(tls).mode & 0o777, 0o700, 'in a 0700 folder');
    // The server certificate for the Mac's own names verifies…
    assert.match(ssl('verify', '-CAfile', join(tls, 'ca.pem'), join(tls, 'server.pem')), /OK/);
    // …and a certificate the CA signs for a public site, or a public IP, does not.
    for (const san of ['DNS:www.bank.example.com', 'IP:8.8.8.8']) {
      writeFileSync(join(dir, 'e.cnf'), `[req]\ndistinguished_name=dn\nprompt=no\n[dn]\nCN=evil\n[v3]\nbasicConstraints=critical,CA:false\nextendedKeyUsage=serverAuth\nsubjectAltName=${san}\n`);
      ssl('genrsa', '-out', join(dir, 'e.key'), '2048');
      ssl('req', '-new', '-key', join(dir, 'e.key'), '-config', join(dir, 'e.cnf'), '-out', join(dir, 'e.csr'));
      ssl('x509', '-req', '-in', join(dir, 'e.csr'), '-CA', join(tls, 'ca.pem'), '-CAkey', join(tls, 'ca.key'), '-CAcreateserial', '-days', '30', '-sha256', '-extfile', join(dir, 'e.cnf'), '-extensions', 'v3', '-out', join(dir, 'e.pem'));
      assert.throws(() => ssl('verify', '-CAfile', join(tls, 'ca.pem'), join(dir, 'e.pem')), undefined, `${san} must not verify`);
    }
    // An EXISTING CA is left alone (paired phones trust that exact one): a second call keeps the same file.
    const before = readFileSync(join(tls, 'ca.pem'));
    ensureTls(tls, 'testmac.local');
    assert.deepEqual(readFileSync(join(tls, 'ca.pem')), before);
    assert.match(caConfig('Evil Host!.local'), /nameConstraints=critical,/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
