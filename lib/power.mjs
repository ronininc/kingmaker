// macOS sleep assertions owned by the Kingmaker process. Neither mode prevents display sleep (`-d` is never used),
// and `-w <Kingmaker pid>` guarantees the assertion dies if Kingmaker crashes.
//
// `idle` is the short, per-turn fallback for a manually started Kingmaker. `host` is the always-on service mode:
// `caffeinate -s` prevents system sleep only while the Mac is on AC power. That is deliberately the supported host
// contract: power connected, lid open, built-in display allowed to sleep. It does not claim to bypass lid sleep.

import { spawn } from 'node:child_process';

export function startIdleSleepAssertion({ platform = process.platform, pid = process.pid, run = spawn, log = () => {}, mode = 'idle' } = {}) {
  if (platform !== 'darwin') return { active: false, release() {} };
  let child;
  try {
    child = run('/usr/bin/caffeinate', [mode === 'host' ? '-s' : '-i', '-w', String(pid)], { stdio: 'ignore' });
    child.unref?.();
    child.on?.('error', (error) => log('power_assertion_failed', { message: String(error?.message ?? error).slice(0, 160) }));
  } catch (error) {
    log('power_assertion_failed', { message: String(error?.message ?? error).slice(0, 160) });
    return { active: false, release() {} };
  }
  let released = false;
  return {
    active: true,
    release() {
      if (released) return;
      released = true;
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
    },
  };
}

export function startHeadlessHostAssertion(options = {}) {
  return startIdleSleepAssertion({ ...options, mode: 'host' });
}

export async function withIdleSleepAssertion(task, options) {
  const assertion = startIdleSleepAssertion(options);
  try { return await task(); } finally { assertion.release(); }
}
