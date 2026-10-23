// lib/fabrication.mjs — Kingmaker's handle on the engine's Fabrication lane, PLANNING-ONLY.
//
// "fabricate a wall bracket for a 35mm pipe" → one well-formed turn to the engine's fabrication lane
// (workflowRoute: 'fabrication' → planFabrication, which returns executed:false / PLAN_ONLY by the engine's own
// doctrine). This handle reaches ONLY that planning turn. It deliberately does NOT touch the engine's stateful
// fabrication workflow (/start → /search-decision → /execute) or /adapter/dispatch REAL_MACHINE — those are how a
// plan would be executed or a machine actuated, and no Kingmaker entry point exposes them. The Kingmaker rule layer
// adds a second guarantee on top of the engine's doctrine: an ask phrased as an execution / real-machine actuation
// is refused here and never becomes a turn. So nothing from this handle can run a machine; it plans and proposes.

const FAB_VERB = /^(fabricate|cad|design|model|prototype)$/i;
// Phrasings that ask to EXECUTE / actuate rather than plan — refused before they can become a turn.
const EXECUTION = /\b(execute|actuate|real[-\s]?machine|g-?code|to the (?:printer|machine|mill|cnc|lathe|press)|start the (?:print|job|machine|run)|run it|actually (?:make|print|mill|cut|build|machine) it|send (?:it )?to (?:the )?(?:printer|machine|mill|cnc)|cut it on|mill it|print it for real)\b/i;

/** Pure: true when the words ask to execute/actuate rather than plan. The handle refuses these. */
export function isExecutionAsk(words) {
  const asked = (Array.isArray(words) ? words.join(' ') : String(words ?? '')).trim();
  return EXECUTION.test(asked);
}

/**
 * Pure: one well-formed sentence for the engine's planning-only fabrication lane, or { error }. A fabrication verb
 * leads when the words do not already start with one. An execution/real-machine ask is refused here (never turned
 * into a turn), so this handle can only ever reach the plan. → { text } | { error }.
 */
export function fabricateTurnText(words) {
  const arr = Array.isArray(words) ? words.filter(Boolean) : String(words ?? '').trim().split(/\s+/).filter(Boolean);
  const asked = arr.join(' ').replace(/\s+/g, ' ').trim();
  if (!asked) return { error: 'Say what to plan, e.g.: kingmaker fabricate a wall bracket for a 35mm pipe' };
  if (EXECUTION.test(asked)) return { error: 'Fabrication is planning-only here: it plans a part and proposes it, it never runs a machine. Ask for the plan, e.g.: kingmaker fabricate a wall bracket for a 35mm pipe.' };
  const text = FAB_VERB.test(arr[0]) ? asked : `fabricate ${asked}`;
  return { text };
}
