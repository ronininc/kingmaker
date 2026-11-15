// Idle scheduling, NOT training/admission. An admitted cancellable local-only worker must be supplied.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { statfs } from 'node:fs/promises';
import { platform, freemem } from 'node:os';
export const WEIGHT_IDLE_MS = 2 * 60 * 60_000;
const MiB = 1024 * 1024;
export function parseHidIdle(text) {
  const m = /"HIDIdleTime"\s*=\s*(\d+)/.exec(String(text));
  const value = m ? Number(m[1]) / 1e6 : NaN;
  return Number.isFinite(value) && value >= 0 ? value : null;
}
export function parseMemoryHeadroom(text) {
  const matches = [...String(text).matchAll(/^System-wide memory free percentage:\s*(\d+)%\s*$/gm)];
  if (matches.length !== 1) return null;
  const pct = Number(matches[0][1]); return pct >= 0 && pct <= 100 ? pct : null;
}
export function parseSwapPages(text) {
  const ins = /^Swapins:\s*(\d+)\.\s*$/m.exec(String(text));
  const outs = /^Swapouts:\s*(\d+)\.\s*$/m.exec(String(text));
  if (!ins || !outs) return null;
  const values = [Number(ins[1]),Number(outs[1])];
  return values.every(Number.isSafeInteger) ? values : null;
}
// -Q alone is a read-only headroom query; never use -l/-p/-S (pressure generators).
// Headroom is NOT the kernel pressure level. The alternate guard reports its own evidence.
export function createMacIdleObserver({ directory, read = promisify(execFile), disk = statfs,
  hostPlatform = platform, freeMemory = freemem, now = () => performance.now() } = {}) {
  let previousSwap = null;
  return async () => {
    if (hostPlatform() !== 'darwin' || !directory) return null;
    try {
      const opts = { timeout: 1500, maxBuffer: 1024 * 1024, encoding: 'utf8' };
      const [hid, power, headroom, vm, space] = await Promise.all([
        read('/usr/sbin/ioreg', ['-c', 'IOHIDSystem', '-r', '-d', '1'], opts),
        read('/usr/bin/pmset', ['-g', 'batt'], opts),
        read('/usr/bin/memory_pressure', ['-Q'], opts), read('/usr/bin/vm_stat', [], opts), disk(directory),
      ]);
      const swap = parseSwapPages(vm.stdout), at = now();
      const stable = Boolean(swap && previousSwap && at - previousSwap.at >= 1000 && at - previousSwap.at <= 15000 &&
        swap.every((value,index) => value === previousSwap.values[index]));
      previousSwap = swap ? { values: swap, at } : null;
      return { idleMs: parseHidIdle(hid.stdout), acPower: /Now drawing from 'AC Power'/.test(power.stdout),
        memoryGuardSource: 'headroom-and-swap', memoryHeadroomPercent: parseMemoryHeadroom(headroom.stdout), swapStable: stable,
        diskFreeBytes: Number(space.bavail) * Number(space.bsize), memoryFreeBytes: freeMemory() };
    } catch { previousSwap = null; return null; }
  };
}
export function idleChurnBlock(s, { minDiskBytes = 512 * MiB, minMemoryBytes = 256 * MiB } = {}) {
  if (!s || !Number.isFinite(s.idleMs) || s.idleMs < 0) return 'activity-unknown';
  if (s.acPower !== true) return 'power-unavailable';
  if (s.memoryGuardSource === 'headroom-and-swap') {
    if (!Number.isFinite(s.memoryHeadroomPercent) || s.memoryHeadroomPercent < 25 || s.memoryHeadroomPercent > 100 || s.swapStable !== true) return 'memory-headroom-or-paging';
  } else if (s.pressureNormal !== true) return 'memory-pressure';
  if (!Number.isFinite(s.diskFreeBytes) || s.diskFreeBytes < minDiskBytes) return 'disk-reserve';
  if (!Number.isFinite(s.memoryFreeBytes) || s.memoryFreeBytes < minMemoryBytes) return 'memory-reserve';
  return null;
}
/** Polls actual OS input idle, not app requests. Never schedules before two hours observed
 * in this process. Unknown activity/suspend/clock discontinuity resets that observation.
 * At most one attempt per idle episode (also on failure); no automatic retry storm.
 * Worker MUST honor signal before each bounded operation and kill its subprocess on abort.
 * stop() requests cancellation; settled() confirms worker exit, not merely signal dispatch.
 */
export function createIdleWeightChurn({ observe, run, busy = () => false, log = () => {},
  now = () => performance.now(), idleMs = WEIGHT_IDLE_MS, pollMs = 5000,
  maxRunMs = 15 * 60_000, limits = {}, setIntervalImpl = setInterval, clearIntervalImpl = clearInterval } = {}) {
  if (typeof observe !== 'function' || typeof run !== 'function') throw Error('idle churn requires observer and cancellable local worker');
  if (![idleMs,pollMs,maxRunMs].every(n => Number.isFinite(n) && n > 0) || idleMs < WEIGHT_IDLE_MS) throw Error('invalid idle churn timing');
  let timer, checking = false, stopped = false, previous = null, idleSince = now(), attempted = false;
  let active = null, pending = Promise.resolve(), lastBlock = 'observing';
  const emit = (event, detail) => { try { log(event, detail); } catch {} };
  const cancel = reason => { if (active && !active.controller.signal.aborted) { active.controller.abort(new Error(reason)); emit('idle_weight_churn_cancel', { reason }); } };
  const reset = at => { idleSince = at; attempted = false; };
  const tick = async () => {
    if (checking || stopped) return false;
    checking = true;
    try {
      let s; try { s = await observe(); } catch { s = null; }
      const at = now(); if (stopped) return false;
      const gap = previous && (at < previous.at || at - previous.at > pollMs * 3);
      const returned = previous && Number.isFinite(s?.idleMs) && s.idleMs < previous.idleMs;
      const unknown = !s || !Number.isFinite(s.idleMs) || s.idleMs < 0;
      if (gap || returned || unknown) reset(at);
      previous = unknown ? null : { at, idleMs: s.idleMs };
      lastBlock = gap ? 'observation-gap' : unknown ? 'activity-unknown' : returned ? 'user-returned' : idleChurnBlock(s, limits);
      if (!lastBlock && busy()) lastBlock = 'foreground-busy';
      if (!lastBlock && (s.idleMs < idleMs || at - idleSince < idleMs)) lastBlock = 'not-idle-two-hours';
      if (active && at - active.started >= maxRunMs) lastBlock = 'run-deadline';
      if (lastBlock) { cancel(lastBlock); return false; }
      if (active || attempted) return false;
      attempted = true;
      const job = { controller: new AbortController(), started: at }; active = job;
      pending = Promise.resolve().then(() => {
        job.controller.signal.throwIfAborted();
        return run({ signal: job.controller.signal, localOnly: true, allowDownloads: false });
      }).then(result => emit('idle_weight_churn_result', { cancelled: job.controller.signal.aborted, result }),
        error => emit('idle_weight_churn_error', { cancelled: job.controller.signal.aborted, error: String(error?.message || error) }))
        .finally(() => { if (active === job) active = null; });
      return true;
    } finally { checking = false; }
  };
  return { tick, start() { if (!timer && !stopped) { timer = setIntervalImpl(() => { void tick().catch(e => { cancel('observer-error'); emit('idle_weight_churn_error', { error: String(e) }); }); }, pollMs); timer?.unref?.(); } },
    stop() { stopped = true; if (timer) clearIntervalImpl(timer); timer = null; cancel('stopped'); },
    settled: () => pending, status: () => ({ running: Boolean(active), attempted, blocked: lastBlock, downloadPolicy: 'local-only' }) };
}
