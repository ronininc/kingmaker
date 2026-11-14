// END-TO-END proof: the real Ronin CRM worker (worker/index + the OfficeHub Durable Object + /mcp/solomon, every
// migration in D1) runs in-process in Miniflare, and lib/floor-participant.mjs ("Mia") is driven against it exactly as
// it would run on the Mac — its real CRM MCP client and its real floor-socket state machine, only the transport pointed
// at Miniflare's dispatchFetch (no port, no mic, no network). It proves the gap the brief names: with Mia running,
// GET /api/meetings is no longer empty.
//
//   join the floor → two synthetic people in the owner's office → a scripted exchange with an action item →
//   "Mia, wrap it up" → meeting_propose → GET /api/meetings shows Mia's meeting with the proposed task.
//
// Needs the ronininc-crm checkout and its node_modules (miniflare, esbuild). Set SOL_GHOST_CRM to point elsewhere.
//   node --test test/floor-participant-e2e.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { randomBytes, createHash } from 'node:crypto';
import { crmMcpClient, MeetingParticipant } from '../lib/floor-participant.mjs';

const CRM = process.env.SOL_GHOST_CRM || join(homedir(), 'Projects', 'ronininc-crm');
const BASE = 'https://ronininc.org';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const nowSecs = () => Math.floor(Date.now() / 1000);
let mf = null; let dispose = null;

const haveCrm = existsSync(join(CRM, 'worker', 'index.ts')) && existsSync(join(CRM, 'node_modules', 'miniflare')) && existsSync(join(CRM, 'node_modules', 'esbuild'));

before(async () => {
  if (!haveCrm) return;
  const require = createRequire(pathToFileURL(join(CRM, 'package.json')));
  const { build } = require('esbuild');
  const { Miniflare, convertV4MiniflareOptions } = require('miniflare');
  // Entry: the real worker + the real OfficeHub, imported by absolute path so nothing is written into the CRM tree.
  const outDir = join(tmpdir(), 'mia-e2e-' + randomBytes(4).toString('hex'));
  await mkdir(outDir, { recursive: true });
  const esc = (p) => p.replace(/\\/g, '/');
  await writeFile(join(outDir, 'entry.mjs'), `
import app from '${esc(join(CRM, 'worker/index'))}';
export { OfficeHub } from '${esc(join(CRM, 'worker/office/hub-do'))}';
export default { fetch: (req, env, ctx) => app.fetch(req, env, ctx) };`);
  await build({ entryPoints: [join(outDir, 'entry.mjs')], outfile: join(outDir, 'worker.mjs'), bundle: true, format: 'esm', platform: 'node', external: ['cloudflare:workers', 'cloudflare:email'], logLevel: 'silent', absWorkingDir: CRM });
  const script = await readFile(join(outDir, 'worker.mjs'), 'utf8');
  const fed = { self: 'ronin', selfName: 'Ronin Inc', peers: [] };
  mf = new Miniflare(convertV4MiniflareOptions({ workers: [{
    name: 'mia-e2e', modules: true, script, compatibilityDate: '2026-08-01', compatibilityFlags: ['nodejs_compat'], d1Databases: ['DB'],
    durableObjects: { OFFICE_HUB: { className: 'OfficeHub', useSQLite: true } },
    bindings: { FLOOR_FEDERATION: JSON.stringify(fed) }, serviceBindings: { ASSETS: () => new Response('Not found', { status: 404 }) },
  }] }));
  dispose = () => mf.dispose();
  const db = await mf.getD1Database('DB');
  const migrations = (await readdir(join(CRM, 'migrations'))).filter((f) => f.endsWith('.sql')).sort();
  for (const f of migrations) await db.exec((await readFile(join(CRM, 'migrations', f), 'utf8')).replace(/--[^\n]*/g, '').replace(/\n/g, ' '));
});
after(async () => { await dispose?.(); });

const df = (path, opts = {}) => mf.dispatchFetch(BASE + path, opts);
async function call(path, { method = 'GET', cookie, body } = {}) {
  const headers = { 'content-type': 'application/json', origin: BASE };
  if (cookie) headers.cookie = cookie;
  const r = await df(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch { /* */ }
  return { status: r.status, body: j, text, headers: r.headers };
}

/** A synthetic member's floor socket over dispatchFetch (same as a browser tab). */
async function personSocket(cookie) {
  const res = await df('/api/office/ws', { headers: { upgrade: 'websocket', cookie, origin: BASE } });
  const ws = res.webSocket; ws.accept();
  const got = [];
  ws.addEventListener('message', (ev) => { try { got.push(JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8'))); } catch { /* */ } });
  const init = await new Promise((resolve) => { const t = setInterval(() => { const m = got.find((x) => x.t === 'init'); if (m) { clearInterval(t); resolve(m); } }, 10); setTimeout(() => { clearInterval(t); resolve(null); }, 4000); });
  return {
    id: init?.you?.id, userId: init?.you?.userId,
    send: (m) => ws.send(JSON.stringify(m)),
    move: (room, x, y) => ws.send(JSON.stringify({ t: 'move', x, y, dir: 'down', room })),
    chat: (text) => ws.send(JSON.stringify({ t: 'chat', text })),
    close: () => { try { ws.close(1000, 'done'); } catch { /* */ } },
  };
}

/** The transport the participant uses here: the floor socket over dispatchFetch. */
async function miniflareTransport(url) {
  const res = await df(url.replace(BASE, ''), { headers: { upgrade: 'websocket' } });
  if (res.status !== 101 || !res.webSocket) return { status: res.status, send() {}, close() {}, onMessage() {}, onClose() {} };
  const ws = res.webSocket; ws.accept();
  const L = { message: [], close: [] };
  ws.addEventListener('message', (ev) => { const s = typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8'); for (const cb of L.message) cb(s); });
  ws.addEventListener('close', () => { for (const cb of L.close) cb(); });
  return { status: 101, send: (s) => { try { ws.send(s); } catch { /* */ } }, close: () => { try { ws.close(1000, 'bye'); } catch { /* */ } }, onMessage: (cb) => L.message.push(cb), onClose: (cb) => L.close.push(cb) };
}

test('Mia joins the real CRM floor, takes notes, and makes GET /api/meetings non-empty', { skip: haveCrm ? false : `ronininc-crm not found at ${CRM}` }, async () => {
  const db = await mf.getD1Database('DB');
  // Owner (the first registered user is admin).
  const reg = await df('/api/auth/register', { method: 'POST', headers: { origin: BASE, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Olivia Owner', email: 'owner@ronininc.org', password: randomBytes(12).toString('hex') }) });
  const ownerCookie = (reg.headers.get('set-cookie') || '').split(';')[0];
  assert.ok(ownerCookie, `register failed: ${reg.status}`);
  const owner = await db.prepare("SELECT id FROM users WHERE role='admin'").first();
  // Open the floor (meetings here are on the open floor; invite-only is a separate concern).
  await call('/api/floor/policy', { method: 'POST', cookie: ownerCookie, body: { invite_only: false } });
  // One more member, so the owner's office holds two distinct people.
  const dana = { id: 'u-' + randomBytes(6).toString('hex'), token: randomBytes(32).toString('hex') };
  await db.prepare("INSERT INTO clearances (id, name, perms, is_system, created_at) VALUES ('cl_sales','Sales Rep','[\"crm\"]',0, unixepoch())").run().catch(() => {});
  await db.prepare("INSERT INTO users (id, name, email, role, pass_hash, pass_salt, clearance_id) VALUES (?,?,?,?, 'x','x','cl_sales')").bind(dana.id, 'Dana Rep', dana.id + '@ronininc.org', 'viewer').run();
  await db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)').bind(dana.token, dana.id, nowSecs() + 3600).run();
  const danaCookie = 'ronin_admin=' + dana.token;
  // An owner-minted MCP token: Mia's credential.
  const minted = await call('/api/admin/mcp/token', { method: 'POST', cookie: ownerCookie, body: { role: 'solomon' } });
  const token = minted.body?.token;
  assert.ok(typeof token === 'string' && token.startsWith('ronin_solomon_'), `token mint failed: ${minted.text}`);

  // Baseline: no meetings yet.
  const before = await call('/api/meetings', { cookie: ownerCookie });
  assert.equal(before.body?.meetings?.length ?? 0, 0, 'starts empty');

  // Mia, wired exactly as on the Mac but over dispatchFetch.
  const mcp = crmMcpClient({ url: BASE + '/mcp/solomon', token, fetchImpl: (url, opts) => df(url.replace(BASE, ''), opts) });
  const events = [];
  const mia = new MeetingParticipant({ mcp, name: 'Mia', wsBase: BASE + '/api/office/ws', openTransport: miniflareTransport, log: (e, d) => events.push({ e, ...d }) });
  assert.equal(await mia.start(), true, 'Mia got onto the floor');

  // Two people walk into the owner's office and talk.
  const a = await personSocket(ownerCookie);
  const b = await personSocket(danaCookie);
  a.move('owner', 10, 5); b.move('owner', 11, 5);
  for (let i = 0; i < 80 && !mia.meetings.get('owner'); i += 1) await sleep(100); // let Mia see the room fill and walk her orb in (poll; robust under suite load)
  assert.ok(mia.meetings.get('owner'), `Mia did not join the owner's office; events=${JSON.stringify(events)}`);

  a.chat("I'll send Pizza Studio the updated quote by Friday");
  b.chat('great, and we should schedule the onboarding call for next week');
  a.chat('Mia, wrap it up');
  // Wait for the proposal to land.
  let proposed = null;
  for (let i = 0; i < 40 && !proposed; i += 1) { await sleep(150); proposed = events.find((e) => e.e === 'proposed' && e.room === 'owner'); }
  assert.ok(proposed, `Mia never proposed; events=${JSON.stringify(events)}`);
  assert.ok(proposed.meeting_id, 'proposal returned a meeting_id');

  // The gap is closed: GET /api/meetings is no longer empty, and Mia's meeting carries the action item.
  const seen = await call('/api/meetings', { cookie: ownerCookie });
  const meetings = seen.body?.meetings ?? [];
  assert.ok(meetings.length >= 1, `GET /api/meetings still empty: ${seen.text?.slice(0, 300)}`);
  const mine = await call('/api/meetings/' + proposed.meeting_id, { cookie: ownerCookie });
  assert.equal(mine.body?.meeting?.room, 'owner');
  assert.ok((mine.body?.meeting?.participants || []).some((p) => p.name === 'Olivia Owner' || p.name === 'Dana Rep'), 'participants captured');
  const titles = (mine.body?.tasks || []).map((t) => t.title).join(' | ');
  assert.ok(/quote|onboarding/i.test(titles), `proposed tasks missing the action items: ${titles}`);
  a.close(); b.close(); await mia.stop();
});
