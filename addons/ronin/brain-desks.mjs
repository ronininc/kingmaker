// The Build Room brains' desks on the Ronin Inc CRM, hosted by this Kingmaker (operator, 2026-10-10).
//
// Muse, Claude, Codex, and grok-bot each sit at their own desk with their own key in this Mac's Keychain
// (ronin-crm-prod / <DESK>_DESK_TOKEN). Seeker (the kingmaker desk) addresses them; each question is answered by
// that desk's local brain in its own session, so desk work never mixes into the owner's voice conversation. The
// keys never leave this Mac (the hosted Grok Bot app never gets one: standing no-go, 2026-09-30). Every brain sees
// only Kingmaker's MCP; anything that would change the CRM or the Mac, send, publish, or move money is a proposal
// the owner decides.

import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createChatgptBrain, findCodex } from './core.mjs';
import { createClaudeBrain, findClaude } from './core.mjs';
import { createGrokBrain, findGrok } from './core.mjs';
import { museModel, newMuseMessage, routeMuseMessage } from './muse-office.mjs';
import { routeAgentOrder } from './agent-offices.mjs';

/** The desks Kingmaker hosts, and the Keychain account each one's key lives under. kingmaker is Seeker's own desk. */
export const DESK_ACCOUNTS = Object.freeze({
  kingmaker: 'KINGMAKER_DESK_TOKEN',
  muse: 'MUSE_DESK_TOKEN',
  claude: 'CLAUDE_DESK_TOKEN',
  codex: 'CODEX_DESK_TOKEN',
  'grok-bot': 'GROK_DESK_TOKEN',
});
export const BRAIN_DESKS = Object.freeze(['muse', 'claude', 'codex', 'grok-bot']);

/** A CLI found by its brain's finder, as a real path, or null when it is not installed. */
export function installedCli(find, name, env = process.env, exists = existsSync, run = execFileSync) {
  const bin = find(env, exists);
  if (bin !== name) return exists(bin) ? bin : null;
  try { return run('/usr/bin/which', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; } catch { return null; }
}

/** The question as a desk brain sees it: who asked, on which desk, and the house rules for a desk answer. */
export const DESK_NAMES = Object.freeze({ muse: 'Muse', claude: 'Claude', codex: 'Codex', 'grok-bot': 'Grok' });

export function deskPrompt(desk, ask) {
  const who = String(ask?.asker_name || 'Seeker');
  return [
    `You are ${DESK_NAMES[desk] || desk}, at the ${desk} desk in the Ronin Inc CRM's Build Room. Seeker (Kingmaker) gives the Build Room its orders; you report back to Seeker, never to the owner directly and never to another desk.`,
    `${who} asked you this on your desk (${desk}):`,
    String(ask?.question || '').trim(),
    ask?.context ? `Context: ${String(ask.context).trim()}` : '',
    'Answer in plain text, short and direct, with no disclaimers. If the question asks for something that would change the CRM or this Mac, send a message, publish, or move money, say what you propose; the owner decides.',
  ].filter(Boolean).join('\n\n');
}

const CLI_BRAINS = {
  claude: { factory: createClaudeBrain, find: findClaude, cli: 'claude', label: 'Claude Code' },
  codex: { factory: createChatgptBrain, find: findCodex, cli: 'codex', label: 'the Codex CLI' },
  'grok-bot': { factory: createGrokBrain, find: findGrok, cli: 'grok', label: 'Grok Build' },
};

/** Where each brain keeps the conversation it resumes. Cleared before every order: Seeker's order carries the context the
 *  job needs, so no desk re-sends (and pays for) the history of every earlier order. The brain keeps its own tools,
 *  Kingmaker's MCP (the hardware, the CRM skill catalog) and its learned memory file. */
const SESSION_MARKERS = {
  claude: ['claude-brain/session.json'],
  codex: ['chatgpt-brain/.started'],
  'grok-bot': ['grok-brain/session.json'],
};
export function clearDeskSession(desk, deskState) {
  for (const rel of SESSION_MARKERS[desk] || []) rmSync(join(deskState, rel), { force: true });
}

/** ready() and answer(ask) for one hosted desk. Factories and probes are injectable for tests. */
export function createBrainDeskHost(desk, { paths, port, env = process.env, log = () => {}, factories = {}, probe = null, fetchImpl = fetch } = {}) {
  if (desk === 'muse') {
    const route = factories.muse || routeMuseMessage;
    const ready = probe || (async () => {
      try {
        const base = String(env.KINGMAKER_MUSE_OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
        const tags = await (await fetchImpl(`${base}/api/tags`, { signal: AbortSignal.timeout(3000) })).json();
        const model = museModel(env);
        return (tags?.models || []).some((m) => m?.name === model || m?.model === model)
          ? { ok: true } : { ok: false, error: `Muse's local model is not installed (${model}).` };
      } catch { return { ok: false, error: 'Ollama is not answering on this Mac, so Muse cannot think.' }; }
    });
    const answer = async (ask) => {
      const r = await route(paths, newMuseMessage(String(ask?.question || ''), { asker: String(ask?.asker_name || 'Seeker'), context: ask?.context ?? null }), { env });
      const text = String(r?.answer?.answer || '').trim();
      return text ? { ok: true, text } : { ok: false, error: 'muse_no_answer' };
    };
    return { ready, answer };
  }
  const spec = CLI_BRAINS[desk];
  if (!spec) throw new Error(`Kingmaker does not host the ${desk} desk.`);
  const ready = probe || (async () => (installedCli(spec.find, spec.cli, env)
    ? { ok: true } : { ok: false, error: `${spec.label} is not installed on this Mac.` }));
  const deskState = join(paths.state, 'desks', desk);
  // Each order runs through the brain's Kingmaker office (lib/agent-offices.mjs): Muse's ruleset as its identity,
  // inbox → one worker → outbox → its own memory. One fresh session per order (see SESSION_MARKERS).
  const think = async (prompt) => {
    let text = '';
    clearDeskSession(desk, deskState);
    const brain = (factories[desk] || spec.factory)({ paths: { ...paths, state: deskState }, port, log, env, say: async (line) => { text = String(line || ''); } });
    const turn = await brain.runTurn(prompt);
    return turn?.ok ? { ok: true, text } : { ok: false, error: turn?.reason || `${desk}_failed` };
  };
  const answer = (ask) => (factories.route || routeAgentOrder)(paths, desk, ask, think);
  return { ready, answer };
}
