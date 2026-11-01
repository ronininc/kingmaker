// interop/run-interop-widening.mjs — the 4.3 airlock-repair WIDENING
// cases, run against the FIXED tree (this copy): expiry enforcement
// + replay protection, per Robbie's 2026-10-25 10:07 decision.
//
// These are the interop battery's §11 transit cases (11a-i replay,
// 11e-iv expired, 11e-v unenrolled sender, 11b bit-flip, 11c frame
// strip) with their expectations FLIPPED to the repaired behavior,
// plus the two guards the widening must not break: a fresh request
// serves, and a second DISTINCT request serves (no false replay
// refusal). Everything is local and deterministic: the relay's
// target API is the proof stub (proof/relay.mjs startApiStub) and
// the relay's fetch is instrumented to count calls — the same
// "relay API calls" measure the original battery used. The guest
// peer cases (W8) run the actual guest bundle (two-endpoint/
// guest-bundle) host-side, the same code the VM runs.
//
// Exit code is informational; results-widening.json is the evidence.

import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as native from '../../../lib/armor-native.mjs';
import * as armorLib from '../../armor.mjs';
import { startRelay, startApiStub } from '../proof/relay.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const P = { relay: 19821, stub: 19822, peerPkg: 18731, peerFiles: 8899 };
const S = {
  engine: join(here, 'state-widening-engine'),
  relay: join(here, 'state-widening-relay'),
  stranger: join(here, 'state-widening-stranger'),
};
const GUEST_RUN = join(here, 'guest-run-widening');
for (const d of [...Object.values(S), GUEST_RUN]) fs.rmSync(d, { recursive: true, force: true });

const results = [];
function check(label, cond, detail = '') {
  results.push({ label, ok: !!cond, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'} — ${label}${detail ? ` :: ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- setup
native.ensureIdentity(S.engine, 'kingmaker-engine');
const engineBlock = native.publicBlockOf(S.engine);
const engineId = armorLib.loadIdentity(native.identityDir(S.engine));
const relayId = native.ensureIdentity(S.relay, 'estate-relay');
const relayBlock = armorLib.publicBlock(relayId);
native.ensureIdentity(S.stranger, 'stranger');

const stub = await startApiStub({ port: P.stub });
let relayApiCount = 0;
const countedFetch = async (url, opts) => { relayApiCount++; return fetch(url, opts); };
const relay = await startRelay({ state: S.relay, engineBlock, port: P.relay, fetchImpl: countedFetch });
const RELAY_URL = `http://127.0.0.1:${P.relay}/`;
const STUB_URL = `http://127.0.0.1:${P.stub}/zen`;

const zenEnv = { method: 'GET', url: STUB_URL, headers: { 'x-api-key': 'widening-probe' }, body_b64: null };
async function postToRelay(rawText) {
  const r = await fetch(RELAY_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/vnd.scripture-armor; v=3' },
    body: rawText, signal: AbortSignal.timeout(30_000),
  });
  return { status: r.status, body: await r.text() };
}
function flipGlyphChar(text) {
  const firstNl = text.indexOf('\n');
  const secondNl = text.indexOf('\n', firstNl + 1);
  const pos = secondNl + 1 + 40;
  const cp = text[pos].codePointAt(0);
  const replacement = cp >= 0xE000 && cp <= 0xE07F
    ? String.fromCodePoint(0xE000 + ((cp - 0xE000 + 1) % 128))
    : '';
  return text.slice(0, pos) + replacement + text.slice(pos + 1);
}

// ------------------------------------------------- W1: fresh request serves
let packet1; let frame1;
try {
  const w = await native.wrapEgress(S.engine, Buffer.from(JSON.stringify(zenEnv), 'utf8'), relayBlock, { purpose: 'widening-fresh' });
  packet1 = w.text; frame1 = w.frame;
  native.noteSent(S.engine, { canary: frame1.canary, purpose: 'widening-fresh', peer: frame1.recipient_seal_fp });
  const before = relayApiCount;
  const r = await postToRelay(packet1);
  const opened = native.openInbound(S.engine, r.body);
  const doc = JSON.parse(opened.plaintext.toString('utf8'));
  const m = native.matchReturn(S.engine, doc.in_reply_to, { purpose: 'widening-fresh' });
  check('W1 fresh legitimate request serves through the relay (API called once, answer return-matches)',
    r.status === 200 && relayApiCount === before + 1 && doc.in_reply_to === frame1.canary && m.ok === true,
    `status=${r.status} apiDelta=${relayApiCount - before} match=${m.ok}`);
} catch (e) { check('W1 fresh legitimate request serves', false, String(e?.message || e)); }

// ------------------------------------------------- W2: a second DISTINCT request serves (no false replay refusal)
try {
  const w = await native.wrapEgress(S.engine, Buffer.from(JSON.stringify(zenEnv), 'utf8'), relayBlock, { purpose: 'widening-fresh-2' });
  native.noteSent(S.engine, { canary: w.frame.canary, purpose: 'widening-fresh-2', peer: w.frame.recipient_seal_fp });
  const before = relayApiCount;
  const r = await postToRelay(w.text);
  const opened = native.openInbound(S.engine, r.body);
  const doc = JSON.parse(opened.plaintext.toString('utf8'));
  const m = native.matchReturn(S.engine, doc.in_reply_to, { purpose: 'widening-fresh-2' });
  check('W2 second DISTINCT request (fresh canary) serves — the replay ledger does not false-fire',
    r.status === 200 && relayApiCount === before + 1 && m.ok === true && w.frame.canary !== frame1.canary,
    `status=${r.status} apiDelta=${relayApiCount - before} match=${m.ok}`);
} catch (e) { check('W2 second distinct request serves', false, String(e?.message || e)); }

// ------------------------------------------------- W3: replayed request REFUSED at the relay
try {
  const before = relayApiCount;
  const r = await postToRelay(packet1); // verbatim re-send of W1's packet
  const beacons = native.readBeacons(S.relay).filter((b) => b.event === 'package-replay' && b.canary === frame1.canary);
  check('W3 replayed REQUEST is refused at the relay BEFORE execution (API count unchanged) + package-replay beacon',
    r.status === 400 && relayApiCount === before && beacons.length >= 1 && !r.body.startsWith('SCRIPTURE-ARMOR'),
    `status=${r.status} apiDelta=${relayApiCount - before} replayBeacons=${beacons.length} body="${r.body.slice(0, 80)}"`);
} catch (e) { check('W3 replayed request refused at the relay', false, String(e?.message || e)); }

// ------------------------------------------------- W4: expired package REFUSED at the relay
try {
  const relayPeer = armorLib.parsePublicBlock(relayBlock);
  const expired = armorLib.sealPlaintext(
    Buffer.from(JSON.stringify(zenEnv), 'utf8'), engineId, relayPeer,
    { expires: new Date(Date.now() - 3600_000).toISOString() });
  const before = relayApiCount;
  const r = await postToRelay(expired.text);
  const beacons = native.readBeacons(S.relay).filter((b) => b.event === 'package-expired' && b.canary === expired.frame.canary);
  check('W4 EXPIRED package is refused at the relay (API count unchanged) + package-expired beacon',
    r.status === 400 && relayApiCount === before && beacons.length >= 1,
    `status=${r.status} apiDelta=${relayApiCount - before} expiredBeacons=${beacons.length} body="${r.body.slice(0, 80)}"`);
} catch (e) { check('W4 expired package refused at the relay', false, String(e?.message || e)); }

// ------------------------------------------------- W5: unenrolled sender still refused (pinning, already fixed)
try {
  const w = await native.wrapEgress(S.stranger, Buffer.from(JSON.stringify(zenEnv), 'utf8'), relayBlock, { purpose: 'widening-stranger' });
  const before = relayApiCount;
  const r = await postToRelay(w.text);
  const beacons = native.readBeacons(S.relay).filter((b) => b.event === 'package-unexpected-sender' && b.canary === w.frame.canary);
  check('W5 package from a never-enrolled sender still refused at the pin (API count unchanged) + beacon',
    r.status === 400 && relayApiCount === before && beacons.length >= 1,
    `status=${r.status} apiDelta=${relayApiCount - before} senderBeacons=${beacons.length}`);
} catch (e) { check('W5 unenrolled sender refused', false, String(e?.message || e)); }

// ------------------------------------------------- W6: bit-flip unchanged
try {
  const before = relayApiCount;
  const r = await postToRelay(flipGlyphChar(packet1));
  check('W6 bit-flipped packet in transit still killed at the relay (no API call)',
    r.status === 400 && relayApiCount === before && !r.body.startsWith('SCRIPTURE-ARMOR'),
    `status=${r.status} apiDelta=${relayApiCount - before}`);
} catch (e) { check('W6 bit-flip at the relay', false, String(e?.message || e)); }

// ------------------------------------------------- W7: frame-strip unchanged
try {
  const lines = packet1.split('\n');
  const before = relayApiCount;
  const rb = await postToRelay(lines.slice(2).join('\n'));
  const rf = await postToRelay(`${lines[0]}\n${lines[1]}\n`);
  check('W7 frame-strip still useless both ways (body-only and frame-only refused, no API call)',
    rb.status === 400 && rf.status === 400 && relayApiCount === before,
    `bodyOnly=${rb.status} frameOnly=${rf.status} apiDelta=${relayApiCount - before}`);
} catch (e) { check('W7 frame-strip handling', false, String(e?.message || e)); }

// ------------------------------------------------- W8: the guest peer (bundle code, host-run)
let peerProc = null;
try {
  fs.cpSync(join(here, '..', 'two-endpoint', 'guest-bundle'), GUEST_RUN, { recursive: true });
  fs.writeFileSync(join(GUEST_RUN, 'engine-block.txt'), engineBlock, { mode: 0o600 });
  peerProc = spawn('node', ['peer-server.mjs'], { cwd: GUEST_RUN, stdio: ['ignore', 'pipe', 'pipe'] });
  let peerErr = '';
  peerProc.stderr.on('data', (d) => { peerErr += d; });
  const ready = await new Promise((resolve) => {
    let buf = '';
    peerProc.stdout.on('data', (d) => { buf += d; if (buf.includes('PEER-READY')) resolve(true); });
    setTimeout(() => resolve(false), 30_000);
  });
  if (!ready) throw new Error(`guest peer did not start: ${peerErr.slice(0, 200)}`);
  const peerBlock = await (await fetch(`http://127.0.0.1:${P.peerFiles}/peer-block.txt`)).text();
  const peerFp = native.signFpOfBlock(peerBlock);
  const peerEnv = { body_b64: Buffer.from('widening-peer-payload', 'utf8').toString('base64') };
  const postToPeer = async (rawText) => {
    const r = await fetch(`http://127.0.0.1:${P.peerPkg}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/vnd.scripture-armor; v=3' },
      body: rawText, signal: AbortSignal.timeout(30_000),
    });
    return { status: r.status, body: await r.text() };
  };
  const readEvidence = () => JSON.parse(fs.readFileSync(join(GUEST_RUN, 'evidence.json'), 'utf8'));

  // W8a: fresh package opens at the peer + ack opens engine-side
  const pw = await native.wrapEgress(S.engine, Buffer.from(JSON.stringify(peerEnv), 'utf8'), peerBlock, { purpose: 'widening-peer' });
  const pr1 = await postToPeer(pw.text);
  const ack = native.openInbound(S.engine, pr1.body, { expectSenderSignFp: peerFp });
  const ackDoc = JSON.parse(ack.plaintext.toString('utf8'));
  check('W8a fresh package opens at the guest peer and its ack opens engine-side',
    pr1.status === 200 && ackDoc.in_reply_to === pw.frame.canary && readEvidence().packages_opened === 1,
    `status=${pr1.status} opened=${readEvidence().packages_opened}`);

  // W8b: verbatim replay refused at the peer + beacon (via guest evidence)
  const pr2 = await postToPeer(pw.text);
  const ev2 = readEvidence();
  check('W8b replayed package REFUSED at the peer (opened count unchanged) + package-replay beacon in guest evidence',
    pr2.status === 400 && ev2.packages_opened === 1 && ev2.packages_refused >= 1 && ev2.replay_beacons >= 1 &&
    ev2.refusals.some((m) => /already served|replay/i.test(m)),
    `status=${pr2.status} opened=${ev2.packages_opened} refused=${ev2.packages_refused} replayBeacons=${ev2.replay_beacons} lastRefusal="${(ev2.refusals[ev2.refusals.length - 1] || '').slice(0, 90)}"`);

  // W8c: expired package refused at the peer + beacon
  const peerParsed = armorLib.parsePublicBlock(peerBlock);
  const expPeer = armorLib.sealPlaintext(
    Buffer.from(JSON.stringify(peerEnv), 'utf8'), engineId, peerParsed,
    { expires: new Date(Date.now() - 3600_000).toISOString() });
  const pr3 = await postToPeer(expPeer.text);
  const ev3 = readEvidence();
  check('W8c EXPIRED package refused at the peer (opened count unchanged) + package-expired beacon in guest evidence',
    pr3.status === 400 && ev3.packages_opened === 1 && ev3.expired_beacons >= 1 &&
    ev3.refusals.some((m) => /expired/i.test(m)),
    `status=${pr3.status} opened=${ev3.packages_opened} expiredBeacons=${ev3.expired_beacons} lastRefusal="${(ev3.refusals[ev3.refusals.length - 1] || '').slice(0, 90)}"`);

  // W8d: a fresh DISTINCT package still opens at the peer (no false refusal)
  const pw2 = await native.wrapEgress(S.engine, Buffer.from(JSON.stringify(peerEnv), 'utf8'), peerBlock, { purpose: 'widening-peer-2' });
  const pr4 = await postToPeer(pw2.text);
  check('W8d second DISTINCT package opens at the peer — no false replay/expiry refusal',
    pr4.status === 200 && readEvidence().packages_opened === 2,
    `status=${pr4.status} opened=${readEvidence().packages_opened}`);
} catch (e) { check('W8 guest peer widening cases', false, String(e?.message || e)); }
finally { if (peerProc) peerProc.kill('SIGKILL'); }

// ---------------------------------------------------------------- wrap
relay.server.close(); stub.server.close();
await sleep(150);
fs.writeFileSync(join(here, 'results-widening.json'), JSON.stringify({ results }, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n==== widening: ${results.length - failed.length} passed, ${failed.length} failed ====`);
process.exit(0);
