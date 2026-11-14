# Phone resource profile (OWNER AMENDMENT 2026-11-14) — derived alongside the desktop budgets (§10)

The phone is a first-class target class: it is *better* suited to this architecture — the metered
doctrine never needed a big resident machine, and the phone's radios are its mesh bearers (§NETWORK).

## What a phone-class device holds at HOME — PROVEN parts
- The surface: rendered under a 96 MB heap cap (a phone webview's practical per-renderer class):
  HOME field 1,519 B rendered in 11.2 ms cold, WALL 2,431 B in 0.28 ms warm, heap used 8.1 MB
  (`measure-output.txt`). Against the desktop budget (≤350 MB frame+renderer), the surface is not
  the constraint on any class. The phone surface budget is set at **≤120 MB** (webview + frame)
  with the same degradation ladder (§7.4) shedding animation -> WALL -> panels -> text-evidence.
- The posture/state machinery, job inbox, audit chain: file-and-record scale, kilobytes. No grade
  difference from desktop.

## What a phone-class device holds at HOME — DERIVED (selector's arithmetic, not a measurement here)
- Engine floor, resident: the router-class pick only. Fleet bench record (M3/8 GB): the 0.6B router
  at 0.89 GB resident / 135.8 tok/s; the smallest-sufficient selector (PR #143) makes the same pick
  on a phone and flips delivery to metered-stream as free memory shrinks — on the owner's 8 GB bench
  a busy-device coding pick already flipped to metered-stream with the pick unchanged. On a phone
  (6-8 GB class, OS + radios resident), the honest expectation: router resident (~1 GB class),
  writer/coder/vision delivered as metered portions or escalated to a docked bigger node — the
  delivery plan changes, the capability doesn't. This is DERIVED from the bench record + the
  selector's proven behavior, not measured on a phone in this build.
- NPU: acceleration only, never a requirement (standing doctrine). Where the platform runtime
  exposes it (MLX/ANE on Apple silicon, NNAPI-class on Android), the floor model may use it; the
  profile budgets as if it were absent.
- Thermal caps: phones throttle sustained compute in a way laptops don't. The profile's rule:
  conduction on a phone is BURST-shaped — short conducted jobs, portions pulled just-in-time;
  sustained heavy conduction (renders, big training passes) escalates to a docked node by the
  selector's existing escalation shape rather than cooking the handset. WALL density auto-sheds
  under thermal pressure via the same governor signal as §7.4.

## Grades
Surface budget: DONE-PROVEN (measured under cap). Engine-floor residency on a real handset:
UNMEASURED here — the first phone bench is an owner seat act (BUILD-REPORT), the same bench
discipline as the desktop (loaded device, working conditions, swap/thermal recorded not excused).
