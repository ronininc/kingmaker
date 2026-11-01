// ADAPTIVE PACER: background work that scales back and up with the Mac, like a download on a metered link.
//
// Operator (2026-10-07): "ghost os shouldnt have a budget. it should work like download speed over a metered
// network autoscaling back to preserve congruent performance on the mac rather than hitting a ceiling".
//
// A port of the engine's own pacer (same numbers) for work Kingmaker runs
// itself, outside the core: a long job is never refused or failed for a busy Mac. It runs at a DUTY CYCLE: in each
// 2 s period its process group runs for duty × 2 s and is paused (SIGSTOP) for the rest, then resumed (SIGCONT).
// The duty follows AIMD, the rule TCP uses to share a link: under congestion it halves (critical memory pressure
// drops it to the floor), with headroom it grows by a tenth, so the job takes whatever share keeps the Mac
// responsive and all of it when the Mac is idle. stop() always leaves the group RUNNING.
//
// Congestion = memory pressure warning/critical, paging over 8 MB/s, a recorded thermal or performance warning,
// or under 8% CPU idle. Kingmaker's process has no memory monitor to ride (the core's lives in the core), so the
// live source reads the kernel's own counters every 3 s ONLY while a job is being paced: the same justified,
// bounded fallback the engine's pacer uses without a monitor; there is no OS event for "memory pressure changed"
// reachable from Node.

import { execFile } from 'node:child_process';
import { cpus as osCpus, platform } from 'node:os';
import { defaultMeetingHoldReader } from './meeting.mjs';

export const MIN_DUTY = 0.1;
export const DUTY_STEP_UP = 0.1;
export const PACE_PERIOD_MS = 2_000;
export const SAMPLE_MS = 3_000;
const PAGING_CONGESTED_BPS = 8 * 1024 * 1024;
const CPU_IDLE_CONGESTED = 0.08;
const round = (n) => Math.round(n * 100) / 100;

/** Pure: one AIMD step (adaptive-pacer.ts nextDuty). */
export function nextDuty(duty, s) {
  // The owner's meeting comes first: hold the job paused (never killed) until the hold ends, then ramp back gently.
  if (s.meeting) return { duty: 0, congested: true, why: 'owner meeting: background paused' };
  const reasons = [];
  if (s.pressureLevel === 'critical') reasons.push('memory pressure critical');
  else if (s.pressureLevel === 'warning') reasons.push('memory pressure warning');
  if (s.pagingBytesPerSecond !== null && s.pagingBytesPerSecond > PAGING_CONGESTED_BPS) reasons.push(`paging ${Math.round(s.pagingBytesPerSecond / 1048576)} MB/s`);
  if (s.thermal === 'hot') reasons.push('the Mac is hot');
  if (s.cpuIdle !== null && s.cpuIdle < CPU_IDLE_CONGESTED) reasons.push(`CPU ${Math.round((1 - s.cpuIdle) * 100)}% busy`);
  if (reasons.length) {
    const next = s.pressureLevel === 'critical' ? MIN_DUTY : Math.max(MIN_DUTY, round(duty / 2));
    return { duty: next, congested: true, why: reasons.join(', ') };
  }
  return { duty: Math.min(1, round(duty + DUTY_STEP_UP)), congested: false, why: 'headroom' };
}

/** Pure: where a job starts from one reading: a busy Mac starts it gently rather than holding it back. */
export function startingDuty(s) {
  if (s.meeting) return MIN_DUTY; // the first sample pauses it fully
  if (s.pressureLevel === 'critical') return MIN_DUTY;
  const d = nextDuty(1, s);
  return d.congested ? Math.max(0.25, d.duty / 2) : 1;
}

/** Pure: CPU idle fraction between two os.cpus() snapshots. */
export function cpuIdleBetween(a, b) {
  let idle = 0; let total = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    const ta = a[i].times; const tb = b[i].times;
    const d = (k) => Math.max(0, tb[k] - ta[k]);
    const sum = d('user') + d('nice') + d('sys') + d('idle') + d('irq');
    idle += d('idle'); total += sum;
  }
  return total > 0 ? idle / total : null;
}

/** Pure: sysctl kern.memorystatus_vm_pressure_level → level (NOTE_MEMORYSTATUS flags: 1, 2, 4). */
export function parsePressureLevel(value) {
  const flag = String(value ?? '').trim();
  return flag === '1' ? 'normal' : flag === '2' ? 'warning' : flag === '4' ? 'critical' : 'unknown';
}

/** Pure: vm_stat → bytes swapped in + out so far, or null. */
export function parseSwapCounters(text) {
  const pageSize = Number(/page size of (\d+) bytes/.exec(String(text))?.[1]);
  const ins = /Swapins:\s+(\d+)/.exec(String(text));
  const outs = /Swapouts:\s+(\d+)/.exec(String(text));
  if (!Number.isFinite(pageSize) || pageSize <= 0 || !ins || !outs) return null;
  return (Number(ins[1]) + Number(outs[1])) * pageSize;
}

/** Pure: pmset -g therm → 'hot' | 'nominal' | 'unknown' (host-guard.ts parsePmsetTherm). */
export function parseThermal(text) {
  const t = String(text ?? '');
  if (!t.trim()) return 'unknown';
  const level = (rx) => { const m = rx.exec(t); return m ? Number(m[1]) : null; };
  if ((level(/thermal\s+warning\s+level\s*[:=]\s*(\d+)/i) ?? 0) > 0) return 'hot';
  if ((level(/performance\s+warning\s+level\s*[:=]\s*(\d+)/i) ?? 0) > 0) return 'hot';
  const speed = level(/CPU_Speed_Limit\s*=\s*(\d+)/i);
  return speed !== null && speed < 100 ? 'hot' : 'nominal';
}

const read = (file, args) => new Promise((resolve) => {
  execFile(file, args, { timeout: 1_500, encoding: 'utf8' }, (error, stdout) => resolve(error ? '' : String(stdout)));
});

/**
 * The live signal source: subscribe(fn) samples the kernel every SAMPLE_MS while subscribed and stops when
 * unsubscribed. `extra(sample)` lets a job watch something of its own on the same samples (the disk floor).
 */
export function liveSignalSource({ readText = read, cpus = osCpus, sampleMs = SAMPLE_MS, now = () => performance.now(), meetingHold = defaultMeetingHoldReader() } = {}) {
  return {
    subscribe(fn) {
      if (platform() !== 'darwin' && readText === read) return () => {};
      let last = cpus();
      let lastSwap = null;
      let samples = 0;
      let thermal = 'unknown';
      let busy = false;
      const timer = setInterval(() => {
        if (busy) return;
        busy = true;
        void (async () => {
          const [pressure, vm] = await Promise.all([readText('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level']), readText('/usr/bin/vm_stat', [])]);
          if (samples++ % 5 === 0) thermal = parseThermal(await readText('/usr/bin/pmset', ['-g', 'therm']));
          const swap = parseSwapCounters(vm);
          const at = now();
          const paging = swap !== null && lastSwap ? Math.max(0, (swap - lastSwap.bytes) / Math.max(0.001, (at - lastSwap.at) / 1000)) : null;
          if (swap !== null) lastSwap = { bytes: swap, at };
          const c = cpus();
          const cpuIdle = cpuIdleBetween(last, c);
          last = c;
          fn({ pressureLevel: parsePressureLevel(pressure), pagingBytesPerSecond: paging, thermal, cpuIdle, meeting: Boolean(meetingHold()) });
        })().catch(() => {}).finally(() => { busy = false; });
      }, sampleMs);
      timer.unref?.();
      return () => clearInterval(timer);
    },
  };
}

/**
 * Pace one running process group (adaptive-pacer.ts pacerFor). start() begins the duty cycle; stop() always leaves
 * the group RUNNING (SIGCONT), whatever happened, so a job is never left frozen.
 */
export function pacerFor(pgid, { initialDuty = 1, source = liveSignalSource(), onChange = () => {}, onSignals = () => {}, signal, periodMs = PACE_PERIOD_MS, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const send = signal ?? ((id, sig) => { try { process.kill(-id, sig); } catch { /* the group is gone */ } });
  let duty = Math.min(1, Math.max(MIN_DUTY, initialDuty));
  let minDuty = duty; let minWhy = 'start'; let changes = 0; let lastWhy = 'start';
  let paused = false; let timer = null; let stopped = false; let unsubscribe = null;
  const resume = () => { if (paused) { send(pgid, 'SIGCONT'); paused = false; } };
  const pause = () => { if (!paused) { send(pgid, 'SIGSTOP'); paused = true; } };
  const arm = (fn, ms) => { timer = setTimer(fn, ms); timer?.unref?.(); };
  const cycle = () => {
    if (stopped) return;
    if (duty <= 0) { pause(); arm(cycle, periodMs); return; } // meeting hold: stay paused, re-check each period
    resume();
    if (duty >= 1) { arm(cycle, periodMs); return; }
    arm(() => {
      if (stopped) return;
      pause();
      arm(cycle, Math.round(periodMs * (1 - duty)));
    }, Math.max(1, Math.round(periodMs * duty)));
  };
  // If Kingmaker exits while the group is paused (a meeting hold can last hours), leave it running, never frozen.
  const onExit = () => { try { send(pgid, 'SIGCONT'); } catch { /* gone */ } };
  return {
    start() {
      process.once('exit', onExit);
      unsubscribe = source.subscribe((s) => {
        try { onSignals(s); } catch { /* a watcher never breaks pacing */ }
        const d = nextDuty(duty, s);
        if (d.duty !== duty) {
          duty = d.duty; changes += 1; lastWhy = d.why;
          if (duty < minDuty) { minDuty = duty; minWhy = d.why; }
          try { onChange(d); } catch { /* reporting only */ }
        }
      });
      cycle();
    },
    stop() {
      process.removeListener('exit', onExit);
      stopped = true;
      if (timer) clearTimer(timer);
      unsubscribe?.();
      resume();
      return { duty, minDuty, changes, lastWhy, minWhy };
    },
    get duty() { return duty; },
    get paused() { return paused; },
  };
}
