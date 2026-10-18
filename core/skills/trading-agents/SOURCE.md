# Source: trading-agents

- A core ability that runs TradingAgents (https://github.com/TauricResearch/TradingAgents, Apache-2.0) on this Mac,
  added 2026-10-16 at the owner's request ("taking what we can from it since it's open source and giving it to
  Kingmaker as an ability").
- TradingAgents itself is NOT vendored. `kingmaker markets install` clones it at the commit pinned in
  lib/trading-agents.mjs (TradingAgents 0.6.0, 1394a3f72aa4) into Kingmaker's data folder, where its own Apache-2.0
  LICENSE stays with it, and REA reads it before it may run.
- This folder is Kingmaker's own prose and driver wiring, under Kingmaker's LICENSE.
