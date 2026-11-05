#!/usr/bin/env node
// scripts/coldstart-bench.mjs — the cold-start measurement harness (COLDSTART.md is its report).
//
// Times the launch→ready chain phase by phase (lib/cold-start.mjs) against this tree, on this
// machine, and prints the table with every number labeled REAL or SIMULATED:
//
//   process       a fresh node child imports the startup module set — REAL.
//                 (The full lib/cli.mjs graph needs the complete checkout — vendor/ and core/ are
//                 not in every snapshot — so the child imports the loadable startup core. On the
//                 acceptance Mac the same child can import cli.mjs itself; see COLDSTART.md.)
//   preflight     payload check + path resolution + port probe + a resident-engine probe against
//                 nothing — REAL, all of it runs here.
//   engine        the REAL startBackend (lib/runtime.mjs) spawning a FIXTURE engine that prints
//                 the real ready line after a scripted delay — SIMULATED: the delay stands in for
//                 the real engine's internal boot (kingmaker-os, not in this tree). The launcher
//                 mechanics inside the measurement (spawn, stream, ready-line match) are real and
//                 reported separately in the notes.
//   post-ready    the launcher's two after-ready calls (agent status for the hands warm, control
//                 status for the rules check) made concurrently against the mock — SIMULATED:
//                 the call pattern is real, the engine behind it is not (its hands start is the
//                 real cost, ≈2 s cold, and it lives on the Mac).
//   first-decision the REAL DecisionRouter against a MOCK /v1/systemone endpoint on loopback —
//                 REAL for the router + transport cost (the mock answers instantly); the reflex
//                 model's own forward pass is not in this number (the reflex pick's published
//                 100 ms is a vendor figure, quoted in the notes, never added to a measured row).
//   first-token   a MOCK /api/generate stream — SIMULATED: the streaming mechanics are timed for
//                 real, but no model exists on this machine to produce a token. The honest Mac
//                 number comes from running this same bench beside Ollama with the seats pulled.
//
// Usage: node scripts/coldstart-bench.mjs [--json] [--fixture-delay <ms>]
// Exit code is 0 for a completed report; the verdict line says what the numbers do and do not prove.

import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPhaseTimer, formatPhaseTable, phaseVerdict } from '../lib/cold-start.mjs';
import { agentStatus, controlStatus, health } from '../lib/client.mjs';
import { DecisionRouter } from '../lib/decision-router.mjs';
import { prewarmModel, prewarmReflex, reflexPrewarmModel } from '../lib/model-warm.mjs';
import { checkPayload } from '../lib/payload.mjs';
import { resolvePaths } from '../lib/paths.mjs';
import { probeResidentEngine } from '../lib/resident-engine.mjs';
import { portFree, startBackend } from '../lib/runtime.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const asJson = args.includes('--json');
const fixtureDelayMs = (() => { const i = args.indexOf('--fixture-delay'); const v = i >= 0 ? Number(args[i + 1]) : 250; return Number.isFinite(v) && v >= 0 ? v : 250; })();

const now = () => performance.now();
const round1 = (ms) => Math.round(ms * 10) / 10;

async function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

/** The fixture engine: prints the real ready line after FIXTURE_DELAY_MS, then idles until killed. */
const FIXTURE_ENGINE = `const delay = Number(process.env.FIXTURE_DELAY_MS || 0);
setTimeout(() => {
  console.log('Solomon runtime listening on http://127.0.0.1:fixture');
  setInterval(() => {}, 60000);
}, delay);
`;

/** One mock server for both Ollama-shaped surfaces the warm paths speak. */
function startMocks() {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(body || '{}'); } catch { /* the mock is forgiving */ }
      if (req.url === '/v1/systemone') {
        const answers = {};
        for (const name of Object.keys(parsed.questions ?? {})) answers[name] = { probabilities: { awake: 0.99, asleep: 0.01 } };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ answers }));
        return;
      }
      if (req.url === '/api/generate') {
        if (parsed.stream === true) {
          res.writeHead(200, { 'content-type': 'application/x-ndjson' });
          res.write(`${JSON.stringify({ model: parsed.model, response: 'first', done: false })}\n`);
          setTimeout(() => res.end(`${JSON.stringify({ model: parsed.model, response: '', done: true })}\n`), 5);
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ model: parsed.model, done: true }));
        return;
      }
      if (req.url === '/api/agent/status' || req.url === '/api/control/status') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, data: {} }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

/** Phase: process — a fresh child imports the startup module set; the number is the child's own. */
function measureProcessPhase() {
  const modules = ['payload', 'paths', 'runtime', 'client', 'models', 'mac-profiles', 'decision-router', 'cold-start', 'model-warm', 'resident-engine'];
  const code = `const t = performance.now(); for (const m of ${JSON.stringify(modules)}) await import(${JSON.stringify(`${root}/lib/`)} + m + '.mjs'); console.log((performance.now() - t).toFixed(1));`;
  return new Promise((resolve) => {
    execFile(process.execPath, ['--input-type=module', '-e', code], { timeout: 60_000 }, (error, stdout) => {
      if (error) { resolve({ ms: null, note: `child import failed: ${String(error.message).slice(0, 120)}` }); return; }
      const ms = Number(String(stdout).trim().split('\n').pop());
      resolve({ ms: Number.isFinite(ms) ? ms : null, note: `fresh node child importing ${modules.length} startup modules (lib/cli.mjs's full graph needs the complete checkout)` });
    });
  });
}

async function main() {
  const timer = createPhaseTimer({ now });
  const notes = [];
  const scratch = mkdtempSync(join(tmpdir(), 'kingmaker-coldstart-'));
  try {
    // ── process ──────────────────────────────────────────────────────────
    const proc = await measureProcessPhase();
    if (proc.ms != null) timer.set('process', proc.ms, { kind: 'REAL', note: proc.note });
    else notes.push(`process: ${proc.note}`);

    // ── preflight ────────────────────────────────────────────────────────
    {
      const t = now();
      const env = { ...process.env, SOL_GHOST_HOME: join(scratch, 'state'), SOL_GHOST_RUNTIME_HOME: join(scratch, 'state', 'runtime') };
      const paths = resolvePaths(env);
      const payload = checkPayload(root); // a snapshot reports its missing parts; the CHECK is what is timed
      const port = await freePort();
      await portFree(port);
      const probe = await probeResidentEngine({ paths, port, healthCheck: (p) => health(p, { timeoutMs: 500 }).catch(() => null) });
      timer.set('preflight', now() - t, { kind: 'REAL', note: `paths + payload check (${payload.checked} essential files; ok=${payload.ok} in this tree) + port probe + resident probe (${probe.state})` });
      notes.push('preflight: the payload check on a partial snapshot reports missing vendor/core parts — its cost is real either way; on an installed app it verifies the full payload list.');
    }

    // ── engine (fixture) ─────────────────────────────────────────────────
    {
      const fixturePath = join(scratch, 'fake-engine.mjs');
      writeFileSync(fixturePath, FIXTURE_ENGINE);
      const env = { ...process.env, SOL_GHOST_HOME: join(scratch, 'state'), SOL_GHOST_RUNTIME_HOME: join(scratch, 'state', 'runtime'), FIXTURE_DELAY_MS: String(fixtureDelayMs) };
      const paths = { ...resolvePaths(env), binary: process.execPath, headlessEntry: fixturePath };
      const port = await freePort();
      const t = now();
      const backend = await startBackend({ paths, port, secrets: { nonce: 'bench-nonce-0123456789abcdef0123456789' }, env, installedModels: [] });
      await backend.ready;
      const total = now() - t;
      await backend.stop();
      timer.set('engine', total, { kind: 'SIMULATED', note: `real startBackend + fixture engine; fixture delay ${fixtureDelayMs} ms stands in for the real engine's internal boot — launcher mechanics ≈ ${round1(total - fixtureDelayMs)} ms of the total` });
      notes.push(`engine: spawn → ready-line mechanics measured ${round1(total - fixtureDelayMs)} ms around a scripted ${fixtureDelayMs} ms fixture boot. The real engine's boot (kingmaker-os headless server) is only measurable on the Mac.`);
    }

    // ── mocks up: pre-warm behavior + the two first-use phases ───────────
    const mocks = await startMocks();
    const mockBase = `http://127.0.0.1:${mocks.port}`;
    try {
      const warmBrain = await prewarmModel({ model: 'bench-seat', baseUrl: mockBase });
      const warmReflex = await prewarmReflex({ model: reflexPrewarmModel('8gb'), baseUrl: mockBase });
      notes.push(`pre-warm vs mock endpoints: brain seat ${warmBrain.ok ? `loaded in ${round1(warmBrain.ms)} ms` : `FAILED (${warmBrain.error})`}; reflex seat ${warmReflex.ok ? `answered in ${round1(warmReflex.ms)} ms` : `FAILED (${warmReflex.error})`} — endpoint mechanics only, no weights exist here.`);

      // post-ready: the two calls the launcher makes the moment the engine answers — the hands
      // warm (agent status) and the fail-closed rules check (control status), now concurrent.
      // The mock answers instantly, so the row is SIMULATED: what's real inside it is the
      // launcher-side cost of making both calls at once instead of in series; the engine's own
      // hands start (≈2 s cold, per warmHands' budget notes) is Mac-only.
      {
        const t = now();
        await Promise.all([
          agentStatus(mocks.port, { timeoutMs: 5_000 }).catch(() => null),
          controlStatus(mocks.port, { timeoutMs: 5_000 }).catch(() => null),
        ]);
        timer.set('post-ready', now() - t, { kind: 'SIMULATED', note: 'hands-warm + rules-check calls, concurrent, vs an instantly-answering mock engine; the real hands start (≈2 s cold on the Mac) is not in this number' });
      }

      // first-decision: one discarded call (the router's own warm-up), then the timed one.
      const router = new DecisionRouter({ model: reflexPrewarmModel('8gb'), baseUrl: mockBase });
      const ask = () => router.decide({ state: 'bench', questions: { go: { type: 'choice', prompt: 'go?', options: ['awake', 'asleep'] } } });
      await ask();
      const t = now();
      const outcomes = await ask();
      const decideMs = now() - t;
      timer.set('first-decision', decideMs, { kind: 'REAL', note: `DecisionRouter round trip vs an instantly-answering mock (${outcomes[0]?.kind}); the reflex model's own forward pass is NOT in this number — the reflex pick's (tev1) published latency is 100 ms (registry, vendor figure)` });

      // first-token: stream from the mock generate endpoint; time to the first chunk.
      const t2 = now();
      const res = await fetch(`${mockBase}/api/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'bench-seat', prompt: 'bench', stream: true }) });
      const reader = res.body.getReader();
      await reader.read();
      const ttft = now() - t2;
      try { await reader.cancel(); } catch { /* done */ }
      timer.set('first-token', ttft, { kind: 'SIMULATED', note: 'mock stream: only the streaming mechanics are timed; a real first token waits on weight paging + the first forward pass, which this machine cannot produce — the Mac run of this bench is the honest number' });
    } finally {
      mocks.server.close();
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  const rows = timer.rows();
  const verdict = phaseVerdict(rows);
  if (asJson) {
    console.log(JSON.stringify({ rows, verdict, notes }, null, 2));
    return;
  }
  console.log('# Kingmaker cold-start bench\n');
  console.log(formatPhaseTable(rows));
  console.log('\n## Notes');
  for (const n of notes) console.log(`- ${n}`);
  for (const r of rows) if (r.note) console.log(`- ${r.id}: ${r.note}`);
  console.log(`\n## Verdict\n- measured ${verdict.measuredCount}/6 phases (${verdict.realCount} REAL, ${verdict.simulatedCount} SIMULATED), total measured ${verdict.totalMeasuredMs} ms.`);
  console.log(verdict.allRealWithinBudget
    ? '- PROVEN: every phase measured REAL and within budget.'
    : '- NOT a proof of "instantaneous": simulated phases and this machine\'s limits are listed above. The Mac run is the verdict that counts.');
}

await main();
