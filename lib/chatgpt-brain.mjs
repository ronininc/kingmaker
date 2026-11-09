// ChatGPT as Kingmaker's brain (opt-in: `kingmaker brain chatgpt`, or SOL_GHOST_BRAIN=chatgpt).
//
// The same lane as lib/claude-brain.mjs, through OpenAI's Codex CLI (`codex exec`) signed in with the owner's ChatGPT
// plan (`codex login`, "Sign in with ChatGPT"): OPENAI_API_KEY is stripped from its environment, so it never bills
// the API. Its only MCP server is Kingmaker's own surface; it runs read-only (no shell writes, no network of its own),
// in <state>/chatgpt-brain, where Codex loads AGENTS.md on every turn as read-only context (it can no longer edit it).
// CRM data comes only through Kingmaker (kingmaker_turn), from the CRM this installation connected.

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DRAFT_SYSTEM_PROMPT, DRAFT_TOOLS, KINGMAKER_BIN, NEW_CONVERSATION, SEED_MEMORY, SYSTEM_PROMPT, photoNote } from './claude-brain.mjs';
import { meterCloud } from './token-meter.mjs';

export const chatgptDir = (paths) => join(paths.state, 'chatgpt-brain');

export function findCodex(env = process.env, exists = existsSync, home = env.HOME || homedir()) {
  if (String(env.SOL_GHOST_CODEX_BIN ?? '').trim()) return String(env.SOL_GHOST_CODEX_BIN).trim();
  return ['/opt/homebrew/bin/codex', '/usr/local/bin/codex', join(home, '.local', 'bin', 'codex')].find((p) => exists(p)) ?? 'codex';
}

/** The CLI's environment: ChatGPT sign-in only, never an API key. Pure. */
export function codexEnv(env = process.env) {
  const out = { ...env };
  for (const k of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'ELECTRON_RUN_AS_NODE']) delete out[k];
  out.PATH = [...new Set(['/opt/homebrew/bin', '/usr/local/bin', ...String(env.PATH || '').split(':').filter(Boolean)])].join(':');
  return out;
}

/** The argv of one turn. Pure. AGENTS.md is the memory; the prompt rides in front of the owner's words. `images`: field
 *  photos on this turn, attached to the prompt (`--image`). */
export function codexArgs({ text, resume = false, port, outFile, bin = KINGMAKER_BIN, model = null, images = [] }) {
  // Read-only: this brain cannot edit AGENTS.md, so the self-learning sentence is replaced (the owner's lasting preferences
  // are kept by Kingmaker's own learning store, which the owner switches on).
  const prompt = `${SYSTEM_PROMPT.replace(/ Self-learning:.*$/, ' Memory: you cannot edit files. The owner\'s lasting preferences are kept by Kingmaker itself, not by you.')}\n\nOwner said: ${text}`;
  const config = [
    '-c', `mcp_servers.kingmaker.command=${JSON.stringify(bin)}`,
    '-c', `mcp_servers.kingmaker.args=${JSON.stringify(['mcp', '--port', String(port)])}`,
  ];
  return ['exec', ...(resume ? ['resume', '--last'] : []), ...config, '--ignore-user-config', '--sandbox', 'read-only', '--skip-git-repo-check',
    ...(model ? ['--model', model] : []), ...images.filter((p) => typeof p === 'string' && p).flatMap((p) => ['--image', p]), '--output-last-message', outFile, prompt];
}

/** The Kingmaker MCP tools a draft may see and call: the same read-only set as the Claude draft (DRAFT_TOOLS), by the
 *  server's own tool names. Everything else the server offers (phone taps, typing, messages, cancelling) is hidden. */
export const CODEX_DRAFT_TOOLS = Object.freeze(DRAFT_TOOLS.map((t) => t.replace(/^mcp__kingmaker__/, '')));

/** The argv of one draft (an add-on's overnight loop): a fresh, read-only run, never resumed and never spoken, limited to
 *  CODEX_DRAFT_TOOLS (Codex's per-server allow list, mcp_servers.<name>.enabled_tools). Pure. */
export function codexDraftArgs({ text, port, outFile, bin = KINGMAKER_BIN, model = null }) {
  const config = [
    '-c', `mcp_servers.kingmaker.command=${JSON.stringify(bin)}`,
    '-c', `mcp_servers.kingmaker.args=${JSON.stringify(['mcp', '--port', String(port)])}`,
    '-c', `mcp_servers.kingmaker.enabled_tools=${JSON.stringify(CODEX_DRAFT_TOOLS)}`,
  ];
  return ['exec', ...config, '--ignore-user-config', '--sandbox', 'read-only', '--skip-git-repo-check',
    ...(model ? ['--model', model] : []), '--output-last-message', outFile, `${DRAFT_SYSTEM_PROMPT}\n\n${text}`];
}

export function createChatgptBrain({ paths, port, say, log = () => {}, env = process.env, run = execFile, timeoutMs = 180_000 }) {
  const dir = chatgptDir(paths);
  mkdirSync(dir, { recursive: true });
  const memory = join(dir, 'AGENTS.md');
  if (!existsSync(memory)) writeFileSync(memory, SEED_MEMORY);
  const outFile = join(dir, 'last-reply.txt');
  let resume = existsSync(join(dir, '.started'));
  const bin = findCodex(env);

  const ask = (text, images = []) => new Promise((resolve) => {
    try { writeFileSync(outFile, ''); } catch { /* fresh */ }
    const child = run(bin, codexArgs({ text, resume, port, outFile, model: env.SOL_GHOST_CODEX_MODEL || null, images }), { cwd: dir, env: codexEnv(env), timeout: timeoutMs, maxBuffer: 8 * 2 ** 20 }, (error, _stdout, stderr) => {
      let reply = '';
      try { reply = readFileSync(outFile, 'utf8').trim(); } catch { /* none */ }
      if (!reply) log('chatgpt_brain_error', { code: error?.code ?? null, stderr: String(stderr ?? '').slice(0, 500) });
      // Codex's last-message output carries no usage: the turn is counted, its tokens and cost stay unknown (null).
      meterCloud({ provider: 'openai', model: env.SOL_GHOST_CODEX_MODEL || 'chatgpt', billing: 'subscription', outcome: reply ? 'ok' : 'error' });
      resolve({ ok: Boolean(reply), text: reply, error: reply ? null : error?.code === 'ENOENT' ? 'not_installed' : 'failed' });
    });
    // `codex exec` appends piped stdin to an argv prompt. Node's execFile keeps
    // that pipe open unless the parent closes it, so the CLI otherwise waits
    // forever at "Reading additional input from stdin...". End it immediately:
    // the owner text is already the final argv argument above.
    child?.stdin?.end();
  });

  // `image`: a field photo from the phone on this turn (lib/field-photo.mjs), attached to the prompt.
  async function runTurn(text, { image = null } = {}) {
    const images = image?.path ? [image.path] : [];
    if (NEW_CONVERSATION.test(String(text).trim())) {
      resume = false;
      rmSync(join(dir, '.started'), { force: true });
      await say('Fresh conversation. I kept what I have learned.');
      return { followUp: false, ok: true, route: 'chatgpt' };
    }
    if (images.length) text = `${text}\n\n(${photoNote(image)})`;
    let r = await ask(text, images);
    if (!r.ok && resume && r.error === 'failed') { resume = false; r = await ask(text, images); }
    if (!r.ok) {
      await say(r.error === 'not_installed'
        ? 'The Codex app is not installed on this Mac. Install it, run codex login and sign in with ChatGPT, then try again.'
        : 'ChatGPT did not answer. Run codex login in Terminal once to check you are signed in.');
      return { followUp: false, ok: false, reason: `chatgpt_${r.error}`, route: 'chatgpt' };
    }
    if (!resume) { resume = true; writeFileSync(join(dir, '.started'), ''); }
    await say(r.text);
    return { followUp: /\?\s*$/.test(r.text), ok: true, route: 'chatgpt', answerChars: r.text.length };
  }

  /** One silent draft (an add-on's overnight loop): its reply text, or null. Not spoken, not part of the conversation. */
  const draft = (text) => new Promise((resolve) => {
    const file = join(dir, 'draft-reply.txt');
    try { writeFileSync(file, ''); } catch { /* fresh */ }
    const child = run(bin, codexDraftArgs({ text, port, outFile: file, model: env.SOL_GHOST_CODEX_MODEL || null }), { cwd: dir, env: codexEnv(env), timeout: timeoutMs * 3, maxBuffer: 8 * 2 ** 20 }, (error, _stdout, stderr) => {
      let reply = '';
      try { reply = readFileSync(file, 'utf8').trim(); } catch { /* none */ }
      if (!reply) log('chatgpt_draft_error', { code: error?.code ?? null, stderr: String(stderr ?? '').slice(0, 500) });
      meterCloud({ provider: 'openai', model: env.SOL_GHOST_CODEX_MODEL || 'chatgpt', billing: 'subscription', outcome: reply ? 'ok' : 'error', kind: 'nightly' });
      resolve(reply || null);
    });
    child?.stdin?.end();
  });

  return { runTurn, draft, memoryPath: memory, bin, sees: true };
}
