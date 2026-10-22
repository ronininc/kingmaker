/**
 * obscura/lib/obscura-contract.mjs
 *
 * The governed launch contract for Obscura (h4ckf0r0day/obscura,
 * Apache-2.0) — a Rust headless browser engine Kingmaker drives in MCP
 * mode (`obscura mcp`). This module downloads nothing and launches
 * nothing: it holds the binary pin record, the verified MCP tool
 * surface, and the rules a launch must satisfy before any process is
 * allowed to exist.
 *
 * Rules, each one deliberate:
 *   - PIN BEFORE LAUNCH. The pin record's expectedSha256 is recorded
 *     by Cage intake (2026-10-20, founder order: v0.2.5,
 *     obscura-aarch64-macos.tar.gz, fetched twice from the official
 *     release with identical hashes — see intake/INTAKE.md). A launch
 *     config is built only against a complete, well-formed pin.
 *   - STDIO IS HOME. `obscura mcp` over stdio is the default transport.
 *     HTTP mode binds 127.0.0.1 upstream and is refused here unless a
 *     bearer token of >= 32 bytes is broker-delivered (upstream's own
 *     floor for non-loopback binds, applied to every HTTP launch).
 *   - SSRF POSTURE PRESERVED. Upstream blocks private/internal IPs by
 *     default. `--allow-private-network` and
 *     OBSCURA_ALLOW_PRIVATE_NETWORK=1 are FORBIDDEN in a governed
 *     launch config — no caller may widen the browser's reach by
 *     passing flags through.
 *   - TOR PROFILE IS THE ONLY PROXY. A caller-supplied `--proxy` is
 *     FORBIDDEN in every launch config. The one governed proxy is the
 *     Tor profile: the exact pinned string socks5h://127.0.0.1:9050
 *     (the `h` keeps DNS inside Tor — plain socks5 resolves locally
 *     and leaks). Upstream's proxy parsing is lenient (a malformed
 *     value is treated as a hostname, not an error), so the contract
 *     never lets a caller string reach the binary: tor mode injects
 *     the pinned constant itself, and the launcher must preflight that
 *     127.0.0.1:9050 answers as a live Tor SOCKS port before spawn —
 *     fail closed, exactly as the binary itself fails closed on a
 *     dead proxy (verified against the v0.2.5 Linux build at intake).
 *   - TOKEN NAMES, NEVER VALUES. The contract references
 *     OBSCURA_MCP_TOKEN by name; the value is delivered by the
 *     credential broker at launch and never lands in a descriptor,
 *     config file, or audit entry.
 *   - Tool surface is the upstream-verified list (docs/Use-the-MCP-
 *     server.md, fetched 2026-10-20), grouped and risk-classed:
 *     browser_evaluate runs arbitrary JS in the page and the storage
 *     tools read/write cookies and storage state — both classes are
 *     flagged so the router can treat them as elevated, not ambient.
 */

import { refused } from '../../lib/governance.mjs';

export const OBSCURA_PIN = Object.freeze({
  repo: 'h4ckf0r0day/obscura',
  license: 'Apache-2.0',
  releaseTag: 'v0.2.5',
  asset: 'obscura-aarch64-macos.tar.gz',
  assetPattern: 'obscura-{aarch64|x86_64}-{macos|linux}.tar.gz',
  // Cage intake 2026-10-20: sha256 of the v0.2.5 macOS arm64 release
  // archive, computed from two independent fetches (identical bytes).
  expectedSha256: 'fcca31eba4280cd67a2e226ef4b015e432d5c089f78cefd074ad12bbc8e23345',
  status: 'PINNED',
});

// The Tor profile's proxy — a pinned constant, never a parameter.
// socks5h = DNS resolves through Tor; 9050 = the stock Tor SOCKS port.
export const OBSCURA_TOR_PROXY = 'socks5h://127.0.0.1:9050';

export const OBSCURA_TOOL_GROUPS = Object.freeze({
  navigation: Object.freeze(['browser_navigate', 'browser_back', 'browser_forward', 'browser_reload', 'browser_close']),
  read: Object.freeze(['browser_snapshot', 'browser_markdown', 'browser_links', 'browser_extract', 'browser_interactive_elements', 'browser_detect_forms', 'browser_get_attribute', 'browser_count', 'browser_search']),
  interact: Object.freeze(['browser_click', 'browser_fill', 'browser_fill_form', 'browser_type', 'browser_press_key', 'browser_select_option', 'browser_scroll']),
  script: Object.freeze(['browser_wait_for', 'browser_wait_for_text', 'browser_evaluate']),
  diagnostics: Object.freeze(['browser_network_requests', 'browser_console_messages']),
  visual: Object.freeze(['browser_screenshot', 'browser_pdf']),
  storage: Object.freeze(['browser_get_cookies', 'browser_set_cookie', 'browser_clear_cookies', 'browser_storage_state', 'browser_set_storage_state']),
  tabs: Object.freeze(['browser_tab_new', 'browser_tab_list', 'browser_tab_switch', 'browser_tab_close']),
});

export const OBSCURA_TOOLS = Object.freeze(Object.values(OBSCURA_TOOL_GROUPS).flat());

// Groups whose tools are NOT ambient: arbitrary script in the page,
// and cookie/storage state in and out.
export const OBSCURA_ELEVATED_GROUPS = Object.freeze(['script', 'storage']);

export function toolRiskGroup(name) {
  for (const [group, tools] of Object.entries(OBSCURA_TOOL_GROUPS)) {
    if (tools.includes(name)) return group;
  }
  return null;
}

export function validatePinRecord(pin) {
  const problems = [];
  if (!pin || typeof pin !== 'object') return { ok: false, problems: ['pin record missing'] };
  if (pin.repo !== OBSCURA_PIN.repo) problems.push(`repo must be ${OBSCURA_PIN.repo}`);
  if (pin.license !== 'Apache-2.0') problems.push('license must be Apache-2.0');
  if (pin.expectedSha256 != null && !/^[0-9a-f]{64}$/.test(pin.expectedSha256)) {
    problems.push('expectedSha256 must be 64 lowercase hex chars when set');
  }
  if (pin.status === 'PINNED') {
    if (!/^[0-9a-f]{64}$/.test(pin.expectedSha256 ?? '')) problems.push('a PINNED record must carry its sha256');
    if (typeof pin.releaseTag !== 'string' || pin.releaseTag.length === 0) problems.push('a PINNED record must name its releaseTag');
  }
  return { ok: problems.length === 0, problems, pinned: /^[0-9a-f]{64}$/.test(pin.expectedSha256 ?? '') };
}

/**
 * The Tor profile admits exactly one proxy string — the pinned
 * constant. Anything else (plain socks5, another port, a hostname,
 * a trailing slash) is not the Tor profile. Launchers use this to
 * check a would-be proxy value before it ever reaches an argv.
 */
export function validateTorProxy(value) {
  return value === OBSCURA_TOR_PROXY;
}

/**
 * Build the MCP server config a governed launch is allowed to use.
 * Refuses (returns the house refusal shape) when the pin is incomplete,
 * when a forbidden flag appears, or when HTTP lacks its token.
 * Options:
 *   pin        pin record (defaults to OBSCURA_PIN)
 *   stealth    add --stealth (upstream anti-detect build flag)
 *   http       use the HTTP transport instead of stdio
 *   token      bearer token VALUE — length-checked here, never stored;
 *              the returned config carries the env NAME only
 *   tor        Tor profile: injects the pinned proxy as a global arg
 *              ahead of `mcp`; the ONLY way a proxy enters a config
 *   extraArgs  caller args — scanned for forbidden flags; a caller
 *              --proxy is refused in every mode (proxy = Tor profile)
 */
export function buildLaunchConfig({ pin = OBSCURA_PIN, stealth = false, http = false, token = null, tor = false, extraArgs = [] } = {}) {
  const pinCheck = validatePinRecord(pin);
  if (!pinCheck.ok) return refused(`obscura: invalid pin record — ${pinCheck.problems.join('; ')}`);
  if (!pinCheck.pinned) {
    return refused('obscura: binary not pinned — Cage intake must record the release archive sha256 before first launch');
  }
  const forbidden = ['--allow-private-network'];
  const bad = extraArgs.find((a) => forbidden.includes(a) || /^OBSCURA_ALLOW_PRIVATE_NETWORK=/.test(String(a)));
  if (bad) {
    return refused(`obscura: '${bad}' is forbidden in a governed launch — upstream SSRF posture is preserved`);
  }
  const callerProxy = extraArgs.find((a) => a === '--proxy' || /^--proxy=/.test(String(a)) || /^OBSCURA_PROXY=/.test(String(a)));
  if (callerProxy) {
    return refused('obscura: caller-supplied proxy is forbidden — the Tor profile is the only governed proxy');
  }
  // Global args precede the subcommand upstream (`obscura --proxy … mcp`).
  const args = [];
  if (tor) args.push('--proxy', OBSCURA_TOR_PROXY);
  args.push('mcp');
  if (stealth) args.push('--stealth');
  if (http) {
    if (typeof token !== 'string' || token.length < 32) {
      return refused('obscura: HTTP transport requires OBSCURA_MCP_TOKEN of at least 32 bytes');
    }
    args.push('--http', '--port', '3000');
  }
  args.push(...extraArgs);
  const env = {};
  if (http) env.OBSCURA_MCP_TOKEN = '<broker-delivered>'; // name + marker only, never the value
  return {
    ok: true,
    mcpServers: {
      obscura: { command: 'obscura', args, ...(Object.keys(env).length ? { env } : {}) },
    },
    governance: {
      transport: http ? 'http(loopback, token-gated)' : 'stdio',
      pinned: true,
      privateNetwork: 'blocked (upstream default, contract-preserved)',
      elevatedGroups: OBSCURA_ELEVATED_GROUPS,
      profile: tor ? 'tor' : 'direct',
      ...(tor
        ? {
            proxy: OBSCURA_TOR_PROXY,
            dns: 'remote (socks5h — names resolve inside Tor, never locally)',
            preflight: 'launcher must verify 127.0.0.1:9050 answers as a live Tor SOCKS port before spawn; refuse the launch if it does not',
          }
        : { proxy: 'none' }),
    },
  };
}
