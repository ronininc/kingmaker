// Live-Tor E2E for the Obscura contract — the owed end-to-end verification.
//
// STATUS 2026-10-21 (Muse VM): Tor itself bootstraps to 45% (consensus
// fetched) but relay microdescriptors stall at 0/9101 — this VM's egress
// is proxy-mediated and direct relay traffic does not flow, so circuits
// never build here. That is an environment fact, not a contract defect:
// the contract suite (32/32) and this harness are the deliverables; the
// live hop must run on a direct-egress host (the Mac is the natural
// seat: TOR_BIN=<tor> OBSCURA_BIN=<obscura-aarch64> node tests/live-tor-e2e.mjs).
// Pass = Obscura fetches check.torproject.org/api/ip through the pinned
// socks5h proxy and the answer says IsTor=true, with the direct control
// saying IsTor=false.
// Live-Tor E2E for the Obscura contract: bootstrap a real Tor client, verify
// 127.0.0.1:9050 answers as SOCKS (the contract's preflight), spawn Obscura
// MCP with the pinned Tor proxy, fetch check.torproject.org/api/ip through
// it, and run the direct (no-proxy) control.
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';

const TOR = process.env.TOR_BIN || '/tmp/tor-expert/tor/tor';
const OBSCURA = process.env.OBSCURA_BIN || new URL('../intake/linux/obscura', import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. Tor bootstrap
mkdirSync('/tmp/tor-data', { recursive: true });
const tor = spawn(TOR, ['--DataDirectory', '/tmp/tor-data', '--SocksPort', '9050', '--Log', 'notice file /tmp/tor.log', '--RunAsDaemon', '0'], { stdio: 'ignore', env: { ...process.env, LD_LIBRARY_PATH: '/tmp/tor-expert/tor' } });
let bootstrapped = false;
for (let i = 0; i < 90 && !bootstrapped; i += 1) {
  await sleep(1000);
  try { bootstrapped = /Bootstrapped 100%/.test(readFileSync('/tmp/tor.log', 'utf8')); } catch { /* not yet */ }
}
console.log(bootstrapped ? 'TOR: bootstrapped 100%' : 'TOR: BOOTSTRAP TIMEOUT');
if (!bootstrapped) { tor.kill(); process.exit(2); }

// 2. SOCKS preflight (the contract's launch preflight)
const socksOk = await new Promise((resolve) => {
  const s = connect(9050, '127.0.0.1', () => s.write(Buffer.from([0x05, 0x01, 0x00])));
  s.on('data', (d) => { resolve(d[0] === 0x05); s.end(); });
  s.on('error', () => resolve(false));
  setTimeout(() => resolve(false), 5000);
});
console.log(socksOk ? 'PREFLIGHT: 127.0.0.1:9050 answers as a SOCKS5 port' : 'PREFLIGHT FAILED');
if (!socksOk) { tor.kill(); process.exit(2); }

// 3. Obscura MCP session
async function obscuraFetch(url, { torProxy }) {
  const args = [...(torProxy ? ['--proxy', 'socks5h://127.0.0.1:9050'] : []), 'mcp'];
  const proc = spawn(OBSCURA, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  const waiters = new Map();
  proc.stdout.on('data', (d) => {
    buf += d.toString('utf8');
    let at;
    while ((at = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, at).trim(); buf = buf.slice(at + 1);
      if (!line.startsWith('{')) continue;
      try { const msg = JSON.parse(line); if (msg.id && waiters.has(msg.id)) { waiters.get(msg.id)(msg); waiters.delete(msg.id); } } catch { /* banner lines */ }
    }
  });
  const send = (id, method, params) => new Promise((resolve, reject) => {
    waiters.set(id, resolve);
    proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 60000);
  });
  try {
    await send(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'tor-e2e', version: '0' } });
    proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    const tools = await send(2, 'tools/list', {});
    const names = (tools.result?.tools ?? []).map((t) => t.name);
    const fetchTool = (tools.result?.tools ?? []).find((t) => /fetch|navigate|open|browse|get_page|visit/i.test(t.name));
    if (!fetchTool) return { ok: false, reason: `no fetch-like tool among: ${names.join(', ')}` };
    const schema = fetchTool.inputSchema?.properties ?? {};
    const argName = Object.keys(schema).find((k) => /url|uri|address/i.test(k)) ?? 'url';
    const call = await send(3, 'tools/call', { name: fetchTool.name, arguments: { [argName]: url } });
    const text = JSON.stringify(call.result ?? call.error ?? {});
    return { ok: true, tool: fetchTool.name, tools: names, text: text.slice(0, 600) };
  } finally {
    proc.kill();
  }
}

const viaTor = await obscuraFetch('https://check.torproject.org/api/ip', { torProxy: true });
console.log('VIA TOR:', JSON.stringify(viaTor).slice(0, 700));
const direct = await obscuraFetch('https://check.torproject.org/api/ip', { torProxy: false });
console.log('DIRECT :', JSON.stringify(direct).slice(0, 700));
tor.kill();

const torSays = /"IsTor"\s*:\s*true/.test(viaTor.text ?? '');
const directSays = /"IsTor"\s*:\s*false/.test(direct.text ?? '');
console.log(torSays ? 'VERDICT: egress through Tor CONFIRMED (IsTor=true)' : 'VERDICT: Tor fetch did not confirm IsTor=true — see output above');
console.log(directSays ? 'CONTROL: direct fetch confirms IsTor=false (proxy is what routes through Tor)' : 'CONTROL: inconclusive');
process.exit(torSays ? 0 : 1);
