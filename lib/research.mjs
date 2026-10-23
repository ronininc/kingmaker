// lib/research.mjs — Kingmaker's handle on the engine's Native Internet / governed research lane.
//
// "research the latest on X" → one well-formed turn to the engine, which intent-routes it to its research lane
// (workflowRoute: 'research' → researchEngineImpl: native, corpus-first, deadline-bounded). Research is a READ — it
// answers on the turn now; it makes no file and needs no go-ahead. But the engine's own internet governance sits
// under it (online mode + consent, egress firewall): when those are not met the turn comes back refused, and the
// handle relays that rather than reaching the network any other way. Kingmaker never opens an ungated egress path;
// the only outbound is this governed turn. The explicit POST /api/frontier-research is a separate fail-closed
// endpoint (needs an attached brain + external-llm consent) and is deliberately NOT what this handle calls.
//
// `research source [<mode>]` is the one write: it reads or sets WHERE web research looks first
// (/api/research-source/settings). Setting it needs the owner (requireOperatorTyped → the launch nonce), so it is
// console/owner only; `say` and the MCP surface can read it but never set it.

const RESEARCH_VERB = /^(research|investigate)$/i;

/** Where web research looks first (the engine's research-source modes). */
export const RESEARCH_MODES = Object.freeze(['browser-first', 'api-first', 'api-only']);

/**
 * Pure: one well-formed sentence for the engine's research lane. A research verb leads (so the engine routes it to
 * research, not a connector) when the words do not already start with one. → { text } | { error }.
 */
export function researchTurnText(words) {
  const arr = Array.isArray(words) ? words.filter(Boolean) : String(words ?? '').trim().split(/\s+/).filter(Boolean);
  const asked = arr.join(' ').replace(/\s+/g, ' ').trim();
  if (!asked) return { error: 'Say what to research, e.g.: kingmaker research the latest on merchant cash advances' };
  const text = RESEARCH_VERB.test(arr[0]) ? asked : `research ${asked}`;
  return { text };
}

/** Pure: a research-source mode or { error } for an unknown one (never a silent default). */
export function normalizeResearchMode(word) {
  const m = String(word ?? '').trim().toLowerCase();
  if (!m) return { error: 'empty' };
  if (RESEARCH_MODES.includes(m)) return { mode: m };
  return { error: `not a research-source mode: ${m}. One of: ${RESEARCH_MODES.join(', ')}` };
}

/** A settings payload (from GET /api/research-source/settings) → one line, keeping only stable fields. */
export function sourceLine(data = {}) {
  const mode = data.mode ?? data.sourceMode ?? '?';
  const engine = data.searchEngine ?? data.engine ?? null;
  const chrome = data.chromeLane ?? data.chrome ?? null;
  return `research source: ${mode}${engine ? ` · engine ${engine}` : ''}${chrome ? ` · chrome ${typeof chrome === 'string' ? chrome : chrome.state ?? 'set'}` : ''}`;
}
