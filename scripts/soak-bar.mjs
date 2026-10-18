#!/usr/bin/env node
// scripts/soak-bar.mjs — soak the INSTALLED Kingmaker through its own bar, the way the owner types: each case goes in as
// kingmaker://bar?text=…&key=<the bar link key> (sent at once, exactly like a typed turn) and its answer is read back from
// bar.log. Safe cases only: nothing is sent to anyone, nothing is paid or recorded in the CRM, and the one install case
// names a repo that does not exist. Between rounds: health, the processes' memory, new crash reports.
//
//   node scripts/soak-bar.mjs [--rounds N] [--only name,name] [--json out.json]
//
// It never prints the bar link key. Exit 0 when every hard case passed in every round.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { RUNTIME_BINARY } from '../lib/paths.mjs';

const STATE = process.env.SOL_GHOST_HOME || join(homedir(), 'Library/Application Support/sol-ghost');
const BAR_LOG = join(STATE, 'logs/bar.log');
const KEY_FILE = join(STATE, 'bar-link.key');
const HEALTH = `http://127.0.0.1:${process.env.SOL_GHOST_PORT || 3001}/api/health`;
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const ROUNDS = Number(arg('--rounds', 3));
const ONLY = arg('--only', '') ? new Set(arg('--only', '').split(',')) : null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Each case: the words, what the answer must (expect) or must not (refuse) contain, how long to wait. `soft` cases
// depend on the network or a model's wording: reported, never failing the run. `then` follows on the same chat, only
// when the first answer passed. No case may leave an action waiting for the owner's word (an install read-back, a send):
// a later "yes" would approve it.
const CASES = [
  { name: 'quick-count', say: 'how many files are on my desktop', expect: /\d+ files? and \d+ folders?/i, wait: 20 },
  { name: 'writer', say: 'write one sentence about a taco truck in Phoenix', expect: /taco/i, refuse: /hugging-bay|Kingmaker, using /i, wait: 120 },
  { name: 'follow-up', say: 'write a two-sentence ad for a taco truck', expect: /./, wait: 120,
    then: { say: 'make it shorter', expect: /taco|truck/i, refuse: /Apple Inc|owner of my Mac/i, wait: 120 } },
  // A draft about a permission, never a "yes" to it: that "yes" makes Kingmaker open System Settings, which takes the
  // owner's screen (soak 2026-10-15). The soak never opens a window, an app or a Settings page.
  { name: 'permission-draft', say: 'Draft a one-line message asking Kingmaker to allow screen recording', expect: /(allow|permission|access).*(screen recording|record (the |your |my )?screen)|(screen recording|record (the |your |my )?screen).*(allow|permission|access)/i, refuse: /hugging-bay|using [a-z]+-[a-z]+-/i, wait: 120 },
  { name: 'installer-missing-repo', say: 'install ronininc/soak-test-no-such-repo', expect: /Installing ronininc\/soak-test-no-such-repo/i, wait: 20,
    then: { await: /soak-test-no-such-repo.*(not|no |couldn|404|private|release)/i, wait: 90 } },
  // Any language (a598fa7): a typed Spanish or Japanese turn gets its answer in that language, then English again.
  { name: 'spanish-writer', say: 'escribe una frase sobre un camión de tacos en Phoenix', expect: /\b(el|la|los|las|una?|de|con|en|es|del)\b[^\n]*\b(el|la|los|las|una?|de|con|en|es|del)\b/i, refuse: /^Kingmaker: (?!I've noticed)[^\n]*\b(the|and|with)\b[^\n]*\b(the|and|with)\b/im, wait: 120 },
  { name: 'japanese-writer', say: 'フェニックスのタコストラックについて一文書いてください', expect: /[\u3040-\u30ff]/, wait: 120 },
  { name: 'english-again', say: 'write one sentence about a coffee cart in Tempe', expect: /coffee|cart|Tempe/i, wait: 120 },
  // The quick answers are built in English; reported, not failing, until they're translated.
  { name: 'spanish-count', say: '¿cuántos archivos hay en mi escritorio?', expect: /archivos?|carpetas?/i, wait: 30, soft: true },
  // The whole stack at once (the profiles session's ask): one picture render beside the writer and voice. Once per run;
  // it opens the picture when it's done.
  { name: 'picture', say: 'make a picture of a gold crown on a black background', await: /Done in \d+ seconds|couldn't draw/i, expect: /Done in \d+ seconds/i, wait: 300, soft: true, once: true },
  { name: 'sources-listed', say: 'what is the latest news about NVIDIA', expect: /sources are in the bar|Sources:/i, refuse: /open in (Chrome|your browser)/i, wait: 180, soft: true },
];

function key() { return readFileSync(KEY_FILE, 'utf8').trim(); }
function logSize() { try { return statSync(BAR_LOG).size; } catch { return 0; } }
// By bytes: the log has —, … and ’ in it, so a character slice at a byte offset skips the new lines.
function logSince(offset) { try { return readFileSync(BAR_LOG).subarray(offset).toString('utf8'); } catch { return ''; } }
function sendBar(text) {
  const u = `kingmaker://bar?text=${encodeURIComponent(text)}&key=${encodeURIComponent(key())}`;
  execFileSync('/usr/bin/open', ['-g', u]);   // -g: in the background, the owner's front app stays front
}
// HEAT (the owner: "be careful the mac's getting kinda hot"): before each case, wait while macOS reports a thermal
// warning or a CPU speed limit under 100%, checking every 30 s for up to 10 minutes.
function thermal() {
  try {
    const t = execFileSync('/usr/bin/pmset', ['-g', 'therm'], { encoding: 'utf8' });
    const limit = Number((/CPU_Speed_Limit\s*=\s*(\d+)/.exec(t) || [])[1] ?? 100);
    const warn = /warning level/i.test(t) && !/No thermal warning level has been recorded/.test(t);
    return { hot: warn || limit < 100, limit, line: warn ? 'thermal warning' : `cpu limit ${limit}%` };
  } catch { return { hot: false, limit: 100, line: 'unknown' }; }
}
async function coolDown(log) {
  for (let i = 0; i < 20; i++) { const t = thermal(); if (!t.hot) return t; log(`  … hot (${t.line}); pausing 30 s`); await sleep(30_000); }
  return thermal();
}
// THE WHOLE STACK'S MEMORY, sampled every 5 s while the soak runs: the lowest kern.memorystatus_level (free memory %),
// the most swap used, and the peak resident memory of Kingmaker's processes (bar, engine, engine server, voice runtime)
// and of Ollama's model runners. These numbers decide whether the 24 GB budget holds with everything on.
const peaks = { level: 100, swapMb: 0, kingmakerMb: 0, ollamaMb: 0, samples: 0 };
function sampleStack() {
  try {
    const level = Number(execFileSync('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_level'], { encoding: 'utf8' }).trim());
    const swap = /used = ([\d.]+)M/.exec(execFileSync('/usr/sbin/sysctl', ['-n', 'vm.swapusage'], { encoding: 'utf8' }));
    let km = 0, ol = 0;
    for (const l of execFileSync('/bin/ps', ['-axo', 'rss=,command='], { encoding: 'utf8' }).split('\n')) {
      const m = /^\s*(\d+)\s+(.*)$/.exec(l); if (!m) continue;
      const mb = Number(m[1]) / 1024;
      if (/Kingmaker\.app\/Contents\//.test(m[2])) km += mb; else if (/ollama/.test(m[2])) ol += mb;
    }
    peaks.level = Math.min(peaks.level, level); peaks.swapMb = Math.max(peaks.swapMb, swap ? Number(swap[1]) : 0);
    peaks.kingmakerMb = Math.max(peaks.kingmakerMb, Math.round(km)); peaks.ollamaMb = Math.max(peaks.ollamaMb, Math.round(ol)); peaks.samples++;
  } catch { /* a missed sample */ }
}
function ollamaLoaded() { try { return execFileSync('/opt/homebrew/bin/ollama', ['ps'], { encoding: 'utf8', timeout: 5000 }).trim().split('\n').slice(1).map((l) => l.split(/\s{2,}/).slice(0, 3).join(' ')); } catch { return []; } }
async function health() { try { return (await fetch(HEALTH, { signal: AbortSignal.timeout(4000) })).status; } catch { return 0; } }
function memory() {
  try {
    return execFileSync('/bin/ps', ['-axo', 'rss=,command='], { encoding: 'utf8' }).split('\n')
      .filter((l) => /Kingmaker\.app\/Contents\/MacOS\//.test(l))
      .map((l) => { const [rss, ...c] = l.trim().split(/\s+/); return { mb: Math.round(Number(rss) / 1024), what: c.join(' ').replace(/.*MacOS\//, '').slice(0, 60) }; });
  } catch { return []; }
}
function crashes(since) {
  const dir = join(homedir(), 'Library/Logs/DiagnosticReports');
  try { return readdirSync(dir).filter((f) => (f.startsWith('Kingmaker') || f.startsWith(RUNTIME_BINARY)) && statSync(join(dir, f)).mtimeMs > since); } catch { return []; }
}

/** Send `say` (unless it only awaits), then read the answer lines until `expect`/`await` shows or it's quiet. */
async function step(c, from = null) {
  // An await-only step (no words of its own) reads from where the case began: the answer may already be in.
  const offset = c.say ? logSize() : (from ?? logSize());
  if (c.say) sendBar(c.say);
  const until = Date.now() + (c.wait ?? 60) * 1000;
  const want = c.await ?? c.expect;
  let answer = '', quietSince = Date.now(), last = '';
  while (Date.now() < until) {
    await sleep(1500);
    const lines = logSince(offset).split('\n').filter((l) => / (Kingmaker|Sources|note): /.test(l));
    answer = lines.map((l) => l.replace(/^\S+ /, '')).join('\n');
    if (answer !== last) { last = answer; quietSince = Date.now(); }
    if (want && answer && want.test(answer) && Date.now() - quietSince > 4000) break;
    if (!c.await && answer && Date.now() - quietSince > 15000) break;   // an answer, then 15 s of quiet: it's done
  }
  const ok = (!want || want.test(answer)) && !(c.await && c.expect && !c.expect.test(answer)) && !(c.refuse && c.refuse.test(answer));
  return { ok, answer: answer.slice(0, 600), offset };
}

async function main() {
  if (!existsSync(KEY_FILE)) { console.error(`No bar link key at ${KEY_FILE}: is Kingmaker installed and started once?`); process.exit(2); }
  if ((await health()) !== 200) { console.error('Kingmaker is not answering on its health route. Start it first.'); process.exit(2); }
  // Its own chat, never the owner's current one ("/new" starts a fresh chat in the bar; the owner's chats are untouched).
  sendBar('/new'); await sleep(2000);
  const started = Date.now();
  sampleStack(); const startSwap = peaks.swapMb, sampler = setInterval(sampleStack, 5000);
  const report = { started: new Date(started).toISOString(), rounds: [], memory: [], crashes: [] };
  let hardFails = 0;
  for (let r = 1; r <= ROUNDS; r++) {
    const round = { round: r, cases: [] };
    for (const c of CASES.filter((x) => (!ONLY || ONLY.has(x.name)) && !(x.once && r > 1))) {
      const heat = await coolDown(console.log);
      if (heat.hot) { console.log('  still hot after 10 minutes: stopping the soak here'); r = ROUNDS; break; }
      const first = await step(c);
      const { offset: _o, ...firstShown } = first;
      let res = { name: c.name, soft: Boolean(c.soft), ...firstShown };
      if (first.ok && c.then) { await sleep(1000); const second = await step(c.then, first.offset); res = { ...res, ok: second.ok, then: second.answer }; }
      if (!res.ok && !res.soft) hardFails++;
      round.cases.push(res);
      console.log(`  ${res.ok ? 'PASS' : res.soft ? 'SOFT' : 'FAIL'} r${r} ${c.name}${res.ok ? '' : `\n       → ${(res.then ?? res.answer).replace(/\n/g, ' | ').slice(0, 300) || '(no answer)'}`}`);
      await sleep(2000);
    }
    const h = await health();
    const mem = memory(), models = ollamaLoaded(), heat = thermal();
    report.memory.push({ round: r, health: h, mem, models, heat: heat.line });
    console.log(`  round ${r}: health ${h}, memory ${mem.map((m) => `${m.what.split(' ')[0]} ${m.mb} MB`).join(', ')}; heat ${heat.line}; models loaded: ${models.join(' · ') || 'none'}`);
    if (h !== 200) { hardFails++; console.log('  FAIL health'); }
    report.rounds.push(round);
  }
  clearInterval(sampler); sampleStack();
  report.stack = { ...peaks, swapGrowthMb: Math.round(peaks.swapMb - startSwap) };
  console.log(`\n  whole stack: free memory fell to ${peaks.level}%, swap peaked at ${Math.round(peaks.swapMb)} MB (${report.stack.swapGrowthMb >= 0 ? '+' : ''}${report.stack.swapGrowthMb} MB during the soak), Kingmaker's processes peaked at ${peaks.kingmakerMb} MB, Ollama's at ${peaks.ollamaMb} MB (${peaks.samples} samples)`);
  report.crashes = crashes(started);
  if (report.crashes.length) { hardFails++; console.log(`  FAIL crash reports: ${report.crashes.join(', ')}`); }
  const out = arg('--json', null);
  if (out) writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(hardFails ? `\n${hardFails} hard failure(s).` : '\nAll hard cases passed in every round.');
  process.exit(hardFails ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
