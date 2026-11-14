// Kingmaker offices for the Build Room brains that act (operator, 2026-10-10: "get all my engines live and firing
// under the same ruleset i gave the muse agent").
//
// Claude, Codex, and Grok each get an office shaped exactly like Muse's (lib/muse-office.mjs): identity.md,
// permissions.json, inbox/, outbox/, their own memory namespace, a lifecycle file, one worker at a time, cold-loaded
// only when Kingmaker routes an order and unloaded when the reply is written. The authority boundary is Muse's, word
// for word. What differs is only what cannot be the same for a doer: Muse is a local model reading ~/workspace; these
// are their owner's signed-in memberships that pick tools from their own store, Kingmaker's governed MCP (the hardware)
// and the CRM skill catalog. Every action through Kingmaker's MCP still meets Kingmaker's gates (the owner's word).

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicJson, privateDir, privateFile, releaseOfficeLock, takeOfficeLock } from './muse-office.mjs';

const HISTORY_MAX = 250;
const HISTORY_CHARS = 3_000; // the office's own recent memory rides along with each order; the order carries the rest

/** Muse's hard authority boundary, applied unchanged to every acting brain. */
export const AUTHORITY_BOUNDARY = 'must never move money, initiate or send outreach, touch a publish toggle or publish state, accept terms, handle credentials, change billing, or check a TCPA/consent box.';
const REPORTS = 'reports what a human or a separately authorized governed workflow would need to do.';
export const DENIED_MUTATIONS = Object.freeze(['credentials', 'billing', 'publish-state', 'outreach', 'money', 'tcpa-consent']);

const AGENTS = {
  claude: { name: 'Claude', job: 'Claude runs the money engines: revenue, pipeline, pricing and the belts that earn, and the engineering they need.', service: 'Anthropic (the owner\'s claude.ai membership)' },
  codex: { name: 'Codex', job: 'Codex builds: code, sites, scripts, repairs and the tooling the other desks need.', service: 'OpenAI (the owner\'s ChatGPT plan)' },
  'grok-bot': { name: 'Grok', job: 'Grok researches: live signal, markets, people and companies, second opinions on the other desks\' work.', service: 'xAI (the owner\'s Grok subscription)' },
};
export const AGENT_OFFICES = Object.freeze(Object.keys(AGENTS));

export function agentIdentity(slug) {
  const a = AGENTS[slug];
  if (!a) throw new Error(`No Kingmaker office for ${slug}.`);
  return `# ${a.name}

${a.name} is the owner's Ronin Inc agent at the ${slug} desk in the Build Room, under the Kingmaker brain.

## Job

${a.job} ${a.name} takes orders from Seeker (Kingmaker), picks the tools the job needs from its own store, Kingmaker's tools and the CRM skill catalog, does the work, and reports back to Seeker. It never reports to the owner directly and never coordinates with another desk; everything routes through Kingmaker.

## Hard authority boundary

${a.name} ${AUTHORITY_BOUNDARY} ${a.name} ${REPORTS}

## Sovereignty and scope

- Ronin Inc only. Orosolu is not connected to this office.
- $0 new spend: only the owner's existing membership (${a.service}); no API keys, no metered or paid calls.
- Acts on the Mac and the CRM only through Kingmaker's governed tools; its gates and the owner's word apply to every action.
- Reads and writes only its own Ronin Inc ./memory namespace and never another office's memory.
- Orders enter through ./inbox and replies leave through ./outbox. Brains and conversation state are never shared.
- Cold-load only when Kingmaker routes an order; unload when the reply is written. No idle worker.
`;
}

export function agentPermissions(slug) {
  const a = AGENTS[slug];
  if (!a) throw new Error(`No Kingmaker office for ${slug}.`);
  return {
    office: slug,
    crm: 'ronininc',
    spend_usd: 0,
    billing: 'membership-only',
    lifecycle: { mode: 'one-shot', idle_workers: 0, unload_after_reply: true },
    network: { allowed: ['loopback', 'model-service'], model_service: a.service, denied: ['lan'], internet: 'only through Kingmaker governed tools' },
    tools: { own_store: true, kingmaker_mcp: 'governed', crm_skill_catalog: true },
    memory: { namespace: `ronininc/${slug}`, cross_office_read: false, cross_office_write: false },
    denied_mutations: [...DENIED_MUTATIONS],
  };
}

export function agentOfficePaths(paths, slug) {
  const root = join(paths.state, 'offices', 'ronininc', slug);
  return {
    root,
    identity: join(root, 'identity.md'),
    permissions: join(root, 'permissions.json'),
    lifecycle: join(root, 'lifecycle.json'),
    lock: join(root, 'run.lock'),
    memory: join(root, 'memory'),
    memoryHistory: join(root, 'memory', 'history.jsonl'),
    inbox: join(root, 'inbox'),
    outbox: join(root, 'outbox'),
  };
}

function writeLifecycle(p, slug, state, detail = {}) {
  const active = state === 'working';
  atomicJson(p.lifecycle, { office: `ronininc/${slug}`, state: active ? 'working' : 'idle', workers: active ? 1 : 0, updated_at: Math.floor(Date.now() / 1000), ...detail });
}

export function ensureAgentOffice(paths, slug) {
  const p = agentOfficePaths(paths, slug);
  privateDir(p.root); privateDir(p.memory); privateDir(p.inbox); privateDir(p.outbox);
  privateFile(p.identity, agentIdentity(slug));
  privateFile(p.permissions, `${JSON.stringify(agentPermissions(slug), null, 2)}\n`);
  if (!existsSync(p.memoryHistory)) privateFile(p.memoryHistory, '');
  if (!existsSync(p.lifecycle)) writeLifecycle(p, slug, 'idle');
  return p;
}

function recentMemory(p) {
  try { const t = readFileSync(p.memoryHistory, 'utf8'); return t.length <= HISTORY_CHARS ? t : t.slice(-HISTORY_CHARS); } catch { return ''; }
}

/** The order as the brain sees it: its office identity (the ruleset), its own recent memory, then Seeker's order. */
export function officePrompt(slug, identity, memory, ask) {
  return [
    identity.trim(),
    memory.trim() ? `Your recent office memory (yours only):\n${memory.trim()}` : '',
    `${String(ask?.asker_name || 'Seeker')} gave you this order on your desk (${slug}):`,
    String(ask?.question || '').trim(),
    ask?.context ? `Context: ${String(ask.context).trim()}` : '',
    'Do the work with the tools it needs, then answer Seeker in plain text, short and direct, with no disclaimers. Anything inside your authority boundary is a proposal for the owner, never done.',
  ].filter(Boolean).join('\n\n');
}

/** Route one desk order through the office: inbox → brain (one worker) → outbox → memory. Returns the reply text. */
export async function routeAgentOrder(paths, slug, ask, think) {
  const p = ensureAgentOffice(paths, slug);
  const id = String(ask?.id || `${slug}-${Date.now()}`).replace(/[^A-Za-z0-9._-]/g, '').slice(0, 96) || `${slug}-${Date.now()}`;
  const outboxPath = join(p.outbox, `${id}.json`);
  if (existsSync(outboxPath)) return { ok: true, text: JSON.parse(readFileSync(outboxPath, 'utf8')).answer, reused: true };
  takeOfficeLock(p, AGENTS[slug].name);
  let failure = '';
  try {
    atomicJson(join(p.inbox, `${id}.json`), { id, asker_name: String(ask?.asker_name || 'Seeker'), question: String(ask?.question || ''), context: ask?.context ?? null, created_at: Math.floor(Date.now() / 1000), type: 'question' });
    writeLifecycle(p, slug, 'working', { ask_id: id });
    const reply = await think(officePrompt(slug, readFileSync(p.identity, 'utf8'), recentMemory(p), ask));
    if (!reply?.ok || !String(reply.text || '').trim()) { failure = String(reply?.error || 'no_answer'); return { ok: false, error: failure }; }
    const answer = String(reply.text).trim().slice(0, 8_000);
    atomicJson(outboxPath, { ask_id: id, answer });
    const record = JSON.stringify({ ask_id: id, question: String(ask?.question || '').slice(0, 600), answer: answer.slice(0, 600), created_at: Math.floor(Date.now() / 1000) });
    let lines = [];
    try { lines = readFileSync(p.memoryHistory, 'utf8').split('\n').filter(Boolean).slice(-(HISTORY_MAX - 1)); } catch { /* first memory */ }
    privateFile(p.memoryHistory, `${[...lines, record].join('\n')}\n`);
    return { ok: true, text: answer };
  } finally {
    writeLifecycle(p, slug, 'idle', failure ? { last_error: failure.slice(0, 240) } : {});
    releaseOfficeLock(p);
  }
}
