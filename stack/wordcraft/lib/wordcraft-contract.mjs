/**
 * wordcraft/lib/wordcraft-contract.mjs
 *
 * The governed launch contract for WordCraft (storytold/wordcraft,
 * MIT OR Apache-2.0) — Kingmaker's document production layer, driven
 * via `wordcraft-cli` (convert / run) and its MCP server. This module
 * downloads nothing and launches nothing: it holds the pin record and
 * the rules a governed invocation must satisfy before any process is
 * allowed to exist. Problems cited as W1..W4 — see ~/workspace/githubprojects-scan/PROBLEMS.md.
 *
 * Rules, each one deliberate:
 *   - PIN BEFORE LAUNCH. expectedSha256 starts EMPTY; Cage intake
 *     records the release binary's hash. Unpinned → no config, ever.
 *   - CONFINEMENT IS NOT OPTIONAL (W1). Upstream, the automation
 *     roots are opt-in: no --automation-read-root / --automation-
 *     write-root means the MCP server runs UNCONFINED against the
 *     whole filesystem (crates/engine/src/file_access.rs: "nothing is
 *     confined then"). A governed launch REQUIRES both roots, inside
 *     the declared workspace, and refuses without them. No caller
 *     config can widen or drop them.
 *   - MACRO FLAVORS REFUSED (W2). Upstream round-trips a .docm's
 *     vbaProject.bin through conversion untouched — a live macro
 *     payload rides through an agent pipeline to whoever opens the
 *     output. Governed convert/run jobs refuse .docm/.dotm inputs.
 *     There is no tap override: the fix is converting from a clean
 *     source, not blessing the payload.
 *   - PASSWORDS BY FILE ONLY (W3). Upstream's own docs admit
 *     --password is readable by any process on the machine from the
 *     command line. Governed jobs accept --password-file only.
 *   - SCRIPTED JOBS ARE TAP-GATED (W4). `wordcraft-cli run` executes
 *     a command-job file — a code-shaped capability. Agent-driven
 *     run jobs need the founder tap; convert jobs do not.
 */

import { refused, createTapGate } from '../../lib/governance.mjs';

export const WORDCRAFT_PIN = Object.freeze({
  repo: 'storytold/wordcraft',
  license: 'MIT OR Apache-2.0',
  auditedCommit: '9b4b948c6ecf29401e01ad58626d3c1983b83770',
  binary: 'wordcraft-cli',
  expectedSha256: null, // Cage intake fills this. Empty on purpose.
  status: 'UNPINNED',
});

export const MACRO_FLAVORS = Object.freeze(['.docm', '.dotm']);

function pinProblem(pin) {
  if (!pin || typeof pin !== 'object') return 'invalid pin record: not an object';
  if (pin.repo !== WORDCRAFT_PIN.repo) return `invalid pin record: repo '${pin.repo}' is not the audited repo`;
  if (pin.expectedSha256 != null && !/^[0-9a-f]{64}$/.test(pin.expectedSha256)) {
    return 'invalid pin record: expectedSha256 is not a sha256 hex digest';
  }
  return null;
}

export function validatePinRecord(pin = WORDCRAFT_PIN) {
  const problem = pinProblem(pin);
  if (problem) return { ok: false, pinned: false, reason: problem };
  return { ok: true, pinned: pin.expectedSha256 != null && pin.status === 'PINNED' };
}

function requirePinned(pin) {
  const v = validatePinRecord(pin);
  if (!v.ok) return refused(`invalid pin record: ${v.reason}`);
  if (!v.pinned) return refused('wordcraft-cli is not pinned — Cage intake records the binary sha256 before any governed launch');
  return null;
}

function insideWorkspace(path, workspace) {
  if (typeof path !== 'string' || typeof workspace !== 'string') return false;
  const norm = (p) => p.replace(/\/+$/, '');
  const w = norm(workspace);
  const p = norm(path);
  return p === w || p.startsWith(`${w}/`);
}

/**
 * Build the governed MCP server registration. Refuses unless the
 * binary is pinned AND both automation roots are declared inside the
 * workspace (W1). The roots are written into the config by THIS
 * module; a caller cannot drop or widen them.
 */
export function buildMcpConfig({ pin = WORDCRAFT_PIN, workspace, readRoot, writeRoot, auditLog = null } = {}) {
  const pinRefusal = requirePinned(pin);
  if (pinRefusal) return pinRefusal;
  if (!workspace) return refused('a declared workspace is required — automation roots must live inside it');
  if (!readRoot || !writeRoot) {
    return refused('both --automation-read-root and --automation-write-root are required: upstream runs UNCONFINED without them (W1)');
  }
  if (!insideWorkspace(readRoot, workspace)) return refused(`read root '${readRoot}' is outside the declared workspace`);
  if (!insideWorkspace(writeRoot, workspace)) return refused(`write root '${writeRoot}' is outside the declared workspace`);
  if (auditLog) auditLog.append({ actor: 'wordcraft-contract', action: 'mcp.config.built', detail: `read=${readRoot} write=${writeRoot}` });
  return {
    ok: true,
    mcpServers: {
      wordcraft: {
        command: 'wordcraft-cli',
        args: ['mcp', '--automation-read-root', readRoot, '--automation-write-root', writeRoot],
      },
    },
    governance: {
      confinement: `read=${readRoot} write=${writeRoot} (pinned by contract; upstream default is unconfined)`,
      macroFlavors: 'refused (.docm/.dotm)',
    },
  };
}

const flavorOf = (path) => {
  const m = /\.([a-z0-9]+)$/i.exec(String(path ?? ''));
  return m ? `.${m[1].toLowerCase()}` : '';
};

/**
 * Validate a convert job. Macro-flavored inputs refuse (W2); a raw
 * password value refuses — passwordFile only (W3); paths must stay
 * inside the workspace the job was declared under.
 */
export function buildConvertArgs({ input, output, workspace, password = null, passwordFile = null, updateFields = false } = {}) {
  if (!input || !output) return refused('convert needs an input and an output path');
  if (MACRO_FLAVORS.includes(flavorOf(input))) {
    return refused(`macro documents refused: '${input}' can carry a VBA project that upstream round-trips untouched into the output (W2) — convert from a clean .docx source`);
  }
  if (password != null) return refused('a raw --password is readable by every process on the machine; use --password-file (W3)');
  if (workspace) {
    if (!insideWorkspace(input, workspace)) return refused(`input '${input}' is outside the declared workspace`);
    if (!insideWorkspace(output, workspace)) return refused(`output '${output}' is outside the declared workspace`);
  }
  const args = ['convert', input, output];
  if (updateFields) args.push('--update-fields');
  if (passwordFile) args.push('--password-file', passwordFile);
  return { ok: true, args };
}

/**
 * Validate a scripted `run` job (W4). Requires the founder tap —
 * a command-job file is a code-shaped capability. Same macro and
 * password rules as convert.
 */
export async function buildRunArgs({ jobFile, workspace, password = null, passwordFile = null, verifyTap = null, tapToken = null, auditLog = null } = {}) {
  const gate = createTapGate(verifyTap);
  const refusal = await gate(tapToken);
  if (refusal) {
    if (auditLog) auditLog.append({ actor: 'wordcraft-contract', action: 'run.refused', detail: refusal.reason });
    return refusal;
  }
  if (!jobFile) return refused('run needs a command-job file');
  if (MACRO_FLAVORS.includes(flavorOf(jobFile))) return refused('macro-flavored job files refused (W2)');
  if (password != null) return refused('a raw --password is readable by every process on the machine; use --password-file (W3)');
  if (workspace && !insideWorkspace(jobFile, workspace)) return refused(`job file '${jobFile}' is outside the declared workspace`);
  const args = ['run', '--file', jobFile];
  if (passwordFile) args.push('--password-file', passwordFile);
  if (auditLog) auditLog.append({ actor: 'wordcraft-contract', action: 'run.allowed', detail: `job=${jobFile}` });
  return { ok: true, args };
}
