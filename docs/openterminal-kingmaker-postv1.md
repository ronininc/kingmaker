# Build Order: OpenTerminal as Kingmaker Market-Data Method (POST-V1)

**Status:** QUEUED — not for first Kingmaker release. Route after v1 ships.
**Source reel:** https://www.instagram.com/reel/DdLBNl1Dq_S/ (gittrend.io, 2026-09-11)
**Repo:** https://github.com/ErTasselli/OpenTerminal
**License:** MIT — clean. Commercial use, modification, and redistribution permitted with attribution. No copyleft. No license risk.

---

## What it is

A terminal-style trading dashboard built entirely on free public market data. Dark, dense, keyboard-driven. Twelve draggable widgets: candlestick charts (8 timeframes, 6 indicators), live US market heatmap, options chain, crypto board, macro dashboard, earnings/economic calendar, local portfolio tracker. No signup, no API keys, no subscriptions.

## What it is NOT

A trading engine. It visualizes — it does not execute. No broker connections, no order routing, no backtesting, no strategy automation. Do not present it as a Bloomberg replacement for execution workflows. Bloomberg's $24K/year buys execution, proprietary data, and chat. This is a free dashboard.

## Vet results (2026-10-17, cloned and inspected)

### Clean
- MIT license, copyright 2026, no copyleft contamination.
- Real fallback-chain architecture (`server/src/providers/registry.ts`): every data endpoint has ordered fallbacks with per-provider health tracking (latency, success/failure counts, last error). A single provider outage never kills the app. This is the pattern worth absorbing.
- 12 data providers: Yahoo Finance, Stooq, Nasdaq, SEC EDGAR, FRED, FINRA, ECB, CoinGecko, Binance, TradingView, econ calendar, news.
- Honest maintenance: README documents its own `npm audit` findings (fast-xml-parser, postcss-in-Next.js) rather than hiding them. Active issue tracker, recent merges.
- Local-first: SQLite (WAL mode) portfolio tracker, binds to 127.0.0.1 by default, documented security defaults for exposure.

### Bugs / issues (17 open, from GitHub API)
- **#24 — TradingView provider spoofs Referer/Origin/User-Agent to bypass anti-scraping.** This is the biggest risk. It works today, it can break tomorrow, and it sits in a ToS gray area. Any Kingmaker integration must treat TradingView as an unreliable source and never depend on it alone. Prefer Yahoo/Stooq/Nasdaq paths.
- **#46** — earnings dates, option expiries, RSI boundary bugs (data correctness).
- **#38** — heatmap layout shifts across polls (UI stability).
- **#45, #29** — npm audit vulnerabilities, thin test coverage.
- **#42, #41, #40, #28, #27, #26, #25** — Docker/CI hygiene: images run as root, no .dockerignore, `npm install` instead of `npm ci`. Fix before any Kingmaker-bundled deployment.

### Missing pieces (for Kingmaker context)
- No price alerts (#43 requests it).
- No options Greeks (#43 requests it).
- No broker/execution layer (by design — dashboard only).
- No backtesting.
- **AI assistant defaults to Claude Opus 4-8 via Anthropic API key.** Paid dependency, ironic in a "free" terminal, and wrong for Kingmaker. Must be repointed at the local model router before integration. The assistant endpoint is cleanly separated (`server/src/routes/ai.ts`) — swap the client, keep the interface.
- No mobile layout mentioned.

---

## Integration plan (post-v1)

### Phase 1 — Absorb the data layer
1. Extract the provider registry + fallback-chain pattern into a Kingmaker market-data method. Keep: `tracked()`, `withFallback()`, provider health stats. This is the real prize — resilient free market data with zero API keys.
2. Port providers in reliability order: Yahoo → Stooq → Nasdaq → SEC EDGAR → FRED → CoinGecko → Binance → ECB/FINRA → econ calendar → news. TradingView LAST, flagged unreliable, never sole-source.
3. Fix Docker hygiene before bundling: non-root USER, .dockerignore, `npm ci`, pinned lockfile install.

### Phase 2 — Repoint the AI
4. Replace the Anthropic client in the AI route with Kingmaker's local model router. Same interface (messages + JSON market context in), local inference out. Zero API spend.
5. Keep the system prompt's "not a licensed financial advisor" guardrail. Add: never personalized investment advice, never buy/sell instructions — analysis only.

### Phase 3 — Dashboard as Kingmaker cohort
6. Ship the dashboard as an optional Kingmaker cohort (local web UI, 127.0.0.1 default). Rename/rebrand per Ronin visual direction (noir grade).
7. Add price alerts and options Greeks (closes #43's feature asks — contribute upstream).
8. Fix #46 (earnings dates, option expiries, RSI) before presenting data as reliable.

### Do NOT
- Do not depend on the TradingView scraper as a primary source.
- Do not ship with the Anthropic API key path as the default AI backend.
- Do not present it as an execution terminal. Dashboard only.
- Do not bundle before the Docker/CI hygiene fixes land.

---

## Why post-v1

Kingmaker v1 is the uncensored local agent. A market-data dashboard is a cohort, not core. It also gives the trading engines (Kronos, Copy Trader) a free visualization layer and a proven free-data pattern — but neither needs it to ship. Queue it, don't block on it.

## Acceptance
- [ ] License verified MIT (done 2026-10-17)
- [ ] Provider fallback chain ported and tested with simulated provider outages
- [ ] TradingView isolated as unreliable/optional source
- [ ] AI route repointed to local model router, zero external API calls in default config
- [ ] Docker images run non-root, .dockerignore present, `npm ci` in CI
- [ ] Price alerts + options Greeks working
- [ ] #46 data-correctness bugs fixed or documented
- [ ] Dashboard renders in Ronin noir direction
- [ ] Robbie taps before it ships as a cohort
