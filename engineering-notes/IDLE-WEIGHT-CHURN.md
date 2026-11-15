# Idle weight churn scheduling (staged, not enabled)

`lib/idle-weight-churn.mjs` supplies a two-hour actual OS input-idle gate and an injected cancellable local-only worker contract. It does not train, download, admit or select weights itself. Do not wire it to the existing monthly Hugging Bay rotation (that can download models).

## Integration

Create `createMacIdleObserver({directory: paths.state})`; pass that to `createIdleWeightChurn({observe,run,busy,log})`. `run({signal,localOnly,allowDownloads})` must execute only an admitted bounded local job, honor cancellation before each operation, terminate its subprocesses on abort, and return actual evidence, not a plan marked as learning. Wire foreground busy to voice/turn/render work. Start with session lifecycle; call stop and await settled during shutdown. No CLI integration or persistent service is enabled in this commit because there is not yet a verified cancellable admitted worker wired to it.

## Behavior

- Poll every 5 seconds; require OS idle >= 2 hours and >= 2 hours continuous observations in this process. Restart conservatively restarts observation.
- App/background requests cannot manufacture or reset OS user-idle. Any decreasing HID idle, missing sensor, >3 polling-period gap (including sleep) or backwards monotonic clock resets observation and aborts active work.
- AC power required, >=25% system-wide memory headroom and no change in either swap counter across two 1–15 second samples, >=512 MiB free disk and >=256 MiB free RAM. This is a conservative headroom/paging policy, NOT a claim of normal kernel memory pressure. Unknown readings fail closed. Foreground busy blocks/cancels.
- One attempt per idle episode; no retries on failing jobs in same episode. 15-minute run deadline requests cancellation.
- AbortSignal is a cancellation request, not proof of process termination. The worker adapter owns subprocess termination; `settled()` waits for exit. A noncooperative worker is an integration bug, not a stopped job.
- No filesystem cleanup, persistent settings, credential operations, downloading or daemon activation.

## Verification

18 focused tests pass on host Node, covering timing, user return, unknown activity, restart, suspension/clock discontinuity, battery and unknown power, low disk/RAM, pressure, busy foreground, run deadline, stop and worker failures. All use deterministic fake time; no two-hour real-world run or training was performed.

Live read-only probe: HIDIdleTime and AC status work on this Mac. The kernel pressure sysctl was denied, so the macOS observer now uses `/usr/bin/memory_pressure -Q` (only that query flag) plus `/usr/bin/vm_stat`. It does not use -l, -p or -S, which generate/simulate pressure. Strict parsing rejects missing, duplicate/out-of-range headroom and missing swap counters. First sample, failed read, swap activity, clock discontinuity and stale pair fail closed. No permission escalation attempted.

Actual two-sample read-only proof: 64% headroom, unchanged swap counters after five seconds, 3.47 GB free disk, AC true. The first sample blocked for lacking a previous swap sample; the second blocked because OS free RAM was 246,398,976 bytes, below the 256 MiB reserve. No work started. Unlike the denied pressure signal, this observer supplies usable measurements without interpreting headroom as a pressure level. Thresholds are conservative admission policy, not an OOM guarantee.
