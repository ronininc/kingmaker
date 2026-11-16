// lib/kill-tree.mjs — stop a process and every descendant (moved out of lib/connectors.mjs so the tool runner and the
// method lane's cancel share the exact helper the connector lane already used).
import { execFileSync } from 'node:child_process';

/** Kill a process, its group, and every descendant by ppid: a setsid() or double-fork leaves the group, so the group
 *  kill alone misses it, but as long as its parent is still up the ppid chain from ps finds it. Never throws.
 *  Returns the pids it signalled (the root last). */
export function killTree(pid, { signal = 'SIGKILL' } = {}) {
  // Map the descendants from ps BEFORE killing anything: a group kill orphans a setsid child (reparented to launchd),
  // which would break the ppid chain before we could follow it.
  let out = '';
  try { out = execFileSync('/bin/ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8', timeout: 5000 }); } catch { out = ''; }
  const kids = new Map();
  for (const line of out.split('\n')) { const [p, pp] = line.trim().split(/\s+/).map(Number); if (p && pp >= 0) { if (!kids.has(pp)) kids.set(pp, []); kids.get(pp).push(p); } }
  const victims = [], stack = [pid], seen = new Set([pid]);
  while (stack.length) { const cur = stack.pop(); for (const k of kids.get(cur) || []) if (!seen.has(k)) { seen.add(k); victims.push(k); stack.push(k); } }
  try { process.kill(-pid, signal); } catch { /* no group */ }
  for (const k of [...victims, pid]) { try { process.kill(k, signal); } catch { /* already gone */ } }
  return [...victims, pid];
}

/** True while `pid` exists (EPERM = exists but not ours). A zombie still counts until its parent reaps it. */
export function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
