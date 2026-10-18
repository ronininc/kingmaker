// lib/connectors.mjs — anything can be connected to Kingmaker and used by its local (abliterated) models: any CLI on this
// Mac, a CLI from the Kingmaker CLI Hub (Ronin's copy of CLI-Anything), an MCP server, a skill (a folder with SKILL.md),
// or a repo folder. Free rein, by the owner's rule (2026-10-15), except code that seeks access unprompted: every connector
// gets REA's treatment first (lib/rea.mjs). Clean ones run as themselves, ones with bad parts run under a macOS sandbox
// that takes exactly those parts away, and code that fetches-and-runs or hides what it runs is never connected.
//   kept in <state>/connectors.json · shown on the bar's Connectors page and in its / picks
import { execFile, execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { codeStamp, inspect, sandboxProfile, verdictFor } from './rea.mjs';
import { builtInSkills } from './core-pack.mjs';
import { WRITER_MODEL } from './fast-route.mjs';
import { meter, meterFail } from './token-meter.mjs';

export const KINDS = ['cli', 'hub', 'mcp', 'skill', 'repo'];
export const HUB_BIN = fileURLToPath(new URL('../vendor/kingmaker-cli-hub/kingmaker-cli-hub', import.meta.url));
const clip = (v, n) => String(v ?? '').trim().slice(0, n);
const slug = (v) => clip(v, 60).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');

export const connectorsPath = (state) => join(state, 'connectors.json');
/** The owner's own connectors (connectors.json) only. */
export function savedConnectors(state) {
  try { const x = JSON.parse(readFileSync(connectorsPath(state), 'utf8')); return Array.isArray(x.connectors) ? x.connectors.filter((c) => !c.builtIn) : []; } catch { return []; }
}
/** Every connector: Kingmaker's built-in skills (lib/core-pack.mjs: core, then the owner's private ones), then the owner's. */
export function listConnectors(state, { builtIn = builtInSkills } = {}) {
  let core = [];
  try { core = builtIn(state); } catch { /* a broken pack never hides the owner's own connectors */ }
  return [...core, ...savedConnectors(state)];
}
function saveConnectors(state, connectors) {
  connectors = connectors.filter((c) => !c.builtIn); // built-ins come from their folders, never from this file
  mkdirSync(state, { recursive: true });
  const f = connectorsPath(state), tmp = `${f}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ connectors }, null, 1), { mode: 0o600 }); renameSync(tmp, f);
}
/** What the bar shows (no findings' code, which can be long): name, kind, verdict, why. */
export const connectorView = (c) => ({ id: c.id, name: c.name, kind: c.kind, verdict: c.verdict, enabled: c.enabled, sandboxed: c.verdict === 'sandboxed',
  summary: c.summary, target: c.target || c.url || null, source: c.source || null, builtIn: c.builtIn || null, blocked: [...new Set(activeFindings(c).map((f) => f.why))].slice(0, 6), proposal: c.proposal || null,
  findings: (c.findings || []).filter((f) => f.id).slice(0, 20).map((f) => ({ id: f.id, why: f.why, file: f.file, line: f.line, canAllow: f.fix !== null && !f.soft, allowed: isAcked(c, f) })) });

/** An owner's acknowledgement holds only for the code it was given on: any change to that code voids it. */
const isAcked = (c, f) => Boolean(f.id && c.codeSha256 && (c.acks || []).some((a) => a.finding === f.id && a.sha256 === c.codeSha256));
/** The findings still in force: all of REA's, less those the owner acknowledged for this exact code. */
export const activeFindings = (c) => (c?.findings || []).filter((f) => !isAcked(c, f));

/**
 * The owner clears one finding REA got wrong (it named a path to block it, say): the connector's verdict is worked out
 * again without it. Bound to the code's hash, so a later change brings the finding back. Only what the sandbox could
 * take away can be cleared; code that downloads-and-runs or hides what it runs stays rejected (the owner's rule).
 */
export function acknowledgeFinding(state, idOrName, findingId) {
  const all = savedConnectors(state), c = all.find((x) => x.id === idOrName || x.name === idOrName);
  if (!c) return { ok: false, error: 'No connector by that name.' };
  const f = (c.findings || []).find((x) => x.id === findingId);
  if (!f) return { ok: false, error: 'REA has no such finding on it.' };
  if (f.fix === null || f.soft) return { ok: false, error: `${c.name} ${f.why}: that can't be cleared; it stays out.` };
  if (!c.codeSha256) return { ok: false, error: `${c.name} was connected before REA kept its code's fingerprint; reconnect it first.` };
  c.acks = [...(c.acks || []).filter((a) => a.finding !== f.id), { finding: f.id, sha256: c.codeSha256, at: new Date().toISOString() }];
  c.verdict = verdictFor(activeFindings(c)); c.enabled = c.verdict !== 'rejected';
  saveConnectors(state, all);
  return { ok: true, connector: c };
}

/**
 * Before a connector runs: if its code changed since REA read it (a pip or brew upgrade, an edit), REA reads it again and
 * the new verdict holds from this run on; the owner's acknowledgements for the old code fall away. A connector saved
 * before REA kept fingerprints is read once now. Kept in connectors.json when `state` is given. Returns the connector.
 */
export function recheckConnector(c, { state = null, inspectImpl = inspect, stampImpl = codeStamp, home = homedir() } = {}) {
  if (!c || c.builtIn) return c;
  const paths = c.codePaths?.length ? c.codePaths : c.kind === 'cli' && c.target ? [c.target] : [];
  if (!paths.length) return c;
  const opts = { home, prose: Boolean(c.prose) };
  if (c.codeStamp && c.codeSha256 && stampImpl(paths, opts) === c.codeStamp) return c;
  const rea = inspectImpl(paths, opts);
  let next = { ...c, codePaths: paths, codeStamp: rea.stamp ?? null };
  if (!c.codeSha256 || rea.sha256 !== c.codeSha256) {
    next = { ...next, codeSha256: rea.sha256 ?? null, findings: rea.findings.slice(0, 20), notes: rea.notes, acks: (c.acks || []).filter((a) => a.sha256 === rea.sha256),
      summary: c.codeSha256 ? `Its code changed, so REA read it again. ${rea.summary}` : rea.summary };
    next.verdict = verdictFor(activeFindings(next)); next.enabled = next.verdict !== 'rejected';
  }
  if (state) { const all = savedConnectors(state); const i = all.findIndex((x) => x.id === c.id); if (i >= 0) { all[i] = next; saveConnectors(state, all); } }
  return next;
}

/** A command name or path → the real executable, or null. */
export function resolveCommand(cmd, { env = process.env } = {}) {
  const c = clip(cmd, 500).replace(/^~(?=\/|$)/, homedir());
  if (!c) return null;
  const ok = (p) => { try { const r = realpathSync(p); return statSync(r).isFile() && (statSync(r).mode & 0o111) ? p : null; } catch { return null; } };
  if (c.includes('/')) return ok(isAbsolute(c) ? c : resolve(c));
  for (const dir of String(env.PATH || '').split(delimiter).concat(['/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.local/bin')])) { const p = dir && ok(join(dir, c)); if (p) return p; }
  return null;
}

/** Kingmaker's own Python for hub CLIs (never the engine's): made on first use, with the hub's two needs. */
export async function ensureHubPython({ state, run = execFileP, env = connectorEnv({}, process.env) }) {
  const venv = join(state, 'cli-hub', 'venv'), py = join(venv, 'bin', 'python3');
  if (existsSync(py)) return py;
  const base = ['/opt/homebrew/bin/python3.13', '/opt/homebrew/bin/python3.12', '/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3'].find((p) => existsSync(p));
  if (!base) throw new Error('No Python 3 on this Mac for the Kingmaker CLI Hub (install python3 with Homebrew).');
  mkdirSync(dirname(venv), { recursive: true });
  await run(base, ['-m', 'venv', venv], { timeout: 120_000, env });
  await run(py, ['-m', 'pip', 'install', '--quiet', 'click', 'requests'], { timeout: 300_000, env });
  return py;
}
function execFileP(bin, args, opts = {}) {
  return new Promise((ok, fail) => execFile(bin, args, { maxBuffer: 8 * 1024 * 1024, ...opts }, (e, stdout, stderr) => (e ? fail(Object.assign(e, { stdout, stderr })) : ok({ stdout, stderr }))));
}

/**
 * Add one connector. spec: { kind, name?, command? (cli · mcp stdio · repo entry), args?, env? (plain values only), url?
 * (mcp http), path? (skill/repo folder, or an extension bundle's folder), hub? (a Kingmaker CLI Hub name), extension? }.
 * deps: { state, registerMcp?, run?, headers? }. `headers` (an extension's key) go only to the engine's MCP hub, which seals
 * them into the vault; they are never kept in the connector. → { ok, connector } or { ok:false, error }.
 */
export async function addConnector(spec, { state, registerMcp = null, run = execFileP, env = process.env, headers = null } = {}) {
  const kind = KINDS.includes(spec?.kind) ? spec.kind : null;
  if (!kind) return { ok: false, error: `kind is one of ${KINDS.join(', ')}` };
  const all = listConnectors(state);
  let target = null, url = null, source = null, codePaths = [], name = slug(spec.name), help = null;
  if (kind === 'hub') {
    const hub = slug(spec.hub || spec.name);
    if (!hub) return { ok: false, error: 'Say which CLI from the Kingmaker CLI Hub (its name, e.g. gimp).' };
    // The hub's install runs the fetched package's own build/setup code (pip/npm hooks). Give it only SAFE_ENV — never
    // Kingmaker's keys, update token or vault key — and on this Mac run it under the sandbox, so a hostile setup.py
    // can't read credentials, persist itself or raise privileges before REA ever sees the code.
    const home = homedir();
    const safeEnv = connectorEnv({}, env);
    const py = await ensureHubPython({ state, run, env: safeEnv }).catch((e) => ({ error: e.message }));
    if (py?.error) return { ok: false, error: py.error };
    const hubEnv = { ...safeEnv, KINGMAKER_CLI_HUB_PYTHON: py, KINGMAKER_CLI_HUB_HOME: join(state, 'cli-hub') };
    const sandboxed = (bin, a) => process.platform === 'darwin' ? ['/usr/bin/sandbox-exec', ['-p', sandboxProfile([], { home }), bin, ...a]] : [bin, a];
    const info = await run(HUB_BIN, ['info', hub], { env: hubEnv, timeout: 60_000 }).catch((e) => ({ error: e.stderr || e.message }));
    if (info.error) return { ok: false, error: `The Kingmaker CLI Hub has no CLI named ${hub}.` };
    const inst = await run(...sandboxed(HUB_BIN, ['install', hub]), { env: hubEnv, timeout: 15 * 60_000 }).catch((e) => ({ error: String(e.stderr || e.stdout || e.message).slice(-400) }));
    if (inst.error) return { ok: false, error: `Installing ${hub} failed: ${inst.error}` };
    const entry = /Installed .*\(([^)]+)\)|already available \(([^)]+)\)/.exec(inst.stdout || '')?.slice(1).find(Boolean) || `cli-anything-${hub}`;
    target = resolveCommand(join(dirname(py), entry)) || resolveCommand(entry, { env });
    if (!target) return { ok: false, error: `${hub} installed, but its command ${entry} wasn't found.` };
    source = 'Kingmaker CLI Hub'; name ||= hub; codePaths = [target];
  } else if (kind === 'cli') {
    target = resolveCommand(spec.command, { env });
    if (!target) return { ok: false, error: `No program called ${clip(spec.command, 120) || '(nothing)'} on this Mac.` };
    name ||= slug(target.split('/').pop()); codePaths = [target];
  } else if (kind === 'skill' || kind === 'repo') {
    const dir = clip(spec.path, 500).replace(/^~(?=\/|$)/, homedir());
    const skillFile = existsSync(join(dir, 'SKILL.md')) ? join(dir, 'SKILL.md') : /SKILL\.md$/i.test(dir) && existsSync(dir) ? dir : null;
    if (!existsSync(dir)) return { ok: false, error: `No folder at ${clip(spec.path, 200)}.` };
    if (kind === 'skill' && !skillFile) return { ok: false, error: 'A skill is a folder with a SKILL.md in it.' };
    const entry = kind === 'repo' && spec.command ? resolveCommand(isAbsolute(spec.command) ? spec.command : join(dir, spec.command), { env }) : null;
    if (kind === 'repo' && !entry && !skillFile) return { ok: false, error: 'Point at the repo’s program (command, relative to the folder) or a folder with a SKILL.md.' };
    target = entry || skillFile; codePaths = [skillFile ? dirname(skillFile) : dir];
    name ||= slug((skillFile ? dirname(skillFile) : dir).split('/').pop());
  } else { // mcp
    if (spec.url) { url = clip(spec.url, 500); if (!/^https?:\/\//.test(url)) return { ok: false, error: 'An MCP server address starts with https://' }; name ||= slug(new URL(url).hostname); }
    else {
      target = resolveCommand(spec.command, { env }); if (!target) return { ok: false, error: `No program called ${clip(spec.command, 120)} on this Mac.` }; name ||= slug(target.split('/').pop());
      // An extension bundle: REA reads the bundle's own code (its folder), not the runtime that launches it (uv, node).
      codePaths = spec.extension && spec.path && existsSync(spec.path) ? [spec.path] : [target];
    }
  }
  if (!name) return { ok: false, error: 'Give it a name.' };
  if (all.some((c) => c.name === name)) name = `${name}-${all.length + 1}`;
  // REA first, always. A remote MCP server's code isn't on this Mac: it's reached only through the engine's MCP hub.
  const rea = codePaths.length ? inspect(codePaths, { prose: kind === 'skill' }) : { verdict: 'clean', findings: [], notes: ['remote'], summary: 'A remote MCP server: its code isn’t on this Mac; Kingmaker’s MCP hub reaches it.' };
  const c = { id: `cn_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, kind: kind === 'hub' ? 'cli' : kind === 'repo' && !target?.endsWith('SKILL.md') ? 'cli' : kind === 'repo' ? 'skill' : kind,
    name, target, url, source: source || (spec.extension ? `extension ${clip(spec.extension, 40)}` : kind === 'repo' ? 'repo folder' : null), args: Array.isArray(spec.args) ? spec.args.map((a) => clip(a, 300)).slice(0, 20) : [],
    env: spec.env && typeof spec.env === 'object' ? Object.fromEntries(Object.entries(spec.env).slice(0, 20).map(([k, v]) => [clip(k, 60), clip(v, 300)])) : {}, extension: spec.extension ? clip(spec.extension, 40) : null,
    verdict: rea.verdict, summary: rea.summary, findings: rea.findings.slice(0, 20), notes: rea.notes, enabled: rea.verdict !== 'rejected', help, added_at: new Date().toISOString(),
    codePaths, prose: kind === 'skill', codeSha256: rea.sha256 ?? null, codeStamp: rea.stamp ?? null, acks: [] };
  if (c.enabled && c.kind === 'mcp' && registerMcp) {
    // A sandboxed stdio MCP server runs on this Mac: it must launch under the same profile its findings build, or not at
    // all. (A remote MCP has no local code and no target, so there's nothing to sandbox.)
    const profile = c.verdict === 'sandboxed' && c.target ? sandboxProfile(activeFindings(c), { home: homedir() }) : null;
    const r = await registerMcp(c, { headers, sandboxProfile: profile }).catch((e) => ({ ok: false, reason: e.message }));
    c.proposal = r?.proposal ? { id: r.proposal.proposalId, words: r.proposal.challenge || null } : null;
    if (!r?.ok) c.summary = `${c.summary} Kingmaker’s MCP hub didn’t take it yet: ${clip(r?.reason, 160)}`;
  }
  saveConnectors(state, [...all, c]);
  return c.enabled ? { ok: true, connector: c } : { ok: false, connector: c, error: c.summary };
}

export function removeConnector(state, id) {
  const core = listConnectors(state).find((c) => c.builtIn && (c.id === id || c.name === id));
  if (core) return { ok: false, error: `${core.name} is built into Kingmaker${core.builtIn === 'private' ? ' (your private skills folder)' : ''}; it can't be removed here.` };
  const all = savedConnectors(state), left = all.filter((c) => c.id !== id && c.name !== id);
  if (left.length === all.length) return { ok: false };
  saveConnectors(state, left); return { ok: true };
}

/** What a connected CLI may see of Kingmaker's environment: the system's own variables, never its keys and tokens. */
const SAFE_ENV = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'TERM', 'TMPDIR', 'TZ', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'SSL_CERT_FILE']);
/** Pure: a connector's environment: those variables (and LC_*), plus the plain values it was connected with (after
 *  OpenJarvis's subprocess sandbox: a clean CLI runs as itself, but never with Kingmaker's API keys, update token or
 *  vault key, which it would otherwise inherit). */
export function connectorEnv(c, env = process.env) {
  const base = Object.fromEntries(Object.entries(env).filter(([k, v]) => v != null && (SAFE_ENV.has(k) || /^LC_[A-Z]+$/.test(k))));
  return { ...base, ...(c?.env && typeof c.env === 'object' ? c.env : {}) };
}

/** Kill a process, its group, and every descendant by ppid: a setsid() or double-fork leaves the group, so the group
 *  kill alone misses it, but as long as its parent is still up the ppid chain from ps finds it. Never throws. */
function killTree(pid) {
  // Map the descendants from ps BEFORE killing anything: a group kill orphans a setsid child (reparented to launchd),
  // which would break the ppid chain before we could follow it.
  let out = '';
  try { out = execFileSync('/bin/ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8', timeout: 5000 }); } catch { out = ''; }
  const kids = new Map();
  for (const line of out.split('\n')) { const [p, pp] = line.trim().split(/\s+/).map(Number); if (p && pp >= 0) { if (!kids.has(pp)) kids.set(pp, []); kids.get(pp).push(p); } }
  const victims = [], stack = [pid], seen = new Set([pid]);
  while (stack.length) { const cur = stack.pop(); for (const k of kids.get(cur) || []) if (!seen.has(k)) { seen.add(k); victims.push(k); stack.push(k); } }
  try { process.kill(-pid, 'SIGKILL'); } catch { /* no group */ }
  for (const k of [...victims, pid]) { try { process.kill(k, 'SIGKILL'); } catch { /* already gone */ } }
}

/** Run a connected CLI with arguments: as itself when REA found it clean, else under the sandbox REA's findings build.
 *  Its own process group, and on a timeout the whole descendant tree is reaped, not just the first process. */
export function runConnector(c, args = [], { timeoutMs = 120_000, home = homedir(), cwd = home, env = process.env, state = null, recheck = recheckConnector } = {}) {
  if (c?.kind === 'cli' && c.enabled) {
    c = recheck(c, { state, home });
    if (!c.enabled) return Promise.resolve({ ok: false, code: -1, stdout: '', stderr: `REA read ${c.name}'s changed code and rejected it: ${c.summary}` });
  }
  if (!c?.enabled || !c.target || c.kind !== 'cli') return Promise.resolve({ ok: false, code: -1, stdout: '', stderr: 'not a connected CLI' });
  const full = [...(c.args || []), ...args.map((a) => String(a).slice(0, 4000))].slice(0, 60);
  const [bin, argv] = c.verdict === 'sandboxed' ? ['/usr/bin/sandbox-exec', ['-p', sandboxProfile(activeFindings(c), { home }), c.target, ...full]] : [c.target, full];
  return new Promise((done) => {
    const child = spawn(bin, argv, { cwd, env: connectorEnv(c, env), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => { if (out.length < 200_000) out += d; });
    child.stderr.on('data', (d) => { if (err.length < 50_000) err += d; });
    const t = setTimeout(() => { if (child.pid) killTree(child.pid); else child.kill('SIGKILL'); }, timeoutMs);
    child.on('error', (e) => { clearTimeout(t); done({ ok: false, code: -1, stdout: out, stderr: String(e.message) }); });
    child.on('close', (code) => { clearTimeout(t); done({ ok: code === 0, code, stdout: out.slice(0, 40_000), stderr: err.slice(0, 8000) }); });
  });
}

// ── WHAT A MODEL-CHOSEN CLI RUN MAY DO WITHOUT THE OWNER'S WORD. The local model picks the arguments from --help, so a
//    run is either recognisably READ-ONLY (a read verb first, nothing write-like anywhere in the arguments) or it waits for
//    the owner's yes through the same owner-word gate the desk uses (lib/device-desk.mjs). Unknown is not read-only.
const READ_VERBS = new Set(['list', 'ls', 'show', 'get', 'status', 'view', 'read', 'cat', 'describe', 'info', 'version', 'help', 'search', 'find', 'whoami', 'log', 'logs', 'diff', 'inspect', 'doctor', 'check', 'print', 'tree', 'head', 'tail', 'stat', 'count', 'ping', 'history', 'blame', 'which']);
const WRITE_WORDS = /^(?:delete|del|remove|rm|rmdir|unlink|send|post|put|patch|write|create|new|add|update|upgrade|set|push|pull|exec|execute|run|start|stop|restart|kill|install|uninstall|drop|reset|force|overwrite|output|out|apply|deploy|publish|upload|mail|email|sms|text|call|dial|pay|charge|transfer|approve|merge|commit|edit|move|mv|cp|copy|rename|chmod|chown|sudo|eval|sh|bash|zsh|yes|y|clean|prune|truncate|format|erase|wipe|revoke|grant|invite|reply|forward|share|sign|login|logout|auth|import|export|sync|save|store|patch|dispatch|trigger|invoke|enable|disable|cancel|archive|unarchive|restore|rollback|revert|checkout|reboot|shutdown)$/;
/** Pure: 'read' when the arguments are recognisably read-only, else 'write' (can write, delete, send or execute, or unknown). */
export function cliRisk(args) {
  const a = (Array.isArray(args) ? args : []).map((x) => String(x));
  if (a.length === 0) return 'write';
  const words = a.map((x) => x.toLowerCase().replace(/^-+/, '').split('=')[0]);
  if (a.every((x) => /^(?:-h|--help|-v|-V|--version)$/.test(x))) return 'read';
  if (a.some((x) => /[;&|`$<>\n]/.test(x) || /^--?(?:exec|execute|eval|command|cmd|script|output|out|o|write|delete|force|f|yes|y|in-place|i)(?:=|$)/i.test(x))) return 'write';
  const verb = words.find((w, i) => !a[i].startsWith('-'));
  if (!verb || !READ_VERBS.has(verb)) return 'write';
  if (words.some((w, i) => (a[i].startsWith('-') || i > 0) && WRITE_WORDS.test(w))) return 'write';
  return 'read';
}
const SECRET_FLAG = /(?:token|secret|password|passwd|pass|pwd|key|auth|authorization|bearer|cookie|credential|apikey|api-key|signature|session)/i;
const SECRET_SHAPE = /(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{12,}|xox[abprs]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{12,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}|Bearer\s+\S+|[A-Fa-f0-9]{32,}|[A-Za-z0-9+/_-]{40,}={0,2}|\b\d{13,19}\b)/g;
/** Pure: the arguments as they may be logged and read back: secret flag values, secret-shaped tokens and URL credentials masked. */
export function maskArgs(args) {
  const out = []; let maskNext = false;
  for (const raw of Array.isArray(args) ? args : []) {
    let x = String(raw).slice(0, 300);
    if (maskNext) { out.push('***'); maskNext = false; continue; }
    const eq = /^(--?[A-Za-z0-9_.-]+)=([\s\S]*)$/.exec(x);
    if (eq && SECRET_FLAG.test(eq[1])) { out.push(`${eq[1]}=***`); continue; }
    if (/^--?[A-Za-z0-9_.-]+$/.test(x) && SECRET_FLAG.test(x)) { out.push(x); maskNext = true; continue; }
    x = x.replace(/(\w+:\/\/)[^/\s:@]+:[^/\s@]+@/g, '$1***:***@').replace(/([?&][A-Za-z0-9_.-]*(?:token|secret|key|password|auth|sig)[A-Za-z0-9_.-]*=)[^&\s]+/gi, '$1***').replace(SECRET_SHAPE, '***');
    out.push(x);
  }
  return out;
}

async function chat(messages, { model = WRITER_MODEL, json = false, base = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434', fetchImpl = fetch, timeoutMs = 120_000 } = {}) {
  const r = await fetchImpl(`${base.replace(/\/$/, '')}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({ model, stream: false, think: false, keep_alive: '30m', ...(json ? { format: 'json' } : {}), options: { temperature: 0.2 }, messages }) });
  if (!r.ok) { meterFail({ kind: 'connector', model }); throw new Error(`the local model answered ${r.status}`); }
  const j = await r.json(); meter(j, { kind: 'connector', model });
  return String(j?.message?.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

/**
 * One request worked with a connector by the local model. A CLI: it reads the CLI's --help, picks the arguments, runs it
 * (sandboxed if REA said so), and answers from what came out. A skill: the SKILL.md guides its answer. An MCP server goes
 * through the engine's MCP hub instead (→ null here). → { text } or null.
 */
export async function connectorTurn(c, request, { model = WRITER_MODEL, fetchImpl = fetch, run = runConnector, log = () => {}, officeOpts = {}, state = null, recheck = recheckConnector, home = homedir(), confirm = null } = {}) {
  if (!c?.enabled) return { text: `${c?.name || 'That connector'} isn’t connected: ${c?.summary || 'REA rejected it'}` };
  if (c.kind === 'skill') {
    // A skill's SKILL.md is read fresh each turn, so an edit after it connected would otherwise skip REA's gate entirely:
    // re-inspect it (as prose) first and refuse the turn if the new verdict is 'rejected'.
    c = recheck(c, { state, home });
    if (!c.enabled) return { text: `${c.name} changed and REA rejected it: ${c.summary}` };
    const skill = readFileSync(c.target, 'utf8').slice(0, 14_000);
    // A skill Kingmaker renders (frontmatter `kingmaker-renderer: office`): the model answers with a spec and Kingmaker
    // makes the real file (lib/office.mjs), so a small model never has to write file bytes.
    if (/^kingmaker-renderer:\s*office\s*$/m.test(skill.slice(0, 1500))) {
      const reply = await chat([{ role: 'system', content: skill }, { role: 'user', content: request }], { model, fetchImpl, timeoutMs: 240_000 });
      const { parseOfficeSpec, renderOffice } = await import('./office.mjs');
      const spec = parseOfficeSpec(reply);
      if (!spec) return { text: `I couldn't put that into a file. ${reply.replace(/```[\s\S]*?```/g, '').trim().slice(0, 400)}`.trim() };
      const r = await renderOffice(spec, officeOpts).catch((e) => ({ ok: false, error: e.message }));
      log('office_file', { kind: spec.kind, ok: r.ok });
      return r.ok ? { text: `Made ${r.path.split('/').pop()} in ${r.path.slice(0, r.path.lastIndexOf('/'))}.${r.note ? ` ${r.note}` : ''}`, file: r.path }
        : { text: `I couldn't make the file: ${r.error}` };
    }
    return { text: await chat([{ role: 'system', content: `Follow this skill to do the owner's request. You only write text; say what to run if something must be run.\n\n${skill}` }, { role: 'user', content: request }], { model, fetchImpl }) };
  }
  if (c.kind !== 'cli') return null;
  const h = c.help ? null : await run(c, ['--help'], { timeoutMs: 20_000, state });
  const help = c.help || `${h.stdout}\n${h.stdout.trim() ? '' : h.stderr}`.trim().slice(0, 8000); // BSD tools print usage to stderr
  const plan = await chat([{ role: 'system', content: 'You drive one command-line program for the owner. From its --help and the request, answer ONLY JSON: {"args":["..."]} (the arguments to run, without the program name) or {"answer":"..."} when it cannot do this.' },
    { role: 'user', content: `Program: ${c.name}\n--help:\n${help}\n\nRequest: ${request}` }], { model, json: true, fetchImpl, timeoutMs: 60_000 });
  let p = null; try { p = JSON.parse(plan); } catch { /* below */ }
  if (!Array.isArray(p?.args)) return { text: String(p?.answer || `I couldn't work out how to use ${c.name} for that.`) };
  // Read-only arguments run at once. Anything that can write, delete, send or execute waits for the owner's yes (`confirm`,
  // wired to the desk's owner-word gate); with no gate wired it is not run at all. The log carries the command and its
  // arguments, secrets masked, never just a count.
  const shownArgs = maskArgs(p.args), risk = cliRisk(p.args);
  log('connector_run', { name: c.name, sandboxed: c.verdict === 'sandboxed', args: shownArgs, risk, gated: risk !== 'read' });
  const go = async () => {
    const r = await run(c, p.args.map(String), { state });
    // The program's real output is shown under one sentence from the model: a small model retelling details gets them wrong.
    const said = await chat([{ role: 'system', content: 'In ONE short sentence, tell the owner what the program did (or why it failed). Do not restate the output\'s details: the output itself is shown right under your sentence.' },
      { role: 'user', content: `Request: ${request}\nRan: ${c.name} ${shownArgs.join(' ')}\nExit code: ${r.code}\nOutput:\n${r.stdout.slice(0, 12_000)}\n${r.stderr ? `Errors:\n${r.stderr.slice(0, 3000)}` : ''}` }], { model, fetchImpl });
    const shown = (r.stdout.trim() || r.stderr.trim()).slice(0, 3000);
    log('connector_done', { name: c.name, args: shownArgs, code: r.code });
    return { text: shown ? `${said}\n\n${shown}` : said, ran: [c.name, ...shownArgs], code: r.code };
  };
  if (risk === 'read') return go();
  const readBack = `${c.name} would run: ${c.name} ${shownArgs.join(' ')}\nThat can change things (write, delete, send or run something). Type yes at the Kingmaker console or the bar to run it, or no to leave it.`;
  if (typeof confirm !== 'function') { log('connector_held', { name: c.name, args: shownArgs, why: 'no approval gate' }); return { text: `I did not run ${c.name}: ${shownArgs.join(' ')}. That can change things and needs your yes, which is not available here.`, held: true }; }
  log('connector_held', { name: c.name, args: shownArgs, why: 'waiting for the owner' });
  confirm({ name: c.name, args: shownArgs, run: go });
  return { text: readBack, held: true, awaiting: true };
}
