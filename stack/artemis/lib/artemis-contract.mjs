/**
 * artemis/lib/artemis-contract.mjs
 *
 * The governed launch contract for ARTEMIS (google/artemis,
 * Apache-2.0) — the Android device-driving layer for Kingmaker
 * Mobile. This module downloads nothing, installs nothing, and
 * launches nothing: it holds the pins (source commit + the on-device
 * helper APK), the pinned environment, and the rules a governed
 * invocation must satisfy. Problems cited as A1..A8 — see
 * ~/workspace/githubprojects-scan/PROBLEMS.md.
 *
 * Rules, each one deliberate:
 *   - THE CLOUD PROXY NEVER RUNS (A1). `artemis server web` binds
 *     ALL interfaces with wildcard CORS and attaches the operator's
 *     GCP identity token + tenant token to proxied requests: any
 *     local process or visited web page can ride an authenticated
 *     proxy. Refused outright, no override.
 *   - THE UPSTREAM INSTALLER NEVER RUNS (A6). `artemis mcp install`
 *     writes agent config files AND injects a rules block into the
 *     host agent's instruction files (~/.claude/CLAUDE.md and
 *     friends). Registrations are written by THIS contract, in the
 *     house format, or not at all.
 *   - THE HELPER INSTALLS ONLY BY HAND (A2, A3). Upstream defaults
 *     ARTEMIS_HELPER_AUTO_INSTALL=true: any task silently installs /
 *     upgrades a persistent accessibility service on the phone. The
 *     governed env pins it false — un-unpinnable — and the only
 *     install path is installHelper(): founder tap + the APK's
 *     sha256 must equal the recorded pin. (The pin is a hash, not a
 *     signature: the APK is signed with a debug keystore shipped in
 *     the repo, so its signature proves nothing. Re-signing with a
 *     private key is FORK-REQUIRED — see PROBLEMS.md.)
 *   - THE CONSOLE STAYS ON LOOPBACK (A4). The admin console has no
 *     user accounts by design: whoever reaches the port is the
 *     operator. Governed launches pin 127.0.0.1 and refuse any
 *     ARTEMIS_ALLOWED_HOSTS widening. (Upstream's Host/Origin
 *     anti-rebinding checks stay untouched and are relied on.)
 *   - THE BRAIN IS OURS, FROM AN ALLOWLIST (A5). Screenshots, UI
 *     trees, and task text leave the phone to the configured model
 *     provider. The governed env may name only an allowlisted
 *     provider; cloud OCR (Google Cloud Vision) is off unless the
 *     founder taps it on per launch.
 *   - STDIO MCP ONLY (A8). The SSE transport binds a port with no
 *     evident auth. Refused.
 *   - THE PHONE SLEEPS (A7). ARTEMIS_KEEP_DEVICE_AWAKE is pinned
 *     false in governed env; upstream defaults it true.
 */

import { refused, createTapGate } from '../../lib/governance.mjs';

export const ARTEMIS_PIN = Object.freeze({
  repo: 'google/artemis',
  license: 'Apache-2.0',
  auditedCommit: '351ca8422f7b5b54e80a9c1ce03a222e02415b6b',
  // Recorded at audit time: sha256 of the APK in the cloned tree AND
  // the value in packages/artemis-accessibility-helper/helper_manifest.json
  // (they agree). Hash-pinned, NEVER signature-trusted (debug key).
  helperApk: Object.freeze({
    path: 'packages/artemis-accessibility-helper/ArtemisAccessibilityHelper.apk',
    package: 'com.artemis.helper',
    versionName: '1.2.0',
    versionCode: 6,
    sha256: '133e373fe03615c251cd74b03a38539c844d09a074954bca2d2dde6684561969',
    signatureTrust: 'NONE — signed with the repo-shipped debug keystore; hash pin is the only integrity',
  }),
});

// Subcommands that must never exist in a governed invocation.
// `server web` = the credential-attaching all-interface proxy (A1).
// Anything under `mcp install` / `install` = the upstream installer
// that edits agent configs and instruction files (A6).
export const FORBIDDEN_COMMANDS = Object.freeze([
  Object.freeze({ argv: ['server', 'web'], why: 'A1: all-interface proxy with wildcard CORS that attaches the operator\u2019s GCP identity token' }),
  Object.freeze({ argv: ['mcp', 'install'], why: 'A6: upstream installer writes agent configs and injects rules into instruction files' }),
  Object.freeze({ argv: ['install'], why: 'A6: upstream installer writes agent configs and injects rules into instruction files' }),
]);

// The model providers a governed launch may name (A5). OpenRouter
// and xAI are upstream-supported and deliberately NOT on this list:
// they are aggregators / extra jurisdictions the founder has not
// sanctioned for phone-screen data.
export const ALLOWED_MODEL_PROVIDERS = Object.freeze(['gemini', 'anthropic', 'openai']);

// Env keys the governed profile owns. A caller-supplied value for any
// of these is not merged — it is refused, so the pin cannot be
// un-pinned by configuration (Blender-MCP telemetry pattern).
export const PINNED_ENV = Object.freeze({
  ARTEMIS_HELPER_AUTO_INSTALL: 'false', // A2
  ARTEMIS_KEEP_DEVICE_AWAKE: 'false', // A7
});

export function forbiddenCommand(argv) {
  if (!Array.isArray(argv)) return null;
  for (const f of FORBIDDEN_COMMANDS) {
    if (f.argv.every((part, i) => argv[i] === part)) return f;
  }
  return null;
}

/**
 * Build the governed environment for any ARTEMIS process. Pinned keys
 * are set by THIS module; a caller value for a pinned key, an
 * ARTEMIS_ALLOWED_HOSTS entry (A4), a non-allowlisted model provider
 * (A5), or cloud OCR without the founder tap (A5) each refuse.
 */
export function buildGovernedEnv({ callerEnv = {}, modelProvider = 'gemini', cloudOcr = false, verifyTap = null, tapToken = null } = {}) {
  for (const key of Object.keys(PINNED_ENV)) {
    if (key in callerEnv && callerEnv[key] !== PINNED_ENV[key]) {
      return refused(`env ${key} is pinned to '${PINNED_ENV[key]}' by the governed profile — caller value refused (the pin cannot be un-pinned by config)`);
    }
  }
  if ('ARTEMIS_ALLOWED_HOSTS' in callerEnv && String(callerEnv.ARTEMIS_ALLOWED_HOSTS).trim() !== '') {
    return refused('ARTEMIS_ALLOWED_HOSTS widens the console beyond its loopback posture — refused (A4: whoever reaches the port is the operator)');
  }
  if (!ALLOWED_MODEL_PROVIDERS.includes(modelProvider)) {
    return refused(`model provider '${modelProvider}' is not on the governed allowlist (${ALLOWED_MODEL_PROVIDERS.join(', ')}) — phone screens go only where the founder sanctioned (A5)`);
  }
  return (async () => {
    if (cloudOcr) {
      const gate = createTapGate(verifyTap);
      const refusal = await gate(tapToken);
      if (refusal) return refusal;
    }
    const env = {
      ...callerEnv,
      ...PINNED_ENV,
      ARTEMIS_MODEL_PROVIDER: modelProvider,
    };
    if (!cloudOcr) delete env.OCR_API_KEY;
    return { ok: true, env };
  })();
}

/**
 * Validate a governed ARTEMIS invocation (argv after the binary).
 * Forbidden subcommands refuse (A1, A6); the console must bind
 * loopback (A4); MCP must be stdio (A8).
 */
export function validateInvocation(argv) {
  const hit = forbiddenCommand(argv);
  if (hit) return refused(`forbidden command '${hit.argv.join(' ')}' — ${hit.why}`);
  const joined = argv.join(' ');
  if (/(^|\s)(--host)(\s|=)(?!127\.0\.0\.1|localhost)/.test(joined) || /0\.0\.0\.0/.test(joined)) {
    return refused('non-loopback bind refused — governed ARTEMIS listeners stay on 127.0.0.1 (A4)');
  }
  if (argv[0] === 'mcp' && /(sse|http)/i.test(joined)) {
    return refused('MCP over SSE/HTTP refused — stdio only (A8)');
  }
  return { ok: true };
}

/**
 * Build the governed MCP registration (stdio). This replaces the
 * upstream installer entirely (A6): the registration is ours, in the
 * house format, and no instruction file is ever touched.
 */
export async function buildMcpConfig({ modelProvider = 'gemini', auditLog = null } = {}) {
  const envResult = await buildGovernedEnv({ modelProvider });
  if (envResult.ok === false) return envResult;
  if (auditLog) auditLog.append({ actor: 'artemis-contract', action: 'mcp.config.built', detail: `provider=${modelProvider} transport=stdio` });
  return {
    ok: true,
    mcpServers: {
      artemis: {
        command: 'uv',
        args: ['run', 'artemis', 'mcp'],
        env: envResult.env,
      },
    },
    governance: {
      transport: 'stdio (SSE refused, A8)',
      helperInstall: 'founder tap + pinned APK sha256 only (A2/A3)',
      console: 'loopback only, no ARTEMIS_ALLOWED_HOSTS (A4)',
      forbidden: FORBIDDEN_COMMANDS.map((f) => f.argv.join(' ')),
    },
  };
}

/**
 * The ONLY helper-install path (A2, A3): founder tap, and the APK
 * about to be installed must hash to the recorded pin. `hashFile` is
 * injected (async (path) => sha256 hex) so tests run on paper.
 */
export async function installHelper({ apkPath, hashFile, verifyTap = null, tapToken = null, auditLog = null } = {}) {
  const gate = createTapGate(verifyTap);
  const refusal = await gate(tapToken);
  if (refusal) {
    if (auditLog) auditLog.append({ actor: 'artemis-contract', action: 'helper.install.refused', detail: refusal.reason });
    return refusal;
  }
  if (!apkPath || typeof hashFile !== 'function') return refused('installHelper needs the APK path and a hash function');
  let digest;
  try {
    digest = await hashFile(apkPath);
  } catch (err) {
    return refused(`could not hash the helper APK: ${err.message}`);
  }
  if (digest !== ARTEMIS_PIN.helperApk.sha256) {
    if (auditLog) auditLog.append({ actor: 'artemis-contract', action: 'helper.install.refused', detail: `apk sha256 ${String(digest).slice(0, 12)}… != pinned ${ARTEMIS_PIN.helperApk.sha256.slice(0, 12)}…` });
    return refused(`helper APK sha256 does not match the pin (got ${String(digest).slice(0, 12)}…, pinned ${ARTEMIS_PIN.helperApk.sha256.slice(0, 12)}…) — install refused (A3)`);
  }
  if (auditLog) auditLog.append({ actor: 'artemis-contract', action: 'helper.install.allowed', detail: `${ARTEMIS_PIN.helperApk.package} ${ARTEMIS_PIN.helperApk.versionName} sha256 verified` });
  return { ok: true, package: ARTEMIS_PIN.helperApk.package, versionName: ARTEMIS_PIN.helperApk.versionName, sha256: digest };
}
