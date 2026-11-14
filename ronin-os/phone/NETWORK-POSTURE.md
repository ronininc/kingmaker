# Network posture — cellular & satellite (OWNER AMENDMENT 2026-11-14)
- The mesh does not care about the bearer. WireGuard+Rosenpass (kernel design §2) runs over
  whatever path exists; the tunnel is the law, the radio is plumbing.
- CELLULAR = an independent, first-class mesh path — not a fallback for Wi-Fi. A phone seat keeps
  mesh presence on cellular alone: portions stream metered over it (the 1 MiB pin-verified portion
  is a cellular-friendly unit), and the path's independence is the point: a phone whose Wi-Fi is
  hostile or absent is still a sovereign node, reachable and originating.
- SATELLITE = a narrowband signaling/continuity channel ONLY. It carries the 35-byte heartbeat
  (`src/heartbeat.mjs`: state, trust, sequence, timestamp, truncated attestation digest, session
  MAC) — proof of life, posture, and attestation continuity while out of terrestrial reach. It
  NEVER carries portions, jobs, or content: a 1 MiB portion is ~30,000 satellite messages. When a
  broadband path returns, the queued full attestations and receipts ride it and the heartbeat
  sequence shows there was no gap in the machine's account of itself.
- Ordering rule: broadband (Wi-Fi/cellular) > satellite-heartbeat > silence. Silence is SEALED's
  home condition (§7.3): the machine keeps working locally and its logs queue — the heartbeat is
  what lets the origin distinguish "sealed and well" from "gone".
