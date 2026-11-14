/**
 * blender-mcp tests — contract logic only. No Blender, no process spawn,
 * no network.
 */

import { readFileSync } from 'node:fs';
import {
  BLENDER_ENV_PIN,
  BLENDER_CAPABILITIES,
  BLENDER_CREDENTIAL_ENV_NAMES,
  classifyCapability,
  buildStartConfig,
  gateCapability,
} from '../lib/blender-contract.mjs';

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}`); }
}

const descriptor = JSON.parse(readFileSync(new URL('../descriptor.json', import.meta.url), 'utf8'));

// 1. Capability list: the upstream nine, risk-classed.
check('nine capabilities registered', BLENDER_CAPABILITIES.length === 9 && descriptor.capabilities.count === 9);
check('execute_blender_code is code-exec', classifyCapability('execute_blender_code')?.risk === 'code-exec');
check('look / get_scene_info are read', classifyCapability('look')?.risk === 'read' && classifyCapability('get_scene_info')?.risk === 'read');
check('generate_3d is egress with four services', classifyCapability('generate_3d')?.services.length === 4);
check('unknown capability classifies to null', classifyCapability('nuke_scene') === null);

// 2. Start config pins the governed env.
const cfg = buildStartConfig();
check('start config builds', cfg.ok === true && cfg.mcpServers.blender.command === 'uvx');
check('package arg is mcp-for-blender', cfg.mcpServers.blender.args.join(' ') === 'mcp-for-blender');
check('telemetry pinned off', cfg.mcpServers.blender.env.DISABLE_TELEMETRY === 'true');
check('safe mode pinned on', cfg.mcpServers.blender.env.BLENDER_MCP_SAFE_MODE === '1');
check('addon socket pinned to localhost:9876', cfg.mcpServers.blender.env.BLENDER_HOST === 'localhost' && cfg.mcpServers.blender.env.BLENDER_PORT === '9876');
check('descriptor env pins agree with contract', JSON.stringify(descriptor.mcpServer.envPins) === JSON.stringify({ ...BLENDER_ENV_PIN, BLENDER_HOST: 'localhost', BLENDER_PORT: '9876' }) || ['DISABLE_TELEMETRY', 'BLENDER_MCP_SAFE_MODE', 'BLENDER_HOST', 'BLENDER_PORT'].every((k) => descriptor.mcpServer.envPins[k] === BLENDER_ENV_PIN[k]));

// 3. Caller env cannot unpin governance.
check('unpinning telemetry refused', buildStartConfig({ env: { DISABLE_TELEMETRY: 'false' } }).ok === false);
check('disabling safe mode refused', buildStartConfig({ env: { BLENDER_MCP_SAFE_MODE: '0' } }).ok === false);
check('moving the socket off localhost refused', buildStartConfig({ env: { BLENDER_HOST: '192.168.1.50' } }).ok === false);
check('echoing the pinned values is allowed', buildStartConfig({ env: { DISABLE_TELEMETRY: 'true' } }).ok === true);

// 4. Credential surface is names-only.
check('credential env names are names only', BLENDER_CREDENTIAL_ENV_NAMES.every((n) => /^[A-Z0-9_]+$/.test(n)) && BLENDER_CREDENTIAL_ENV_NAMES.length === 6);
check('no credential VALUE anywhere in the config', !JSON.stringify(cfg).match(/sk-[A-Za-z0-9]|api[_-]?key\s*[:=]\s*['"][^<]/i));

// 5. Per-call gate.
const tap = async (t) => t === 'founder-token';
check('read capability is ambient', (await gateCapability('look')).ok === true);
check('code-exec refuses without a tap', (await gateCapability('execute_blender_code')).ok === false);
check('code-exec refuses with a bad tap', (await gateCapability('execute_blender_code', { tapToken: 'nope', verifyTap: tap })).ok === false);
check('code-exec passes with the founder tap', (await gateCapability('execute_blender_code', { tapToken: 'founder-token', verifyTap: tap })).ok === true);
check('egress refuses undeclared services', (await gateCapability('generate_3d')).ok === false);
check('egress refuses a partial declaration', (await gateCapability('generate_3d', { egressServices: ['tripo'] })).ok === false);
check('egress passes when all services declared', (await gateCapability('generate_3d', { egressServices: ['tripo', 'hunyuan3d', 'hyper3d-rodin', 'meshy'] })).ok === true);
check('trajectory feedback refused (telemetry pinned off)', (await gateCapability('record_trajectory_feedback')).ok === false);
check('unknown capability refused at the gate', (await gateCapability('nuke_scene')).ok === false);

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail === 0 ? 0 : 1);
