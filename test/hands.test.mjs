// The hands: Hands of Horus (Peekaboo, github.com/openclaw/Peekaboo, MIT) when installed, else ghost-os as before.
// Selection, the backend env it hands the engine, the start banner, the doctor's permission read — and that nothing a
// person reads says "Peekaboo" (only identifiers: env vars, the binary path, the brew formula).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findPeekabooBinary, resolvePaths } from '../lib/paths.mjs';
import { ghostBackendEnv, HANDS_NAMES, selectHands } from '../lib/profile.mjs';
import { handsPermissions, parsePeekabooPermissions, peekabooInfo, peekabooPermissions } from '../lib/health.mjs';
import { handsBinary, handsLine } from '../lib/cli.mjs';

const paths = resolvePaths({ SOL_GHOST_HOME: '/tmp/sg-state' }, '/Users/owner', { exists: () => false });
const secrets = { nonce: 'a'.repeat(64), voiceKey: 'b'.repeat(64) };
const PKB = '/opt/homebrew/bin/peekaboo';
const GHOST = '/opt/homebrew/bin/ghost';
const shownNoPeekaboo = (text) => !/peekaboo/i.test(String(text).replace(/brew install openclaw\/tap\/peekaboo|SOLOMON_PEEKABOO_MCP_CMD/g, ''));

test('peekaboo binary: explicit path must exist; then Homebrew, /usr/local, PATH', () => {
  assert.equal(findPeekabooBinary({ SOL_GHOST_PEEKABOO_BIN: '/nope' }, () => false), null);
  assert.equal(findPeekabooBinary({ SOL_GHOST_PEEKABOO_BIN: '/x/peekaboo' }, (p) => p === '/x/peekaboo'), '/x/peekaboo');
  assert.equal(findPeekabooBinary({}, (p) => p === PKB), PKB);
  assert.equal(findPeekabooBinary({}, (p) => p === '/usr/local/bin/peekaboo'), '/usr/local/bin/peekaboo');
  assert.equal(findPeekabooBinary({ PATH: '/usr/bin:/Users/o/.local/bin' }, (p) => p === '/Users/o/.local/bin/peekaboo'), '/Users/o/.local/bin/peekaboo');
  assert.equal(findPeekabooBinary({ PATH: '/usr/bin' }, () => false), null);
});

test('selection: the operator\'s SOLOMON_MAC_HANDS wins; else Peekaboo when installed; else ghost-os; else none', () => {
  assert.equal(selectHands({ env: {}, ghostBin: GHOST, peekabooBin: PKB }), 'peekaboo');
  assert.equal(selectHands({ env: {}, ghostBin: GHOST, peekabooBin: null }), 'ghost');
  assert.equal(selectHands({ env: {}, ghostBin: null, peekabooBin: null }), null);
  assert.equal(selectHands({ env: { SOLOMON_MAC_HANDS: 'ghost' }, ghostBin: GHOST, peekabooBin: PKB }), 'ghost');
  assert.equal(selectHands({ env: { SOLOMON_MAC_HANDS: 'Peekaboo' }, ghostBin: null, peekabooBin: null }), 'peekaboo');
});

test('backend env: Peekaboo installed → SOLOMON_MAC_HANDS=peekaboo + its MCP command + Mac control on (ghost-os kept configured)', () => {
  const env = ghostBackendEnv({ env: { PATH: '/usr/bin' }, paths, port: 3001, secrets, ghostBin: GHOST, peekabooBin: PKB });
  assert.equal(env.SOLOMON_MAC_HANDS, 'peekaboo');
  assert.deepEqual(JSON.parse(env.SOLOMON_PEEKABOO_MCP_CMD), [PKB, 'mcp']);
  assert.equal(env.SOLOMON_DEVICE_MAC_CONTROL_ENABLED, 'true');
  assert.deepEqual(JSON.parse(env.SOLOMON_GHOST_MCP_CMD), [GHOST, 'mcp'], 'ghost-os stays configured so SOLOMON_MAC_HANDS=ghost can switch back');
  const only = ghostBackendEnv({ env: {}, paths, port: 3001, secrets, ghostBin: null, peekabooBin: PKB });
  assert.equal(only.SOLOMON_MAC_HANDS, 'peekaboo');
  assert.equal(only.SOLOMON_GHOST_MCP_CMD, undefined);
  assert.equal(only.SOLOMON_DEVICE_MAC_CONTROL_ENABLED, 'true');
});

test('backend env: no Peekaboo → ghost-os exactly as today; neither → no Mac control', () => {
  const ghost = ghostBackendEnv({ env: {}, paths, port: 3001, secrets, ghostBin: GHOST });
  assert.equal(ghost.SOLOMON_MAC_HANDS, undefined);
  assert.equal(ghost.SOLOMON_PEEKABOO_MCP_CMD, undefined);
  assert.deepEqual(JSON.parse(ghost.SOLOMON_GHOST_MCP_CMD), [GHOST, 'mcp']);
  assert.equal(ghost.SOLOMON_DEVICE_MAC_CONTROL_ENABLED, 'true');
  const none = ghostBackendEnv({ env: {}, paths, port: 3001, secrets, ghostBin: null, peekabooBin: null });
  assert.equal(none.SOLOMON_DEVICE_MAC_CONTROL_ENABLED, undefined);
  assert.equal(none.SOLOMON_MAC_HANDS, undefined);
});

test('backend env: the operator\'s own SOLOMON_* env still wins (hands, command, the Mac-control switch)', () => {
  const env = ghostBackendEnv({ env: { SOLOMON_MAC_HANDS: 'ghost', SOLOMON_PEEKABOO_MCP_CMD: '["/mine/peekaboo","mcp"]', SOLOMON_DEVICE_MAC_CONTROL_ENABLED: 'false' }, paths, port: 3001, secrets, ghostBin: GHOST, peekabooBin: PKB });
  assert.equal(env.SOLOMON_MAC_HANDS, 'ghost');
  assert.equal(env.SOLOMON_PEEKABOO_MCP_CMD, '["/mine/peekaboo","mcp"]');
  assert.equal(env.SOLOMON_DEVICE_MAC_CONTROL_ENABLED, 'false');
  assert.equal(handsBinary(env), '/mine/peekaboo');
  assert.equal(handsBinary({}), null);
});

const status = (detail, state = 'LIVE', toolCount = 19) => ({ toolCount: 240, providers: [{ providerId: 'mac', state, toolCount, detail }] });

test('banner: "Hands: Hands of Horus <version> live (N tools…)" when the server drives with it; ghost-os otherwise', () => {
  const horus = handsLine(status('Hands of Horus live (unpinned), osascript:ok Hands of Horus unpinned'), { version: '4.9.0', toolCount: 26 });
  assert.equal(horus.live, true);
  assert.equal(horus.line, 'Hands: Hands of Horus 4.9.0 live (26 tools, 19 Mac tools, 240 tools in all).');
  assert.ok(shownNoPeekaboo(horus.line));
  const ghost = handsLine(status('ghost:ghost-os live (unpinned), osascript:ok ghost unpinned'), { version: '4.9.0', toolCount: 26 });
  assert.equal(ghost.line, 'Hands: ghost-os live (19 Mac tools, 240 tools in all).', 'an older core still on ghost-os is named for what it is');
  const down = handsLine(status('Hands of Horus:accessibility_not_granted', 'CONFIG_HOLD', 0));
  assert.equal(down.live, false);
  assert.match(down.line, /^Hands: not live yet — CONFIG_HOLD: Hands of Horus:accessibility_not_granted\.$/);
  assert.equal(handsLine({ providers: [] }).line, 'Hands: no Mac provider in this build.');
  assert.equal(HANDS_NAMES.peekaboo, 'Hands of Horus');
});

const permissionsJson = (ax, screen) => JSON.stringify({ data: { source: 'bridge', permissions: [
  { name: 'Screen Recording', isGranted: screen, isRequired: true },
  { name: 'Accessibility', isGranted: ax, isRequired: true },
  { name: 'Event Synthesizing', isGranted: true, isRequired: false },
] }, success: true });

test('doctor / self-check: `peekaboo permissions status --json` → Accessibility + Screen Recording', async () => {
  assert.deepEqual(parsePeekabooPermissions(permissionsJson(true, true)), { accessibility: 'granted', screen: 'granted' });
  assert.deepEqual(parsePeekabooPermissions(permissionsJson(false, false)), { accessibility: 'not_granted', screen: 'denied' });
  assert.deepEqual(parsePeekabooPermissions('Accessibility: Granted'), { accessibility: 'unknown', screen: 'unknown' });
  assert.deepEqual(await peekabooPermissions(null), { accessibility: 'unavailable', screen: 'unknown' }, 'not installed: nothing can drive apps');
  const calls = [];
  const exec = (bin, args, _o, cb) => { calls.push([bin, ...args]); cb(null, permissionsJson(true, false)); };
  assert.deepEqual(await peekabooPermissions(PKB, { exec }), { accessibility: 'granted', screen: 'denied' });
  assert.deepEqual(calls[0], [PKB, 'permissions', 'status', '--json']);
  assert.deepEqual(await handsPermissions({ kind: 'peekaboo', peekabooBin: PKB, ghostBin: GHOST }, { exec }), { accessibility: 'granted', screen: 'denied' });
  const ghostCalls = [];
  await handsPermissions({ kind: 'ghost', peekabooBin: PKB, ghostBin: GHOST }, { exec: (bin, args, _o, cb) => { ghostCalls.push([bin, ...args]); cb(null, 'Accessibility: granted'); } });
  assert.deepEqual(ghostCalls[0], [GHOST, 'status'], 'ghost-os hands read ghost-os\'s own status');
  assert.deepEqual(await handsPermissions({ kind: null }), { accessibility: 'unavailable', screen: 'unknown' });
});

test('banner info: version and tool count from Peekaboo\'s own CLI', async () => {
  const exec = (_bin, args, _o, cb) => cb(null, args[0] === '--version' ? 'Peekaboo 4.9.0 (release/4.9.0/7020aedd3, built: 2026-10-07)' : JSON.stringify({ data: { count: 26, tools: [] } }));
  assert.deepEqual(await peekabooInfo(PKB, { exec }), { version: '4.9.0', toolCount: 26 });
  assert.deepEqual(await peekabooInfo(null), { version: null, toolCount: null });
  assert.deepEqual(await peekabooInfo(PKB, { exec: (_b, _a, _o, cb) => cb(new Error('gone'), '') }), { version: null, toolCount: null });
});
