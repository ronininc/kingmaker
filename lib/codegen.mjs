// lib/codegen.mjs — Kingmaker's handle on the engine's universal builder (CodeGen).
//
// "build a tracker for my leads" → one well-formed turn to the engine, which intent-routes it to its codegen
// lane (workflowRoute: 'codegen') and returns a READY plan held on "go ahead" — the same read-back lib/client.mjs
// already detects as confirmationRequired. Kingmaker deliberately never calls POST /api/codegen/execute: that route
// runs a build immediately and ungated, so routing through the turn loop keeps the owner's go-ahead in front of every
// build, exactly as `kingmaker craft` does for ArtCraft. A build is a 'write' (it makes an artifact); it is read back
// and waits for the owner's word. Only `build status` answers now (a read of what has already been built).
//
// Out of scope here (owner-console + nonce only, a later `build deploy`): the Goose agent edit
// (/api/codegen/agent/execute, needs operatorConfirmed) and the Cloudflare deploy
// (/api/codegen/projects/:id/deploy/cloudflare, needs operatorConfirmed + expectedContentHash).

// The verbs the engine's own BUILD_VERB classifier keys on; a fresh ask gets one prefixed if it lacks one.
const BUILD_VERB = /^(build|make|create|generate|rebuild|scaffold|code)$/i;
const STATUS_WORD = /^(status|list|projects?)$/i;
const MODIFY_WORD = /^(modify|change|edit|update)$/i;

/**
 * Pure: what a `build …` ask does, from its first word.
 *   'status' — read: list what has already been built (no turn, no write).
 *   'modify' — change an existing project by id; held on the owner's go-ahead.
 *   'build'  — a fresh artifact; held on the owner's go-ahead.
 * Unknown → 'build' (the safe default: it is read back, never run without a yes).
 */
export function classifyBuildAsk(words) {
  const arr = Array.isArray(words) ? words : String(words ?? '').trim().split(/\s+/).filter(Boolean);
  const first = (arr[0] ?? '').toLowerCase();
  if (STATUS_WORD.test(first)) return 'status';
  if (MODIFY_WORD.test(first)) return 'modify';
  return 'build';
}

/**
 * Pure: one well-formed sentence for the engine's codegen lane, or { kind:'status' } (handled by a read route,
 * not a turn), or { error } when there is nothing to build. A fresh ask gets a `build ` verb when its first word
 * is not already one (so the engine routes it to codegen, not a connector). A modify names the project id in the
 * sentence so a threaded turn works on it. Never produces an immediate-execute call. → { text, kind } | { error }.
 */
export function buildTurnText(words, { projectId = null } = {}) {
  const arr = Array.isArray(words) ? words.filter(Boolean) : String(words ?? '').trim().split(/\s+/).filter(Boolean);
  const kind = classifyBuildAsk(arr);
  if (kind === 'status') return { text: null, kind };
  if (kind === 'modify') {
    const rest = arr.slice(1);
    const id = projectId ?? (rest[0] && !BUILD_VERB.test(rest[0]) ? rest[0] : null);
    const instr = (projectId ? rest : rest.slice(id ? 1 : 0)).join(' ').replace(/\s+/g, ' ').trim();
    if (!instr) return { error: 'Say what to change, e.g.: kingmaker build modify <projectId> add a dark mode toggle' };
    return { text: id ? `modify the project ${id}: ${instr}` : `modify ${instr}`, kind };
  }
  const asked = arr.join(' ').replace(/\s+/g, ' ').trim();
  if (!asked) return { error: 'Say what to build, e.g.: kingmaker build a tracker for my leads' };
  const text = BUILD_VERB.test(arr[0]) ? asked : `build ${asked}`;
  return { text, kind };
}

/** A built project for `build status`, trimmed to what a line needs. The engine's /api/codegen/projects shape
 *  varies by build; this keeps only the stable fields and never invents one. */
export function projectLine(p = {}) {
  const id = p.projectId ?? p.id ?? p.project?.id ?? '?';
  const name = p.projectName ?? p.name ?? p.project?.name ?? '(unnamed)';
  const when = p.updatedAt ?? p.createdAt ?? p.lastBuiltAt ?? null;
  return `· ${name} (${id})${when ? ` — ${when}` : ''}`;
}
