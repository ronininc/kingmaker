/**
 * lib/space-client.mjs
 *
 * A thin client for the SPACE HTTP API (perplexityai/SPACE, Apache-2.0 —
 * see NOTICE). SPACE is the sandbox platform that runs on the Linux host
 * (Firecracker microVMs); Kingmaker lives on the Mac and drives it from
 * outside. This module contains NO policy — governance lives in
 * cell-governor.mjs. This module knows the wire shape and nothing else.
 *
 * The wire shape, taken from SPACE's own docs and its standard-library-only
 * reference example (examples/first_sandbox.py), verified 2026-10-19:
 *
 *   Management plane (SPACE_API_URL, bearer = SPACE_API_TOKEN):
 *     POST   /v1/sandboxes                        -> 202 {sandbox_id, operation_id}
 *     GET    /v1/sandboxes/{id}                   -> sandbox {id, state, ...}
 *     DELETE /v1/sandboxes/{id}                   -> 202 {sandbox_id, operation_id}
 *     POST   /v1/sandboxes/{id}:pause             -> 202 {sandbox_id, operation_id}
 *     POST   /v1/sandboxes/{id}:suspend           -> 202 {sandbox_id, operation_id}
 *     POST   /v1/sandboxes/{id}:wake              -> 202 {sandbox_id, operation_id}
 *     GET    /v1/sandboxes/{id}/processes         -> {data: [...]} (readiness probe)
 *     POST   /v1/sandboxes/{id}/commands          -> 201 command {session_id, process_id, attach}
 *     GET    /v1/operations/{operation_id}        -> operation {id, state, ...}
 *   Data plane (SPACE_DATA_PLANE_URL, bearer = the session's attach token):
 *     GET    /v1/sessions/{session_id}/events     -> SSE stream of JSON frames:
 *            {type:'attached'|'process_started'} … {type:'stdout'|'stderr', data_base64}
 *            … {type:'process_exited', exit_code} | {type:'error'|'resync_required'}
 *
 * Lifecycle changes are ASYNCHRONOUS: a 202 accepts the work; the client
 * polls the operation until state 'succeeded'. Creating a command session
 * does NOT run anything — attaching to the events stream starts the process.
 *
 * Transport is INJECTED: `transport({method, url, headers, body, stream})`
 * must resolve to `{ status, body }` where body is parsed JSON normally, or
 * an async iterable of text lines when `stream: true`. Tests inject a fake
 * implementing this documented shape; production injects a fetch-based one.
 * The SPACE API token is injected at construction and held in a closure —
 * it is never stored on the client object, never logged, never serialized.
 */

import { randomUUID } from 'node:crypto';

export class SpaceApiError extends Error {
  constructor(message, { status = null, method = null, path = null, envelope = null } = {}) {
    super(message);
    this.name = 'SpaceApiError';
    this.status = status;
    this.method = method;
    this.path = path;
    this.envelope = envelope;
  }
}

const OPERATION_FAILURE_STATES = new Set(['failed', 'canceled', 'cancelled', 'expired']);
// States from the reference example that mean "this sandbox will never reach
// the target" when waiting for `running`.
const SANDBOX_DEAD_STATES = new Set([
  'failed', 'canceled', 'expired', 'deleted', 'deleting', 'stopped',
]);

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function trimSlash(u) {
  return String(u).replace(/\/+$/, '');
}

/**
 * Create a SPACE client.
 * Required: transport, apiToken, apiUrl, dataPlaneUrl.
 * `sleep`, `pollIntervalMs`, `operationTimeoutMs` are seams for tests.
 */
export function createSpaceClient({
  transport,
  apiToken,
  apiUrl,
  dataPlaneUrl,
  sleep = defaultSleep,
  pollIntervalMs = 1000,
  operationTimeoutMs = 300_000,
} = {}) {
  if (typeof transport !== 'function') {
    throw new Error('space-client: an injected transport function is required');
  }
  if (!apiToken) throw new Error('space-client: apiToken is required (injected, never stored)');
  if (!apiUrl || !dataPlaneUrl) {
    throw new Error('space-client: apiUrl and dataPlaneUrl are required');
  }
  const apiBase = trimSlash(apiUrl);
  const dataBase = trimSlash(dataPlaneUrl);
  // Sessions created through this client, keyed by session_id, so
  // collectOutput(sessionId) can find the attach credentials. Held in
  // memory only; attach tokens are session-scoped and expire with it.
  const sessions = new Map();

  async function request(method, path, { body = undefined, idempotencyKey = null, extraHeaders = {} } = {}) {
    const headers = {
      Accept: 'application/json',
      Authorization: `Bearer ${apiToken}`,
      ...extraHeaders,
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    const res = await transport({ method, url: apiBase + path, headers, body, stream: false });
    if (res.status < 200 || res.status >= 300) {
      const env = res.body ?? null;
      const detail =
        env?.error?.message ?? env?.message ?? env?.error?.code ?? `HTTP ${res.status}`;
      throw new SpaceApiError(`${method} ${path}: ${detail}`, {
        status: res.status, method, path, envelope: env,
      });
    }
    return res.body;
  }

  /** Poll an operation until it succeeds; fail closed on terminal states. */
  async function waitOperation(operationId, { timeoutMs = operationTimeoutMs } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const op = await request('GET', `/v1/operations/${operationId}`);
      const state = op?.state;
      if (state === 'succeeded') return op;
      if (OPERATION_FAILURE_STATES.has(state)) {
        throw new SpaceApiError(
          `operation ${operationId} ${state}${op?.terminal_error_code ? `: ${op.terminal_error_code}` : ''}`,
          { method: 'GET', path: `/v1/operations/${operationId}` }
        );
      }
      if (!state) {
        throw new SpaceApiError(`operation ${operationId} returned no state`, {
          method: 'GET', path: `/v1/operations/${operationId}`,
        });
      }
      // queued / running / unknown future values: tolerate and keep polling.
      if (Date.now() >= deadline) {
        throw new SpaceApiError(`operation ${operationId} did not succeed within ${timeoutMs}ms`, {
          method: 'GET', path: `/v1/operations/${operationId}`,
        });
      }
      await sleep(pollIntervalMs);
    }
  }

  /** Poll a sandbox until it reaches `target` state. */
  async function waitSandboxState(sandboxId, target, { timeoutMs = operationTimeoutMs } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const sb = await request('GET', `/v1/sandboxes/${sandboxId}`);
      const state = sb?.state;
      if (state === target) return sb;
      if (state && SANDBOX_DEAD_STATES.has(state) && target === 'running') {
        throw new SpaceApiError(`sandbox ${sandboxId} is ${state}, expected ${target}`, {
          method: 'GET', path: `/v1/sandboxes/${sandboxId}`,
        });
      }
      if (!state) {
        throw new SpaceApiError(`sandbox ${sandboxId} returned no state`, {
          method: 'GET', path: `/v1/sandboxes/${sandboxId}`,
        });
      }
      if (Date.now() >= deadline) {
        throw new SpaceApiError(`sandbox ${sandboxId} did not reach ${target} within ${timeoutMs}ms`, {
          method: 'GET', path: `/v1/sandboxes/${sandboxId}`,
        });
      }
      await sleep(pollIntervalMs);
    }
  }

  /**
   * Create a sandbox from a template and wait until it is running and its
   * process endpoint answers. `networkPolicy` (optional) is SPACE's
   * CreateSandboxRequest.network_policy — an egress policy override applied
   * on top of the template default. `egressProfiles` (optional) names
   * operator-configured profiles, selected via the
   * X-Space-Egress-Profiles header ('+name' tokens).
   */
  async function createSandbox(template, {
    name = null,
    metadata = {},
    env = undefined,
    resources = undefined,
    networkPolicy = undefined,
    egressProfiles = [],
    wait = true,
  } = {}) {
    if (!template) throw new Error('space-client: createSandbox requires a template');
    const body = { template, runtime: 'fc' };
    if (name) body.name = name;
    if (metadata && Object.keys(metadata).length > 0) body.metadata = metadata;
    if (env !== undefined) body.env = env;
    if (resources !== undefined) body.resources = resources;
    if (networkPolicy !== undefined && networkPolicy !== null) body.network_policy = networkPolicy;
    const extraHeaders = {};
    if (Array.isArray(egressProfiles) && egressProfiles.length > 0) {
      extraHeaders['X-Space-Egress-Profiles'] = egressProfiles.map((p) => `+${p}`).join(' ');
    }
    const res = await request('POST', '/v1/sandboxes', {
      body, idempotencyKey: randomUUID(), extraHeaders,
    });
    const sandboxId = res?.sandbox_id;
    const operationId = res?.operation_id;
    if (!sandboxId || !operationId) {
      throw new SpaceApiError('create sandbox response missing sandbox_id/operation_id', {
        method: 'POST', path: '/v1/sandboxes', envelope: res ?? null,
      });
    }
    let sandbox = null;
    if (wait) {
      await waitOperation(operationId);
      sandbox = await waitSandboxState(sandboxId, 'running');
      // Readiness probe from the reference example: the process endpoint
      // must answer with a list before commands are issued.
      const probe = await request('GET', `/v1/sandboxes/${sandboxId}/processes?limit=1`);
      if (!Array.isArray(probe?.data)) {
        throw new SpaceApiError('process readiness response did not contain a list', {
          method: 'GET', path: `/v1/sandboxes/${sandboxId}/processes`,
        });
      }
    }
    return {
      sandboxId,
      operationId,
      templateDigest: sandbox?.template_digest ?? null,
      sandbox,
    };
  }

  async function getSandbox(sandboxId) {
    return request('GET', `/v1/sandboxes/${sandboxId}`);
  }

  async function listProcesses(sandboxId, { limit = 10 } = {}) {
    return request('GET', `/v1/sandboxes/${sandboxId}/processes?limit=${limit}`);
  }

  /**
   * Create a command session. This does NOT start the process — attaching
   * (collectOutput) does. `command` is an argv array, never a shell string
   * (use ['sh','-c',...] explicitly for shell semantics, per SPACE docs).
   * `env` is the per-command environment — the ONLY channel through which
   * the cell governor injects brokered credentials.
   */
  async function runCommand(sandboxId, { command, cwd = undefined, env = undefined, timeout = undefined } = {}) {
    if (!Array.isArray(command) || command.length === 0) {
      throw new Error('space-client: runCommand requires a non-empty argv array');
    }
    const body = { command: [...command] };
    if (cwd !== undefined) body.cwd = cwd;
    if (env !== undefined) body.env = env;
    if (timeout !== undefined) body.timeout = timeout;
    const res = await request('POST', `/v1/sandboxes/${sandboxId}/commands`, {
      body, idempotencyKey: randomUUID(),
    });
    const sessionId = res?.session_id;
    const attach = res?.attach;
    if (!sessionId || !attach?.token || !attach?.events_url) {
      throw new SpaceApiError('command response missing session_id or attach info', {
        method: 'POST', path: `/v1/sandboxes/${sandboxId}/commands`, envelope: null,
      });
    }
    // Destination check, mirrored from the reference example: the events
    // URL must be exactly this session's path at the configured data-plane
    // origin before we send the attach token anywhere.
    const expectedPath = `/v1/sessions/${sessionId}/events`;
    if (attach.events_url !== expectedPath && attach.events_url !== dataBase + expectedPath) {
      throw new SpaceApiError(
        `unexpected events URL for session ${sessionId}; refusing to attach`, {
          method: 'POST', path: `/v1/sandboxes/${sandboxId}/commands`,
        });
    }
    const session = {
      sessionId,
      processId: res.process_id ?? null,
      sandboxId,
      eventsUrl: dataBase + expectedPath,
      expiresAt: attach.expires_at ?? null,
    };
    sessions.set(sessionId, { ...session, attachToken: attach.token });
    return session;
  }

  /**
   * Attach to a session's event stream (this STARTS the process) and
   * collect its output until process_exited. Accepts a sessionId returned
   * by runCommand, or a session handle. Returns { stdout, stderr, exitCode }.
   * A stream that ends without process_exited is a failure, not a result.
   */
  async function collectOutput(sessionOrId) {
    const sessionId = typeof sessionOrId === 'string' ? sessionOrId : sessionOrId?.sessionId;
    const record = sessions.get(sessionId);
    if (!record) {
      throw new Error(`space-client: unknown session ${sessionId} — collect via the client that created it`);
    }
    const res = await transport({
      method: 'GET',
      url: record.eventsUrl,
      headers: { Authorization: `Bearer ${record.attachToken}`, Accept: 'text/event-stream' },
      body: undefined,
      stream: true,
    });
    if (res.status < 200 || res.status >= 300) {
      throw new SpaceApiError(`GET events for session ${sessionId}: HTTP ${res.status}`, {
        status: res.status, method: 'GET', path: `/v1/sessions/${sessionId}/events`,
      });
    }
    let stdout = '';
    let stderr = '';
    let exitCode = null;
    let completed = false;
    // SSE parsing per the reference example: frames are `data:` lines
    // separated by blank lines; each frame's data is one JSON object.
    let pending = [];
    const handleFrame = (frame) => {
      const kind = frame?.type;
      if (kind === 'error' || kind === 'resync_required') {
        throw new SpaceApiError(`command stream for session ${sessionId} reported ${kind}`, {
          method: 'GET', path: `/v1/sessions/${sessionId}/events`,
        });
      }
      if (kind === 'stdout') stdout += Buffer.from(frame.data_base64 ?? '', 'base64').toString('utf8');
      if (kind === 'stderr') stderr += Buffer.from(frame.data_base64 ?? '', 'base64').toString('utf8');
      if (kind === 'process_exited') {
        if (typeof frame.exit_code !== 'number') {
          throw new SpaceApiError(`process_exited for session ${sessionId} carried no exit_code`, {
            method: 'GET', path: `/v1/sessions/${sessionId}/events`,
          });
        }
        exitCode = frame.exit_code;
        completed = true;
      }
    };
    let buffer = '';
    for await (const chunk of res.body) {
      buffer += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        if (line === '') {
          if (pending.length > 0) {
            handleFrame(JSON.parse(pending.join('\n')));
            pending = [];
          }
        } else if (line.startsWith('data:')) {
          pending.push(line.slice(5).replace(/^ /, ''));
        }
        // event:/id:/comment lines are ignored, as in the reference example.
      }
    }
    if (pending.length > 0) {
      throw new SpaceApiError(`event stream for session ${sessionId} ended mid-frame`, {
        method: 'GET', path: `/v1/sessions/${sessionId}/events`,
      });
    }
    if (!completed) {
      throw new SpaceApiError(`event stream for session ${sessionId} ended without process_exited`, {
        method: 'GET', path: `/v1/sessions/${sessionId}/events`,
      });
    }
    return { stdout, stderr, exitCode };
  }

  /** Shared lifecycle-verb helper: POST the verb, poll its operation. */
  async function lifecycle(sandboxId, verb, { waitState = null } = {}) {
    const res = await request('POST', `/v1/sandboxes/${sandboxId}:${verb}`, {
      body: {}, idempotencyKey: randomUUID(),
    });
    const operationId = res?.operation_id ?? null;
    if (operationId) await waitOperation(operationId);
    let sandbox = null;
    if (waitState) sandbox = await waitSandboxState(sandboxId, waitState);
    return { sandboxId, operationId, sandbox };
  }

  async function pauseSandbox(sandboxId) {
    return lifecycle(sandboxId, 'pause', { waitState: 'paused' });
  }

  async function suspendSandbox(sandboxId) {
    return lifecycle(sandboxId, 'suspend', { waitState: 'suspended' });
  }

  async function wakeSandbox(sandboxId) {
    return lifecycle(sandboxId, 'wake', { waitState: 'running' });
  }

  async function deleteSandbox(sandboxId) {
    const res = await request('DELETE', `/v1/sandboxes/${sandboxId}`, {
      idempotencyKey: randomUUID(),
    });
    const operationId = res?.operation_id ?? null;
    if (operationId) await waitOperation(operationId);
    for (const [id, s] of sessions) {
      if (s.sandboxId === sandboxId) sessions.delete(id);
    }
    return { sandboxId, operationId };
  }

  return {
    createSandbox,
    getSandbox,
    listProcesses,
    runCommand,
    collectOutput,
    pauseSandbox,
    suspendSandbox,
    wakeSandbox,
    deleteSandbox,
    waitOperation,
    waitSandboxState,
  };
}
