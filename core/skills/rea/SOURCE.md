# Source: rea

- Kingmaker's own skill for its built-in REA gate (`lib/rea.mjs`), added 2026-10-16 at the owner's request ("make the
  cli anything and rea skills as shipping as core capabilities").
- The reverse-engineering method it points to is `core/skills/clone/references/reverse-engineer-anything`
  (https://github.com/morluto/rea, MIT, its LICENSE kept there). That text does not install an engine.
- The R&D floor (`lib/rd-floor.mjs`, `kingmaker rd`, `docs/RD-FLOOR.md`) is the analysis engine, pinned to
  morluto/rea @ 40b9c03 / rea-agents 6.8.0 after the licence audit. The toolkit is not imported.
