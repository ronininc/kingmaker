// lib/project-twin.mjs — Kingmaker's handle on the engine's Project Twin (Class C: it had no Kingmaker entry at all;
// Solomon's UI was its only surface). The engine's /api/project-twins/* routes are read-and-record only — every
// write is marked noExternalSideEffect:true, so a Project Twin never reaches outside the machine. This gives them a
// Kingmaker surface: list / show / back-burner / export are reads, and the one owner decision is a back-burner task
// action (approve/edit/reject/defer/continue), which Kingmaker holds behind the owner's word and a read-back even
// though the engine itself has no side effect to gate. No turn-loop route reaches Project Twins, so this calls the
// routes directly.

/** The back-burner task actions the engine accepts. */
export const TWIN_ACTIONS = Object.freeze(['approve', 'edit', 'reject', 'defer', 'continue']);

/** Pure: a valid task action or { error } (never a silent default). */
export function normalizeTwinAction(word) {
  const a = String(word ?? '').trim().toLowerCase();
  if (!a) return { error: 'empty' };
  if (TWIN_ACTIONS.includes(a)) return { action: a };
  return { error: `not a Project Twin task action: ${a}. One of: ${TWIN_ACTIONS.join(', ')}` };
}

/** One line for a Project Twin, keeping only stable fields and never inventing one. */
export function twinLine(t = {}) {
  const id = t.twinId ?? t.id ?? t.projectTwinId ?? '?';
  const name = t.name ?? t.title ?? t.projectName ?? '(unnamed)';
  const domain = t.domain ?? t.sourceDomain ?? null;
  const status = t.status ?? t.state ?? null;
  return `· ${name} (${id})${domain ? ` — ${domain}` : ''}${status ? ` · ${status}` : ''}`;
}

/** A short summary of a back-burner record (counts + the recommended next action), defensively. */
export function backBurnerLines(data = {}) {
  const bb = data.backBurner ?? {};
  const tasks = Array.isArray(bb.tasks) ? bb.tasks : [];
  const packet = bb.reviewPacket ?? {};
  const out = [`back burner: ${tasks.length} task${tasks.length === 1 ? '' : 's'}${packet.status ? ` · packet ${packet.status}` : ''}`];
  const decisions = Array.isArray(packet.decisionsNeeded) ? packet.decisionsNeeded : [];
  if (decisions.length) out.push(`  ${decisions.length} decision${decisions.length === 1 ? '' : 's'} needed`);
  for (const t of tasks.slice(0, 20)) out.push(`  · ${t.id ?? t.taskId ?? '?'}: ${t.title ?? t.label ?? t.summary ?? '(task)'}${t.state ? ` [${t.state}]` : ''}`);
  if (packet.recommendedNextAction) out.push(`  → ${packet.recommendedNextAction}`);
  return out;
}

/** Pure: the PATCH body for a task action (draftText only carried when present, e.g. for 'edit'). */
export function twinTaskBody(action, draftText = null) {
  return draftText ? { action, draftText } : { action };
}
