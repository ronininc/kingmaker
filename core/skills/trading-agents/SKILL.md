---
name: trading-agents
description: >-
  Research a stock, ETF or crypto ticker with a desk of AI analysts (market, social sentiment, news, fundamentals) that
  debate it and rate it Buy, Overweight, Hold, Underweight or Sell, with the reports behind the rating. Use when the
  owner asks what the analysts think of a ticker, wants a stock researched, or asks for a buy/hold/sell view. Research
  only: it never places a trade.
---

# Trading desk (TradingAgents)

TradingAgents (TauricResearch, Apache-2.0) runs a desk of analysts on this Mac's own local models. For one ticker as of
one date, the market, sentiment, news and fundamentals analysts write reports, a bull and a bear researcher debate them,
a trader proposes, a risk team argues it, and a portfolio manager gives the rating.

## When to use it

- "What do the analysts think of NVDA?", "research Apple stock", "should I hold BTC?", "rate TSLA as of last Friday".
- Not for live prices or a quick quote: a desk run takes minutes on a local model.

## How Kingmaker runs it

1. **Installed?** `kingmaker markets status`. If not, offer `kingmaker markets install` (one ask; it fetches the pinned
   TradingAgents and its own Python, a few hundred MB, into Kingmaker's data folder).
2. **Run it.** `kingmaker markets <TICKER>` with `--date YYYY-MM-DD` for a past date (default today). Narrow it with
   `--analysts market,news` to go faster, or `--rounds 2` for a longer debate. Crypto tickers end in `-USD`.
3. **Answer.** Say the rating and the portfolio manager's reasoning in a few plain sentences, then where the full
   reports are. Always end with: research from AI analysts, not financial advice.

## Boundary

- Research only. Kingmaker never places, stages or schedules a trade, never connects a brokerage, and never moves money
  on this ability's say. If the owner asks it to buy or sell, say so and leave the trade to them.
- Never present the rating as advice tailored to the owner's situation, or as certain.
- Only the ticker leaves the Mac, to public market-data sources (Yahoo Finance, SEC EDGAR, Polymarket, Reddit,
  StockTwits). The analysts think on the local models; no API key is used.
