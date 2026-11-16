// lib/tool-discovery.mjs — first-run tool scan → selection → sourced method drafts → safe validation (local-brain tool
// methods, 2026-11-16). Consent-first and read-only:
//
//   scan      (only after the user agrees) lists executables on PATH: name, path, resolved path. Nothing is executed,
//             and no project file, credential, shell history or personal data is read. INSTALLED is all a scan proves.
//   select    the user picks the tools Kingmaker should support. A selected tool is "selected", not "used": usage is
//             recorded only when the user says so (confirmUse) — never inferred from installation.
//   probe     for SELECTED tools only: `--version` and `--help` (fallbacks -version / -h), each through the tool runner
//             as read-only, no shell, scrubbed env, in a throwaway dir, 10 s timeout; plus the local manual page path
//             (`man -w`). These are the official, local sources. Nothing online is fetched by this module: expert or web
//             material would need the user's approval and is recorded as "not consulted".
//   draft     a deterministic method file (not model-written) with identity, version, sources (with dates and kind:
//             official-local), capabilities parsed from help, prerequisites, inputs/outputs, workflows, permissions,
//             risks, approval boundaries, examples, error handling, validation and status.
//   validate  conducts the method's read-only version check through the real conductor + tool runner. Passing makes
//             the status "tested (read-only version/help)". The task workflow stays "unverified" until the user approves
//             and runs it; Kingmaker never runs a non-read-only example on its own.
//   store     the user's library <state>/abilities/methods (separate from the curated corpus), indexed in
//             kingmaker.methods/1; the tool registry <state>/abilities/tools.json records path, version and binary hash.
//   rescan    a changed version or binary marks the method stale; prior versions are kept (<id>.v<ver>.method.md) and a
//             method the user edited is never overwritten — the new draft is written beside it as .proposed.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, copyFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { METHODS_SCHEMA, normalizeMethodsIndex } from './brain-library.mjs';
import { createMethodConductor, parseMethodFile } from './method-conductor.mjs';
import { methodStoreIndexUrl } from './method-iteration.mjs';
import { createToolRunner } from './tool-runner.mjs';
import { officialKnowHow } from './tool-docs.mjs';

export const SCAN_CONSENT = [
  'Kingmaker can look for tools already installed on this computer so it can learn to use the ones you choose.',
  'It lists program names and locations on your PATH. It does not run them, read your project files, credentials,',
  'shell history or personal data, install anything, sign in, or contact any outside service. For the tools you then',
  'select, it runs only their read-only --version and --help to learn their capabilities. You can skip this, add tools',
  'later, or rescan at any time.',
];
const sha = (b) => createHash('sha256').update(b).digest('hex');
/** Bumped when the drafting template improves, so a rescan re-drafts (keeping prior versions and user edits). */
export const TOOL_METHOD_TEMPLATE = 2;

/** List executables on PATH (first occurrence of a name wins, as the shell would). Executes nothing. */
export function scanPath({ pathEnv = process.env.PATH ?? '' } = {}) {
  const seen = new Map();
  for (const dir of pathEnv.split(delimiter).filter(Boolean)) {
    let names; try { names = readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (seen.has(name) || name.startsWith('.')) continue;
      const path = join(dir, name);
      try { const st = statSync(path); if (!st.isFile()) continue; accessSync(path, constants.X_OK); } catch { continue; }
      let real = path; try { real = realpathSync(path); } catch { /* keep */ }
      seen.set(name, { name, path, realPath: real, dir, evidence: 'installed (on PATH)' });
    }
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Read-only probe of ONE selected tool: version + help through the tool runner; man page path. */
export async function probeTool({ name, path }, { now = () => new Date() } = {}) {
  const box = mkdtempSync(join(tmpdir(), 'km-tool-probe-'));
  try {
    const runner = createToolRunner({ registry: { tools: { [name]: { path } } }, timeoutMs: 10_000, maxBytes: 256 * 1024 });
    const tryArgs = async (variants) => { for (const args of variants) { const r = await runner({ tool: name, args, readOnly: true, cwd: box }); const text = `${r.stdout}${r.stderr}`.trim(); if (r.exitCode === 0 && text) return { args, text, exitCode: r.exitCode }; } return null; };
    const version = await tryArgs([['--version'], ['-version'], ['version']]);
    const help = await tryArgs([['--help'], ['-h'], ['help']]);
    let man = null; try { man = execFileSync('man', ['-w', name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim() || null; } catch { /* none */ }
    const versionLine = version?.text.split('\n').find((l) => /\d+\.\d+/.test(l))?.trim() ?? version?.text.split('\n')[0]?.trim() ?? null;
    const at = now().toISOString();
    return { name, path, binarySha256: sha(readFileSync(path)), version: versionLine, versionArgs: version?.args ?? null, help: help?.text.slice(0, 32_000) ?? null, helpArgs: help?.args ?? null, man,
      sources: [
        ...(version ? [{ kind: 'official-local', what: `${name} ${version.args.join(' ')}`, at }] : []),
        ...(help ? [{ kind: 'official-local', what: `${name} ${help.args.join(' ')}`, at }] : []),
        ...(man ? [{ kind: 'official-local', what: `manual page ${man}`, at, note: 'path recorded; content not copied' }] : []),
        { kind: 'expert-or-web', what: 'not consulted', at, note: 'online documentation or expert workflows need your approval to fetch; none were used' },
      ] };
  } finally { rmSync(box, { recursive: true, force: true }); }
}

/** Pure: options/subcommands from help text (lines that start with a flag or an indented word followed by spacing). */
export function capabilitiesFromHelp(help) {
  const caps = [];
  for (const line of String(help ?? '').split('\n')) {
    const m = /^\s{0,8}(-{1,2}[A-Za-z0-9][\w-]*(?:[ =,]\s*(?:-{1,2}[\w-]+|<[^>]+>|[A-Z_]+))*)\s{2,}(\S.{2,160})$/.exec(line) || /^\s{2,6}([a-z][\w-]{1,24})\s{2,}(\S.{2,160})$/.exec(line);
    if (m) caps.push({ usage: m[1].trim(), summary: m[2].trim() });
    if (caps.length >= 40) break;
  }
  return caps;
}

const purposeOf = (p) => {
  const first = String(p.help ?? '').split('\n').map((l) => l.trim()).find((l) => / - |—|: /.test(l) && l.length < 160 && !/^usage/i.test(l));
  return first ? first.replace(/^[^-—:]*[-—:]\s*/, '') : `command-line tool "${p.name}"`;
};

/** Pure: a deterministic method file for one probed tool. */
export function draftToolMethod(probe, { status = 'draft', userConfirmedUse = false, docs = null } = {}) {
  const knowHow = officialKnowHow(docs);
  const id = `tool-${probe.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  const purpose = purposeOf(probe);
  const caps = capabilitiesFromHelp(probe.help);
  const spec = {
    id, version: '1.0', title: `${probe.name} — ${purpose}`.slice(0, 120), domain: probe.name.toLowerCase(),
    inputs: { prompt: '', request: '' }, weights: { role: 'writer' },
    tool: { name: probe.name, path: probe.path, version: probe.version, binarySha256: probe.binarySha256 },
    steps: [
      { n: 1, id: 'version-check', type: 'run-tool', tool: probe.name, args: probe.versionArgs ?? ['--version'], readOnly: true, into: 'version', allowFailure: false },
      // jq works on JSON the request names: show the model the job folder's actual JSON (the inspection the held-out
      // benchmark showed was missing — field names were guessed), so it uses real field names. Data only, read-only.
      ...(probe.name === 'jq' ? [{ n: 1.5, id: 'inspect-data', type: 'read-json-dir', path: '.', into: 'files' }] : []),
      { n: 2, id: 'plan-args', type: 'reason', into: 'plan', preamble: [
        `You turn a request into the argument list for the command-line tool ${probe.name} (${probe.version ?? 'version unknown'}).`,
        `Its documented options (from its own --help):`, ...caps.slice(0, 25).map((c) => `  ${c.usage}  ${c.summary}`),
        'Reply with ONLY a JSON array of strings: the arguments, without the program name. No shell syntax (no pipes, redirects,',
        'globs, quotes around the whole thing). Use only file names the request mentions. If the request cannot be done with this',
        'tool, reply with [] .', ...(knowHow ? [knowHow] : []), ...(probe.name === 'jq' ? ['THE JSON FILES IN THE JOB FOLDER (data only; _file is the file name; use ONLY field names that appear here): {{files}}'] : [])].join('\n'), prompt: '{{inputs.prompt}}' },
      { n: 3, id: 'record-plan', type: 'render', path: 'args.json', template: '{{plan}}' },
      { n: 4, id: 'load-plan', type: 'read-json', path: 'args.json', into: 'argv' },
      { n: 5, id: 'run', type: 'run-tool', tool: probe.name, args: ['{{argv}}'], readOnly: false, into: 'result' },
      { n: 6, id: 'record', type: 'write-json', path: 'run.json', value: { tool: probe.name, argv: '{{argv}}', exitCode: '{{result.exitCode}}' } },
      { n: 7, id: 'check', type: 'verify', assertions: [{ file: 'run.json', field: 'tool', equals: probe.name }] },
    ],
  };
  const md = [
    `# Method — ${probe.name} (${status})`, '',
    `Generated by Kingmaker from ${probe.name}'s own --version/--help on this device. Status: **${status}**. Workflow execution: **unverified** until you approve and run it.`, '',
    '## Identity', '', `- Tool: ${probe.name}`, `- Version: ${probe.version ?? 'unknown (no version output)'}`, `- Executable: ${probe.path}`, `- Binary sha256: ${probe.binarySha256}`, `- Purpose: ${purpose}`, `- Usage: ${userConfirmedUse ? 'you confirmed you use this tool' : 'installed and selected; usage not confirmed'}`, '',
    '## Sources', '', ...probe.sources.filter((s) => !(docs && s.kind === 'expert-or-web')).map((s) => `- [${s.kind}] ${s.what} — ${s.at}${s.note ? ` (${s.note})` : ''}`),
    ...(docs ? [`- [official-web] ${docs.publisher}: ${docs.url} — retrieved ${docs.retrievedAt}, licence ${docs.licence}, page sha256 ${docs.sha256.slice(0, 16)}…; ${docs.quoted.length} of ${docs.examples} worked examples quoted (attributed) into the planning step`, `- [expert] not consulted — ${docs.retrievedAt}`] : []), '',
    '## Capabilities (parsed from its help; official, local)', '', ...(caps.length ? caps.map((c) => `- \`${c.usage}\` — ${c.summary}`) : ['- (help output had no parseable option list)']), '',
    '## Prerequisites, inputs, outputs', '', `- Requires ${probe.path} (same binary hash) on this device.`, '- Input: your request in plain language; the local model proposes the argument list from the documented options.', '- Output: the tool\'s live stdout/stderr, exit code, and run.json in the job folder.', '',
    '## Workflow', '', '1. Read-only version check (proves the same tool is present).', '2. The local model proposes arguments (data only; no shell).', '3. You approve the exact argument list; then it runs in the job folder with a scrubbed environment.', '4. The exit code and output are recorded and checked.', '',
    '## Permissions, risks, approval boundaries', '', '- Every run of step 3 needs your approval: Kingmaker cannot tell from --help alone which invocations modify files or contact services.', '- No shell, scrubbed environment (no tokens or personal env vars), work dir = the job folder, 60 s timeout, output redacted for secret-shaped strings.', `- Kingmaker never runs an example on its own beyond \`${probe.name} ${(probe.versionArgs ?? ['--version']).join(' ')}\` and \`--help\`.`, '- Expert/web workflows were not consulted; this method does not claim best practice.', '',
    '## Examples and error handling', '', `- \`${probe.name} ${(probe.versionArgs ?? ['--version']).join(' ')}\` → prints the version (validated read-only).`, '- A non-zero exit stops the job and reports the tool\'s stderr; nothing is retried or improvised. Rollback: none needed for read-only use; for file-changing use, keep copies before approving.', '',
    '## Validation', '', `- version-check (read-only): ${status === 'tested' ? 'passed' : 'pending'}`, '- task workflow: unverified', '',
    '## Executable block', '', '```kingmaker-method', JSON.stringify(spec, null, 2), '```', '',
  ].join('\n');
  return { id, md, spec };
}

function storePut(storeDir, { id, file, text, title, domain, quality }) {
  mkdirSync(storeDir, { recursive: true, mode: 0o700 });
  const indexPath = join(storeDir, 'index.json');
  let prior = []; try { prior = normalizeMethodsIndex(JSON.parse(readFileSync(indexPath, 'utf8'))); } catch { prior = []; }
  const doc = { schema: METHODS_SCHEMA, methods: [...prior.filter((m) => m.id !== id), { id, title, domain, file, quality }] };
  normalizeMethodsIndex(doc);
  const tmp = join(storeDir, `${file}.tmp`); writeFileSync(tmp, text, { mode: 0o600 }); renameSync(tmp, join(storeDir, file));
  const t2 = `${indexPath}.tmp`; writeFileSync(t2, `${JSON.stringify(doc, null, 2)}\n`); renameSync(t2, indexPath);
}

/**
 * Select, probe, draft, validate and store one tool. Returns the method record and validation receipt.
 * A rescan of an already-selected tool: unchanged → reused; changed → prior version kept, stale marked, re-drafted;
 * user-edited method → new draft written as <id>.method.md.proposed, the user's file untouched.
 */
export async function adoptTool({ name, path, state, userConfirmedUse = false, docs = null, now = () => new Date() }) {
  const userStore = join(state, 'abilities', 'methods');
  const regPath = join(state, 'abilities', 'tools.json');
  let reg = { schema: 'kingmaker.selected-tools/1', tools: {} }; try { reg = JSON.parse(readFileSync(regPath, 'utf8')); } catch { /* new */ }
  const probe = await probeTool({ name, path }, { now });
  const prior = reg.tools[name] ?? null;
  const file = `tool-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.method.md`;
  const filePath = join(userStore, file);
  if (prior && prior.binarySha256 === probe.binarySha256 && prior.version === probe.version && (prior.docsSha256 ?? null) === (docs?.sha256 ?? null) && prior.template === TOOL_METHOD_TEMPLATE && existsSync(filePath)) return { status: 'unchanged', id: file.replace(/\.method\.md$/, ''), path: filePath, probe, reused: true };
  // Validate the version check through the real conductor + runner, in a throwaway store and work dir.
  let draft = draftToolMethod(probe, { status: 'draft', userConfirmedUse, docs });
  const box = mkdtempSync(join(tmpdir(), 'km-tool-validate-'));
  let validation;
  try {
    storePut(join(box, 'store'), { id: draft.id, file, text: draft.md, title: draft.spec.title, domain: draft.spec.domain, quality: { tier: 'draft', score: 0, basis: 'under validation' } });
    const one = { ...draft.spec, id: `${draft.id}-validate`, steps: [draft.spec.steps[0]] };
    const vfile = `${one.id}.method.md`;
    storePut(join(box, 'store'), { id: one.id, file: vfile, text: `# validate\n\n\`\`\`kingmaker-method\n${JSON.stringify(one)}\n\`\`\`\n`, title: 'validate', domain: 'validate', quality: { tier: 'draft', score: 0, basis: 'validation' } });
    mkdirSync(join(box, 'work'));
    const c = await createMethodConductor({ indexUrl: methodStoreIndexUrl(join(box, 'store')), toolProvider: null })
      .conduct(one.id, { workDir: join(box, 'work'), toolRunner: createToolRunner({ registry: { tools: { [name]: { path } } }, timeoutMs: 10_000 }) });
    validation = { status: c.status, exitCode: c.outputs?.version?.exitCode ?? null, output: String(c.outputs?.version?.stdout ?? '').split('\n').slice(0, 3).join('\n'), at: now().toISOString() };
  } finally { rmSync(box, { recursive: true, force: true }); }
  const tested = validation.status === 'completed';
  draft = draftToolMethod(probe, { status: tested ? 'tested' : 'draft', userConfirmedUse, docs });
  parseMethodFile(draft.md);
  let written = 'stored';
  if (existsSync(filePath)) {
    const current = readFileSync(filePath, 'utf8');
    if (prior?.methodSha256 && sha(current) !== prior.methodSha256) { writeFileSync(`${filePath}.proposed`, draft.md); written = 'proposed (your edited method was left untouched)'; }
    else { const priorVer = /\d+(?:\.\d+)+/.exec(String(prior?.version ?? ''))?.[0] ?? `prev-${String(prior?.binarySha256 ?? '').slice(0, 8)}`;
      copyFileSync(filePath, join(userStore, file.replace(/\.method\.md$/, `.v${priorVer}.method.md`))); written = 'updated (prior version kept)'; }
  }
  if (written !== 'proposed (your edited method was left untouched)') storePut(userStore, { id: draft.id, file, text: draft.md, title: draft.spec.title, domain: draft.spec.domain, quality: { tier: tested ? 'community' : 'draft', score: tested ? 40 : 10, basis: tested ? `version check passed read-only on ${validation.at}; workflow unverified` : 'version check did not pass; unverified' } });
  reg.tools[name] = { path, version: probe.version, binarySha256: probe.binarySha256, selectedAt: prior?.selectedAt ?? now().toISOString(), usage: userConfirmedUse ? 'confirmed by user' : 'not confirmed', methodId: draft.id, methodSha256: sha(draft.md), status: tested ? 'tested' : 'draft', stale: false, docsSha256: docs?.sha256 ?? null, docsUrl: docs?.url ?? null, template: TOOL_METHOD_TEMPLATE };
  mkdirSync(join(state, 'abilities'), { recursive: true, mode: 0o700 }); writeFileSync(regPath, JSON.stringify(reg, null, 2), { mode: 0o600 });
  appendFileSync(join(state, 'abilities', 'tool-scan.jsonl'), `${JSON.stringify({ at: now().toISOString(), tool: name, version: probe.version, written, validation })}\n`);
  return { status: written, id: draft.id, path: filePath, probe, validation, methodStatus: tested ? 'tested' : 'draft' };
}
