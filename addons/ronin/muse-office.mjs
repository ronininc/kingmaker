// Muse: one local, sovereign Ronin Inc office under Kingmaker.
//
// The office is deliberately file based. Kingmaker writes the same question
// shape used by Ronin's desk_inbox contract and reads the same answer shape
// used by desk_answer. Muse has no daemon: one message cold-loads one local
// Ollama turn with keep_alive=0, writes the reply, and returns to zero workers.

import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export const MUSE_SLUG = 'muse';
export const MUSE_NAMESPACE = 'ronininc/muse';
export const MUSE_HISTORY_MAX = 250;
export const MUSE_RETRY_EVENT_MAX = 64;
export const MUSE_IDENTITY = `# Muse — Mr. Social

Muse is the owner's personal Ronin Inc agent under the Kingmaker brain.

## Job

Muse is a coordinator, verifier, and reporter. Muse may read approved local workspace material, organize facts, verify what the evidence supports, and return a concise report to Kingmaker.

## Hard authority boundary

Muse must never move money, initiate or send outreach, touch a publish toggle or publish state, accept terms, handle credentials, change billing, or check a TCPA/consent box. Muse reports what a human or a separately authorized governed workflow would need to do.

## Sovereignty and scope

- Ronin Inc only. Orosolu is not connected to this office.
- Local-only: nothing leaves the owner's local network.
- $0 new spend. No paid model, API, or service calls.
- The only tool scope is read-only access to ~/workspace.
- Muse reads only its own Ronin Inc ./memory namespace and never reads another CRM office's memory.
- Messages enter through ./inbox and replies leave through ./outbox. Brains and conversation state are never shared.
- Cold-load only when Kingmaker routes a message; unload immediately when the reply is written. No idle worker.
`;

export const MUSE_PERMISSIONS = Object.freeze({
  office: MUSE_SLUG,
  crm: 'ronininc',
  spend_usd: 0,
  lifecycle: { mode: 'one-shot', idle_workers: 0, unload_after_reply: true },
  network: { allowed: ['loopback'], denied: ['lan', 'internet', 'cloud'] },
  tools: { workspace: { root: '~/workspace', access: 'read-only' } },
  memory: { namespace: MUSE_NAMESPACE, cross_office_read: false, cross_office_write: false },
  denied_mutations: ['credentials', 'billing', 'publish-state', 'outreach', 'money', 'tcpa-consent'],
});

const BLOCKED_MUTATION = /\b(send|post|publish|enable|disable|toggle|launch|start|approve|accept|check|transfer|pay|charge|refund|invoice|buy|sell|wire|withdraw|deposit|email|text|dm|outreach|credential|password|secret|api[ -]?key|billing|tcpa|consent)\b/i;
const MESSAGE_KEYS = ['id', 'asker_name', 'question', 'context', 'created_at', 'type'];
const ANSWER_KEYS = ['ask_id', 'answer'];

export function museOfficePath(paths) { return join(paths.state, 'offices', 'ronininc', MUSE_SLUG); }

export function musePaths(paths) {
  const root = museOfficePath(paths);
  return {
    root,
    identity: join(root, 'identity.md'),
    permissions: join(root, 'permissions.json'),
    lifecycle: join(root, 'lifecycle.json'),
    lock: join(root, 'run.lock'),
    memory: join(root, 'memory'),
    memoryHistory: join(root, 'memory', 'history.jsonl'),
    retryHistory: join(root, 'memory', 'retry-attempts.jsonl'),
    inbox: join(root, 'inbox'),
    outbox: join(root, 'outbox'),
  };
}

export function privateDir(path) { mkdirSync(path, { recursive: true, mode: 0o700 }); chmodSync(path, 0o700); }
export function privateFile(path, body) { writeFileSync(path, body, { mode: 0o600 }); chmodSync(path, 0o600); }

export function ensureMuseOffice(paths) {
  const p = musePaths(paths);
  privateDir(p.root); privateDir(p.memory); privateDir(p.inbox); privateDir(p.outbox);
  privateFile(p.identity, MUSE_IDENTITY);
  privateFile(p.permissions, `${JSON.stringify(MUSE_PERMISSIONS, null, 2)}\n`);
  if (!existsSync(p.memoryHistory)) privateFile(p.memoryHistory, '');
  if (!existsSync(p.retryHistory)) privateFile(p.retryHistory, '');
  if (!existsSync(p.lifecycle)) writeMuseLifecycle(p, 'idle');
  return p;
}

export function writeMuseLifecycle(p, state, detail = {}) {
  const active = state === 'working';
  atomicJson(p.lifecycle, { office: MUSE_NAMESPACE, state: active ? 'working' : 'idle', workers: active ? 1 : 0, updated_at: Math.floor(Date.now() / 1000), ...detail });
}

function processAlive(pid) { try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; } }
const OWNED_OFFICE_LOCKS = new Map();

/** One worker per office (bounded concurrency 1 on this 8 GB host). Shared by every Kingmaker office. */
export function takeOfficeLock(p, name = 'Muse') {
  const token = randomBytes(16).toString('hex');
  try {
    mkdirSync(p.lock, { mode: 0o700 });
    atomicJson(join(p.lock, 'owner.json'), { pid: process.pid, token, created_at: Date.now() });
    OWNED_OFFICE_LOCKS.set(p.lock, token);
    return token;
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  let pid = 0;
  try {
    if (lstatSync(p.lock).isDirectory()) pid = Number(JSON.parse(readFileSync(join(p.lock, 'owner.json'), 'utf8')).pid) || 0;
    else pid = Number(readFileSync(p.lock, 'utf8').trim()) || 0; // legacy lock file
  } catch { throw new Error(`${name} is already working; its lock is partial and requires explicit recovery.`); }
  if (pid > 0 && processAlive(pid)) throw new Error(`${name} is already working; bounded concurrency is 1 on this 8 GB host.`);
  // Never remove a path merely because its recorded process appears dead: the
  // pathname may have been replaced since inspection. Recovery is owner-visible.
  throw new Error(`${name} has a stale lock that requires explicit recovery.`);
}

export function releaseOfficeLock(p) {
  const token = OWNED_OFFICE_LOCKS.get(p.lock);
  if (!token) return;
  try {
    const owner = JSON.parse(readFileSync(join(p.lock, 'owner.json'), 'utf8'));
    if (owner.pid !== process.pid || owner.token !== token) return;
    const released = `${p.lock}.released.${process.pid}.${randomBytes(4).toString('hex')}`;
    renameSync(p.lock, released);
    rmSync(released, { recursive: true, force: true });
  } catch { /* ownership changed or lock already gone */ }
  finally { OWNED_OFFICE_LOCKS.delete(p.lock); }
}

export function validateDeskMessage(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Muse inbox message must be an object.');
  if (Object.keys(message).sort().join('|') !== [...MESSAGE_KEYS].sort().join('|')) throw new Error(`Muse inbox uses exactly: ${MESSAGE_KEYS.join(', ')}.`);
  if (!/^[A-Za-z0-9._-]{1,96}$/.test(String(message.id || ''))) throw new Error('Muse inbox id is invalid.');
  if (!String(message.asker_name || '').trim() || String(message.asker_name).length > 120) throw new Error('Muse asker_name is required.');
  if (!String(message.question || '').trim() || String(message.question).length > 8_000) throw new Error('Muse question is required.');
  if (message.context != null && (typeof message.context !== 'string' || message.context.length > 16_000)) throw new Error('Muse context must be null or text.');
  if (!Number.isInteger(message.created_at) || message.created_at <= 0) throw new Error('Muse created_at must be epoch seconds.');
  if (!['question', 'recap'].includes(message.type)) throw new Error('Muse type must be question or recap.');
  return { ...message, asker_name: message.asker_name.trim(), question: message.question.trim() };
}

export function validateDeskAnswer(answer) {
  if (!answer || typeof answer !== 'object' || Object.keys(answer).sort().join('|') !== [...ANSWER_KEYS].sort().join('|')) throw new Error(`Muse outbox uses exactly: ${ANSWER_KEYS.join(', ')}.`);
  if (!/^[A-Za-z0-9._-]{1,96}$/.test(String(answer.ask_id || ''))) throw new Error('Muse ask_id is invalid.');
  if (!String(answer.answer || '').trim()) throw new Error('Muse answer is required.');
  return { ask_id: answer.ask_id, answer: String(answer.answer).trim().slice(0, 8_000) };
}

export function atomicJson(path, value) {
  const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  privateFile(temp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temp, path);
}

function historyFor(p, maxChars = 16_000) {
  let text = '';
  try { text = readFileSync(p.memoryHistory, 'utf8'); } catch { return ''; }
  return text.length <= maxChars ? text : text.slice(-maxChars);
}

export function assertMuseWorkspacePath(requested, home = homedir()) {
  const root = resolve(home, 'workspace');
  if (!existsSync(root)) throw new Error(`Muse workspace is not present: ${root}`);
  const rootReal = realpathSync(root);
  if (!requested || isAbsolute(requested)) throw new Error('Muse workspace reads require a relative path.');
  const candidate = resolve(rootReal, requested);
  const rel = relative(rootReal, candidate);
  if (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) throw new Error('Muse cannot read outside ~/workspace.');
  const real = realpathSync(candidate);
  const realRel = relative(rootReal, real);
  if (realRel.startsWith(`..${sep}`) || realRel === '..' || isAbsolute(realRel)) throw new Error('Muse cannot follow a link outside ~/workspace.');
  if (!lstatSync(real).isFile()) throw new Error('Muse workspace reads require a file.');
  return real;
}

export function readMuseWorkspace(requested, { home = homedir(), maxBytes = 256 * 1024 } = {}) {
  const path = assertMuseWorkspacePath(requested, home);
  const body = readFileSync(path);
  if (body.length > maxBytes) throw new Error(`Muse refuses workspace files larger than ${maxBytes} bytes.`);
  if (body.includes(0)) throw new Error('Muse reads text workspace files only.');
  return body.toString('utf8');
}

export function museModel(env = process.env) {
  return String(env.KINGMAKER_MUSE_MODEL || env.SOLOMON_LOCAL_GENERAL_MODEL || 'huihui_ai/qwen3-abliterated:0.6b').trim();
}

export async function localMuseResponder(message, { identity, memory, env = process.env, fetchImpl = fetch } = {}) {
  const endpoint = String(env.KINGMAKER_MUSE_OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
  const url = new URL(endpoint);
  if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname) || url.protocol !== 'http:') throw new Error('Muse permits only a loopback Ollama endpoint.');
  if (BLOCKED_MUTATION.test(message.question)) {
    return 'Blocked by Muse authority: I can coordinate, verify, and report, but I cannot mutate money, outreach, publishing, credentials, billing, or TCPA consent.';
  }
  const model = museModel(env);
  const tagsResponse = await fetchImpl(`${endpoint}/api/tags`, { signal: AbortSignal.timeout(30_000) });
  if (!tagsResponse.ok) throw new Error(`Muse could not inventory the local models (HTTP ${tagsResponse.status}).`);
  const tags = await tagsResponse.json();
  const installed = (tags?.models || []).flatMap((item) => [item?.name, item?.model]).filter(Boolean);
  if (!installed.includes(model)) throw new Error(`Muse model is not installed locally: ${model}. Refusing to download it during a message.`);
  const prompt = `${identity}\n\nRecent private Muse memory (never another office):\n${memory || '(none)'}\n\nInbox message:\n${JSON.stringify(message)}\n\nReply as Muse with a concise coordinator/verifier/reporter answer. Report uncertainty. Do not claim or propose a prohibited mutation.`;
  const response = await fetchImpl(`${endpoint}/api/generate`, {
    method: 'POST', signal: AbortSignal.timeout(120_000), headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, prompt, stream: false, keep_alive: 0, options: { temperature: 0.2, num_ctx: 2048, num_predict: 320 } }),
  });
  if (!response.ok) throw new Error(`Muse local model returned HTTP ${response.status}.`);
  const body = await response.json();
  const answer = String(body?.response || '').trim();
  if (!answer) throw new Error('Muse local model returned no answer.');
  return answer;
}

export async function routeMuseMessage(paths, message, options = {}) {
  const p = ensureMuseOffice(paths);
  const clean = validateDeskMessage(message);
  const inboxPath = join(p.inbox, `${clean.id}.json`);
  const outboxPath = join(p.outbox, `${clean.id}.json`);
  if (existsSync(outboxPath)) return { inboxPath, outboxPath, answer: validateDeskAnswer(JSON.parse(readFileSync(outboxPath, 'utf8'))), reused: true };
  takeOfficeLock(p, 'Muse');
  // A second caller can observe no outbox before the first caller finishes.
  // Re-check under the office lock so an exact-ID retry never runs twice.
  if (existsSync(outboxPath)) {
    try { return { inboxPath, outboxPath, answer: validateDeskAnswer(JSON.parse(readFileSync(outboxPath, 'utf8'))), reused: true }; }
    finally { releaseOfficeLock(p); }
  }
  try { readMuseLifecycle(p); }
  catch (error) { releaseOfficeLock(p); throw error; }
  try { return await runMuseMessageLocked(p, clean, { inboxPath, outboxPath, ...options }); }
  finally { releaseOfficeLock(p); }
}

async function runMuseMessageLocked(p, clean, options = {}) {
  const inboxPath = options.inboxPath || join(p.inbox, `${clean.id}.json`);
  const outboxPath = options.outboxPath || join(p.outbox, `${clean.id}.json`);
  let failure = '';
  let dispatched = false;
  try {
    atomicJson(inboxPath, clean);
    writeMuseLifecycle(p, 'working', { ask_id: clean.id, model: museModel(options.env) });
    // Cold load happens here. The handler receives only Ronin Muse's identity and namespaced memory.
    const responder = options.responder || localMuseResponder;
    dispatched = true;
    const answerText = await responder(clean, { identity: readFileSync(p.identity, 'utf8'), memory: historyFor(p), env: options.env, fetchImpl: options.fetchImpl });
    const answer = validateDeskAnswer({ ask_id: clean.id, answer: answerText });
    atomicJson(outboxPath, answer);
    const record = JSON.stringify({ ask_id: clean.id, question: clean.question, answer: answer.answer, created_at: Math.floor(Date.now() / 1000) });
    let lines = [];
    try { lines = readFileSync(p.memoryHistory, 'utf8').split('\n').filter(Boolean).slice(-(MUSE_HISTORY_MAX - 1)); } catch { /* first memory */ }
    privateFile(p.memoryHistory, `${[...lines, record].join('\n')}\n`);
    return { inboxPath, outboxPath, answer, reused: false };
  } catch (error) {
    failure = String(error?.message || error).slice(0, 240);
    throw error;
  } finally {
    if (failure && dispatched) atomicJson(p.lifecycle, { office: MUSE_NAMESPACE, state: 'uncertain', workers: 0, ask_id: clean.id, updated_at: Math.floor(Date.now() / 1000), last_error: failure });
    else writeMuseLifecycle(p, 'idle', failure ? { last_error: failure } : {});
  }
}

function readMuseLifecycle(p) {
  let lifecycle;
  try { lifecycle = JSON.parse(readFileSync(p.lifecycle, 'utf8')); }
  catch { throw new Error('Muse lifecycle is unreadable; retry refused.'); }
  if (lifecycle.office !== MUSE_NAMESPACE || lifecycle.state !== 'idle' || lifecycle.workers !== 0) {
    throw new Error(`Muse retry requires idle ${MUSE_NAMESPACE} lifecycle with zero workers.`);
  }
  return lifecycle;
}

function assertMuseRetryProfile(p) {
  for (const [label, path] of [['profile', p.root], ['identity', p.identity], ['permissions', p.permissions], ['lifecycle', p.lifecycle], ['inbox', p.inbox], ['outbox', p.outbox]]) {
    if (!existsSync(path)) throw new Error(`Muse retry requires an existing ${label} at the active ${MUSE_NAMESPACE} profile.`);
  }
  if (readFileSync(p.identity, 'utf8') !== MUSE_IDENTITY) throw new Error(`Muse retry requires the exact ${MUSE_NAMESPACE} identity.`);
  let permissions;
  try { permissions = JSON.parse(readFileSync(p.permissions, 'utf8')); }
  catch { throw new Error('Muse permissions are unreadable; retry refused.'); }
  if (JSON.stringify(permissions) !== JSON.stringify(MUSE_PERMISSIONS)) {
    throw new Error(`Muse retry requires the exact ${MUSE_NAMESPACE} profile.`);
  }
  readMuseLifecycle(p);
}

function appendMuseRetryEvent(p, event) {
  let lines = [];
  try { lines = readFileSync(p.retryHistory, 'utf8').split('\n').filter(Boolean); } catch { /* first event */ }
  const record = JSON.stringify(event);
  privateFile(p.retryHistory, `${[...lines, record].slice(-MUSE_RETRY_EVENT_MAX).join('\n')}\n`);
}

/** Retry one existing inbox item without creating a new ask id or using a paid fallback. */
export async function retryMuseMessage(paths, askId, options = {}) {
  const p = musePaths(paths);
  const id = String(askId || '').trim();
  if (!/^[A-Za-z0-9._-]{1,96}$/.test(id)) throw new Error('Muse retry ask id is invalid.');
  if (options.office != null && options.office !== MUSE_NAMESPACE) throw new Error(`Muse retry requires office ${MUSE_NAMESPACE}.`);
  if (options.profileRoot != null && resolve(String(options.profileRoot)) !== resolve(p.root)) throw new Error('Muse retry profile does not match the active Muse office.');

  // Retrying is a read-existing operation. Never initialize or repair identity,
  // permissions, lifecycle, or directories while deciding whether it is safe.
  assertMuseRetryProfile(p);
  const inboxPath = join(p.inbox, `${id}.json`);
  const outboxPath = join(p.outbox, `${id}.json`);
  if (!existsSync(inboxPath)) throw new Error(`Muse inbox item does not exist in this profile: ${id}.`);
  const clean = validateDeskMessage(JSON.parse(readFileSync(inboxPath, 'utf8')));
  if (clean.id !== id) throw new Error('Muse retry inbox identity does not match the requested ask id.');

  takeOfficeLock(p, 'Muse');
  const attemptId = `retry-${Date.now()}-${randomBytes(4).toString('hex')}`;
  const startedAt = Math.floor(Date.now() / 1000);
  const profileHash = createHash('sha256').update(realpathSync(p.root)).digest('hex');
  try {
    assertMuseRetryProfile(p);
    if (!existsSync(p.retryHistory)) privateFile(p.retryHistory, '');
    appendMuseRetryEvent(p, { attempt_id: attemptId, ask_id: id, office: MUSE_NAMESPACE, profile_hash: profileHash, status: 'started', at: startedAt });
    if (existsSync(outboxPath)) {
      const answer = validateDeskAnswer(JSON.parse(readFileSync(outboxPath, 'utf8')));
      if (answer.ask_id !== id) throw new Error('Muse retry outbox identity does not match the requested ask id.');
      appendMuseRetryEvent(p, { attempt_id: attemptId, ask_id: id, office: MUSE_NAMESPACE, profile_hash: profileHash, status: 'replayed', at: Math.floor(Date.now() / 1000) });
      return { inboxPath, outboxPath, answer, reused: true, attemptId };
    }
    const result = await runMuseMessageLocked(p, clean, { inboxPath, outboxPath, ...options });
    appendMuseRetryEvent(p, { attempt_id: attemptId, ask_id: id, office: MUSE_NAMESPACE, profile_hash: profileHash, status: 'completed', at: Math.floor(Date.now() / 1000) });
    return { ...result, attemptId };
  } catch (error) {
    appendMuseRetryEvent(p, { attempt_id: attemptId, ask_id: id, office: MUSE_NAMESPACE, profile_hash: profileHash, status: 'failed', error: String(error?.message || error).slice(0, 240), at: Math.floor(Date.now() / 1000) });
    throw error;
  } finally {
    releaseOfficeLock(p);
  }
}

export function newMuseMessage(question, { asker = 'Kingmaker', context = null, now = () => Date.now() } = {}) {
  return {
    id: `muse-${now()}-${randomBytes(4).toString('hex')}`,
    asker_name: asker,
    question: String(question || '').trim(),
    context: context == null ? null : String(context),
    created_at: Math.floor(now() / 1000),
    type: 'question',
  };
}

export function museStatus(paths) {
  const p = ensureMuseOffice(paths);
  const count = (dir) => { try { return readdirSync(dir).filter((name) => name.endsWith('.json')).length; } catch { return 0; } };
  let lifecycle = { state: 'idle', workers: 0 };
  try { lifecycle = JSON.parse(readFileSync(p.lifecycle, 'utf8')); } catch { /* repaired on next route */ }
  return { path: p.root, namespace: MUSE_NAMESPACE, crm: 'ronininc', inbox: count(p.inbox), outbox: count(p.outbox), idle_workers: lifecycle.workers || 0, lifecycle: lifecycle.state || 'idle', model: museModel() };
}

export function museMemoryDigest(paths) {
  const p = ensureMuseOffice(paths);
  return createHash('sha256').update(readFileSync(p.memoryHistory)).digest('hex');
}
