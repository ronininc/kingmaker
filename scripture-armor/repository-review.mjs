// Read-only, commit-pinned repository inspection. Never checkout, install or execute repository content.
//
// Remainder-run changes (items 2 + 8, 2026-11-04) — this copy only:
//  * Disk-backed streaming: blobs over the 16 MiB buffered ceiling are
//    streamed to a temp file in the review workspace and inspected in
//    bounded-memory chunks (repository-stream.mjs). They are no longer
//    automatic coverage gaps. Anything still uninspectable remains an
//    explicit deferred gap — never a silent pass.
//  * Durable resume: full job state (inventory progress, cursor,
//    per-counter totals) is persisted to <id>.state.json after every
//    step; recover() restores a killed/restarted job where it stopped.
//  * Mid-work cancellation: cancel() stops cleanly, preserves partial
//    state and appends a summary marked PARTIAL.
//  * Report retention/history: every terminal job (completed, gapped,
//    cancelled) is entered into repository-reports/index.json with job
//    id, repository, commit, timestamp, coverage and gap count.
//  * GitHub quota: HTTP 403/429 from the API or raw host pauses the job
//    (state 'paused_for_quota') with the cursor NOT advanced — a pause
//    plus an explicit report record, never a crash and never a silent
//    per-file skip.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fetchPublicBytes, publicReviewURL} from './review-intake.mjs';
import {fetchPublicBytesToFile, streamInspectFile, STREAM_CHUNK_BYTES} from './repository-stream.mjs';

export const BUFFERED_BLOB_LIMIT = 16 * 1024 * 1024; // review-intake.mjs fetchPublicBytes hard cap; blobs above this take the streamed lane
const TERMINAL = ['completed', 'completed_with_gaps', 'cancelled'];

export function repositoryReference(input) { const u = publicReviewURL(input), m = u.hostname === 'github.com' && /^\/([\w-]+)\/([\w.-]+)\/?$/.exec(u.pathname); return m ? {owner: m[1], repo: m[2].replace(/\.git$/, '')} : null; }
const isQuotaError = (e) => !!e && (e.quota === true || e.statusCode === 403 || e.statusCode === 429);

export function createRepositoryReview({identityDir, fetchBytes = fetchPublicBytes, fetchToFile = fetchPublicBytesToFile, analyze, resources = async () => true, isLicensed = async () => true, now = Date.now, budgetMs = 15 * 60 * 1000} = {}) {
  let current = null, stopped = false, running = false;
  const reportsDir = () => path.join(identityDir, 'repository-reports');
  const statePath = (id) => path.join(reportsDir(), id + '.state.json');
  const snapshot = () => current ? {...current.public, attempted: current.cursor, elapsedSeconds: Math.round((now() - current.started) / 1000), estimateSeconds: current.public.inventoryComplete && current.public.scanned ? Math.ceil(current.scanMillis / current.public.scanned * (current.files.length - current.cursor) / 1000) : null} : null;
  const record = (entry) => fs.appendFileSync(current.report, JSON.stringify(entry) + '\n', {mode: 0o600});

  function persist() {
    if (!current) return;
    const c = current, p = c.public;
    const state = {version: 1, id: p.id, ref: c.ref, localRoot: c.localRoot || null, commit: p.commit, trees: c.trees, files: c.files, cursor: c.cursor,
      scanMillis: c.scanMillis, started: c.started, scanStarted: c.scanStarted, budgetMs: c.budgetMs, report: path.basename(c.report), historyWritten: !!c.historyWritten,
      public: {id: p.id, title: p.title, repository: p.repository, state: p.state, commit: p.commit, totalFiles: p.totalFiles, scanned: p.scanned, codeFiles: p.codeFiles,
        codeLines: p.codeLines, findings: p.findings, deferred: p.deferred, inventoryComplete: p.inventoryComplete, complete: p.complete,
        recentFindings: p.recentFindings, authority: p.authority, targetExecuted: p.targetExecuted, currentFile: p.currentFile || null, error: p.error || null}};
    const tmp = statePath(p.id) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state), {mode: 0o600});
    fs.renameSync(tmp, statePath(p.id));
  }
  function writeHistory(partial) {
    if (!current || current.historyWritten) return;
    const p = current.public, dir = reportsDir();
    const indexFile = path.join(dir, 'index.json');
    let index = [];
    try { index = JSON.parse(fs.readFileSync(indexFile, 'utf8')); if (!Array.isArray(index)) index = []; } catch {}
    index.push({id: p.id, repository: p.repository, commit: p.commit, finishedAt: new Date(now()).toISOString(), state: p.state, partial: !!partial,
      coverage: {totalFiles: p.totalFiles, scanned: p.scanned, codeFiles: p.codeFiles, codeLines: p.codeLines}, gaps: p.deferred, findings: p.findings, report: path.basename(current.report)});
    const tmp = indexFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(index, null, 2), {mode: 0o600});
    fs.renameSync(tmp, indexFile);
    current.historyWritten = true;
  }
  function finishTerminal(partial) { record({type: 'summary', ...(partial ? {partial: true} : {}), ...snapshot()}); writeHistory(partial); persist(); }

  async function tick() {
    if (running || stopped || !current) return; running = true;
    try {
      if (!await isLicensed()) { current.public.state = 'waiting_for_login'; return; }
      if (!await resources()) { current.public.state = 'paused_for_resources'; return; }
      if (now() > current.deadline) { current.public.state = 'paused_for_time_budget'; persist(); return; }
      const c = current, p = c.public;
      if (c.localRoot) {
        // Local-source mode: inventory was built synchronously by startLocal.
        if (c.cursor >= c.files.length) { p.state = p.deferred ? 'completed_with_gaps' : 'completed'; p.complete = p.deferred === 0; finishTerminal(false); return; }
      } else {
        const base = `https://api.github.com/repos/${c.ref.owner}/${c.ref.repo}`;
        if (!p.commit) { const r = await fetchBytes(base + '/commits/HEAD', {maxBytes: 1024 * 1024}), d = JSON.parse(r.bytes.toString()); r.bytes.fill(0); if (!/^[a-f0-9]{40}$/.test(d.sha || '') || !/^[a-f0-9]{40}$/.test(d.commit?.tree?.sha || '')) throw Error('Cannot pin repository revision.'); p.commit = d.sha; c.trees.push({sha: d.commit.tree.sha, prefix: ''}); record({type: 'revision', repository: p.repository, commit: p.commit}); persist(); return; }
        if (c.trees.length) {
          p.state = 'inventory'; const item = c.trees[0], r = await fetchBytes(base + '/git/trees/' + item.sha, {maxBytes: 16 * 1024 * 1024}), d = JSON.parse(r.bytes.toString()); r.bytes.fill(0); if (!Array.isArray(d.tree) || d.truncated) throw Error('Tree inventory is incomplete; no complete verdict issued.'); c.trees.shift();
          for (const e of d.tree) {
            if (typeof e.path !== 'string' || e.path.startsWith('/') || e.path.split('/').some((s) => s === '..' || s === '.') || /[\0\r\n\\]/.test(e.path) || !/^[a-f0-9]{40}$/.test(e.sha || '')) { p.deferred++; record({type: 'deferred', path: String(e.path).slice(0, 1024), reason: 'Unsupported or unsafe tree entry.'}); continue; }
            const file = {...e, path: item.prefix + e.path};
            if (e.type === 'tree') c.trees.push({sha: e.sha, prefix: file.path + '/'});
            else if (e.type === 'blob' && ['100644', '100755'].includes(e.mode)) c.files.push(file);
            else { p.deferred++; record({type: 'deferred', path: file.path, reason: 'Symlink, submodule or unsupported mode; not followed or executed.'}); }
          }
          p.totalFiles = c.files.length; p.inventoryComplete = !c.trees.length; if (p.inventoryComplete) c.scanStarted = now(); persist(); return;
        }
        if (c.cursor >= c.files.length) { p.state = p.deferred ? 'completed_with_gaps' : 'completed'; p.complete = p.deferred === 0; finishTerminal(false); return; }
      }
      p.state = 'scanning'; const fileStarted = now(); const file = c.files[c.cursor]; p.currentFile = file.path;
      let bytes, advance = true;
      try {
        let review, streamed = false;
        if (c.localRoot) {
          const abs = path.join(c.localRoot, file.path);
          const st = fs.statSync(abs);
          if (st.size > BUFFERED_BLOB_LIMIT) { review = await streamInspectFile(abs, path.basename(file.path)); streamed = true; }
          else { bytes = fs.readFileSync(abs); review = await analyze(bytes, path.basename(file.path)); }
        } else if (Number.isSafeInteger(file.size) && file.size > BUFFERED_BLOB_LIMIT) {
          // Disk-backed streaming lane: download to a temp file in the
          // review workspace, verify the pinned blob hash from the
          // streamed bytes, inspect in bounded chunks, then discard.
          const tmpDir = path.join(reportsDir(), 'tmp'); fs.mkdirSync(tmpDir, {recursive: true, mode: 0o700});
          const tmp = path.join(tmpDir, p.id + '-' + c.cursor + '.blob');
          try {
            await fetchToFile(`https://raw.githubusercontent.com/${c.ref.owner}/${c.ref.repo}/${p.commit}/${file.path.split('/').map(encodeURIComponent).join('/')}`, tmp);
            review = await streamInspectFile(tmp, path.basename(file.path));
            if (review.gitBlobSha1 !== file.sha) throw Error('Content does not match pinned Git blob.');
            streamed = true;
          } finally { try { fs.unlinkSync(tmp); } catch {} }
        } else {
          const r = await fetchBytes(`https://raw.githubusercontent.com/${c.ref.owner}/${c.ref.repo}/${p.commit}/${file.path.split('/').map(encodeURIComponent).join('/')}`); bytes = r.bytes;
          const blob = crypto.createHash('sha1').update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest('hex'); if (blob !== file.sha) throw Error('Content does not match pinned Git blob.');
          review = await analyze(bytes, path.basename(file.path));
        }
        p.scanned++;
        if (review.kind === 'source') { p.codeFiles++; if (streamed) p.codeLines += review.codeLines || 0; else { for (const b of bytes) if (b === 10) p.codeLines++; if (bytes.length && bytes.at(-1) !== 10) p.codeLines++; } }
        if (review.status === 'limited') { p.deferred++; }
        const findings = (review.findings || []).filter((f) => f.severity !== 'info'); p.findings += findings.length;
        const item = {type: 'file', path: file.path, sha256: review.contentSha256, kind: review.kind, status: review.status, streamed, findings, limitations: review.limitations || []}; record(item);
        for (const f of findings) { p.recentFindings.push({...f, file: file.path}); if (p.recentFindings.length > 30) p.recentFindings.shift(); }
      } catch (error) {
        if (isQuotaError(error)) { advance = false; throw error; } // handled by the outer catch: pause, cursor NOT advanced
        p.deferred++; record({type: 'deferred', path: file.path, reason: error.message});
      } finally { if (advance) { bytes?.fill(0); c.scanMillis += now() - fileStarted; c.cursor++; } }
      persist();
    } catch (error) {
      if (isQuotaError(error)) {
        current.public.state = 'paused_for_quota';
        current.public.error = 'GitHub API quota exhausted (HTTP ' + error.statusCode + '); job paused, no file skipped. Resume after the quota window' + (error.retryAfterSeconds ? ` (Retry-After: ${error.retryAfterSeconds}s)` : '') + '.';
        if (error.retryAfterSeconds) current.public.quotaRetryAfterSeconds = error.retryAfterSeconds;
        record({type: 'quota-pause', status: error.statusCode, retryAfterSeconds: error.retryAfterSeconds ?? null, at: new Date(now()).toISOString()});
        persist();
      } else { current.public.state = 'paused_for_error'; current.public.error = error.message; persist(); }
    } finally { running = false; }
  }
  const timer = setInterval(() => { if (current && !['completed', 'completed_with_gaps', 'cancelled', 'paused_for_time_budget', 'paused_for_error', 'paused_by_admin', 'paused_for_quota'].includes(current.public.state)) void tick(); }, 1000); timer.unref();

  function newJob({ref, localRoot, repositoryLabel, title, commit}) {
    const id = crypto.randomUUID(), dir = reportsDir(); fs.mkdirSync(dir, {recursive: true, mode: 0o700}); if (fs.lstatSync(dir).isSymbolicLink() || fs.realpathSync(dir) !== dir) throw Error('Unsafe report directory.');
    current = {ref, localRoot: localRoot || null, report: path.join(dir, id + '.jsonl'), files: [], cursor: 0, trees: [], started: now(), scanStarted: now(), scanMillis: 0, deadline: now() + budgetMs, budgetMs, historyWritten: false,
      public: {id, title: `${title || repositoryLabel} — Repository Security Review`, repository: repositoryLabel, state: 'inventory', commit: commit || null, totalFiles: 0, scanned: 0, codeFiles: 0, codeLines: 0, findings: 0, deferred: 0, inventoryComplete: false, complete: false, recentFindings: [], authority: 'device-admin-decides', targetExecuted: false}};
    fs.writeFileSync(current.report, JSON.stringify({type: 'notice', title: current.public.title, text: 'Static findings are potential risk vectors, not proof of a breach. No repository code was executed. Owner approval and removal are separate actions.'}) + '\n', {mode: 0o600, flag: 'wx'});
    return current;
  }

  return {state: snapshot, tick,
    start(input) { if (current && !TERMINAL.includes(current.public.state)) throw Error('Finish or cancel the current repository review first.'); const ref = repositoryReference(input); if (!ref) throw Error('Use a GitHub repository root URL.');
      newJob({ref, repositoryLabel: `${ref.owner}/${ref.repo}`, title: `${ref.owner}-${ref.repo}`}); persist(); return snapshot(); },
    // Local-source mode (acceptance + offline use): inventory a local
    // directory tree with the same counters, gaps and report machinery.
    // No network, no GitHub API. Commit is pinned from the local clone
    // when one is present.
    startLocal(rootDir) { if (current && !TERMINAL.includes(current.public.state)) throw Error('Finish or cancel the current repository review first.');
      const root = fs.realpathSync(rootDir); if (!fs.statSync(root).isDirectory()) throw Error('Local source root is not a directory.');
      let commit = null; try { commit = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {stdio: ['ignore', 'pipe', 'ignore']}).toString().trim(); if (!/^[a-f0-9]{40}$/.test(commit)) commit = null; } catch {}
      const job = newJob({ref: null, localRoot: root, repositoryLabel: `local:${root}`, commit});
      const walk = (rel) => {
        for (const entry of fs.readdirSync(path.join(root, rel), {withFileTypes: true})) {
          const childRel = rel ? rel + '/' + entry.name : entry.name;
          if (entry.isSymbolicLink()) { job.public.deferred++; record({type: 'deferred', path: childRel, reason: 'Symlink; not followed or executed.'}); continue; }
          if (entry.isDirectory()) { if (entry.name !== '.git') walk(childRel); continue; }
          if (!entry.isFile()) continue;
          const st = fs.statSync(path.join(root, childRel));
          job.files.push({path: childRel, size: st.size, mode: (st.mode & 0o111) ? '100755' : '100644', type: 'blob'});
        }
      };
      walk('');
      job.public.totalFiles = job.files.length; job.public.inventoryComplete = true; job.scanStarted = now();
      record({type: 'revision', repository: job.public.repository, commit});
      persist(); return snapshot(); },
    pause() { if (current) { current.public.state = 'paused_by_admin'; persist(); } },
    resume() { if (current) { current.deadline = now() + budgetMs; current.public.state = 'queued'; delete current.public.error; delete current.public.quotaRetryAfterSeconds; persist(); } },
    // Mid-work cancellation: stop cleanly, keep the partial report and
    // mark it PARTIAL in the report itself and in the history index.
    cancel() { if (!current || TERMINAL.includes(current.public.state)) return snapshot();
      current.public.state = 'cancelled'; finishTerminal(true); return snapshot(); },
    // Durable resume: restore the newest non-terminal persisted job
    // (e.g. after the process was killed) and continue from its cursor.
    recover() { const dir = reportsDir(); if (!fs.existsSync(dir)) return null;
      const candidates = fs.readdirSync(dir).filter((f) => f.endsWith('.state.json'))
        .map((f) => { try { return {f, mtime: fs.statSync(path.join(dir, f)).mtimeMs, state: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))}; } catch { return null; } })
        .filter((x) => x && !TERMINAL.includes(x.state.public.state)).sort((a, b) => b.mtime - a.mtime);
      if (!candidates.length) return null;
      const s = candidates[0].state;
      current = {ref: s.ref, localRoot: s.localRoot, report: path.join(dir, s.report), files: s.files, cursor: s.cursor, trees: s.trees, started: s.started, scanStarted: s.scanStarted,
        scanMillis: s.scanMillis, deadline: now() + (s.budgetMs || budgetMs), budgetMs: s.budgetMs || budgetMs, historyWritten: !!s.historyWritten,
        public: {...s.public, state: 'queued'}};
      record({type: 'resumed', at: new Date(now()).toISOString(), cursor: s.cursor, scanned: s.public.scanned});
      persist(); return snapshot(); },
    history() { try { return JSON.parse(fs.readFileSync(path.join(reportsDir(), 'index.json'), 'utf8')); } catch { return []; } },
    report(id) { if (!current || current.public.id !== id) throw Error('Report not found.'); return current.report; },
    close() { stopped = true; clearInterval(timer); }
  };
}
