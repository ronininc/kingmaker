/**
 * artemis tests — pure contract checks. No APK, no device, no network.
 * The hash function is an injected fake; the tap is an injected fake.
 */

import { readFileSync } from 'node:fs';
import {
  ARTEMIS_PIN,
  ALLOWED_MODEL_PROVIDERS,
  buildGovernedEnv,
  validateInvocation,
  buildMcpConfig,
  installHelper,
} from '../lib/artemis-contract.mjs';

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}`); }
}

const descriptor = JSON.parse(readFileSync(new URL('../descriptor.json', import.meta.url), 'utf8'));
const tapOk = async (t) => t === 'tap-ok';

// 1. Pins recorded at audit time.
check('helper APK pin recorded with manifest-matching sha256', /^[0-9a-f]{64}$/.test(ARTEMIS_PIN.helperApk.sha256) && ARTEMIS_PIN.helperApk.versionCode === 6);
check('descriptor agrees with APK pin', descriptor.pin.helperApk.sha256 === ARTEMIS_PIN.helperApk.sha256);
check('APK signature trust is NONE (debug keystore)', /NONE/.test(ARTEMIS_PIN.helperApk.signatureTrust));

// 2. A1/A6 — forbidden commands refuse.
check('server web refuses (A1)', validateInvocation(['server', 'web']).ok === false && /A1/.test(validateInvocation(['server', 'web']).reason));
check('mcp install refuses (A6)', validateInvocation(['mcp', 'install', '--client', 'claude']).ok === false && /A6/.test(validateInvocation(['mcp', 'install']).reason));
check('plain run invocation passes', validateInvocation(['run', 'open settings', '--profile', 'flash']).ok === true);

// 3. A4/A8 — binds and transports.
check('wide bind refuses (A4)', validateInvocation(['ui', '--host', '0.0.0.0']).ok === false && /loopback/.test(validateInvocation(['ui', '--host', '0.0.0.0']).reason));
check('loopback bind passes', validateInvocation(['ui', '--host', '127.0.0.1']).ok === true);
check('MCP SSE refuses (A8)', validateInvocation(['mcp', '--transport', 'sse']).ok === false && /stdio only/.test(validateInvocation(['mcp', '--transport', 'sse']).reason));

// 4. Pinned env — the pins cannot be un-pinned by caller config.
const e1 = await buildGovernedEnv({ callerEnv: { ARTEMIS_HELPER_AUTO_INSTALL: 'true' } });
check('caller cannot un-pin helper auto-install (A2)', e1.ok === false && /pinned/.test(e1.reason));
const e2 = await buildGovernedEnv({ callerEnv: { ARTEMIS_KEEP_DEVICE_AWAKE: 'true' } });
check('caller cannot un-pin keep-awake (A7)', e2.ok === false && /pinned/.test(e2.reason));
const e3 = await buildGovernedEnv({ callerEnv: { ARTEMIS_ALLOWED_HOSTS: 'myhost.ts.net' } });
check('ALLOWED_HOSTS widening refuses (A4)', e3.ok === false && /operator/.test(e3.reason));
const e4 = await buildGovernedEnv({});
check('governed env builds with pins set', e4.ok === true && e4.env.ARTEMIS_HELPER_AUTO_INSTALL === 'false' && e4.env.ARTEMIS_KEEP_DEVICE_AWAKE === 'false');

// 5. A5 — provider allowlist + OCR tap.
const e5 = await buildGovernedEnv({ modelProvider: 'openrouter' });
check('openrouter refuses (A5)', e5.ok === false && /allowlist/.test(e5.reason));
const e6 = await buildGovernedEnv({ modelProvider: 'xai' });
check('xai refuses (A5)', e6.ok === false);
check('allowlist is the sanctioned three', ALLOWED_MODEL_PROVIDERS.join(',') === 'gemini,anthropic,openai');
const e7 = await buildGovernedEnv({ callerEnv: { OCR_API_KEY: 'should-not-survive' } });
check('OCR key stripped when cloud OCR is off', e7.ok === true && !('OCR_API_KEY' in e7.env));
const e8 = await buildGovernedEnv({ cloudOcr: true });
check('cloud OCR without tap refuses (A5)', e8.ok === false && /tap/.test(e8.reason));
const e9 = await buildGovernedEnv({ cloudOcr: true, callerEnv: { OCR_API_KEY: 'k' }, verifyTap: tapOk, tapToken: 'tap-ok' });
check('cloud OCR with founder tap builds and keeps key', e9.ok === true && e9.env.OCR_API_KEY === 'k');

// 6. MCP config is ours: stdio, governed env, no installer.
const m1 = await buildMcpConfig({});
check('MCP config builds over stdio', m1.ok === true && m1.mcpServers.artemis.args.join(' ') === 'run artemis mcp');
check('MCP config env carries the pins', m1.mcpServers.artemis.env.ARTEMIS_HELPER_AUTO_INSTALL === 'false');

// 7. A2/A3 — helper install: tap + hash pin, fail-closed.
const h1 = await installHelper({ apkPath: '/x/helper.apk', hashFile: async () => ARTEMIS_PIN.helperApk.sha256 });
check('install without tap verifier refuses (fail-closed)', h1.ok === false && /fail-closed|tap/.test(h1.reason));
const h2 = await installHelper({ apkPath: '/x/helper.apk', hashFile: async () => 'f'.repeat(64), verifyTap: tapOk, tapToken: 'tap-ok' });
check('install with wrong APK hash refuses (A3)', h2.ok === false && /does not match the pin/.test(h2.reason));
const h3 = await installHelper({ apkPath: '/x/helper.apk', hashFile: async () => ARTEMIS_PIN.helperApk.sha256, verifyTap: tapOk, tapToken: 'tap-ok' });
check('install with tap + pinned hash allowed', h3.ok === true && h3.package === 'com.artemis.helper');

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail === 0 ? 0 : 1);
