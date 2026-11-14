// FULL SPOKEN FLOW, end to end: the real Ronin CRM worker + OfficeHub + /mcp/solomon in Miniflare, the REAL participant
// with live audio on, and a fake BROWSER PEER whose werift mic streams spoken Opus — with the WebRTC offer/answer/ICE
// carried THROUGH the hub's own {t:'signal'} relay (not a shortcut). Two people in the owner's office, note-taking on →
// Mia joins → she transcribes the LIVE audio on the Mac → "Mia, wrap it up" → meeting_propose → GET /api/meetings is
// non-empty with a task built from what was SPOKEN. This is the parent session's acceptance bar for spoken meetings.
//
// Media flows peer-to-peer over loopback (both werift PeerConnections are in this process); the hub only relays sign
// -alling. Needs ronininc-crm + miniflare/esbuild, the vendored WebRTC bundle, and the installed whisper + say/afconvert.
//   node --test --test-force-exit test/floor-participant-audio-e2e.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { crmMcpClient, MeetingParticipant, makeTranscriber, wavToSamples } from '../lib/floor-participant.mjs';
import { loadWebrtc } from '../lib/floor-audio-webrtc.mjs';
import { transcribe } from '../../../lib/voice.mjs';

const CRM = process.env.SOL_GHOST_CRM || join(homedir(), 'Projects', 'ronininc-crm');
const BASE = 'https://ronininc.org';
const WHISPER = process.env.SOL_GHOST_WHISPER || '/Applications/Kingmaker.app/Contents/Resources/voice-runtime/stt/whisper-cli';
const MODEL = process.env.SOL_GHOST_WHISPER_MODEL || '/Applications/Kingmaker.app/Contents/Resources/voice-runtime/models/stt/ggml-base.bin';
const VENDOR = fileURLToPath(new URL('../vendor/webrtc/webrtc-libs.mjs', import.meta.url));
const has = (b) => { try { execFileSync('/usr/bin/which', [b], { stdio: 'ignore' }); return true; } catch { return false; } };
const ready = process.platform === 'darwin' && existsSync(join(CRM, 'worker', 'index.ts')) && existsSync(join(CRM, 'node_modules', 'miniflare'))
  && existsSync(VENDOR) && existsSync(WHISPER) && existsSync(MODEL) && has('say') && has('afconvert');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowSecs = () => Math.floor(Date.now() / 1000);
let mf = null; let dispose = null;

before(async () => {
  if (!ready) return;
  const require = createRequire(pathToFileURL(join(CRM, 'package.json')));
  const { build } = require('esbuild');
  const { Miniflare, convertV4MiniflareOptions } = require('miniflare');
  const outDir = join(tmpdir(), 'mia-audio-e2e-' + randomBytes(4).toString('hex'));
  await mkdir(outDir, { recursive: true });
  const esc = (p) => p.replace(/\\/g, '/');
  await writeFile(join(outDir, 'entry.mjs'), `
import app from '${esc(join(CRM, 'worker/index'))}';
export { OfficeHub } from '${esc(join(CRM, 'worker/office/hub-do'))}';
export default { fetch: (req, env, ctx) => app.fetch(req, env, ctx) };`);
  await build({ entryPoints: [join(outDir, 'entry.mjs')], outfile: join(outDir, 'worker.mjs'), bundle: true, format: 'esm', platform: 'node', external: ['cloudflare:workers', 'cloudflare:email'], logLevel: 'silent', absWorkingDir: CRM });
  mf = new Miniflare(convertV4MiniflareOptions({ workers: [{
    name: 'mia-audio-e2e', modules: true, script: await readFile(join(outDir, 'worker.mjs'), 'utf8'),
    compatibilityDate: '2026-08-01', compatibilityFlags: ['nodejs_compat'], d1Databases: ['DB'],
    durableObjects: { OFFICE_HUB: { className: 'OfficeHub', useSQLite: true } },
    bindings: { FLOOR_FEDERATION: JSON.stringify({ self: 'ronin', selfName: 'Ronin Inc', peers: [] }) },
    serviceBindings: { ASSETS: async () => new Response('', { status: 404 }) },
  }] }));
  dispose = () => mf.dispose();
  const db = await mf.getD1Database('DB');
  for (const f of (await readdir(join(CRM, 'migrations'))).filter((x) => x.endsWith('.sql')).sort()) await db.exec((await readFile(join(CRM, 'migrations', f), 'utf8')).replace(/--[^\n]*/g, '').replace(/\n/g, ' '));
});
after(async () => { await dispose?.(); });

const df = (p, opts = {}) => mf.dispatchFetch(BASE + p, opts);
async function call(p, { method = 'GET', cookie, body } = {}) {
  const headers = { 'content-type': 'application/json', origin: BASE }; if (cookie) headers.cookie = cookie;
  const r = await df(p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch { /* */ }
  return { status: r.status, body: j, text, headers: r.headers };
}
/** A floor socket with a tiny event tap, over dispatchFetch. */
async function personSocket(cookie) {
  const res = await df('/api/office/ws', { headers: { upgrade: 'websocket', cookie, origin: BASE } });
  const ws = res.webSocket; ws.accept();
  const got = []; const handlers = [];
  ws.addEventListener('message', (ev) => { let m; try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8')); } catch { return; } got.push(m); for (const h of handlers) h(m); });
  const init = await new Promise((resolve) => { const t = setInterval(() => { const m = got.find((x) => x.t === 'init'); if (m) { clearInterval(t); resolve(m); } }, 10); setTimeout(() => { clearInterval(t); resolve(null); }, 4000); });
  return { id: init?.you?.id, on: (cb) => handlers.push(cb), send: (m) => ws.send(JSON.stringify(m)), move: (room, x, y) => ws.send(JSON.stringify({ t: 'move', x, y, dir: 'down', room })), chat: (text) => ws.send(JSON.stringify({ t: 'chat', text })), close: () => { try { ws.close(1000, 'done'); } catch { /* */ } } };
}
async function miniflareTransport(url) {
  const res = await df(url.replace(BASE, ''), { headers: { upgrade: 'websocket' } });
  if (res.status !== 101 || !res.webSocket) return { status: res.status, send() {}, close() {}, onMessage() {}, onClose() {} };
  const ws = res.webSocket; ws.accept(); const L = { message: [], close: [] };
  ws.addEventListener('message', (ev) => { const s = typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8'); for (const cb of L.message) cb(s); });
  ws.addEventListener('close', () => { for (const cb of L.close) cb(); });
  return { status: 101, send: (s) => { try { ws.send(s); } catch { /* */ } }, close: () => { try { ws.close(1000, 'bye'); } catch { /* */ } }, onMessage: (cb) => L.message.push(cb), onClose: (cb) => L.close.push(cb) };
}

test('two people in the owner office, Mia transcribes the LIVE room audio and proposes', { skip: ready ? false : 'needs ronininc-crm + miniflare + vendored webrtc + whisper' }, async () => {
  const wrtc = await loadWebrtc();
  const dir = mkdtempSync(join(tmpdir(), 'mia-spoken-'));
  try {
    const db = await mf.getD1Database('DB');
    const reg = await df('/api/auth/register', { method: 'POST', headers: { origin: BASE, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Olivia Owner', email: 'owner@ronininc.org', password: randomBytes(12).toString('hex') }) });
    const ownerCookie = (reg.headers.get('set-cookie') || '').split(';')[0];
    await call('/api/floor/policy', { method: 'POST', cookie: ownerCookie, body: { invite_only: false } });
    const dana = { id: 'u-' + randomBytes(6).toString('hex'), token: randomBytes(32).toString('hex') };
    await db.prepare("INSERT INTO clearances (id, name, perms, is_system, created_at) VALUES ('cl_sales','Sales Rep','[\"crm\"]',0, unixepoch())").run().catch(() => {});
    await db.prepare("INSERT INTO users (id, name, email, role, pass_hash, pass_salt, clearance_id) VALUES (?,?,?,?, 'x','x','cl_sales')").bind(dana.id, 'Dana Rep', dana.id + '@ronininc.org', 'viewer').run();
    await db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)').bind(dana.token, dana.id, nowSecs() + 3600).run();
    const minted = await call('/api/admin/mcp/token', { method: 'POST', cookie: ownerCookie, body: { role: 'solomon' } });
    const token = minted.body?.token;
    assert.ok(token?.startsWith('ronin_solomon_'), `token mint failed: ${minted.text}`);

    // A spoken line with an action item → 48 kHz mono PCM (say -o writes a file; nothing is played aloud).
    const spoken = "I'll email the Lakeside deck on Tuesday";
    execFileSync('say', ['-o', join(dir, 'd.aiff'), spoken]);
    execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@48000', '-c', '1', join(dir, 'd.aiff'), join(dir, 'd.wav')]);
    const pcm48 = wavToSamples(readFileSync(join(dir, 'd.wav')));

    // Mia — the real participant, live audio on, real whisper.
    const mcp = crmMcpClient({ url: BASE + '/mcp/solomon', token, fetchImpl: (u, o) => df(u.replace(BASE, ''), o) });
    const transcriber = makeTranscriber({ transcribe, whisper: WHISPER, model: MODEL, language: 'en', prompt: 'Lakeside deck Tuesday' });
    const events = [];
    const mia = new MeetingParticipant({ mcp, name: 'Mia', wsBase: BASE + '/api/office/ws', openTransport: miniflareTransport, transcriber, log: (e, d) => events.push({ e, ...d }) });
    assert.equal(await mia.start(), true);

    // Two members walk into the owner's office; Dana's browser will stream her mic.
    const owner = await personSocket(ownerCookie);
    const dana2 = await personSocket(dana.token ? 'ronin_admin=' + dana.token : '');
    // Dana's browser: answer Mia's WebRTC offer over the hub and send the spoken audio.
    const pc = new wrtc.RTCPeerConnection();
    const mic = new wrtc.MediaStreamTrack({ kind: 'audio' });
    let miaId = null; let streamed = false;
    pc.onIceCandidate.subscribe((e) => { const c = e?.candidate ?? e; if (c && miaId) dana2.send({ t: 'signal', to: miaId, data: { ice: c } }); });
    const streamMic = async () => {
      if (streamed) return; streamed = true;
      const enc = new wrtc.OpusScript(48000, 1, wrtc.OpusScript.Application.AUDIO, { wasm: false });
      const tx = pc.getTransceivers()[0]; const pt = tx?.sender?.codecs?.[0]?.payloadType ?? 96;
      let seq = 1; let ts = 0;
      for (let off = 0; off + 960 <= pcm48.length; off += 960) {
        const frame = Buffer.from(pcm48.buffer, pcm48.byteOffset + off * 2, 960 * 2);
        mic.writeRtp(new wrtc.RtpPacket(new wrtc.RtpHeader({ version: 2, payloadType: pt, sequenceNumber: seq++ & 0xffff, timestamp: ts, ssrc: 2024, marker: off === 0 }), enc.encode(frame, 960)));
        ts += 960; await sleep(20);
      }
    };
    dana2.on(async (m) => {
      if (m.t !== 'signal' || !m.data || m.data.th) return;
      miaId = m.from;
      try {
        if (m.data.sdp) {
          await pc.setRemoteDescription(m.data.sdp);
          if (m.data.sdp.type === 'offer') {
            const tx = pc.getTransceivers()[0];
            try { tx.direction = 'sendonly'; } catch { /* */ } tx.sender.replaceTrack(mic);
            const ans = await pc.createAnswer(); await pc.setLocalDescription(ans);
            dana2.send({ t: 'signal', to: m.from, data: { sdp: pc.localDescription } });
            void (async () => { for (let i = 0; i < 40 && pc.connectionState !== 'connected'; i += 1) await sleep(100); await streamMic(); })();
          }
        } else if (m.data.ice) { await pc.addIceCandidate(m.data.ice); }
      } catch (e) { events.push({ e: 'browser_err', error: String(e?.message || e) }); }
    });
    owner.move('owner', 10, 5); dana2.move('owner', 11, 5);

    // Wait for Mia to join and for the audio to flow + transcribe.
    for (let i = 0; i < 60 && !mia.meetings.get('owner'); i += 1) await sleep(100);
    assert.ok(mia.meetings.get('owner'), `Mia did not join; events=${JSON.stringify(events).slice(0, 800)}`);
    await sleep(6000); // ICE/DTLS through the hub + ~2s of speech + gap-flush + whisper

    owner.chat('Mia, wrap it up');
    let proposed = null;
    for (let i = 0; i < 60 && !proposed; i += 1) { await sleep(200); proposed = events.find((e) => e.e === 'proposed' && e.room === 'owner'); }
    assert.ok(proposed, `no proposal; events=${JSON.stringify(events).slice(0, 1200)}`);

    const seen = await call('/api/meetings', { cookie: ownerCookie });
    assert.ok((seen.body?.meetings || []).length >= 1, 'GET /api/meetings is non-empty');
    const detail = await call('/api/meetings/' + proposed.meeting_id, { cookie: ownerCookie });
    const lines = (detail.body?.transcript || []).map((l) => `${l.speaker}: ${l.text}`).join(' | ');
    const titles = (detail.body?.tasks || []).map((t) => t.title).join(' | ');
    assert.match((lines + ' ' + titles).toLowerCase(), /lakeside|deck|tuesday|email/, `the SPOKEN words did not reach the notes. transcript=[${lines}] tasks=[${titles}]`);
    assert.ok((detail.body?.meeting?.transcript || detail.body?.transcript || []).some((l) => l.speaker === 'Dana Rep'), 'the spoken line is labeled with the speaker');

    pc.close(); owner.close(); dana2.close(); await mia.stop();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
