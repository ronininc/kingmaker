/**
 * solidcraft/lib/solidcraft-contract.mjs
 *
 * The governed launch contract for SolidCraft (tangency-labs/
 * solidcraft, MIT OR Apache-2.0) — Kingmaker's parametric CAD for
 * fabrication and renders, driven headless via `solidcraft-cli`
 * (JSON command scripts) and its MCP server. This module downloads
 * nothing and launches nothing: it holds the pin record, the pinned
 * preferences, and the job validation a governed invocation must
 * satisfy. Problems cited as S1..S3 — see ~/workspace/githubprojects-scan/PROBLEMS.md.
 *
 * Rules, each one deliberate:
 *   - THE UPDATER IS OFF, AND STAYS OFF (S1). Upstream checks for
 *     updates by default (check_updates: true) and its "verify"
 *     step is a SHA256SUMS file fetched from the same GitHub
 *     release as the binary — the minisign signature path exists
 *     but ships disabled (PUBLIC_KEY = None in update/install.rs),
 *     so a verified update can replace the running executable on
 *     the strength of same-origin checksums alone. The governed
 *     profile pins check_updates=false in a prefs file THIS module
 *     writes, and validatePrefs() refuses any prefs carrying
 *     check_updates=true. Making upstream's signature real is
 *     FORK-REQUIRED (set PUBLIC_KEY + sign the sums) — see
 *     PROBLEMS.md.
 *   - GOVERNED SURFACE IS THE CLI, NOT THE GUI. The updater lives
 *     in the desktop app. Governed launches are solidcraft-cli
 *     jobs and the MCP server only; the GUI is refused as a launch
 *     target in governed mode.
 *   - SCRIPT JOBS STAY IN THE WORKSPACE (S2). A JSON command
 *     script opens, imports, and exports at whatever paths it
 *     names — that is the tool's job, and exactly why an
 *     agent-authored script must be path-checked before it runs.
 *     validateScriptJob() walks every path-shaped string in the
 *     script and refuses any that resolves outside the declared
 *     fabrication workspace.
 *   - PIN BEFORE LAUNCH. The CLI binary's expectedSha256 starts
 *     EMPTY (upstream's own downloads are unsigned); Cage intake
 *     records the hash of the exact binary that will run.
 */

import { refused } from '../../lib/governance.mjs';

export const SOLID_PIN = Object.freeze({
  repo: 'tangency-labs/solidcraft',
  license: 'MIT OR Apache-2.0',
  auditedCommit: '8a562f2719ebe362399f5512296dea2cccb1a14e',
  binary: 'solidcraft-cli',
  expectedSha256: null, // Cage intake fills this. Empty on purpose.
  status: 'UNPINNED',
  forkRequired: Object.freeze([
    'crates/ui-egui/src/update/install.rs: PUBLIC_KEY is None — set it to the project minisign public key and ship SHA256SUMS.txt.minisig with releases so update verification is a signature, not same-origin checksums (S1)',
  ]),
});

/**
 * The governed preferences file content. check_updates is pinned
 * false here; there is no parameter that turns it on.
 */
export function buildGovernedPrefs() {
  return {
    ok: true,
    prefs: {
      check_updates: false,
    },
    governance: 'check_updates pinned false by contract (S1); validatePrefs refuses any prefs that re-enable it',
  };
}

/**
 * Validate a prefs object (e.g. read back from a machine about to
 * be governed). check_updates=true refuses — the pin cannot be
 * un-pinned by editing the file the contract produced.
 */
export function validatePrefs(prefs) {
  if (!prefs || typeof prefs !== 'object') return refused('prefs is not an object');
  if (prefs.check_updates === true) {
    return refused('check_updates=true refused: upstream update verification is same-origin SHA256SUMS with its minisign key unset (PUBLIC_KEY = None) — updates stay off in governed use (S1)');
  }
  return { ok: true };
}

const PATH_KEYS = Object.freeze(['path', 'out', 'output', 'file', 'input', 'export', 'import', 'src', 'dst', 'target']);

/** Collect path-shaped strings from a command script (recursive). */
export function scriptPaths(node, acc = []) {
  if (typeof node === 'string') {
    if (/^(?:\/|[a-zA-Z]:[\\/]|\.\.?\/)/.test(node) || /\.(?:step|stp|stl|3mf|iges|igs|obj|gltf|glb|solidcraft|json)$/i.test(node)) acc.push(node);
    return acc;
  }
  if (Array.isArray(node)) {
    for (const item of node) scriptPaths(item, acc);
    return acc;
  }
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (PATH_KEYS.includes(key) && typeof value === 'string') acc.push(value);
      else scriptPaths(value, acc);
    }
  }
  return acc;
}

function resolveInWorkspace(raw, workspace) {
  // Lexical resolution only (no fs access): join + normalize . / ..
  const joined = raw.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(raw) ? raw : `${workspace}/${raw}`;
  const parts = [];
  for (const seg of joined.replace(/\\/g, '/').split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { parts.pop(); continue; }
    parts.push(seg);
  }
  const resolved = `/${parts.join('/')}`;
  const root = `/${workspace.replace(/\\/g, '/').split('/').filter(Boolean).join('/')}`;
  return { resolved, inside: resolved === root || resolved.startsWith(`${root}/`) };
}

/**
 * Validate a script job before the CLI runs it (S2): the script
 * must parse as JSON, and every path it names must resolve inside
 * the declared fabrication workspace. Returns the CLI args on
 * success.
 */
export function validateScriptJob({ scriptText, workspace, outPath = null } = {}) {
  if (!workspace) return refused('a declared fabrication workspace is required');
  let script;
  try {
    script = JSON.parse(scriptText);
  } catch (err) {
    return refused(`script is not valid JSON: ${err.message}`);
  }
  const paths = scriptPaths(script);
  if (outPath) paths.push(outPath);
  for (const p of paths) {
    const { resolved, inside } = resolveInWorkspace(p, workspace);
    if (!inside) return refused(`script path '${p}' resolves to '${resolved}', outside the fabrication workspace (S2)`);
  }
  return { ok: true, pathsChecked: paths.length };
}

/**
 * Governed launch targets. The GUI app is refused (its updater is
 * the S1 surface); the CLI and the MCP server are the surface.
 */
export function validateLaunchTarget(target) {
  if (target === 'cli' || target === 'mcp') return { ok: true, target };
  if (target === 'gui' || target === 'app') {
    return refused('the desktop GUI is not a governed launch target: the auto-updater lives there and its verification is same-origin checksums (S1) — governed fabrication runs through solidcraft-cli / MCP');
  }
  return refused(`unknown launch target '${target}'`);
}

export function validatePinRecord(pin = SOLID_PIN) {
  if (!pin || pin.repo !== SOLID_PIN.repo) return { ok: false, pinned: false, reason: 'invalid pin record' };
  if (pin.expectedSha256 != null && !/^[0-9a-f]{64}$/.test(pin.expectedSha256)) {
    return { ok: false, pinned: false, reason: 'invalid pin record: expectedSha256 is not a sha256 hex digest' };
  }
  return { ok: true, pinned: pin.expectedSha256 != null && pin.status === 'PINNED' };
}
