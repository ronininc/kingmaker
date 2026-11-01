// `kingmaker markets`: the TradingAgents ability from the terminal (lib/trading-agents.mjs). Research only.
//   kingmaker markets install | status
//   kingmaker markets <TICKER> [--date YYYY-MM-DD] [--model M] [--deep-model M] [--analysts market,news] [--rounds N] [--crypto]
import { analyze, ANALYSTS, DISCLAIMER, install, resultLines, status, TRADING_AGENTS_SOURCE } from './trading-agents.mjs';

const USAGE = `usage: kingmaker markets install | status | <TICKER> [--date YYYY-MM-DD] [--model M] [--deep-model M] [--analysts ${ANALYSTS.join(',')}] [--rounds 1-3] [--crypto]\n${DISCLAIMER}`;
const VALUED = new Set(['--date', '--model', '--deep-model', '--analysts', '--rounds']);

/** Pure: the words and --flags of a markets command. → { words, opts } or { error }. */
export function parseMarketsArgs(args) {
  const words = [], opts = {};
  for (let i = 0; i < args.length; i += 1) {
    const a = String(args[i]);
    if (a === '--crypto') { opts.crypto = true; continue; }
    if (VALUED.has(a)) {
      const v = args[i + 1];
      if (v == null || String(v).startsWith('--')) return { error: `${a} needs a value.` };
      opts[a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(v); i += 1; continue;
    }
    if (a.startsWith('--')) return { error: `${a} isn't a markets option.` };
    words.push(a);
  }
  return { words, opts };
}

export async function cmdMarkets(args, { paths, runtimes, out = console.log, err = console.error, installImpl = install, analyzeImpl = analyze, statusImpl = status }) {
  const parsed = parseMarketsArgs(args);
  if (parsed.error) { err(`✗ ${parsed.error}\n${USAGE}`); return 2; }
  const { words, opts } = parsed;
  const [first] = words;
  if (!first) { err(USAGE); return 2; }
  if (first === 'status') {
    const s = statusImpl({ state: paths.state });
    out(s.ok ? `TradingAgents ${s.version} at ${s.commit.slice(0, 12)} (${TRADING_AGENTS_SOURCE.license}), REA: ${s.rea?.verdict ?? '?'}. ${DISCLAIMER}` : `TradingAgents is ${s.why}.`);
    return s.ok ? 0 : 1;
  }
  if (first === 'install') {
    out(`Installing TradingAgents ${TRADING_AGENTS_SOURCE.version} (${TRADING_AGENTS_SOURCE.repo} @ ${TRADING_AGENTS_SOURCE.commit.slice(0, 12)}, ${TRADING_AGENTS_SOURCE.license}) with its own Python, into Kingmaker's data folder. A few hundred MB.`);
    const r = installImpl({ state: paths.state, uv: runtimes?.uv, log: out });
    out(r.ok ? `✓ TradingAgents ${r.already ? 'is already' : 'is'} installed at ${r.commit.slice(0, 12)}; REA: ${r.rea?.verdict}.` : `✗ ${r.error}`);
    return r.ok ? 0 : 1;
  }
  if (words.length > 1) { err(`✗ One ticker at a time.\n${USAGE}`); return 2; }
  out(`The TradingAgents desk is studying ${first.toUpperCase()}. On a local model this takes several minutes.`);
  const r = await analyzeImpl({ state: paths.state, ticker: first, ...opts }, { onLine: (l) => out(`  ${l}`) });
  for (const line of resultLines(r)) out(line);
  return r.ok ? 0 : 1;
}
