// interop/probe-served-ledger-restart.mjs — companion probe for the
// widening: proves the relay's served-canary ledger is FILE-backed
// (survives a relay process restart), not in-memory. Serves one
// request, kills the relay, starts a NEW relay process-side instance
// on the SAME state dir, re-sends the identical packet: the replay
// must still refuse with zero additional API calls.

import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as native from '../../../lib/armor-native.mjs';
import * as armorLib from '../../armor.mjs';
import { startRelay, startApiStub } from '../proof/relay.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const S = {
  engine: join(here, 'state-probe-engine'),
  relay: join(here, 'state-probe-relay'),
};
for (const d of Object.values(S)) fs.rmSync(d, { recursive: true, force: true });

native.ensureIdentity(S.engine, 'kingmaker-engine');
const engineBlock = native.publicBlockOf(S.engine);
const relayId = native.ensureIdentity(S.relay, 'estate-relay');
const relayBlock = armorLib.publicBlock(relayId);

const stub = await startApiStub({ port: 19832 });
let apiCount = 0;
const countedFetch = async (url, opts) => { apiCount++; return fetch(url, opts); };
const env = { method: 'GET', url: 'http://127.0.0.1:19832/zen', headers: {}, body_b64: null };
const w = await native.wrapEgress(S.engine, Buffer.from(JSON.stringify(env), 'utf8'), relayBlock, { purpose: 'restart-probe' });
const post = async (port) => {
  const r = await fetch(`http://127.0.0.1:${port}/`, {
    method: 'POST', headers: { 'content-type': 'application/vnd.scripture-armor; v=3' }, body: w.text,
  });
  return { status: r.status, body: await r.text() };
};

const relay1 = await startRelay({ state: S.relay, engineBlock, port: 19831, fetchImpl: countedFetch });
const first = await post(19831);
relay1.server.close();
await new Promise((r) => setTimeout(r, 250)); // relay process-side instance fully down

const ledgerPath = join(S.relay, 'armor', 'served-ledger.jsonl');
const ledgerOnDisk = fs.existsSync(ledgerPath)
  ? fs.readFileSync(ledgerPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  : [];

const relay2 = await startRelay({ state: S.relay, engineBlock, port: 19833, fetchImpl: countedFetch });
const second = await post(19833);
relay2.server.close(); stub.server.close();

const ok = first.status === 200 && second.status === 400 && apiCount === 1 &&
  ledgerOnDisk.some((e) => e.canary === w.frame.canary);
console.log(`${ok ? 'PASS' : 'FAIL'} — served ledger survives a relay restart: first=${first.status} after-restart replay=${second.status} totalApiCalls=${apiCount} ledgerFile=${ledgerPath} entries=${ledgerOnDisk.length} entryForCanary=${ledgerOnDisk.some((e) => e.canary === w.frame.canary)} until=${ledgerOnDisk[0]?.until ?? 'n/a'}`);
process.exit(ok ? 0 : 1);
