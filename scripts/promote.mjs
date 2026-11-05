#!/usr/bin/env node
// scripts/promote.mjs — the promotion door: proven in private → public, by
// mechanism instead of by hand (PROMOTION.md tells the whole flow).
//
// Until now every private→public move was a hand-carry: someone assembled a
// snapshot, eyeballed it, pushed. The releases scattered (a stale Latest in
// one repo, the site saying another version) because the transfer depended
// on a person remembering. This tool makes the mantrap's second door
// mechanical:
//
//   1. PROVE — each component's own test suite runs HERE, in the private
//      tree, in the exact layout the files will ship in. Any failure, any
//      missing suite, any nonzero exit: promotion is refused. The proof
//      gate is mechanical, not a checkbox; a suite that only passed in
//      some other tree proves nothing about this one.
//   2. DIFF — the proven set is blob-SHA compared against public main
//      (ronininc/kingmaker). Only the delta travels. Byte-identical files
//      are named as such and stay home.
//   3. STAGE — the delta is staged under ~/workspace/.gh-sync/promote/
//      with a proof manifest and a PR body carrying the in-layout proof
//      table, per the snapshot-push discipline (UTF-8 text only, no
//      binaries, no deletions — a binary in the set is EXCLUDED and named
//      in the PR body, never silently dropped).
//   4. PUSH (unless --dry-run) — one branch + one PR against the public
//      repo, through the GitHub connector. This tool NEVER merges, NEVER
//      creates a release, and NEVER picks a version: --version is a
//      required input with no default, because the version number is
//      Robbie's call.
//
//   node scripts/promote.mjs --version 0.5.0 --components components.json [--branch promote-0.5.0] [--dry-run]
//     components.json: [{ "path": "stack/littlebrother", "test": "tests/run-tests.mjs" }, ...]
//     ("test" may be omitted: tests/run-tests.mjs is discovered, else the
//      first tests/*.test.mjs; a component with no discoverable suite is
//      refused — unproven is unpromotable.)
//   → prints a JSON verdict; exit 0 only when proof passed and the PR (or,
//     with --dry-run, the staged snapshot) exists.

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CLI = '/opt/hatch/bin/github';

/* ------------------------------------------------------------------ */
/* Blobs — the same hash git computes, so local and remote compare     */
/* ------------------------------------------------------------------ */

/** Pure: the git blob SHA-1 of a byte string — what GitHub reports for a
 *  file's contents, so a local file and a remote file compare by hash. */
export function blobSha(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
}

/** Pure: is this carryable by the connector snapshot? UTF-8 text only —
 *  strict decode, no NUL bytes. Binaries are excluded by the caller and
 *  NAMED, never silently dropped. */
export function isCarryableText(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (buf.includes(0)) return false;
  try { new TextDecoder('utf-8', { fatal: true }).decode(buf); return true; } catch { return false; }
}

/* ------------------------------------------------------------------ */
/* Component collection                                                */
/* ------------------------------------------------------------------ */

const SYNC_RECORD = /\.muse-github-snapshot-sync\.json(\.tmp-.*)?$/;

/** Walk a component path in the private tree → [{ path, abs, size, blob,
 *  text }] with repo-relative paths. Sync records and symlinks are
 *  problems, never payload (the snapshot discipline excludes both). */
export function collectComponent(root, componentPath) {
  const problems = [];
  const files = [];
  const base = join(root, componentPath);
  if (!existsSync(base)) return { files, problems: [`${componentPath}: not present in the private tree`] };
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = join(dir, e.name);
      if (SYNC_RECORD.test(e.name)) continue;
      if (e.isSymbolicLink()) { problems.push(`${relative(root, p)}: a symlink — snapshots cannot carry symlinks`); continue; }
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.isFile()) continue;
      const bytes = readFileSync(p);
      files.push({ path: relative(root, p).split(sep).join('/'), abs: p, size: bytes.length, blob: blobSha(bytes), text: isCarryableText(bytes) });
    }
  };
  if (lstatSync(base).isFile()) {
    const bytes = readFileSync(base);
    files.push({ path: componentPath.split(sep).join('/'), abs: base, size: bytes.length, blob: blobSha(bytes), text: isCarryableText(bytes) });
  } else walk(base);
  return { files, problems };
}

/** Pure-ish: a component's test entry — the declared one, else
 *  tests/run-tests.mjs, else the first tests/*.test.mjs. Null when the
 *  component carries no discoverable suite (unproven = unpromotable). */
export function discoverTest(root, component) {
  const base = join(root, component.path);
  if (component.test) return existsSync(join(base, component.test)) ? component.test : null;
  if (existsSync(join(base, 'tests', 'run-tests.mjs'))) return 'tests/run-tests.mjs';
  const testsDir = join(base, 'tests');
  if (existsSync(testsDir)) {
    const first = readdirSync(testsDir).filter((n) => n.endsWith('.test.mjs')).sort()[0];
    if (first) return `tests/${first}`;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* The proof gate — suites run HERE, in this layout                    */
/* ------------------------------------------------------------------ */

/** Pure: the pass count a suite's output claims ("13/13 checks passed",
 *  "darkweb-ts-port: 18 checks passed") → { passed, total } or null. */
export function parseSuiteCounts(output) {
  const text = String(output ?? '');
  const frac = /(\d+)\s*\/\s*(\d+)\s+checks passed/.exec(text);
  if (frac) return { passed: Number(frac[1]), total: Number(frac[2]) };
  const plain = /(\d+)\s+checks passed/.exec(text);
  if (plain) return { passed: Number(plain[1]), total: Number(plain[1]) };
  return null;
}

const defaultRun = (cmd, args, opts) => spawnSync(cmd, args, { encoding: 'utf8', ...opts });

/**
 * Run one component's suite in the private tree. The suite's own verdict
 * rules: exit 0 AND, when it prints a count, passed === total. Anything
 * else refuses — a suite that exits 0 while reporting 12/13 is a failing
 * suite wearing a green coat.
 */
export function runSuite({ root, component, run = defaultRun, timeoutMs = 600_000 }) {
  const entry = discoverTest(root, component);
  if (!entry) return { component: component.path, entry: null, ok: false, exitCode: null, counts: null, summary: 'no test suite found — unproven is unpromotable' };
  const r = run('node', [join(root, component.path, entry)], { cwd: join(root, component.path), timeout: timeoutMs, maxBuffer: 1024 * 1024 * 16 });
  const output = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  const counts = parseSuiteCounts(output);
  const lastLine = output.trim().split('\n').filter(Boolean).pop() ?? '';
  const ok = r.status === 0 && (!counts || counts.passed === counts.total);
  return { component: component.path, entry, ok, exitCode: r.status, counts, summary: lastLine.slice(0, 200) };
}

/** Prove every component. → { ok, results } — ok only when ALL pass. */
export function proveComponents({ root, components, run = defaultRun }) {
  const results = components.map((component) => runSuite({ root, component, run }));
  return { ok: results.every((r) => r.ok), results };
}

/* ------------------------------------------------------------------ */
/* The diff — blob-SHA against public main                             */
/* ------------------------------------------------------------------ */

/**
 * Compare the proven set against the public repo. remoteBlob(path) →
 * blob SHA | null (null = absent on public main).
 * → { delta: [files to push], identical: [paths], excluded: [files the
 *     snapshot cannot carry — binaries — named, never dropped quietly] }
 */
export async function diffAgainstRemote({ files, remoteBlob }) {
  const delta = [];
  const identical = [];
  const excluded = [];
  for (const f of files) {
    if (!f.text) { excluded.push({ path: f.path, size: f.size, reason: 'not UTF-8 text — the connector snapshot cannot carry binaries' }); continue; }
    const remote = await remoteBlob(f.path);
    if (remote === f.blob) identical.push(f.path);
    else delta.push({ ...f, change: remote === null ? 'added' : 'changed', remoteBlob: remote });
  }
  return { delta, identical, excluded };
}

/* ------------------------------------------------------------------ */
/* The PR body — the proof table rides with the code                   */
/* ------------------------------------------------------------------ */

export function buildPrBody({ version, branch, proof, diff, repo = 'ronininc/kingmaker' }) {
  const rows = proof.results.map((r) => `| ${r.component} | ${r.entry ?? '—'} | ${r.ok ? 'PASS' : 'FAIL'} | ${r.counts ? `${r.counts.passed}/${r.counts.total}` : '—'} |`).join('\n');
  const deltaRows = diff.delta.map((f) => `| ${f.change} | ${f.path} | ${f.size} |`).join('\n') || '| — | (no delta — everything proven is already on public main, byte-identical) | — |';
  const excluded = diff.excluded.length
    ? `\n## Excluded — the snapshot cannot carry these\n\n${diff.excluded.map((f) => `- \`${f.path}\` (${f.size} bytes) — ${f.reason}`).join('\n')}\n`
    : '';
  return `## Promotion — Kingmaker ${version}

Proven in kingmaker-private, promoted by mechanism (\`scripts/promote.mjs\`, branch \`${branch}\`). Every suite below ran in the private tree, in the exact layout these files ship in — a suite that only passed somewhere else proves nothing about this tree.

## Proof (in-layout, private tree)

| Component | Suite | Verdict | Checks |
|---|---|---|---|
${rows}

## Delta against public main (blob-SHA)

| Change | Path | Bytes |
|---|---|---|
${deltaRows}

${diff.identical.length} file(s) already on public main byte-identical and not re-pushed.${excluded}
## The gate

This PR does not merge itself and creates no release. Merge is the founder's tap; the version number (${version}) is the founder's call, carried here as given. The release, when he calls it, is built by \`scripts/release-parts.mjs\` and flipped by \`scripts/mirror-v2.mjs\` — see PROMOTION.md.
`;
}

/* ------------------------------------------------------------------ */
/* The GitHub connector adapter (production effects; tests fake it)    */
/* ------------------------------------------------------------------ */

/** Effects over /opt/hatch/bin/github. run(cmd, args, opts) is injectable. */
export function connectorGh({ owner = 'ronininc', repo = 'kingmaker', cli = DEFAULT_CLI, run = defaultRun } = {}) {
  const callTool = (name, args) => {
    const r = run(cli, ['call-tool', '--name', name, '--arguments-json', JSON.stringify(args)], { maxBuffer: 1024 * 1024 * 16 });
    if (r.status !== 0) throw new Error(`github ${name} failed: ${String(r.stderr || r.stdout).trim().slice(-300)}`);
    return JSON.parse(r.stdout);
  };
  const toolText = (res) => res?.result?.content?.find((c) => c.type === 'text')?.text ?? '';
  return {
    /** Blob SHA of a path at a ref, or null when the path is absent. */
    async remoteBlob(path, ref = 'main') {
      try {
        const res = callTool('get_file_contents', { owner, repo, path, ref });
        const m = /SHA: ([0-9a-f]{40})/.exec(toolText(res));
        if (!m) {
          // Absent on the remote is this method's null case — and the MCP
          // server reports it as an isError payload ("...the file does not
          // exist in the repository"), not a thrown error. Without this, any
          // private-only file (e.g. a component's new suite entry) crashed
          // the diff instead of staging as an addition.
          if (res?.result?.isError || /does not exist|Failed to get file contents/i.test(toolText(res))) return null;
          throw new Error(`get_file_contents ${path}: no blob SHA in the result`);
        }
        return m[1];
      } catch (e) {
        if (/not found|404|No such|does not exist/i.test(String(e.message))) return null;
        throw e;
      }
    },
    /** The branch's head SHA, or null when the branch does not exist. */
    async branchHead(branch) {
      try {
        const res = callTool('list_commits', { owner, repo, sha: branch, perPage: 1 });
        const text = toolText(res);
        const m = /"sha":\s*"([0-9a-f]{40})"/.exec(text);
        return m ? m[1] : null;
      } catch { return null; }
    },
    async createBranch(branch, fromBranch = 'main') {
      callTool('create_branch', { owner, repo, branch, from_branch: fromBranch });
    },
    /** push-files: the snapshot itself (sourceDir + NUL-delimited paths file it manages). */
    async pushFiles({ branch, message, sourceDir, pathsFile }) {
      const r = run(cli, ['push-files', '--owner', owner, '--repo', repo, '--branch', branch, '--message', message, '--source-dir', sourceDir, '--paths-file', pathsFile], { maxBuffer: 1024 * 1024 * 16 });
      if (r.status !== 0) throw new Error(`github push-files failed: ${String(r.stderr || r.stdout).trim().slice(-300)}`);
      const m = /[0-9a-f]{40}/.exec(String(r.stdout)) ;
      return { commit: m ? m[0] : null, raw: String(r.stdout).slice(0, 500) };
    },
    async createPullRequest({ title, body, head, base = 'main' }) {
      const res = callTool('create_pull_request', { owner, repo, title, body, head, base });
      const text = toolText(res);
      try { const j = JSON.parse(text); return { url: j.html_url ?? null, number: j.number ?? null }; } catch { return { url: /https:\/\/github\.com\/\S+/.exec(text)?.[0] ?? null, number: null }; }
    },
  };
}

/* ------------------------------------------------------------------ */
/* The promotion itself                                                */
/* ------------------------------------------------------------------ */

/**
 * promote({ root, version, components, branch, stageDir, dryRun, gh, run, log })
 *   root        the private tree (kingmaker-private checkout)
 *   version     REQUIRED — the founder's call; there is no default
 *   components  [{ path, test? }] to prove and promote
 *   gh          a connectorGh-shaped adapter (required unless dryRun)
 * Returns the verdict object the CLI prints. Never merges, never releases.
 */
export async function promote({ root, version, components, branch, stageDir, dryRun = false, gh = null, run = defaultRun, log = () => {} }) {
  if (!version || !/^v?[\w.-]+$/.test(String(version))) return { ok: false, stage: 'input', problems: ['--version is required and has no default: the version number is the founder\'s call'] };
  if (!Array.isArray(components) || !components.length) return { ok: false, stage: 'input', problems: ['no components given: nothing to prove, nothing to promote'] };
  const ver = String(version).replace(/^v/, '');

  // 1. PROVE — in this tree, in this layout. A red suite stops everything.
  const proof = proveComponents({ root, components, run });
  if (!proof.ok) {
    const failed = proof.results.filter((r) => !r.ok).map((r) => `${r.component}: ${r.summary}`);
    log(`✗ proof gate: ${failed.join(' | ')} — promotion refused, nothing staged, nothing pushed`);
    return { ok: false, stage: 'proof', problems: failed, proof };
  }
  log(`✓ proof: ${proof.results.map((r) => `${r.component} ${r.counts ? `${r.counts.passed}/${r.counts.total}` : 'pass'}`).join(', ')}`);

  // 2. COLLECT + DIFF against public main.
  const files = [];
  const collectProblems = [];
  for (const c of components) {
    const got = collectComponent(root, c.path);
    files.push(...got.files);
    collectProblems.push(...got.problems);
  }
  if (collectProblems.length) return { ok: false, stage: 'collect', problems: collectProblems, proof };
  if (!gh && !dryRun) return { ok: false, stage: 'input', problems: ['a GitHub adapter is required when not --dry-run'], proof };
  const remoteBlob = gh ? (p) => gh.remoteBlob(p, 'main') : async () => null;
  const diff = await diffAgainstRemote({ files, remoteBlob });
  log(`· diff: ${diff.delta.length} to push, ${diff.identical.length} already identical, ${diff.excluded.length} excluded`);

  // 3. STAGE the delta + the proof manifest + the PR body.
  mkdirSync(stageDir, { recursive: true });
  for (const f of diff.delta) {
    const dest = join(stageDir, f.path);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(f.abs, dest);
  }
  const proofManifest = { schema: 'kingmaker.promotion-proof/1', version: ver, branch, provedAt: new Date().toISOString(), results: proof.results };
  writeFileSync(join(stageDir, 'proof-manifest.json'), `${JSON.stringify(proofManifest, null, 2)}\n`);
  const body = buildPrBody({ version: ver, branch, proof, diff });
  writeFileSync(join(stageDir, 'pr-body.md'), body);
  const pathsFile = join(stageDir, 'paths.nul');
  writeFileSync(pathsFile, Buffer.from(`${diff.delta.map((f) => f.path).join('\0')}\0`));

  if (dryRun) {
    log(`= dry run: staged ${diff.delta.length} file(s) at ${stageDir}; nothing pushed`);
    return { ok: true, stage: 'staged', dryRun: true, version: ver, branch, stageDir, proof, delta: diff.delta.map((f) => f.path), identical: diff.identical, excluded: diff.excluded };
  }
  if (!diff.delta.length) {
    log('= nothing to promote: the proven set is already on public main, byte-identical');
    return { ok: true, stage: 'no-delta', version: ver, branch, proof, delta: [], identical: diff.identical, excluded: diff.excluded };
  }

  // 4. PUSH — one branch, one PR. Never a merge, never a release.
  if (!(await gh.branchHead(branch))) { await gh.createBranch(branch, 'main'); log(`· branch ${branch} created from main`); }
  const pushed = await gh.pushFiles({ branch, message: `Promote Kingmaker ${ver}: ${components.map((c) => c.path).join(', ')} (proven in private)`, sourceDir: stageDir, pathsFile });
  const pr = await gh.createPullRequest({ title: `Promote Kingmaker ${ver} — proven in private`, body, head: branch, base: 'main' });
  log(`✓ PR opened: ${pr.url ?? `#${pr.number}`}`);
  return { ok: true, stage: 'pr', version: ver, branch, stageDir, proof, delta: diff.delta.map((f) => f.path), identical: diff.identical, excluded: diff.excluded, commit: pushed.commit, pr };
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

function arg(argv, name, fallback = undefined) {
  const at = argv.indexOf(name);
  return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback;
}

async function main(argv = process.argv.slice(2)) {
  const version = arg(argv, '--version');
  const componentsFile = arg(argv, '--components');
  if (!version || !componentsFile) {
    console.log(JSON.stringify({ ok: false, problems: ['usage: promote.mjs --version <x.y.z> --components <components.json> [--branch <name>] [--stage <dir>] [--repo <owner/name>] [--dry-run] — --version is required: the version number is the founder\'s call and has no default'] }, null, 2));
    return 2;
  }
  const components = JSON.parse(readFileSync(resolve(componentsFile), 'utf8'));
  const ver = String(version).replace(/^v/, '');
  const branch = arg(argv, '--branch', `promote-${ver}`);
  const stageDir = resolve(arg(argv, '--stage', join(homedir(), 'workspace', '.gh-sync', 'promote', branch)));
  const [owner, repo] = String(arg(argv, '--repo', 'ronininc/kingmaker')).split('/');
  const dryRun = argv.includes('--dry-run');
  const gh = connectorGh({ owner, repo });
  const verdict = await promote({ root: resolve(HERE, '..'), version, components, branch, stageDir, dryRun, gh, log: (l) => console.log(l) });
  console.log(JSON.stringify(verdict, null, 2));
  return verdict.ok ? 0 : 1;
}

function invokedDirectly() {
  try { return resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url); } catch { return false; }
}
if (invokedDirectly()) main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(1); });
