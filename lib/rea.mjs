// lib/rea.mjs — REA, Reverse Engineer Anything: before Kingmaker uses a connector (a CLI, an MCP server, a skill, a repo
// folder), it reads that connector's code and finds what it would do UNPROMPTED: phone home, read credentials, install
// itself to run at login, raise privileges, run code fetched or hidden at runtime. The owner's rule (2026-10-15): connected
// tools have free rein, except code that seeks access unprompted. That code gets this treatment and its bad parts are
// rejected:
//   clean      nothing found: it runs as itself.
//   sandboxed  bad parts the sandbox can take away (telemetry, credential reads, login persistence, privilege): it runs
//              under macOS's sandbox with exactly those denied (sandboxProfile), and the rest works.
//   rejected   code that fetches-and-runs or hides what it runs (curl | sh, eval of base64…): it isn't connected at all.
// Every finding names the file and line, and has an id (rule:file:line). The rules are data (lib/rea-rules.mjs): a path
// named in a deny list or a rule's own source is a mention, not an act. Every inspection carries a hash of the code, so a
// connector is read again when its code changes and an owner's acknowledgement of a finding holds only for that code
// (lib/connectors.mjs). Pure scanning: REA never runs what it inspects.
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, relative } from 'node:path';
import { DECODE, DOC_PATH, DYNEXEC, DYNEXEC_BARE, FETCH, INSTRUCTION_NOTES, INSTRUCTION_RULES, NOTES, REGEX_SOURCE, RULES } from './rea-rules.mjs';

export { INSTRUCTION_RULES, RULES };

const MAX_FILES = 4000, MAX_FILE_BYTES = 1_500_000, MAX_TOTAL_BYTES = 60_000_000;
// Every folder of a program is read (2026-10-15, after QwenPaw's skip_in_docs: skipping docs/, tests/, examples/, dist/
// and build/ let a payload the package imports from there go unread). In docs and tests only the reject rules still
// count (lib/rea-rules.mjs DOC_PATH); the rest are notes there. Only tooling caches and installed dependencies stay out.
const SKIP_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv', '.next', 'coverage']);
// A skill's folders are all read (2026-10-15, REA pointed at itself: a skill's SKILL.md sent the model to run the
// examples/*.py that REA had skipped). Only tooling caches stay out.
const SKILL_SKIP_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv']);
const TEXT_EXT = new Set(['', '.py', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.sh', '.bash', '.zsh', '.rb', '.pl', '.php', '.go', '.rs', '.swift', '.json', '.toml', '.cfg', '.ini', '.yaml', '.yml', '.md', '.ps1', '.lua', '.applescript', '.scpt', '.plist']);

const LONG_BLOB = /["'`][A-Za-z0-9+/=]{800,}["'`]/;
// A line that runs something (so a curl | sh or sudo in it is done, not just printed as advice).
const RUNS = /\b(subprocess\.|os\.system|os\.popen|Popen|execSync|execFileSync|exec\(|execFile|spawn|child_process|eval\(|system\(|shell=True|\$\(|`)/;
const PRINTS = /^\s*(echo|printf|print\(|click\.echo|console\.(log|error)|logger\.|log\(|raise\b|throw\b)|^\s*["'f]/;
const PROSE = new Set(['.md', '.txt', '.rst', '']);
const isShell = (file, text) => /\.(sh|bash|zsh)$/.test(file) || /^#!.*\b(ba|z)?sh\b/.test(text.slice(0, 80));

function* walk(root, budget, skip = SKIP_DIRS) {
  const st = lstatSync(root);
  if (st.isFile()) { yield root; return; }
  if (!st.isDirectory()) return;
  const stack = [root];
  while (stack.length && budget.files < MAX_FILES) {
    const dir = stack.pop();
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { if (!skip.has(e.name) && !e.name.endsWith('.dist-info')) stack.push(p); }
      else if (e.isFile()) { budget.files += 1; yield p; if (budget.files >= MAX_FILES) return; }
    }
  }
}

/** Pure: whether one rule fires on one line, and how: 'finding', 'note' (named but not done), or null. */
function ruleOn(r, line, { prose = false, compiled = false } = {}) {
  if (!r.patterns.some((re) => re.test(line))) return null;
  const code = line.replace(/\s(\/\/|#)\s.*$/, '');   // a trailing comment can't make an act look like a deny list
  if (r.access?.test(code)) return 'finding';
  if (r.quiet?.some((re) => re.test(code))) return null;
  // A compiled program's strings and a skill's words have no calls to anchor on: the path itself counts there.
  if (r.requires && !prose && !compiled && !r.requires.some((re) => re.test(code))) return 'note';
  return 'finding';
}

/** Pure: findings in one file's text. Comments, docstrings and prose are not code; advice a program prints ("install uv
 *  with curl … | sh") is not something it does. `prose: true` reads instructions too (a skill's SKILL.md tells a model
 *  what to do, so there the words are the code). Each finding's id is `${rule}:${file}:${line}`. */
export function scanText(text, file = '', { prose = false, compiled = false } = {}) {
  const findings = [], notes = new Set(), seen = new Set();
  const src = String(text), lines = src.split(/\r?\n/), py = /\.py$/.test(file), shell = isShell(file, src);
  if (!prose && PROSE.has(extname(file).toLowerCase()) && !shell && !/^#!/.test(src)) return { findings, notes: [] };
  // File-level taint runs only over real code (not a skill's prose .md, where a fenced snippet isn't executed).
  const codeFile = shell || !PROSE.has(extname(file).toLowerCase());
  let decodeAt = null, fetchAt = null, dynexecAt = null, bareAt = null;
  const inDocs = !prose && DOC_PATH.test(file);
  const add = (r, i, t, extra = {}) => {
    const id = `${r.id}:${file}:${i + 1}`;
    if (!seen.has(id)) { seen.add(id); findings.push({ id, rule: r.id, kind: r.kind, why: r.why, fix: r.fix, file, line: i + 1, code: t.slice(0, 200), ...extra }); }
  };
  let inDoc = false;
  lines.forEach((line, i) => {
    if (line.length > 4000) line = line.slice(0, 4000);
    const t = line.trim();
    if (py) { const q = (t.match(/"""|'''/g) || []).length; if (inDoc || (q && /^(r|u|b)?("""|''')/.test(t))) { if (q % 2 === 1) inDoc = !inDoc; return; } }
    if (!prose && (/^(#|\/\/|\/\*|\*|--|;)/.test(t) && !/^#!/.test(t))) return;
    if (codeFile && !REGEX_SOURCE.test(line)) {   // remember the first decode/fetch/exec anywhere: the reject gates don't
      if (!decodeAt && DECODE.test(line)) decodeAt = { i, t };   // need them on one line (a rule's own regex source never counts)
      if (!fetchAt && FETCH.test(line)) fetchAt = { i, t };
      if (!dynexecAt && DYNEXEC.test(line)) dynexecAt = { i, t };
      if (!bareAt && DYNEXEC_BARE.test(line)) bareAt = { i, t };
    }
    for (const r of RULES) {
      const how = ruleOn(r, line, { prose, compiled });
      if (!how) continue;
      if (how === 'note') { notes.add(r.note || `mentions_${r.kind}`); continue; }
      // Downloading-and-running and sudo only count where the line runs it (or in a shell script that isn't echoing it).
      if (r.runs && !prose && !(shell ? !PRINTS.test(t) : RUNS.test(line) && !PRINTS.test(t))) { notes.add('mentions_install_scripts'); continue; }
      // A program's docs, tests and examples aren't what it runs: there only what the sandbox can't take away counts.
      if (inDocs && r.docs) { notes.add(`${r.kind}_in_docs_or_tests`); continue; }
      add(r, i, t);
    }
    for (const n of NOTES) if (n.re.test(line)) notes.add(n.kind);
    if (prose && PROSE.has(extname(file).toLowerCase())) {
      for (const r of INSTRUCTION_RULES) if (r.patterns.some((re) => re.test(line))) add(r, i, t);
      for (const n of INSTRUCTION_NOTES) if (n.re.test(line)) notes.add(n.kind);
    }
    if (LONG_BLOB.test(line)) add({ id: 'hidden_code.blob', kind: 'hidden_code', why: 'carries a large encoded blob', fix: null }, i, `${t.slice(0, 80)}…`, { soft: true });
  });
  // The reject gates as file-level taint: decode-then-exec (hidden code), fetch-then-exec (remote code), or a bare
  // eval/exec/new Function on a value. Reject, same as the on-one-line rules — the owner's rule holds either way; skip
  // when the one-line rule already caught it on this file (no double finding).
  const haveHidden = findings.some((f) => f.rule === 'hidden_code.decode'), haveRemote = findings.some((f) => f.rule === 'remote_code.pipe');
  if (decodeAt && dynexecAt && !haveHidden) add({ id: 'hidden_code.taint', kind: 'hidden_code', why: 'runs code it hides (decodes data, then executes it)', fix: null }, dynexecAt.i, dynexecAt.t);
  else if (fetchAt && dynexecAt && !haveRemote) add({ id: 'remote_code.taint', kind: 'remote_code', why: 'downloads code and runs it', fix: null }, dynexecAt.i, dynexecAt.t);
  else if (bareAt && !haveHidden) add({ id: 'hidden_code.dynamic', kind: 'hidden_code', why: 'runs a value as code (eval/exec/new Function)', fix: null }, bareAt.i, bareAt.t);
  return { findings, notes: [...notes] };
}

/** Pure: the printable strings (6+ characters) in a compiled program, one per line. */
export function binaryStrings(buf) {
  const out = []; let start = -1;
  for (let i = 0; i <= buf.length; i++) {
    const c = i < buf.length ? buf[i] : 0, printable = c >= 0x20 && c < 0x7f;
    if (printable) { if (start < 0) start = i; } else if (start >= 0) { if (i - start >= 6) out.push(buf.toString('latin1', start, Math.min(i, start + 400))); start = -1; }
  }
  return out.join('\n');
}

/**
 * Pure: what a licence text allows. → { license, redistributable }. 'proprietary' (all rights reserved, no open grant),
 * 'AGPL-3.0' (copyleft over a network: never bundled), an open licence by name, or 'Ronin' (Kingmaker's own, PolyForm).
 */
export function readLicense(text) {
  const t = String(text || '');
  if (!t.trim()) return { license: 'none', redistributable: false };
  const open = [['AGPL-3.0', /GNU AFFERO GENERAL PUBLIC LICENSE/i], ['Apache-2.0', /Apache License,?\s+Version 2\.0/i], ['MIT', /\bMIT License\b|Permission is hereby granted, free of charge/i],
    ['BSD', /Redistribution and use in source and binary forms/i], ['MPL-2.0', /Mozilla Public License,?\s+(v\.|Version)\s*2\.0/i], ['ISC', /\bISC License\b|Permission to use, copy, modify, and\/or distribute/i],
    ['GPL', /GNU GENERAL PUBLIC LICENSE/i], ['LGPL', /GNU LESSER GENERAL PUBLIC LICENSE/i], ['CC0-1.0', /CC0 1\.0|Creative Commons Zero/i], ['OFL-1.1', /SIL OPEN FONT LICENSE/i],
    ['Unlicense', /This is free and unencumbered software/i], ['Ronin', /Ronin Inc/i]];
  for (const [license, re] of open) if (re.test(t)) return { license, redistributable: license !== 'AGPL-3.0' };
  if (/all rights reserved/i.test(t)) return { license: 'proprietary', redistributable: false };
  return { license: 'unknown', redistributable: false };
}

/** The licence of a folder (LICENSE, LICENSE.txt, LICENSE.md, COPYING), or { license: 'none' }. */
export function folderLicense(dir) {
  try {
    const fm = /^---\n[\s\S]*?^license:\s*(.+)$[\s\S]*?\n---/m.exec(existsSync(join(dir, 'SKILL.md')) ? readFileSync(join(dir, 'SKILL.md'), 'utf8').slice(0, 4000) : '')?.[1];
    if (fm && /AGPL|Affero/i.test(fm)) return { license: 'AGPL-3.0', redistributable: false, file: 'SKILL.md' };
    // The folder's own licence file, else the nearest one up to its repository's root.
    for (let d = dir, i = 0; i < 6; i += 1, d = dirname(d)) {
      const f = readdirSync(d).find((n) => /^(LICEN[CS]E|COPYING)(\.(txt|md))?$/i.test(n));
      if (f) return { ...readLicense(readFileSync(join(d, f), 'utf8').slice(0, 20_000)), file: relative(dir, join(d, f)) || f };
      if (existsSync(join(d, '.git')) || dirname(d) === d) break;
    }
    if (fm) return { ...readLicense(fm), file: 'SKILL.md' };
    return { license: 'none', redistributable: false };
  } catch { return { license: 'none', redistributable: false }; }
}

/** Pure: the verdict for a set of findings. A large encoded blob alone only sandboxes (fonts, icons and data ship that way). */
export function verdictFor(findings) {
  if (findings.some((f) => f.fix === null && !f.soft)) return 'rejected';
  return findings.length ? 'sandboxed' : 'clean';
}

/** Where the code of a command really is: the file, and for a Python or Node entry script, the package it runs. */
export function codeRoots(target) {
  const roots = new Set();
  let p = target;
  try { p = realpathSync(target); } catch { return []; }
  roots.add(p);
  try {
    if (statSync(p).isFile() && statSync(p).size < 200_000) {
      const head = readFileSync(p, 'utf8').slice(0, 4000);
      // A Python console script: "from pkg.cli import main" inside a venv → that venv's site-packages/pkg.
      const pkg = /^from\s+([A-Za-z_][\w]*)[\w.]*\s+import\b/m.exec(head)?.[1];
      const py = /^#!\s*(\S*python[\d.]*)/.exec(head)?.[1];
      if (pkg && py) {
        const lib = join(dirname(dirname(py)), 'lib');
        for (const v of existsSync(lib) ? readdirSync(lib) : []) { const d = join(lib, v, 'site-packages', pkg); if (existsSync(d)) roots.add(d); }
      }
      // A Node bin: its package folder.
      if (/^#!.*\bnode\b/.test(head)) { let d = dirname(p); for (let i = 0; i < 4 && d !== '/'; i++, d = dirname(d)) if (existsSync(join(d, 'package.json'))) { roots.add(d); break; } }
    }
  } catch { /* the file alone */ }
  return [...roots];
}

/** The files REA reads under some roots, sorted (so the hash below is stable). */
function filesUnder(roots, prose) {
  const budget = { files: 0, bytes: 0 }, out = [];
  for (const root of roots) { const files = []; for (const f of walk(root, budget, prose ? SKILL_SKIP_DIRS : SKIP_DIRS)) files.push(f); out.push(...files.sort().map((f) => [root, f])); }
  return out;
}
const rootsOf = (targets, home) => [...new Set((Array.isArray(targets) ? targets : [targets]).flatMap((t) => codeRoots(String(t).replace(/^~(?=\/|$)/, home))))];

/** A stamp of a connector's code (how many files, their sizes, the newest change, and a hash of every file's content):
 *  when it moves, the code is read again (lib/connectors.mjs). The content hash is what catches a same-size, backdated
 *  Trojan update that the count:bytes:mtime alone would miss. Never throws. */
export function codeStamp(targets, { home = homedir(), prose = false } = {}) {
  let n = 0, bytes = 0, newest = 0; const h = createHash('sha256');
  for (const [root, f] of filesUnder(rootsOf(targets, home), prose)) {
    let st; try { st = statSync(f); } catch { continue; }
    n += 1; bytes += st.size; newest = Math.max(newest, Math.floor(st.mtimeMs));
    const rel = relative(dirname(root), f) || basename(f);
    try { h.update(`${rel}\0${st.size}\0`); h.update(readFileSync(f)); } catch { h.update(`${rel}\0gone`); }
  }
  return `${n}:${bytes}:${newest}:${h.digest('hex').slice(0, 16)}`;
}

/** Inspect a connector's code (files, folders, or a command's real code). Never throws; never runs anything.
 *  `sha256` is over every file's path and what REA read of it (an owner's acknowledgement is bound to it); `stamp` is
 *  codeStamp's. */
export function inspect(targets, { home = homedir(), prose = false } = {}) {
  const roots = rootsOf(targets, home);
  const budget = { bytes: 0 }, findings = [], notes = new Set(), hash = createHash('sha256');
  let scanned = 0;
  for (const [root, file] of filesUnder(roots, prose)) {
    let st; try { st = statSync(file); } catch { continue; }
    const rel = relative(dirname(root), file) || basename(file);
    hash.update(`${rel}\0${st.size}\0`);
    if (!TEXT_EXT.has(extname(file).toLowerCase()) && !/^[^.]+$/.test(basename(file))) continue;
    if (/^(LICENSE|NOTICE|COPYING|AUTHORS|CHANGELOG|README)/i.test(basename(file)) && !prose) continue;
    let head; try { head = readFileSync(file).subarray(0, 4096); } catch { continue; }
    const compiled = head.includes(0);
    let size = st.size;
    if (size > (compiled ? 200_000_000 : MAX_FILE_BYTES) || budget.bytes + Math.min(size, MAX_FILE_BYTES) > MAX_TOTAL_BYTES) {
      // Too big, or past the byte budget: REA can't read it, yet it still runs. Hash it whole (so a later edit is caught),
      // raise a finding, and downgrade — unvetted code never gets free rein. The owner can clear it if they trust it.
      try { hash.update(readFileSync(file)); } catch { /* unreadable: the rel\0size\0 above still marks it */ }
      findings.push({ id: `unscanned.skipped:${rel}:1`, rule: 'unscanned.skipped', kind: 'unscanned', why: 'is too large for REA to read before it runs', fix: 'files', file: rel, line: 1, code: '' });
      notes.add('unscanned_code');
      continue;
    }
    // A compiled program: what it can reach is in its strings (hosts, paths, commands), so read those.
    let buf, text; try { buf = readFileSync(file); text = compiled ? binaryStrings(buf) : buf.toString('utf8'); } catch { continue; }
    hash.update(buf);
    if (compiled) notes.add('compiled');
    size = Math.min(size, MAX_FILE_BYTES);
    budget.bytes += size; scanned += 1;
    // A skill's words are instructions (prose); its scripts are code, read as code: advice a script only prints isn't done.
    const r = scanText(text, rel, { compiled, prose: (prose && PROSE.has(extname(file).toLowerCase())) || /^SKILL\.md$/i.test(basename(file)) });
    findings.push(...r.findings); r.notes.forEach((x) => notes.add(x));
  }
  const verdict = roots.length ? verdictFor(findings) : 'rejected';
  const dir = roots.find((r) => { try { return statSync(r).isDirectory(); } catch { return false; } });
  return { verdict, roots, scanned, findings: findings.slice(0, 60), notes: [...notes], reason: roots.length ? null : 'nothing to inspect at that path',
    license: dir ? folderLicense(dir) : null, sha256: roots.length ? hash.digest('hex') : null, stamp: codeStamp(targets, { home, prose }),
    summary: summarize(verdict, findings, scanned) };
}

function summarize(verdict, findings, scanned) {
  if (!scanned && verdict === 'rejected') return 'REA found nothing it could read there, so it won’t connect it.';
  const kinds = [...new Set(findings.filter((f) => !f.soft).map((f) => f.why))];
  if (verdict === 'clean') return `REA read ${scanned} file${scanned === 1 ? '' : 's'}: nothing that reaches for access unprompted.`;
  if (verdict === 'rejected') return `REA rejected it: it ${kinds.filter((k) => /downloads code|hides/.test(k)).join(' and ') || 'runs hidden code'}.`;
  return `REA read ${scanned} files. It ${kinds.join('; ') || 'carries encoded data'}. Those parts are blocked: it runs sandboxed.`;
}

/** The macOS sandbox profile that takes away exactly what REA found (always: credentials, login persistence, admin). */
export function sandboxProfile(findings = [], { home = homedir() } = {}) {
  const fixes = new Set(findings.map((f) => f.fix).filter(Boolean));
  const q = (p) => JSON.stringify(p);
  const rules = ['(version 1)', '(allow default)',
    `(deny file-read* file-write* ${[`${home}/.ssh`, `${home}/Library/Keychains`, `${home}/.solomon-secure`, `${home}/Library/Cookies`, `${home}/.aws`, `${home}/.gnupg`,
      `${home}/Library/Application Support/Google/Chrome`, `${home}/Library/Application Support/BraveSoftware`, `${home}/Library/Safari`, `${home}/.config/gh`,
      // and, after QwenPaw's DEFAULT_SANDBOX_DENY_PATHS: cloud and package-registry logins, coding agents' own keys, Firefox
      `${home}/.kube`, `${home}/.config/gcloud`, `${home}/.azure`, `${home}/.claude`, `${home}/.codex`, `${home}/Library/Application Support/Firefox`].map((p) => `(subpath ${q(p)})`).join(' ')} ${
      ['.netrc', '.git-credentials', '.npmrc', '.pypirc', '.vault-token', '.docker/config.json', '.zsh_history', '.bash_history'].map((f) => `(literal ${q(`${home}/${f}`)})`).join(' ')})`,
    `(deny file-write* (subpath ${q(`${home}/Library/LaunchAgents`)}) (subpath "/Library/LaunchAgents") (subpath "/Library/LaunchDaemons") ${['.zshrc', '.bashrc', '.bash_profile', '.zprofile', '.profile'].map((f) => `(literal ${q(`${home}/${f}`)})`).join(' ')})`,
    // No new hard link to anything: the deny above is by path, so without this a connector could link a secret to a
    // fresh path it is allowed to read (the deny never named it) and read the secret through it.
    '(deny file-link)',
    '(deny process-exec (literal "/usr/bin/sudo") (literal "/usr/bin/security") (literal "/bin/launchctl") (literal "/usr/bin/crontab") (literal "/usr/bin/osascript"))',
    '(deny mach-lookup (global-name "com.apple.SecurityServer") (global-name "com.apple.securityd"))'];
  // Phoning home: no network but this Mac's own (a local app's API, Ollama, ComfyUI on localhost still work). Denied
  // whenever a connector reads credentials or the environment too, not only on the 'network' fix: what it read can't leave.
  const denyNet = fixes.has('network') || findings.some((f) => f.kind === 'credentials' || f.kind === 'environment' || f.kind === 'unscanned');
  if (denyNet) rules.push('(deny network-outbound)', '(allow network-outbound (remote ip "localhost:*"))', '(allow network-outbound (remote unix-socket))');
  return rules.join('\n');
}
