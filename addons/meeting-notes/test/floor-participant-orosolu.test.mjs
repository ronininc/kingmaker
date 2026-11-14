// END-TO-END against the OWNER'S LIVE CRM code: the real Orosolu worker (src/index.js + its OfficeHub + /mcp, every
// migration in D1) in Miniflare, driven by lib/floor-participant.mjs's REAL CRM MCP client. Proves the Orosolu side of
// the contract — office_ticket (a ticket + the orb spots incl. the owner office) and meeting_propose (it files a
// meeting) — with the participant exactly as it runs on the Mac, only pointed at Miniflare's dispatchFetch.
//
// Read-only: it builds from the worktree's src + migrations into a tmp dir and never writes into the worktree.
// Orosolu's /mcp is plain JSON (not SSE) and accepts the server token as Bearer — the participant's client handles both.
//   SOL_GHOST_OROSOLU_CRM=/path/to/orosolu-crm node --test test/floor-participant-orosolu.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { readFile, readdir, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { crmMcpClient } from '../lib/floor-participant.mjs';

const W = process.env.SOL_GHOST_OROSOLU_CRM || '/Users/yordanrivera/Desktop/KM-Orosolu/crm-wt-neon';
const TOKEN = 'proof-only-mia';
const BASE = 'https://crm.orosolu.org';
const have = existsSync(join(W, 'src', 'index.js')) && existsSync(join(W, 'src', 'office-hub.js')) && existsSync(join(W, 'node_modules', 'miniflare'));
let mf = null; let dir = null;

before(async () => {
  if (!have) return;
  const require = createRequire(pathToFileURL(join(W, 'package.json')));
  const { build } = require('esbuild');
  const { Miniflare, convertV4MiniflareOptions } = require('miniflare');
  dir = await mkdtemp(join(tmpdir(), 'mia-orosolu-'));
  const esc = (p) => p.replace(/\\/g, '/');
  await writeFile(join(dir, 'entry.mjs'), `
import app from '${esc(join(W, 'src/index.js'))}';
export { OfficeHub } from '${esc(join(W, 'src/office-hub.js'))}';
export default app;`);
  await build({ entryPoints: [join(dir, 'entry.mjs')], outfile: join(dir, 'worker.mjs'), bundle: true, format: 'esm', platform: 'node', external: ['cloudflare:email', 'cloudflare:workers'], logLevel: 'silent', absWorkingDir: W });
  mf = new Miniflare(convertV4MiniflareOptions({ workers: [{
    name: 'mia-orosolu-proof', modules: true, script: await readFile(join(dir, 'worker.mjs'), 'utf8'),
    compatibilityDate: '2026-09-01', compatibilityFlags: ['nodejs_compat'], d1Databases: ['DB'],
    durableObjects: { OFFICE_HUB: { className: 'OfficeHub', useSQLite: true } },
    bindings: { MIA_MCP_TOKEN: TOKEN }, serviceBindings: { ASSETS: async () => new Response('', { status: 404 }) },
  }] }));
  const db = await mf.getD1Database('DB');
  for (const f of (await readdir(join(W, 'migrations'))).filter((x) => x.endsWith('.sql')).sort()) await db.exec((await readFile(join(W, 'migrations', f), 'utf8')).replace(/--[^\n]*/g, '').replace(/\n/g, ' '));
});
after(async () => { await mf?.dispose(); if (dir) await rm(dir, { recursive: true, force: true }); });

test('Mia drives office_ticket + meeting_propose against the real Orosolu worker', { skip: have ? false : `orosolu-crm not found at ${W}` }, async () => {
  const mcp = crmMcpClient({ url: BASE + '/mcp', token: TOKEN, fetchImpl: (url, opts) => mf.dispatchFetch(url, opts) });

  // office_ticket: a one-use ticket, the orb spots (incl. the owner office), the floor settings, and the ws path.
  const tk = await mcp.callTool('office_ticket', { name: 'Mia' });
  assert.ok(tk.enabled, `meetings switched off: ${JSON.stringify(tk)}`);
  assert.match(String(tk.ticket), /^[A-Za-z0-9_-]{20,64}$/, 'a usable ticket');
  assert.equal(tk.ws_path, '/api/office/ws');
  assert.ok(tk.spots && tk.spots.owner, `no orb spot for the owner office: ${JSON.stringify(tk.spots)}`);
  assert.ok(tk.settings && typeof tk.settings.min_people === 'number', 'floor settings present');

  // meeting_propose: file a scripted room's notes + a proposed task, exactly as the participant would at wrap-up.
  const startedAt = Date.now() - 60_000;
  const res = await mcp.callTool('meeting_propose', {
    room: 'owner', started_at: startedAt, ended_at: Date.now(),
    participants: [{ name: 'Robbie' }, { name: 'Dana' }],
    transcript: [
      { at: startedAt + 1000, speaker: 'Robbie', text: "I'll send Pizza Studio the updated quote by Friday" },
      { at: startedAt + 2000, speaker: 'Dana', text: 'and schedule the onboarding call for next week' },
    ],
    synopsis: 'Robbie, Dana — 2 action items.',
    tasks: [{ title: 'Send Pizza Studio the updated quote', detail: 'by Friday', evidence: [0] }],
  });
  assert.ok(res.meeting_id, `meeting_propose returned no id: ${JSON.stringify(res)}`);
  assert.equal(res.status, 'proposed');

  // The gap is closed on the owner's own CRM code: the meeting row and its proposed task are in the DB.
  const db = await mf.getD1Database('DB');
  const m = await db.prepare('SELECT id, room, status FROM meetings WHERE id = ?').bind(res.meeting_id).first();
  assert.ok(m && m.room === 'owner' && m.status === 'proposed', `meeting not filed: ${JSON.stringify(m)}`);
  const k = await db.prepare('SELECT title, status FROM meeting_tasks WHERE meeting_id = ?').bind(res.meeting_id).first();
  assert.ok(k && /quote/i.test(k.title) && k.status === 'proposed', `task not filed: ${JSON.stringify(k)}`);
});
