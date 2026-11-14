/**
 * obscura tests — pure contract checks. No binary, no process, no network.
 */

import { readFileSync } from 'node:fs';
import {
  OBSCURA_PIN,
  OBSCURA_TOR_PROXY,
  OBSCURA_TOOLS,
  OBSCURA_TOOL_GROUPS,
  OBSCURA_ELEVATED_GROUPS,
  toolRiskGroup,
  validatePinRecord,
  validateTorProxy,
  buildLaunchConfig,
} from '../lib/obscura-contract.mjs';

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}`); }
}

const descriptor = JSON.parse(readFileSync(new URL('../descriptor.json', import.meta.url), 'utf8'));

// 1. The shipped pin is PINNED — Cage intake completed 2026-10-20
//    (v0.2.5 macOS arm64 archive, hash from two identical fetches).
check('pin is pinned by Cage intake', OBSCURA_PIN.status === 'PINNED' && /^[0-9a-f]{64}$/.test(OBSCURA_PIN.expectedSha256));
check('pin names its release', OBSCURA_PIN.releaseTag === 'v0.2.5' && OBSCURA_PIN.asset === 'obscura-aarch64-macos.tar.gz');
check('pin record validates as pinned', (() => { const v = validatePinRecord(OBSCURA_PIN); return v.ok && v.pinned === true; })());
check('descriptor pin agrees with contract pin', descriptor.pin.expectedSha256 === OBSCURA_PIN.expectedSha256 && descriptor.pin.releaseTag === OBSCURA_PIN.releaseTag && descriptor.pin.repo === OBSCURA_PIN.repo);

// 2. An unpinned record → no launch config, ever.
const unpinned = { ...OBSCURA_PIN, releaseTag: null, expectedSha256: null, status: 'UNPINNED' };
const r1 = buildLaunchConfig({ pin: unpinned });
check('unpinned binary refuses launch config', r1.ok === false && r1.refused === true && /not pinned/.test(r1.reason));

// 3. A Cage-completed pin builds the stdio config.
const pinned = { ...OBSCURA_PIN, releaseTag: 'v0.0.0-test', expectedSha256: 'a'.repeat(64), status: 'PINNED' };
const r2 = buildLaunchConfig({ pin: pinned });
check('pinned stdio config builds', r2.ok === true && r2.mcpServers.obscura.command === 'obscura' && r2.mcpServers.obscura.args.join(' ') === 'mcp');
check('stdio config carries no token env', r2.mcpServers.obscura.env === undefined);
check('governance block records stdio + preserved SSRF posture', r2.governance.transport === 'stdio' && /blocked/.test(r2.governance.privateNetwork));
check('direct profile carries no proxy', r2.governance.profile === 'direct' && r2.governance.proxy === 'none');

// 4. Malformed hash is rejected at the pin level.
const r3 = buildLaunchConfig({ pin: { ...pinned, expectedSha256: 'xyz' } });
check('malformed sha256 refuses', r3.ok === false && /invalid pin record/.test(r3.reason));

// 5. The forbidden flag is refused even with a valid pin.
const r4 = buildLaunchConfig({ pin: pinned, extraArgs: ['--allow-private-network'] });
check('--allow-private-network forbidden', r4.ok === false && /forbidden/.test(r4.reason));
const r5 = buildLaunchConfig({ pin: pinned, extraArgs: ['OBSCURA_ALLOW_PRIVATE_NETWORK=1'] });
check('OBSCURA_ALLOW_PRIVATE_NETWORK env forbidden', r5.ok === false && /forbidden/.test(r5.reason));

// 6. HTTP without a >= 32-byte token refuses; with one, it builds — and
//    the token VALUE never appears in the config.
const r6 = buildLaunchConfig({ pin: pinned, http: true });
check('HTTP without token refuses', r6.ok === false && /32 bytes/.test(r6.reason));
const secretToken = 't'.repeat(40);
const r7 = buildLaunchConfig({ pin: pinned, http: true, token: secretToken });
check('HTTP with token builds', r7.ok === true && r7.mcpServers.obscura.args.includes('--http'));
check('token value never lands in the config', !JSON.stringify(r7).includes(secretToken) && r7.mcpServers.obscura.env.OBSCURA_MCP_TOKEN === '<broker-delivered>');

// 7. Verified tool surface: 37 tools, grouped, risk-classed.
check('tool surface is 37 tools', OBSCURA_TOOLS.length === 37);
check('descriptor tool count agrees', descriptor.mcpServer.tools.count === OBSCURA_TOOLS.length);
check('browser_evaluate is in the script group', toolRiskGroup('browser_evaluate') === 'script');
check('storage tools are storage group', toolRiskGroup('browser_storage_state') === 'storage');
check('script + storage are the elevated groups', OBSCURA_ELEVATED_GROUPS.join(',') === 'script,storage');
check('unknown tool classifies to null', toolRiskGroup('browser_teleport') === null);
check('no duplicate tools across groups', new Set(OBSCURA_TOOLS).size === OBSCURA_TOOLS.length);
check('every group is non-empty', Object.values(OBSCURA_TOOL_GROUPS).every((g) => g.length > 0));

// 8. Tor profile — the only governed proxy, an exact pinned constant.
//    Global args precede the subcommand: obscura --proxy <pin> mcp.
check('tor proxy constant is the pinned socks5h loopback', OBSCURA_TOR_PROXY === 'socks5h://127.0.0.1:9050');
check('validateTorProxy admits only the constant', validateTorProxy(OBSCURA_TOR_PROXY) === true
  && validateTorProxy('socks5://127.0.0.1:9050') === false
  && validateTorProxy('socks5h://127.0.0.1:9150') === false
  && validateTorProxy('socks5h://127.0.0.1:9050/') === false
  && validateTorProxy('http://127.0.0.1:8080') === false);
const r8 = buildLaunchConfig({ pin: pinned, tor: true });
check('tor config builds with proxy ahead of mcp', r8.ok === true && r8.mcpServers.obscura.args.join(' ') === '--proxy socks5h://127.0.0.1:9050 mcp');
check('tor governance records profile, dns posture, preflight', r8.governance.profile === 'tor' && r8.governance.proxy === OBSCURA_TOR_PROXY && /socks5h/.test(r8.governance.dns) && /9050/.test(r8.governance.preflight));
check('descriptor tor profile agrees', descriptor.torProfile && descriptor.torProfile.proxy === OBSCURA_TOR_PROXY && descriptor.torProfile.default === 'off');
const r9 = buildLaunchConfig({ pin: pinned, extraArgs: ['--proxy', 'http://127.0.0.1:8080'] });
check('caller --proxy refused (direct mode)', r9.ok === false && /only governed proxy/.test(r9.reason));
const r10 = buildLaunchConfig({ pin: pinned, tor: true, extraArgs: ['--proxy=socks5h://127.0.0.1:9050'] });
check('caller --proxy refused even when it matches the pin', r10.ok === false && /only governed proxy/.test(r10.reason));
const r11 = buildLaunchConfig({ pin: pinned, tor: true, http: true, token: secretToken });
check('tor + http composes: proxy global, http on mcp', r11.ok === true && r11.mcpServers.obscura.args.join(' ') === '--proxy socks5h://127.0.0.1:9050 mcp --http --port 3000');
const r12 = buildLaunchConfig({ pin: unpinned, tor: true });
check('tor still refuses when unpinned', r12.ok === false && /not pinned/.test(r12.reason));

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail === 0 ? 0 : 1);
