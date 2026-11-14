// lib/local-task.mjs — the LOCAL TASK LANE (4.4.5 chat-route fix, 2026-11-09).
// A typed turn that names a real local file or folder (an absolute or ~ path that exists on this Mac), or asks for
// file/tool work (unzip, run python3 x.py, render, an attached .zip, "pilot one scored attempt"), is local work: it is
// done here, on this Mac, by the hunter's model choosing one command at a time from what the last command returned.
// It is never sent to research or the web, and a bare path never opens a browser search.
// Guard rails (general, not task-specific): commands run without a shell, inside the task's own working folder, from a
// short allowlist; python runs only .py files that already exist in that folder (no -c, no new scripts: the model
// decides each step itself, it cannot write an autopilot); every step and its output are logged to the folder's
// kingmaker-task.log. This command allowlist is not a sandbox for the scripts themselves.
import { existsSync, statSync, readFileSync, readdirSync, mkdirSync, appendFileSync, realpathSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { basename, dirname, join, resolve, relative, isAbsolute, extname } from 'node:path';
import { homedir } from 'node:os';
import { conduct } from './state-conductor.mjs';

const PATH_RE = /(?:^|[\s"'`(])((?:~|\/(?:Users|Volumes|tmp|var|private|opt))\/[^\s"'`)]+)/g;
// A language name or a filename inside a coding question is not an instruction
// to execute an existing local file. Pathless requests need an explicit file action.
const PATHLESS_FILE_TASK = /^(?:please\s+)?(?:unzip\b|untar\b|gunzip\b|(?:run|execute)\s+(?:the\s+|this\s+)?(?:attached\b|python3?\b|[\w.-]+\.(?:py|mjs|cjs|js)\b)|pilot\s+one\b|(?:work\s+on|open|inspect|verify|render|extract)\s+(?:the\s+|this\s+|my\s+)?(?:attached|attachment|archive)\b)/i;
const BIN = { python3: ['/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3'], python: ['/opt/homebrew/bin/python3', '/usr/bin/python3'],
  node: ['/opt/homebrew/bin/node', '/usr/local/bin/node', process.execPath],
  ls: ['/bin/ls'], cat: ['/bin/cat'], head: ['/usr/bin/head'], tail: ['/usr/bin/tail'], wc: ['/usr/bin/wc'], find: ['/usr/bin/find'],
  unzip: ['/usr/bin/unzip'], mkdir: ['/bin/mkdir'], ffprobe: ['/opt/homebrew/bin/ffprobe', '/usr/local/bin/ffprobe'] };
const PRIVATE = /(?:\.env\b|keychain|id_rsa|\.ssh|token|secret|password|credential)/i;

const expand = (p) => (p.startsWith('~/') ? join(homedir(), p.slice(2)) : p).replace(/[.,;:!?]+$/, '');
/** The real local paths a message names. */
export function localPaths(text) {
  const out = []; for (const m of String(text || '').matchAll(PATH_RE)) { const p = expand(m[1]); if (existsSync(p) && !out.includes(p)) out.push(p); }
  return out;
}
/** Is this turn local file/tool work? {paths, bare} or null. */
export function localTaskIntent(text) {
  const t = String(text || '').trim(); if (!t) return null;
  const paths = localPaths(t);
  const rest = paths.reduce((s, p) => s.split(p).join(' '), t).replace(/~\/\S+/g, ' ').trim();
  if (paths.length) return { paths, bare: rest.length === 0 };
  return PATHLESS_FILE_TASK.test(t) ? { paths: [], bare: false } : null;
}
/** Split a command line into argv (quotes honoured, no shell). */
export function argv(line) {
  const out = []; let cur = '', q = null, any = false;
  for (const ch of String(line)) {
    if (q) { if (ch === q) q = null; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { q = ch; any = true; continue; }
    if (/\s/.test(ch)) { if (cur || any) out.push(cur); cur = ''; any = false; continue; }
    cur += ch;
  }
  if (cur || any) out.push(cur);
  return out;
}
const inside = (root, p) => { const r = relative(root, resolve(root, p)); return !r.startsWith('..') && !isAbsolute(r); };
/** Check one proposed command; returns {file, args} or {error}. */
export function checkCommand(line, cwd) {
  if (/[|;&><`$]/.test(line.replace(/"[^"]*"|'[^']*'/g, ''))) return { error: 'no shell operators (| ; & > < ` $): one plain command' };
  return checkArgv(argv(line), cwd);
}
function checkArgv(words, cwd) {
  if (!Array.isArray(words) || words.some((w) => typeof w !== 'string')) return { error: 'invalid command arguments' };
  const [cmd0, ...args] = words; const cmd = basename(cmd0 || '');
  const bins = BIN[cmd]; if (!bins) return { error: `${cmd || '(empty)'} is not an allowed command (${Object.keys(BIN).join(', ')})` };
  const file = bins.find((b) => existsSync(b)); if (!file) return { error: `${cmd} is not installed` };
  for (const a of args) if (!a.startsWith('-') && (a.includes('/') || a.includes('..')) && !inside(cwd, a)) return { error: `${a} is outside the task folder` };
  if (args.some((a) => PRIVATE.test(a))) return { error: 'private files are off limits' };
  if (cmd.startsWith('python')) {
    if (args.some((a) => a === '-c' || a === '-m' || a === '-')) return { error: 'python runs only an existing .py file in the task folder' };
    const script = args.find((a) => !a.startsWith('-'));
    if (!script || extname(script) !== '.py' || !existsSync(resolve(cwd, script))) return { error: 'python runs only an existing .py file in the task folder' };
  }
  if (cmd === 'node' && (!args[0] || !/\.(?:mjs|cjs|js)$/.test(args[0]) || !existsSync(resolve(cwd, args[0])))) return { error: 'node runs only an existing script in the task folder' };
  return { file, args };
}
const run = (file, args, cwd, timeoutMs = 180_000) => new Promise((done) => {
  execFile(file, args, { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env: { PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin', HOME: homedir(), LANG: 'en_US.UTF-8', ELECTRON_RUN_AS_NODE: '1' } },
    (error, stdout, stderr) => done({ code: error ? (error.code ?? 1) : 0, out: `${stdout || ''}${stderr ? `\n${stderr}` : ''}`.trim() }));
});
const listing = (dir, depth = 2, pre = '') => {
  if (depth < 0) return []; let rows = [];
  for (const n of readdirSync(dir).filter((n) => !n.startsWith('.') && n !== '__MACOSX').slice(0, 40)) {
    const p = join(dir, n); const d = statSync(p).isDirectory(); rows.push(`${pre}${n}${d ? '/' : ''}`);
    if (d) rows = rows.concat(listing(p, depth - 1, `${pre}${n}/`));
  }
  return rows;
};
/** Prepare the task folder: unpack archives into a fresh folder, else work in the named folder (or the file's folder). */
export async function prepare(paths, { workRoot }) {
  const notes = [];
  for (const p of paths) {
    if (/\.zip$/i.test(p) && statSync(p).isFile()) {
      const dir = join(workRoot, `${basename(p).replace(/\.zip$/i, '')}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
      mkdirSync(dir, { recursive: true });
      const r = await run('/usr/bin/unzip', ['-q', p, '-d', dir], dir);
      notes.push(r.code === 0 ? `Unpacked ${basename(p)} into ${dir}` : `Could not unpack ${basename(p)}: ${r.out.slice(0, 200)}`);
      if (r.code === 0) return { cwd: dir, notes };
    }
  }
  const p = paths[0]; if (!p) return { cwd: null, notes };
  return { cwd: statSync(p).isDirectory() ? p : dirname(p), notes };
}
/** Find the instruction file the message names (a relative .md/.txt path), else a *PROMPT*.md / README.md. */
export function instructionFile(text, cwd) {
  const all = listing(cwd, 3).filter((r) => !r.endsWith('/'));
  for (const m of String(text).matchAll(/([\w./-]+\.(?:md|txt))\b/gi)) { const hit = all.find((r) => r.toLowerCase().endsWith(m[1].toLowerCase())); if (hit) return hit; }
  return all.find((r) => /prompt[^/]*\.md$/i.test(r)) || all.find((r) => /readme\.md$/i.test(r)) || null;
}
const ACTION = /^\s*(RUN|SAY|DONE)\s*:\s*(.+)$/im;
/**
 * Run a local task. deps: { complete(prompt) -> text, say(line), show(line), log(event, data) }.
 * Returns { ok, cwd, steps, summary }.
 */
export async function runLocalTask(text, intent, { complete, say, show = say, log = () => {}, workRoot, maxSteps = 80, deliver = null, conductTask = conduct }) {
  const startedMs = Date.now();
  const { cwd, notes } = await prepare(intent.paths, { workRoot });
  if (!cwd) { await say('That needs a file on this Mac: give me its full path (or drop it in) and I will work on it here.'); return { ok: false }; }
  const trace = join(cwd, 'kingmaker-task.log');
  const note = (s) => { try { appendFileSync(trace, `${new Date().toISOString()} ${s}\n`); } catch { /* the trace never breaks the turn */ } };
  note(`TASK ${text}`); for (const n of notes) { note(n); await show(n); }
  const files = listing(cwd, 3);
  if (intent.bare) { await say(`That's a local ${statSync(intent.paths[0]).isDirectory() ? 'folder' : 'file'}: ${intent.paths[0]}. ${notes.join(' ')} It holds: ${files.slice(0, 25).join(', ')}. Tell me what to do with it and I'll do it here, on this Mac.`); return { ok: true, cwd, steps: 0, at: Date.now() }; }
  // Work from the folder that holds the instruction file (the kit's own commands are relative to it).
  const instr = instructionFile(text, cwd);
  const base = instr && dirname(instr) !== '.' ? join(cwd, dirname(instr)) : cwd;
  const fullGuide = instr ? readFileSync(join(cwd, instr), 'utf8') : '';
  const guide = fullGuide.slice(0, 6000);
  const head = [
    'You are Kingmaker doing a local task on this Mac. You act by running one command at a time and reading what it returns.',
    `Task from the owner: ${text}`,
    `Working folder (every relative path is from here): ${base}`,
    notes.length ? `Already done: ${notes.join('; ')}. Do not unpack it again.` : '',
    `Files: ${listing(base, 2).slice(0, 40).join(', ')}`,
    guide ? `Instructions file ${instr}:\n${guide}` : '',
    `Allowed commands: ${Object.keys(BIN).join(', ')}. No shell operators. python runs only existing .py files. You cannot write files or scripts.`,
    'Reply with EXACTLY ONE line, one of:',
    '  RUN: <one command>      (it runs now; its output comes back to you)',
    '  SAY: <message to the owner>   (e.g. your strategy and expected score before starting)',
    '  DONE: <final report: what happened, real numbers only from command output, paths of outputs>',
    'Decide each step from the latest output. Never invent results. If something is blocked, say DONE with the blocker.',
  ].filter(Boolean).join('\n');
  const history = []; let steps = 0, bad = 0, summary = null, rejects = 0, ok = false, lastRunOk = false;
  // The completion goal for an open task: the output files the request or its instructions name (--out x, x.mp4 …).
  const expected = [...new Set([...`${text}\n${fullGuide}`.matchAll(/--out(?:put)?\s+([\w./-]+\.\w{2,4})/g)].map((m) => m[1]))];
  await show(`Working on it here, in ${base}.`);
  // A tool the docs drive step by step (start → act on each returned state → over) is conducted deterministically
  // (lib/state-conductor.mjs): commands from the docs, each action from method math on the latest state.
  const readme = listing(base, 1).find((r) => /^readme\.md$/i.test(r));
  const docs = [fullGuide, readme && join(base, readme) !== join(cwd, instr || '') ? readFileSync(join(base, readme), 'utf8') : ''].filter(Boolean);
  // Both documents reach the conductor together, so a README restriction cannot be lost after an early match.
  const conducted = docs.length ? await conductTask({ docs: docs.join('\n'), cwd: base, task: text, show, note, complete, maxSteps, methodDirs: [new URL('../catalog/methods/', import.meta.url).pathname, join(dirname(workRoot), 'methods')] }).catch((e) => ({ ok: false, steps: 0, why: String(e?.message || e) })) : null;
  if (conducted) {
    const st = conducted.state || {};
    const facts = Object.entries(st).filter(([, v]) => v === null || typeof v !== 'object').map(([k, v]) => `${k}: ${typeof v === 'number' ? Math.round(v * 1000) / 1000 : v}`).join(', ');
    const pr = conducted.practice || {};
    const disclose = pr.attempts ? `\nPractice: I made ${pr.attempts} practice attempts on a scratch copy of the folder (not the real one) to tune the method ${pr.from}${pr.saved ? `; the tuned method is saved as ${pr.saved}` : ''}. The result below is the one final run in the real folder.` : '';
    const goalLine = conducted.goal ? ` Goal (${conducted.goal.text}): ${conducted.met ? 'met' : 'NOT met'}${pr.attempts && !pr.met ? ' — practice ran out of budget before meeting it, so this is the best I found' : ''}.` : '';
    const missing = expected.filter((o) => !existsSync(resolve(base, o)));
    const failedOutputs = (conducted.outputs || []).filter((o) => o.code !== 0);
    ok = conducted.ok === true && (!conducted.goal || conducted.met === true) && !failedOutputs.length && !missing.length;
    const why = conducted.why || (conducted.goal && !conducted.met ? 'the completion goal was not met' : failedOutputs.length ? 'an output or verification command failed' : missing.length ? `requested outputs are missing: ${missing.join(', ')}` : 'the tool did not complete');
    summary = `${ok ? 'Completed' : `I couldn't finish: ${why}`}: ${conducted.steps} steps, each decided by ${conducted.method ? `the method ${conducted.method.name}` : 'the local model'} from the latest state.${goalLine}${disclose}\nFinal state: ${facts}.${(conducted.outputs || []).map((o) => `\n• ${o.cmd} → exit ${o.code}${o.out ? `: ${o.out.split('\n').slice(-6).join(' ').slice(0, 400)}` : ''}`).join('')}`;
    steps = conducted.steps;
  }
  while (!summary && steps < maxSteps) {
    const recent = history.slice(-8).map((h) => `> ${h.act}\n${h.out}`).join('\n');
    // After a message the next line is a command: the reply is pre-filled with RUN: so a small model can't talk in circles.
    const mustRun = history.at(-1)?.act?.startsWith('SAY:') || history.filter((h) => h.act.startsWith('SAY:')).length >= 2;
    const prompt = `${head}\n\nSteps so far (${history.length}, latest last):\n${recent || '(none yet)'}\n\nYour next line:${mustRun ? '\nRUN:' : ''}`;
    let reply = String(await complete(prompt) || '').trim();
    if (mustRun && !ACTION.test(reply.split('\n')[0])) reply = `RUN: ${reply.split('\n').find((l) => l.trim()) || ''}`.replace(/^RUN:\s*RUN:/i, 'RUN:');
    const m = reply.match(ACTION);
    if (!m) { if (++bad >= 3) { summary = `I stopped: the model did not give a usable next step (${reply.slice(0, 160)}).`; break; } history.push({ act: reply.slice(0, 200), out: 'INVALID: reply with one line starting RUN:, SAY: or DONE:' }); continue; }
    bad = 0; const kind = m[1].toUpperCase(), body = m[2].trim();
    if (history.length >= 2 && history.slice(-2).every((h) => h.act === `${kind}: ${body}`)) { summary = `I stopped: the same step (${kind}: ${body.slice(0, 120)}) came back three times without progress.`; break; }
    if (kind === 'DONE') {
      const missing = expected.filter((o) => !existsSync(resolve(base, o)));
      if (missing.length && rejects < 3) { rejects += 1; history.push({ act: `DONE: ${body.slice(0, 120)}`, out: `NOT DONE: these outputs the task asks for do not exist yet: ${missing.join(', ')}. Keep going.` }); continue; }
      ok = !missing.length && lastRunOk;
      summary = missing.length ? `I couldn't finish: still missing ${missing.join(', ')} after ${steps} commands.\n${body}` : !lastRunOk ? `Completion is unverified: no successful final command was recorded.\n${body}` : body; note(`DONE ${body}`); break;
    }
    if (kind === 'SAY') {
      steps += 1; // a message is a step too, so talking can never loop forever
      if (history.at(-1)?.act?.startsWith('SAY:')) { history.push({ act: `SAY: ${body.slice(0, 80)}`, out: 'ALREADY SAID: do the work now. Reply RUN: <command> (or DONE: if blocked).' }); continue; }
      note(`SAY ${body}`); await show(body); history.push({ act: `SAY: ${body}`, out: '(shown to the owner) Next: RUN: the first command.' }); continue;
    }
    steps += 1;
    const c = checkCommand(body, base);
    lastRunOk = false;
    if (c.error) { note(`REFUSED ${body} :: ${c.error}`); history.push({ act: `RUN: ${body}`, out: `REFUSED: ${c.error}` }); continue; }
    const r = await run(c.file, c.args, base);
    lastRunOk = r.code === 0;
    note(`RUN ${body}\n${r.out.slice(0, 4000)}\n(exit ${r.code})`);
    log('local_task_step', { step: steps, cmd: basename(c.file), exit: r.code });
    history.push({ act: `RUN: ${body}`, out: `${r.out.slice(-2500)}\n(exit ${r.code})` });
    await show(`Step ${steps}: ${body.slice(0, 160)} (exit ${r.code})`);
  }
  if (!summary) summary = `I stopped after ${steps} commands without a final report.`;
  // The files this task made (videos, pictures, documents) go back to the owner as files, not just paths.
  const made = [];
  const walk = (d, depth = 0) => { if (depth > 4) return; for (const n of readdirSync(d)) { const p = join(d, n); const st = statSync(p); if (st.isDirectory()) walk(p, depth + 1); else if (st.mtimeMs >= startedMs && /\.(mp4|mov|m4v|gif|png|jpe?g|pdf|csv)$/i.test(n)) made.push(p); } };
  try { walk(base); } catch { /* listing only */ }
  if (made.length && deliver) { try { const given = await deliver(made, base); if (given?.length) summary += `\n\nFiles: ${given.join(', ')}`; } catch (e) { note(`DELIVER failed ${e?.message || e}`); } }
  await say(`${summary}\n\nEverything I ran is in ${trace}.`);
  return { ok, cwd: base, steps, summary, trace, made, tool: conducted?.tool || null, at: Date.now() };
}
/**
 * The bar (app/Kingmaker.swift) reads a leading "/word" as a /Program tag and sends it as a program to drive, with "_"
 * turned into spaces; a pasted absolute path ("/Users/me/Desktop/kit.zip …") arrived as the program
 * "Users/me/Desktop/kit.zip" and the turn was sent off to research/the web "using" it. A program name never holds a "/":
 * such a tag is a path, and it goes back into the owner's words. → { paths, programs }.
 */
export function reclaimProgramPaths(programs) {
  const paths = [], kept = [];
  for (const raw of Array.isArray(programs) ? programs : []) {
    const p = String(raw || '').trim(); if (!p) continue;
    if (!p.includes('/')) { kept.push(p); continue; }
    const tries = [`/${p}`, `/${p.replaceAll(' ', '_')}`];
    paths.push(tries.find((c) => existsSync(c)) || tries[0]);
  }
  return { paths, programs: kept };
}

const FOLLOW_AGE = 60 * 60_000;
const FOLLOW_OBJECT = '(?:(?:the|my|our|this|that|last|final|saved|previous)\\s+)*(?:it|them|score|results?|replay|videos?|race|run|task|files?|folder|outputs?|log|status)';
const FOLLOW_CLAUSE = new RegExp(`^(?:(?:verify|check|validate|replay|play|watch|show|open)(?:\\s+me)?(?:\\s+${FOLLOW_OBJECT})?|${FOLLOW_OBJECT}|(?:what(?: was| is|\\'s)|how did)\\s+(?:${FOLLOW_OBJECT})(?:\\s+(?:go|do))?)(?:\\s+again)?$`, 'i');
/** A short follow-up about the last local task (no path of its own) stays with that task's folder. */
export function isLocalFollowUp(text, last, now = Date.now()) {
  const age = now - (last?.at || 0);
  const t = String(text || '').trim().replace(/[?.!]+$/, '').replace(/^(?:please\s+|(?:can|could|would) you\s+)/i, '').replace(/^please\s+/i, '');
  return Boolean(last?.cwd && Number.isFinite(age) && age >= 0 && age < FOLLOW_AGE && t.length && t.length < 300 && !localPaths(t).length && t.split(/\s+(?:and|then)\s+|\s*,\s*/i).every((part) => FOLLOW_CLAUSE.test(part)));
}
/** Conversation-local memory; the bar's default conversation cannot collide with a named conversation. */
export function createLocalTaskContexts({ now = Date.now, limit = 128 } = {}) {
  const entries = new Map(), defaultConversation = Symbol('bar');
  const key = (id) => typeof id === 'string' && id.trim() ? id.trim() : defaultConversation;
  const get = (id) => {
    const k = key(id), last = entries.get(k), age = now() - (last?.at || 0);
    if (!last?.cwd || age < 0 || age >= FOLLOW_AGE) { entries.delete(k); return null; }
    return last;
  };
  return {
    get,
    set(id, task) {
      const k = key(id); entries.delete(k);
      if (task?.cwd) entries.set(k, task);
      while (entries.size > limit) entries.delete(entries.keys().next().value);
    },
    clear: (id) => entries.delete(key(id)),
  };
}
const openVideo = (file) => new Promise((done) => execFile('/usr/bin/open', [file], (error) => done({ code: error ? (error.code || 1) : 0, out: error?.message || '' })));
/** Read/check the saved run and replay its artifact. Never init, step, render or retry the task. */
export async function runFollowUp(text, last, { say, deliver = null, execute = run, openFile = openVideo }) {
  if (!last?.cwd || !existsSync(last.cwd)) { await say('The last local task folder is no longer available. I cannot verify or replay it.'); return { ok: false, checks: [], made: [] }; }
  const lines = [], results = []; let ok = true;
  const wantsCheck = /\b(?:verify|check|validate|score|results?|status|how did)\b/i.test(text);
  const wantsVideo = /\b(?:replay|play|watch|videos?)\b/i.test(text);
  const checks = (last.tool?.after || []).filter((w) => Array.isArray(w) && /^(?:verify|check|validate|score|result|status)$/i.test(w[2] || ''));
  if (wantsCheck) {
    for (const w of checks) {
      const c = checkArgv(w, last.cwd);
      if (c.error) { ok = false; lines.push(`Could not verify: ${c.error}.`); continue; }
      const r = await execute(c.file, c.args, last.cwd); results.push({ cmd: w, ...r });
      if (r.code !== 0) ok = false;
      lines.push(`${w.slice(1).join(' ')} → exit ${r.code}\n${r.out.slice(-2500)}`);
    }
    if (!checks.length) { ok = false; lines.push('No saved verification command is available; the previous result has not been re-verified.'); }
  }
  const made = (last.made || []).filter((p) => {
    try { return inside(realpathSync(last.cwd), realpathSync(p)) && statSync(p).isFile(); } catch { return false; }
  });
  if (made.length && deliver) {
    try { await deliver(made, last.cwd); } catch (e) { ok = false; lines.push(`Could not deliver the saved files: ${e.message}.`); }
  }
  const video = made.find((p) => /\.(mp4|mov|m4v)$/i.test(p) && !/4x/i.test(p)) || made.find((p) => /\.(mp4|mov|m4v)$/i.test(p));
  if (wantsVideo) {
    if (video) { const r = await openFile(video); if (r?.code === 0) lines.push(`Playing ${video}.`); else { ok = false; lines.push(`Could not open ${video}: ${r?.out || 'the player failed'}.`); } }
    else { ok = false; lines.push('The saved video is missing; I have not rerun the task to replace it.'); }
  } else if (!made.length && /\b(?:files?|outputs?)\b/i.test(text)) { ok = false; lines.push('No saved output files are available.'); }
  await say([`From the last task (${last.cwd}):`, ...lines, made.length ? `Files: ${made.join(', ')}` : '', last.summary ? `Recorded result: ${last.summary}` : ''].filter(Boolean).join('\n\n'));
  return { ok, checks: results, made };
}
