# iOS — the walls, NAMED, not solved (OWNER AMENDMENT 2026-11-14)
The iOS claim today is APP-LAYER ONLY. These are platform facts, not engineering TODOs:
1. **No background daemon.** iOS kills backgrounded apps on its own schedule; BGTaskScheduler is
   opportunistic and system-timed, not a daemon. There is no KeepAlive equivalent an App Store app
   may hold. Consequence: on iOS the engine's presence is foreground-session + opportunistic
   background refresh. Jobs conducted while the app is suspended resume on return; receipts queue
   in the engine's records (§7.1's discipline carries the design through the wall).
2. **No JIT.** Just-in-time compilation is reserved to Apple's own processes (and, in the EU,
   alternative-marketplace browsers under separate rules). WKWebView's JavaScriptCore JIT is
   Apple's; a Ronin engine process cannot JIT its own model/runtime code. Consequence: on-device
   inference on iOS runs interpreted/compiled-ahead paths only — slower floor, same architecture;
   the selector escalates more readily. The wall is named in the phone profile's iOS row rather
   than papered over.
3. **No full-screen takeover.** There is no presentation-options kiosk for a normal app, no login
   item, no session replacement. The iOS surface is a full-screen app while foregrounded — the
   hosted mounting at its most honest: identity, sealing, and authenticated origination are
   guaranteed (they live in the stack's stores, not the session); availability and exclusivity
   are not, and on iOS that sentence is stronger than on macOS.
4. **What DOES work on iOS:** the identical surface (WKWebView over the loopback server while
   foregrounded), attest-grade entry via the installed stack's own checks (SEALED-ENTRY vocabulary,
   §6.1 — the hosted grade, never borrowed native words), sealed data at rest, mesh presence while
   the app lives, satellite/cellular heartbeat posture unchanged (the heartbeat is 35 bytes; it
   fits any bearer the platform allows the app to touch).
Grade: WALL — by platform design, documented as the product truth for iOS, not a defect list.
