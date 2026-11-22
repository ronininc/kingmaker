/**
 * blender-mcp/lib/blender-contract.mjs
 *
 * The governed start contract for Blender MCP (ahujasid/mcp-for-blender,
 * MIT) — the connector that lets the sovereign 3D pipeline drive a live
 * Blender session. Architecture (upstream README, fetched 2026-10-20):
 * a Blender addon runs a socket server inside Blender; the MCP server
 * (`uvx mcp-for-blender`) talks to it over TCP/JSON at
 * BLENDER_HOST:BLENDER_PORT (default localhost:9876).
 *
 * The contract pins what a governed session is allowed to be:
 *   - TELEMETRY OFF, ALWAYS. Upstream collects a minimal anonymous
 *     usage record by default (install id, session id, tool name,
 *     success, duration, versions, OS, timestamp). The governed launch
 *     env pins DISABLE_TELEMETRY=true. A caller-supplied env that turns
 *     it back on is refused.
 *   - SAFE MODE ON. BLENDER_MCP_SAFE_MODE=1 makes upstream validate
 *     scripts before they run in Blender. Pinned, not optional.
 *   - LOCAL SOCKET ONLY. BLENDER_HOST is pinned to localhost; a
 *     non-localhost addon host is refused — the Blender session is a
 *     local instrument, not a network service.
 *   - NINE CAPABILITIES, RISK-CLASSED (see BLENDER_CAPABILITIES):
 *       read         scene/viewport inspection — ambient.
 *       data-control telemetry + trajectory-feedback switches. In a
 *                    governed session telemetry is pinned OFF at
 *                    launch, so record_trajectory_feedback (the
 *                    opt-in content-collection path) is refused too.
 *       code-exec    execute_blender_code is arbitrary Python inside
 *                    Blender — upstream's own README warns it is
 *                    "potentially dangerous". Founder-tap-gated.
 *       egress       generate_3d and the asset tools reach third-party
 *                    services (Tripo, Hunyuan3D, Hyper3D Rodin, Meshy;
 *                    Poly Haven, Sketchfab, Poly Pizza). Each call must
 *                    have every service it touches on the session's
 *                    declared egress list. Asset-service credential env
 *                    names are broker-delivered; values never appear in
 *                    this contract or the audit log.
 */

import { createTapGate, refused } from '../../lib/governance.mjs';

export const BLENDER_ENV_PIN = Object.freeze({
  DISABLE_TELEMETRY: 'true',
  BLENDER_MCP_SAFE_MODE: '1',
  BLENDER_HOST: 'localhost',
  BLENDER_PORT: '9876',
});

export const BLENDER_CAPABILITIES = Object.freeze([
  Object.freeze({ name: 'execute_blender_code', risk: 'code-exec', note: 'arbitrary Python in live Blender — founder tap per call' }),
  Object.freeze({ name: 'look', risk: 'read', note: 'viewport/camera views (solid/material/rendered/wireframe/xray)' }),
  Object.freeze({ name: 'get_scene_info', risk: 'read', note: 'scene structure' }),
  Object.freeze({ name: 'generate_3d', risk: 'egress', services: Object.freeze(['tripo', 'hunyuan3d', 'hyper3d-rodin', 'meshy']), note: 'cloud 3D generation services' }),
  Object.freeze({ name: 'search_assets', risk: 'egress', services: Object.freeze(['polyhaven', 'sketchfab', 'polypizza']), note: 'asset libraries; Poly Pizza CC-BY assets carry attribution duties upstream' }),
  Object.freeze({ name: 'import_asset', risk: 'egress', services: Object.freeze(['polyhaven', 'sketchfab', 'polypizza']), note: 'downloads an asset into the scene' }),
  Object.freeze({ name: 'get_addon_status', risk: 'read', note: 'addon/service status' }),
  Object.freeze({ name: 'disable_telemetry', risk: 'data-control', note: 'already pinned off at launch; harmless to call' }),
  Object.freeze({ name: 'record_trajectory_feedback', risk: 'data-control', note: 'trains on session content — refused while telemetry is pinned off' }),
]);

// Credential env NAMES the broker may deliver for egress capabilities.
// Names only — values never live in the contract.
export const BLENDER_CREDENTIAL_ENV_NAMES = Object.freeze([
  'BLENDERMCP_SKETCHFAB_API_KEY',
  'BLENDERMCP_POLYPIZZA_API_KEY',
  'BLENDERMCP_HYPER3D_API_KEY',
  'BLENDERMCP_HUNYUAN3D_SECRET_ID',
  'BLENDERMCP_HUNYUAN3D_SECRET_KEY',
  'BLENDERMCP_MESHY_API_KEY',
]);

export function classifyCapability(name) {
  return BLENDER_CAPABILITIES.find((c) => c.name === name) ?? null;
}

/**
 * Build the governed MCP start config. Refuses when a caller env tries
 * to unpin telemetry/safe-mode or move the addon socket off localhost.
 */
export function buildStartConfig({ env: callerEnv = {} } = {}) {
  for (const [key, pinned] of Object.entries(BLENDER_ENV_PIN)) {
    if (key in callerEnv && String(callerEnv[key]) !== pinned) {
      return refused(`blender-mcp: ${key} is pinned to '${pinned}' by the governed contract — caller value refused`);
    }
  }
  return {
    ok: true,
    mcpServers: {
      blender: {
        command: 'uvx',
        args: ['mcp-for-blender'],
        env: { ...BLENDER_ENV_PIN },
      },
    },
    governance: {
      telemetry: 'off (pinned)',
      safeMode: 'on (pinned)',
      addonSocket: 'localhost:9876 only',
      codeExec: 'founder-tap-gated',
      egress: 'per-capability declared services',
    },
  };
}

/**
 * The per-call gate. Returns { ok: true, capability } or a refusal.
 * ctx: { tapToken, verifyTap, egressServices = [] }
 */
export async function gateCapability(name, { tapToken = null, verifyTap = null, egressServices = [] } = {}) {
  const cap = classifyCapability(name);
  if (!cap) return refused(`blender-mcp: unknown capability '${name}' — refused`);
  if (cap.risk === 'read') return { ok: true, capability: cap };
  if (cap.risk === 'data-control') {
    if (cap.name === 'record_trajectory_feedback') {
      return refused('blender-mcp: trajectory feedback is refused — telemetry is pinned OFF in a governed session');
    }
    return { ok: true, capability: cap };
  }
  if (cap.risk === 'code-exec') {
    const gate = createTapGate(verifyTap);
    const blocked = await gate(tapToken);
    if (blocked) return { ...blocked, reason: `blender-mcp: execute_blender_code refused — ${blocked.reason}` };
    return { ok: true, capability: cap };
  }
  if (cap.risk === 'egress') {
    const declared = new Set(egressServices.map((s) => String(s).toLowerCase()));
    const missing = cap.services.filter((s) => !declared.has(s));
    if (missing.length > 0) {
      return refused(`blender-mcp: '${name}' touches undeclared egress services: ${missing.join(', ')} — declare them on the session first`);
    }
    return { ok: true, capability: cap };
  }
  return refused(`blender-mcp: unhandled risk class '${cap.risk}' — refused`);
}
