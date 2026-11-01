// two-endpoint/rogue-server.mjs — the FORGED RESPONDER, runs in the
// guest on port 18733. It holds a FRESH identity that the engine has
// NOT enrolled. It cannot open the engine's request (sealed to the
// real peer) and does not need to: the request frame's canary is
// visible in the cleartext frame header, so the rogue can name it.
//
//   POST /forge-match    → sealed reply (rogue keypair → engine)
//                          whose doc names the REAL request canary
//   POST /forge-unknown  → same, but names a canary never sent
//
// The daemon-conformance audit predicts /forge-match is ACCEPTED by
// the engine (responder fingerprint is never pinned at the call
// site) and /forge-unknown is REFUSED by return-match. This server
// exists to find out what actually happens across a real link.

import http from 'node:http';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ensureIdentity, wrapEgress } from './engine/lib/armor-native.mjs';
import * as armorLib from './scripture-armor/armor.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const STATE = join(here, 'state-rogue');
const ENGINE_BLOCK_FILE = join(here, 'engine-block.txt');
const PORT = 18733;
export const FORGED_PAYLOAD = 'FORGED-RESPONSE-PAYLOAD-51bd::composed by an unenrolled keypair';

const me = ensureIdentity(STATE, 'rogue');
fs.writeFileSync(join(here, 'rogue-info.json'), JSON.stringify({ rogue_sign_fp: me.signFp, rogue_seal_fp: me.sealFp }, null, 2), { mode: 0o600 });

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    const { frame } = armorLib.parseScriptureFile(raw); // frame header is cleartext metadata — readable by anyone on the wire
    const canary = req.url.startsWith('/forge-unknown') ? randomUUID() : frame.canary;
    const doc = JSON.stringify({
      in_reply_to: canary, status: 200, headers: {},
      body_b64: Buffer.from(FORGED_PAYLOAD, 'utf8').toString('base64'),
    });
    const engineBlock = fs.readFileSync(ENGINE_BLOCK_FILE, 'utf8');
    const { text } = await wrapEgress(STATE, Buffer.from(doc, 'utf8'), engineBlock, { purpose: 'rogue-forge' });
    res.writeHead(200, { 'content-type': 'application/vnd.scripture-armor; v=3' });
    res.end(text);
  } catch (e) {
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end(`rogue error: ${e?.message || e}`);
  }
});
await new Promise((r) => server.listen(PORT, '0.0.0.0', r));
console.log(`ROGUE-READY sign_fp=${me.signFp} port=${PORT}`);
