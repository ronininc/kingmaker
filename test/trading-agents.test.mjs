import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyze, ANALYSTS, cleanDate, cleanTicker, DISCLAIMER, DRIVER, install, installPlan, parseResult, RESULT_MARK, resultLines, runPlan, status,
  TRADING_AGENTS_SOURCE, tradingAgentsDir } from '../lib/trading-agents.mjs';
import { cmdMarkets, parseMarketsArgs } from '../lib/trading-agents-cli.mjs';
import { builtInSkills, pickBuiltInSkill } from '../lib/core-pack.mjs';

const NOW = new Date('2026-10-16T15:00:00Z');
const tmp = () => mkdtempSync(join(tmpdir(), 'km-ta-'));
const installed = (state, commit = TRADING_AGENTS_SOURCE.commit) => {
  const dir = tradingAgentsDir(state);
  mkdirSync(join(dir, '.venv', 'bin'), { recursive: true });
  writeFileSync(join(dir, '.venv', 'bin', 'python'), '');
  writeFileSync(join(dir, 'installed.json'), JSON.stringify({ commit, version: '0.6.0', rea: { verdict: 'clean' } }));
};

test('pin: one 40-hex commit, Apache-2.0, never vendored; the driver ships beside the module', () => {
  assert.match(TRADING_AGENTS_SOURCE.commit, /^[0-9a-f]{40}$/);
  assert.equal(TRADING_AGENTS_SOURCE.license, 'Apache-2.0');
  assert.equal(TRADING_AGENTS_SOURCE.bundled, false);
  assert.ok(existsSync(DRIVER));
  assert.match(readFileSync(DRIVER, 'utf8'), /"llm_provider": "ollama"/, 'the driver pins the brain to the local models');
});

test('installPlan: argv lists (no shell), the pinned commit, a uv-managed Python inside the ability folder', () => {
  const p = installPlan({ dir: '/s/abilities/trading-agents', uv: '/k/uv' });
  assert.ok(p.steps.every((s) => Array.isArray(s) && s.every((a) => typeof a === 'string')));
  assert.ok(p.steps.some((s) => s.includes(TRADING_AGENTS_SOURCE.commit) && s.includes('checkout')));
  assert.ok(p.steps.some((s) => s[0] === '/k/uv' && s.includes('only-managed')), 'never the system Python');
  assert.ok(p.steps.flat().every((a) => !/\|\s*(sh|bash)|curl/.test(a)), 'nothing is piped into a shell');
  assert.equal(p.python, '/s/abilities/trading-agents/.venv/bin/python');
});

test('install: stops on a failed step, refuses a clone off the pin or one REA rejects, writes a receipt only when all pass', () => {
  const state = tmp();
  try {
    assert.equal(install({ state, uv: null }).ok, false, 'no uv, no install');
    const calls = [];
    const ok = (head) => (argv) => { calls.push(argv); return argv.includes('rev-parse') ? { code: 0, stdout: `${head}\n`, stderr: '' } : { code: 0, stdout: '', stderr: '' }; };
    let r = install({ state, uv: '/k/uv', runImpl: () => ({ code: 128, stdout: '', stderr: 'fatal: unable to access' }) });
    assert.equal(r.ok, false); assert.match(r.error, /git failed/);
    r = install({ state, uv: '/k/uv', runImpl: ok('f'.repeat(40)), inspectImpl: () => ({ verdict: 'clean' }) });
    assert.equal(r.ok, false); assert.match(r.error, /not the pinned/);
    r = install({ state, uv: '/k/uv', runImpl: ok(TRADING_AGENTS_SOURCE.commit), inspectImpl: () => ({ verdict: 'rejected', summary: 'it pipes curl into sh' }) });
    assert.equal(r.ok, false); assert.match(r.error, /REA rejected/);
    assert.equal(existsSync(join(tradingAgentsDir(state), 'installed.json')), false);
    assert.ok(!calls.slice(-6).some((a) => a[0] === '/k/uv'), 'a rejected clone never reaches the Python install (its build hooks never run)');
    r = install({ state, uv: '/k/uv', runImpl: ok(TRADING_AGENTS_SOURCE.commit), inspectImpl: () => ({ verdict: 'clean', summary: 'fine', sha256: 'ab' }), now: () => NOW });
    assert.equal(r.ok, true); assert.equal(r.commit, TRADING_AGENTS_SOURCE.commit);
    assert.equal(JSON.parse(readFileSync(join(tradingAgentsDir(state), 'installed.json'), 'utf8')).rea.verdict, 'clean');
  } finally { rmSync(state, { recursive: true, force: true }); }
});

test('status: a receipt at the pin with its Python, nothing else', () => {
  const state = tmp();
  try {
    assert.match(status({ state }).why, /not installed/);
    installed(state, 'e'.repeat(40));
    assert.match(status({ state }).why, /not the pinned/);
    installed(state);
    assert.equal(status({ state }).ok, true);
  } finally { rmSync(state, { recursive: true, force: true }); }
});

test('tickers and dates: Yahoo symbols only, a real day up to today', () => {
  for (const t of ['nvda', 'BRK-B', '^GSPC', 'GC=F', 'BTC-USD', '7203.T']) assert.ok(cleanTicker(t), t);
  for (const t of ['', 'NVDA; rm -rf ~', '$(id)', 'A'.repeat(20), '../etc', '-rf']) assert.equal(cleanTicker(t), null, t);
  assert.equal(cleanDate('', NOW), '2026-10-16');
  assert.equal(cleanDate('2026-09-01', NOW), '2026-09-01');
  for (const d of ['2026-10-17', '2026-02-30', '09/01/2026', 'yesterday']) assert.equal(cleanDate(d, NOW), null, d);
});

test('runPlan: local models, no Kingmaker keys in its environment, its writes kept in the ability folder', () => {
  const env = { PATH: '/usr/bin', HOME: '/Users/o', ANTHROPIC_API_KEY: 'sk-ant-x', OPENAI_API_KEY: 'sk-x', SOL_GHOST_UPDATE_TOKEN: 't', TRADINGAGENTS_LLM_PROVIDER: 'openai' };
  const p = runPlan({ state: '/s', ticker: 'nvda', date: '2026-09-01', env, now: NOW });
  assert.equal(p.command, '/s/abilities/trading-agents/.venv/bin/python');
  assert.deepEqual(p.args.slice(0, 2), ['-I', DRIVER]);
  const req = JSON.parse(p.args[2]);
  assert.equal(req.ticker, 'NVDA'); assert.equal(req.assetType, 'stock'); assert.deepEqual(req.analysts, [...ANALYSTS]);
  for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'SOL_GHOST_UPDATE_TOKEN', 'TRADINGAGENTS_LLM_PROVIDER']) assert.equal(p.env[k], undefined, k);
  assert.equal(p.env.OLLAMA_BASE_URL, 'http://127.0.0.1:11434/v1');
  assert.ok(p.env.TRADINGAGENTS_RESULTS_DIR.startsWith('/s/abilities/trading-agents/runs/'));
  assert.equal(runPlan({ state: '/s', ticker: 'BTC-USD', env, now: NOW }).request.assetType, 'crypto');
  assert.match(runPlan({ state: '/s', ticker: 'NVDA', analysts: 'market,options', env, now: NOW }).error, /not options/);
  assert.match(runPlan({ state: '/s', ticker: 'NVDA', rounds: 9, env, now: NOW }).error, /1 to 3/);
  assert.match(runPlan({ state: '/s', ticker: 'NVDA;ls', env, now: NOW }).error, /isn't a ticker/);
});

test('results: the last marked line is read; every answer carries the disclaimer; nothing reads as an order', () => {
  const r = parseResult(`noise\n${RESULT_MARK}{"ok":false}\nmore\n${RESULT_MARK}{"ok":true,"ticker":"NVDA","date":"2026-09-01","rating":"Hold","decision":"Hold: valuation is full.","reportDir":"/r"}\n`);
  assert.equal(r.rating, 'Hold');
  assert.equal(parseResult('no result here'), null);
  assert.equal(parseResult(`${RESULT_MARK}{not json`), null);
  const lines = resultLines(r);
  assert.equal(lines[0], 'NVDA as of 2026-09-01: Hold.');
  assert.equal(lines.at(-1), DISCLAIMER);
  assert.match(resultLines({ ...r, rating: 'REVIEW' })[0], /no clear rating/);
  assert.match(resultLines({ ok: false, error: 'boom' })[0], /didn't finish: boom/);
  assert.match(DISCLAIMER, /not financial advice/); assert.match(DISCLAIMER, /never places trades/);
});

test('analyze: refuses when not installed; runs the driver in its own group and reads its result', async () => {
  const state = tmp();
  try {
    assert.match((await analyze({ state, ticker: 'NVDA', now: NOW })).error, /not installed/);
    installed(state);
    let seen;
    const spawnImpl = (cmd, args, opts) => {
      seen = { cmd, args, opts };
      const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.pid = 999999;
      setImmediate(() => { c.stdout.emit('data', Buffer.from(`desk running\n${RESULT_MARK}{"ok":true,"ticker":"NVDA","date":"2026-10-16","rating":"Buy","decision":"Buy."}\n`)); c.emit('close', 0); });
      return c;
    };
    const lines = [];
    const r = await analyze({ state, ticker: 'NVDA', now: NOW }, { spawnImpl, onLine: (l) => lines.push(l) });
    assert.equal(r.rating, 'Buy');
    assert.equal(seen.opts.detached, true, 'its own process group, reaped whole on a timeout');
    assert.deepEqual(lines, ['desk running']);
  } finally { rmSync(state, { recursive: true, force: true }); }
});

test('kingmaker markets: usage, status, install and a run, all through injected seams', async () => {
  assert.deepEqual(parseMarketsArgs(['NVDA', '--date', '2026-09-01', '--deep-model', 'q:14b', '--crypto']).opts, { date: '2026-09-01', deepModel: 'q:14b', crypto: true });
  assert.match(parseMarketsArgs(['NVDA', '--date']).error, /needs a value/);
  assert.match(parseMarketsArgs(['NVDA', '--buy']).error, /isn't a markets option/);
  const out = [], err = [];
  const io = { paths: { state: '/s' }, runtimes: { uv: '/k/uv' }, out: (l) => out.push(l), err: (l) => err.push(l) };
  assert.equal(await cmdMarkets([], io), 2);
  assert.equal(await cmdMarkets(['status'], { ...io, statusImpl: () => ({ ok: false, why: 'not installed (kingmaker markets install)' }) }), 1);
  let asked;
  assert.equal(await cmdMarkets(['install'], { ...io, installImpl: (o) => { asked = o; return { ok: true, commit: TRADING_AGENTS_SOURCE.commit, rea: { verdict: 'clean' } }; } }), 0);
  assert.equal(asked.uv, '/k/uv');
  let opts;
  assert.equal(await cmdMarkets(['nvda', '--rounds', '2'], { ...io, analyzeImpl: async (o) => { opts = o; return { ok: true, ticker: 'NVDA', date: '2026-10-16', rating: 'Hold', decision: 'Hold.' }; } }), 0);
  assert.deepEqual(opts, { state: '/s', ticker: 'nvda', rounds: '2' });
  assert.equal(out.at(-1), DISCLAIMER);
  assert.equal(await cmdMarkets(['NVDA', 'AAPL'], io), 2);
});

test('the core skill ships (REA clean, Ronin licence) and picks up a request to research a ticker', () => {
  const skills = builtInSkills(null);
  const ta = skills.find((s) => s.name === 'trading-agents');
  assert.ok(ta?.enabled, 'shipped and on');
  assert.equal(pickBuiltInSkill('what do the trading agents think of NVDA', skills)?.name, 'trading-agents');
  assert.equal(pickBuiltInSkill('research the stock ticker NVDA and rate it', skills)?.name, 'trading-agents');
});
