// The light window's approval loop: pending broker proposals from the running engine, with approve /
// cancel, so an ask that is held completes INSIDE the window — no terminal console ritual.
//
// The seam is the engine's own control surface, exactly as the owner console speaks it (lib/client.mjs):
//   GET  /api/control/proposals                 — the waiting list
//   POST /api/control/proposals/<id>/confirm    — approve (guarded: needs the operator_typed principal)
//   POST /api/control/proposals/<id>/cancel     — cancel (GUARD_EXEMPT by design: stopping is never guarded)
//
// Authority: confirm needs the per-launch desktop nonce. The nonce is NEVER sent to the page. When the
// desktop/headless launcher minted the nonce itself it leaves it for the local owner in
// <runtimeHome>/owner-console.nonce (0600, solomon/desktop/headless-server.mjs writeOwnerNonceFile) — the
// same sanctioned local-owner channel `kingmaker key` reads. This server, running as the owner on the
// owner's device, reads that file and attaches the header server-side only, the same pattern as the job
// inbox's bar-link key. When the file is absent (the console minted and kept the nonce in memory), list
// and cancel still work and approve reports OWNER_NONCE_UNAVAILABLE instead of failing silently.
//
// A GUARDRAIL hold is a different animal from a broker proposal: the engine's input rails can hold a
// turn (disposition HELD_FOR_REVIEW) with NO proposal behind it — nothing exists to approve. The ask
// view marks that state 'held' from the engine's own held line so it shows AS held, with its reason,
// and never masquerades as an approvable proposal.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cancelProposal, confirmProposal, pendingProposals } from '../lib/client.mjs';
import { DESKTOP_NONCE_HEADER } from '../lib/profile.mjs';

export const OWNER_NONCE_FILE = 'owner-console.nonce';
export const DEFAULT_ENGINE_PORT = 3001;

/** The engine's guardrail held line (solomon/server conversation route, heldForReviewTurnData). */
export const GUARDRAIL_HELD_LINE = 'held for review by the input guardrail';
export const isGuardrailHeldAnswer = (answer) => typeof answer === 'string' && answer.includes(GUARDRAIL_HELD_LINE);

/** The engine port: the daemon state file the engine maintains, else the default port. */
export function enginePort(engineStateDir, { env = process.env, readFile = readFileSync } = {}) {
  try {
    const state = JSON.parse(readFile(join(engineStateDir, 'daemon.json'), 'utf8'));
    if (Number.isFinite(state?.port) && state.port > 0) return state.port;
  } catch { /* no daemon state — the default port */ }
  return Number(env.SOL_GHOST_PORT) || DEFAULT_ENGINE_PORT;
}

/** This launch's owner nonce from the local-owner file, or null. Never leaves this process. */
export function readOwnerNonce(engineStateDir, { env = process.env, readFile = readFileSync } = {}) {
  const runtimeHome = String(env.SOL_GHOST_RUNTIME_HOME || join(engineStateDir, 'runtime'));
  try {
    const nonce = String(readFile(join(runtimeHome, OWNER_NONCE_FILE), 'utf8')).trim();
    return nonce.length >= 32 ? nonce : null;
  } catch { return null; }
}

/** One proposal as the window renders it: the console's describe() fields, nothing invented. */
export function proposalView(p) {
  return {
    proposalId: p.proposalId ?? null,
    status: p.status ?? 'PENDING',
    summary: p.summary ?? p.origin ?? '(no summary)',
    origin: p.origin ?? null,
    riskTier: p.riskTier ?? null,
    challenge: typeof p.challenge === 'string' && p.challenge ? p.challenge : null,
    requesterKind: p.requester?.kind ?? null,
    createdAt: p.createdAt ?? null,
    expiresAt: p.expiresAt ?? null,
  };
}

const unavailable = (error, hint) => ({ ok: false, error, ...(hint ? { hint } : {}), proposals: [] });

/**
 * The proposals client the light server uses. All engine contact goes through lib/client.mjs; the
 * client fns are injectable so tests drive the real client code against a stub engine fetch.
 */
export function createProposalsClient({ engineStateDir, env = process.env, client = { pendingProposals, confirmProposal, cancelProposal }, readFile } = {}) {
  const port = () => enginePort(engineStateDir, { env, readFile });
  const ownerHeaders = () => {
    const nonce = readOwnerNonce(engineStateDir, { env, readFile });
    return nonce ? { headers: { [DESKTOP_NONCE_HEADER]: nonce }, hasNonce: true } : { headers: {}, hasNonce: false };
  };

  return {
    async list() {
      const { headers, hasNonce } = ownerHeaders();
      const r = await client.pendingProposals(port(), { headers }).catch(() => null);
      if (!r) return unavailable('ENGINE_NOT_RUNNING', 'The Kingmaker engine is not running, so its waiting list cannot be read. Start it with: kingmaker start');
      if (!r.ok) return { ok: false, error: `ENGINE_HTTP_${r.status}`, proposals: [] };
      const raw = r.json?.data?.proposals ?? r.json?.data ?? [];
      const proposals = (Array.isArray(raw) ? raw : []).filter((p) => p && (p.status ?? 'PENDING') === 'PENDING').map(proposalView);
      return { ok: true, port: port(), approveAvailable: hasNonce, proposals };
    },
    async approve(id, { typedChallenge } = {}) {
      const { headers, hasNonce } = ownerHeaders();
      if (!hasNonce) return { ok: false, error: 'OWNER_NONCE_UNAVAILABLE', hint: 'This engine launch kept its owner nonce in the console’s memory, so the window cannot sign an approval for it. Cancel still works here; approvals need a launch that leaves the owner nonce file (the desktop/headless launch does).' };
      const r = await client.confirmProposal(port(), id, { typedChallenge, headers }).catch(() => null);
      if (!r) return { ok: false, error: 'ENGINE_NOT_RUNNING' };
      const data = r.json?.data ?? {};
      return { ok: r.ok, status: r.status, spoken: data.spoken ?? data.message ?? null, outcome: data.outcome ?? null, error: r.ok ? null : (data.outcome || r.json?.error || `ENGINE_HTTP_${r.status}`) };
    },
    async cancel(id) {
      // Cancel is GUARD_EXEMPT in the engine (stopping is never guarded); the nonce rides anyway when held.
      const { headers } = ownerHeaders();
      const r = await client.cancelProposal(port(), id, { headers }).catch(() => null);
      if (!r) return { ok: false, error: 'ENGINE_NOT_RUNNING' };
      const data = r.json?.data ?? {};
      return { ok: r.ok, status: r.status, spoken: data.spoken ?? data.message ?? null, error: r.ok ? null : (r.json?.error || `ENGINE_HTTP_${r.status}`) };
    },
  };
}
