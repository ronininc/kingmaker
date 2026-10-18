// Fork-mode wiring: the env Kingmaker hands its engine (lib/profile.mjs ghostBackendEnv) must be what the imported
// engine source actually reads. Guards against a re-import that renames or drops a variable Kingmaker relies on:
//   SOLOMON_CRM_DEFAULT=none        → home-crm.ts: no CRM until the owner connects one (never the operator's Ronin CRM)
//   SOLOMON_MAC_HANDS=peekaboo      → peekaboo-hands-client.ts / mac-hands.ts: Hands of Horus drive the Mac
//   SOLOMON_PEEKABOO_MCP_CMD        → peekaboo-hands-client.ts: the Peekaboo MCP launch command (JSON argv)
//   SOLOMON_RUNTIME_EDITION=DEV_NONCOMMERCIAL (lib/fork.mjs) → edition-profile.ts: the noncommercial dev edition, on 'merchant'
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { forkBackendLaunch, forkLayout, KINGMAKER_RUNTIME_EDITION, REPO_ROOT } from '../lib/fork.mjs';
import { resolvePaths } from '../lib/paths.mjs';
import { ghostBackendEnv } from '../lib/profile.mjs';

const runtime = join(forkLayout(REPO_ROOT).root, 'server', 'src', 'runtime');
const src = (name) => readFileSync(join(runtime, name), 'utf8');
const imported = existsSync(forkLayout(REPO_ROOT).serverEntry);
const paths = resolvePaths({ SOL_GHOST_HOME: '/tmp/sg-state' }, '/Users/owner', { exists: () => false });
const secrets = { nonce: 'a'.repeat(64), voiceKey: 'b'.repeat(64) };
const PKB = '/opt/homebrew/bin/peekaboo';

test('the imported engine reads the CRM and hands variables Kingmaker sets', { skip: !imported && 'the engine source is not imported' }, () => {
  assert.match(src('home-crm.ts'), /env\.SOLOMON_CRM_DEFAULT\b/, 'home-crm.ts reads SOLOMON_CRM_DEFAULT');
  assert.match(src('ronin-crm-mcp.ts'), /crmDefaultNone|SOLOMON_CRM_DEFAULT/, 'the Ronin CRM client honours "no CRM by default"');
  const hands = src('peekaboo-hands-client.ts');
  assert.match(hands, /env\.SOLOMON_MAC_HANDS\b/, 'peekaboo-hands-client.ts reads SOLOMON_MAC_HANDS');
  assert.match(hands, /env\.SOLOMON_PEEKABOO_MCP_CMD\b/, 'peekaboo-hands-client.ts reads SOLOMON_PEEKABOO_MCP_CMD');
  assert.ok(existsSync(join(runtime, 'mac-hands.ts')) && existsSync(join(runtime, 'peekaboo-control-actuator.ts')), 'the Peekaboo actuator is imported');
});

test('backend env → engine: no CRM by default, Peekaboo selected when installed', { skip: !imported && 'the engine source is not imported' }, async (t) => {
  const env = ghostBackendEnv({ env: {}, paths, port: 3001, secrets, ghostBin: null, peekabooBin: PKB });
  assert.equal(env.SOLOMON_CRM_DEFAULT, 'none');
  assert.equal(env.SOLOMON_MAC_HANDS, 'peekaboo');
  assert.deepEqual(JSON.parse(env.SOLOMON_PEEKABOO_MCP_CMD), [PKB, 'mcp']);
  // home-crm.ts imports only node builtins, so a Node with type stripping (22.18+) can run it as-is.
  let homeCrm;
  try { ({ homeCrm } = await import(pathToFileURL(join(runtime, 'home-crm.ts')).href)); } catch (error) { t.skip(`this Node cannot load .ts (${error.code ?? error.message})`); return; }
  const data = mkdtempSync(join(tmpdir(), 'km-crm-'));
  const h = homeCrm({ ...env, SOLOMON_DATA_DIR: data });
  assert.equal(h.none, true, 'with SOLOMON_CRM_DEFAULT=none and nothing connected, there is no home CRM');
  assert.equal(h.isRonin, false);
  assert.equal(homeCrm({ SOLOMON_DATA_DIR: data }).isRonin, true, 'without the flag the engine would fall back to the Ronin CRM');
});

test('fork mode runs the noncommercial dev edition on the merchant surface', { skip: !imported && 'the engine source is not imported' }, async () => {
  assert.equal(KINGMAKER_RUNTIME_EDITION, 'DEV_NONCOMMERCIAL');
  const profile = src('edition-profile.ts');
  assert.match(profile, /'DEV_NONCOMMERCIAL'/, 'the imported engine defines DEV_NONCOMMERCIAL');
  assert.match(profile, /\.\.\.PAID_CORE_PROFILE/, 'built from PAID_CORE_PROFILE (same gating)');
  const runtimeHome = mkdtempSync(join(tmpdir(), 'km-edition-'));
  const launch = await forkBackendLaunch({ env: { HOME: runtimeHome, PATH: '/usr/bin' }, runtimeHome, resources: join(runtimeHome, 'res'), port: 3999 });
  assert.equal(launch.env.SOLOMON_RUNTIME_EDITION, 'DEV_NONCOMMERCIAL');
  assert.equal(launch.env.SOLOMON_RUNTIME_SURFACE, 'merchant');
  assert.match(readFileSync(launch.bootstrap.envPath, 'utf8'), /^SOLOMON_RUNTIME_EDITION=DEV_NONCOMMERCIAL$/m);
  const backend = ghostBackendEnv({ env: launch.env, paths, port: 3999, secrets, ghostBin: null });
  assert.equal(backend.SOLOMON_RUNTIME_EDITION, 'DEV_NONCOMMERCIAL', 'the Kingmaker profile keeps it');
  assert.equal(backend.SOLOMON_RUNTIME_SURFACE, 'merchant');
});
