/**
 * lib/cell-governor.mjs
 *
 * The governor for the SPACE cell — the point of the whole v0.4.1 sandbox
 * layer. SPACE runs the microVMs on the Linux host; EVERYTHING that makes
 * those VMs safe to use lives here, on the Mac, outside the cell:
 *
 *   1. Intent first. Every sandbox request is written to the hash-chained
 *      audit log BEFORE it is sent. If it isn't in the log, it didn't get
 *      sent — there is no path around this module to the client.
 *   2. Egress is declared host-side. Each workload kind carries a default
 *      egress policy (default posture: DENY-ALL). The policy is handed to
 *      SPACE at create time (network_policy + operator egress profiles);
 *      the VM never gets a say in its own network.
 *   3. Credentials are brokered, never placed. A workload asks for a
 *      credential by NAME; the governor resolves it through the injected
 *      broker and injects the value into the command session's env only.
 *      Values never appear in sandbox templates, sandbox env, command
 *      text, or audit entries — the audit log records names, never values.
 *   4. Workloads are registered, not improvised. Unknown kinds are
 *      refused. Red Hat kinds refuse unless the spine is in
 *      'kingmaker-x-heretic' mode.
 *   5. Output is verified before it is believed. Results pass through the
 *      structural verifier pattern (empty / refusal / truncation /
 *      nonzero-exit) and the verdict is audited before the caller sees
 *      the output.
 *
 * The spine mode is injected at construction ('custom' |
 * 'kingmaker-x-heretic') — this module reads it, it does not set it.
 * The credential broker is injected: { resolve(name) -> value }. This
 * module never stores a resolved value beyond the run that requested it.
 */

/** Spine modes in ascending order of what they unlock. */
const SPINE_ORDER = { custom: 0, 'kingmaker-x-heretic': 1 };

export const DENY_ALL_EGRESS = Object.freeze({ mode: 'deny-all', allow: Object.freeze([]) });

/**
 * The workload registry. `template` names a SPACE template the operator
 * publishes on the Linux host (overridable at construction). `egress.allow`
 * entries are { domain } or { cidr } objects — the vocabulary of SPACE's
 * egress profiles. An allowlist with an EMPTY allow list reaches nothing:
 * operators must declare real destinations before a run means anything.
 */
export const WORKLOAD_KINDS = Object.freeze({
  'cage-eval': Object.freeze({
    description: 'Cage evaluation of an untrusted candidate skill inside a microVM.',
    template: 'kingmaker/cage-eval:latest',
    spine: 'custom',
    egress: DENY_ALL_EGRESS,
    credentials: Object.freeze(['huggingface-token']),
  }),
  'digital-twin': Object.freeze({
    description: 'Digital twin session substrate.',
    template: 'kingmaker/digital-twin:latest',
    spine: 'custom',
    egress: DENY_ALL_EGRESS,
    credentials: Object.freeze([]),
  }),
  'redhat-darkweb': Object.freeze({
    description: 'Governed darkweb search workload (darkweb-search) inside the cell.',
    template: 'kingmaker/redhat-darkweb:latest',
    spine: 'kingmaker-x-heretic',
    // Tor egress is operator-declared: supply { domain } / { cidr } entries
    // for the host-side Tor path at construction or per run. Empty = the
    // workload can be created but can reach nothing.
    egress: Object.freeze({ mode: 'allowlist', allow: Object.freeze([]) }),
    credentials: Object.freeze([]),
  }),
  'redhat-abliterate': Object.freeze({
    description: 'Governed abliteration run (abliterate-model) inside the cell.',
    template: 'kingmaker/redhat-abliterate:latest',
    spine: 'kingmaker-x-heretic',
    egress: DENY_ALL_EGRESS, // weights are local; an abliteration run needs no network
    credentials: Object.freeze(['huggingface-token']),
  }),
  'littlebrother-full': Object.freeze({
    description: 'LittleBrother full method set inside the cell (Kingmaker side only).',
    template: 'kingmaker/littlebrother-full:latest',
    spine: 'kingmaker-x-heretic',
    // Source destinations are operator-declared per the boundary spec.
    egress: Object.freeze({ mode: 'allowlist', allow: Object.freeze([]) }),
    credentials: Object.freeze(['osint-source-keys']),
  }),
  'kuroko-voice': Object.freeze({
    description: 'Kuroko, the voice layer: synthesis, cloning, dubbing, transcription.',
    template: 'kingmaker/kuroko-voice:latest',
    spine: 'custom', // no spine requirement — voice work runs in custom mode
    egress: DENY_ALL_EGRESS, // the engine is fully local; it needs no network
    credentials: Object.freeze([]),
    // ENGINE RULE (AGPL external-tool rule): the engine is Voice Studio
    // (debpalash/VoiceStudio, AGPL-3.0). It is an EXTERNAL tool, driven by
    // subprocess/API from inside the cell — never linked, never imported,
    // never shipped in the payload. Same rule as heretic-llm. Kingmaker
    // side + Robbie's own content work only; OUT of Solomon and out of
    // any commercial distribution.
  }),
});

export class CellGovernorError extends Error {
  constructor(message, { code = 'cell-error', kind = null } = {}) {
    super(message);
    this.name = 'CellGovernorError';
    this.code = code;
    this.kind = kind;
  }
}

const REFUSAL_PATTERNS = [
  /\bI\s*(?:can't|cannot|won't|am unable to)\s+(?:help|assist|do|perform|provide|comply)/i,
  /\bI(?:'m| am) sorry,?\s+but\b/i,
  /\bas an AI\b/i,
  /\bI must (?:decline|refuse)\b/i,
];

function delimitersUnbalanced(text) {
  const pairs = { '{': '}', '[': ']', '(': ')' };
  const closers = new Set(Object.values(pairs));
  const stack = [];
  for (const ch of text) {
    if (pairs[ch]) stack.push(pairs[ch]);
    else if (closers.has(ch) && stack.pop() !== ch) return true;
  }
  return stack.length !== 0;
}

/**
 * The structural verifier pattern, cell-sized (the full pattern lives in
 * router-phase2/lib/output-verifier.mjs): a result is checked WITHOUT
 * trusting it — empty output, refusal markers, truncation shape, and the
 * process exit code. Returns { pass, reasons }.
 */
export function verifyCellOutput({ stdout = '', stderr = '', exitCode = null } = {}) {
  const reasons = [];
  const out = String(stdout ?? '');
  const err = String(stderr ?? '');
  if (out.trim() === '' && err.trim() === '') reasons.push('empty output');
  if (REFUSAL_PATTERNS.some((re) => re.test(out))) reasons.push('refusal marker in output');
  const fences = (out.match(/```/g) || []).length;
  if (fences % 2 !== 0 || delimitersUnbalanced(out)) reasons.push('possible truncation');
  if (exitCode !== 0) reasons.push(`nonzero exit code: ${exitCode}`);
  return { pass: reasons.length === 0, reasons };
}

/** Credential name -> guest env var name (huggingface-token -> HUGGINGFACE_TOKEN). */
function envVarFor(credentialName) {
  return String(credentialName).toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

function summarizeEgress(policy) {
  return {
    mode: policy.mode,
    allow: (policy.allow ?? []).map((a) => ({ ...a })),
    egressProfiles: [...(policy.egressProfiles ?? [])],
  };
}

/** Translate a governor egress policy into SPACE create-time fields. */
function toSpacePolicy(policy) {
  return {
    networkPolicy: { egress: { mode: policy.mode, allow: (policy.allow ?? []).map((a) => ({ ...a })) } },
    egressProfiles: [...(policy.egressProfiles ?? [])],
  };
}

/**
 * Create the cell governor.
 * Required: client (space-client), auditLog ({ append, entries, verify }).
 * spineMode defaults to 'custom' — the restrictive posture.
 * credentialBroker: { resolve(name) } — sync or async. Required only when
 * a run actually requests credentials.
 * workloadOverrides: { [kind]: partial def } — operator templates/egress.
 */
export function createCellGovernor({
  client,
  auditLog,
  spineMode = 'custom',
  credentialBroker = null,
  verifyOutput = verifyCellOutput,
  workloadOverrides = {},
} = {}) {
  if (!client) throw new Error('cell-governor: a SPACE client is required');
  if (!auditLog || typeof auditLog.append !== 'function') {
    throw new Error('cell-governor: an auditLog is required — unlogged cell work is not shipped');
  }
  if (!(spineMode in SPINE_ORDER)) {
    throw new Error(`cell-governor: unknown spine mode ${spineMode}`);
  }
  const actor = 'cell-governor';
  const log = (action, detail, meta) => auditLog.append({ actor, action, detail, meta: meta ?? {} });

  const registry = {};
  for (const [kind, def] of Object.entries(WORKLOAD_KINDS)) {
    registry[kind] = { ...def, ...(workloadOverrides[kind] ?? {}) };
  }
  for (const [kind, def] of Object.entries(workloadOverrides)) {
    if (!registry[kind]) registry[kind] = { ...def }; // operator-registered kind; egress defaults at resolve time
  }

  function refuse(kind, code, message, meta = {}) {
    log('cell.refused', message, { kind, code, ...meta });
    throw new CellGovernorError(message, { code, kind });
  }

  function resolveEgress(kind, def, override) {
    const policy = override ?? def.egress ?? DENY_ALL_EGRESS;
    if (policy.mode !== 'deny-all' && policy.mode !== 'allowlist') {
      refuse(kind, 'egress-invalid', `workload ${kind}: unknown egress mode ${policy.mode}`);
    }
    if (policy.mode === 'deny-all') return { mode: 'deny-all', allow: [], egressProfiles: [] };
    return {
      mode: 'allowlist',
      allow: [...(policy.allow ?? [])],
      egressProfiles: [...(policy.egressProfiles ?? def.egressProfiles ?? [])],
    };
  }

  /**
   * Run one governed workload in the cell. See the module header for the
   * order of operations — intent is audited before anything is sent.
   */
  async function runWorkload({
    kind,
    command,
    credentials = [],
    egress = undefined,
    template = undefined,
    cwd = undefined,
    timeout = undefined,
    keepSandbox = false,
  } = {}) {
    const def = registry[kind];
    if (!def) {
      refuse(kind ?? null, 'unknown-workload', `unknown workload kind: ${kind} — refused`);
    }
    const required = def.spine ?? 'custom';
    if ((SPINE_ORDER[spineMode] ?? 0) < (SPINE_ORDER[required] ?? 0)) {
      refuse(kind, 'spine-required',
        `workload ${kind} requires spine mode '${required}'; current mode is '${spineMode}'`,
        { required, spineMode });
    }
    if (!Array.isArray(command) || command.length === 0) {
      refuse(kind, 'command-required', `workload ${kind}: a non-empty argv command is required`);
    }
    const allowedCreds = def.credentials ?? [];
    for (const name of credentials) {
      if (!allowedCreds.includes(name)) {
        refuse(kind, 'credential-not-allowed',
          `workload ${kind} may not request credential '${name}'`, { credential: name });
      }
    }
    const policy = resolveEgress(kind, def, egress);
    const templateRef = template ?? def.template;
    if (!templateRef) {
      refuse(kind, 'template-missing', `workload ${kind} has no template configured`);
    }

    // (1) INTENT FIRST — the audit entry exists before any request is sent.
    const intent = log('cell.intent',
      `${kind} on template ${templateRef}; egress ${policy.mode}` +
      (policy.allow.length ? ` (${policy.allow.length} destination(s))` : '') +
      (credentials.length ? `; credentials: ${credentials.join(', ')}` : ''),
      {
        kind, template: templateRef, spineMode, required,
        egress: summarizeEgress(policy), credentialNames: [...credentials],
      });

    let sandboxId = null;
    try {
      // (3) Broker credentials host-side. Values live only in this scope
      // and in the command session env — nowhere else, ever.
      let env;
      if (credentials.length > 0) {
        if (!credentialBroker || typeof credentialBroker.resolve !== 'function') {
          throw new CellGovernorError(
            `workload ${kind} requested credentials but no credential broker is configured`,
            { code: 'broker-missing', kind });
        }
        env = {};
        for (const name of credentials) {
          const value = await credentialBroker.resolve(name);
          if (typeof value !== 'string' || value === '') {
            throw new CellGovernorError(`credential broker returned no value for '${name}'`,
              { code: 'broker-empty', kind });
          }
          // A credential value must never ride in the command text: argv is
          // visible in too many places. Env is the only channel.
          if (command.some((arg) => String(arg).includes(value))) {
            throw new CellGovernorError(
              `credential '${name}' appears in command text — inject via env only`,
              { code: 'credential-in-command', kind });
          }
          env[envVarFor(name)] = value;
        }
      }

      // (2) Create the cell. The egress policy travels with the create —
      // host-declared, VM-enforced, immutable for the sandbox's lifetime.
      const { networkPolicy, egressProfiles } = toSpacePolicy(policy);
      const created = await client.createSandbox(templateRef, {
        name: `cell-${kind}`,
        metadata: { workload: kind },
        networkPolicy,
        egressProfiles,
      });
      sandboxId = created.sandboxId;
      log('cell.sandbox.created', `sandbox ${sandboxId} for ${kind}`, {
        kind, sandboxId, operationId: created.operationId, templateDigest: created.templateDigest,
      });

      const session = await client.runCommand(sandboxId, {
        command, cwd, timeout, env,
      });
      log('cell.command.session', `session ${session.sessionId} in sandbox ${sandboxId}`, {
        kind, sandboxId, sessionId: session.sessionId, processId: session.processId,
        credentialNames: [...credentials], // names only — values are never logged
      });

      const { stdout, stderr, exitCode } = await client.collectOutput(session.sessionId);
      log('cell.output.collected', `session ${session.sessionId} exited ${exitCode}`, {
        kind, sandboxId, sessionId: session.sessionId, exitCode,
        stdoutBytes: Buffer.byteLength(stdout), stderrBytes: Buffer.byteLength(stderr),
      });

      // (5) Verify before the caller believes anything.
      const verification = verifyOutput({ stdout, stderr, exitCode });
      log('cell.output.verified',
        `session ${session.sessionId} verification ${verification.pass ? 'passed' : 'FAILED'}: ${verification.reasons.join('; ') || 'ok'}`,
        { kind, sandboxId, sessionId: session.sessionId, pass: verification.pass, reasons: verification.reasons });

      const result = {
        kind, sandboxId, sessionId: session.sessionId, processId: session.processId,
        exitCode, stdout, stderr, verification, intentSeq: intent.seq,
      };
      if (!keepSandbox) {
        await client.deleteSandbox(sandboxId);
        log('cell.sandbox.deleted', `sandbox ${sandboxId} deleted`, { kind, sandboxId });
        result.sandboxDeleted = true;
      }
      return result;
    } catch (err) {
      log('cell.error', `${kind} failed: ${err.message}`, {
        kind, sandboxId, code: err.code ?? 'error',
      });
      if (sandboxId && !keepSandbox) {
        try {
          await client.deleteSandbox(sandboxId);
          log('cell.sandbox.deleted', `sandbox ${sandboxId} deleted after failure`, { kind, sandboxId });
        } catch {
          // Best effort: the original error is the one that matters.
        }
      }
      throw err;
    }
  }

  function listWorkloads() {
    return Object.entries(registry).map(([kind, def]) => ({
      kind,
      description: def.description ?? '',
      template: def.template ?? null,
      spine: def.spine ?? 'custom',
      egress: summarizeEgress(def.egress ?? DENY_ALL_EGRESS),
      credentials: [...(def.credentials ?? [])],
    }));
  }

  return { runWorkload, listWorkloads };
}
