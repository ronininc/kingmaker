import fs from 'node:fs';
import net from 'node:net';
import { daemonSocketFor, isPipeEndpoint } from './daemon-transport.mjs';

// Read-only public status. No identity keys or owner tokens enter this reader.
export async function readProtectionStatus(identityDir, { timeoutMs = 750 } = {}) {
  const unavailable = { connected: false, state: 'daemon_unavailable', activeAirlocks: 0, runningActivations: 0, wholeDeviceCoverageVerified: false };
  const socketPath = daemonSocketFor(identityDir);
  // The pre-check stats the socket FILE and refuses another user's. A
  // named pipe (win32) is not a file and cannot be stat'd this way —
  // there the connect attempt below is the whole check.
  if (!isPipeEndpoint(socketPath)) {
    try {
      const stat = fs.lstatSync(socketPath);
      if (!stat.isSocket() || (process.getuid && stat.uid !== process.getuid())) return unavailable;
    } catch { return unavailable; }
  }
  return new Promise(resolve => {
    let settled = false, bytes = 0, text = '';
    const socket = net.createConnection(socketPath);
    const finish = value => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); resolve(value); };
    const timer = setTimeout(() => finish(unavailable), Math.max(1, Math.min(timeoutMs, 1000)));
    socket.on('connect', () => socket.write('{"cmd":"status"}\n'));
    socket.on('error', () => finish(unavailable));
    socket.on('close', () => finish(unavailable));
    socket.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 16384) return finish(unavailable);
      text += chunk.toString('utf8');
      if (!text.includes('\n')) return;
      try {
        const reply = JSON.parse(text.slice(0, text.indexOf('\n')));
        if (reply.ok !== true || ![reply.airlock_sessions, reply.activations_running].every(n => Number.isSafeInteger(n) && n >= 0)) return finish(unavailable);
        finish({ connected: true, state: reply.terms_accepted_by_owner !== true ? 'owner_setup_required' : reply.airlock_sessions || reply.activations_running ? 'routed_work_active' : 'waiting_for_routed_work', activeAirlocks: reply.airlock_sessions, runningActivations: reply.activations_running, wholeDeviceCoverageVerified: false });
      } catch { finish(unavailable); }
    });
  });
}
