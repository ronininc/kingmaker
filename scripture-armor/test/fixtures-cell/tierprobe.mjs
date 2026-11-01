// tierprobe — emits plain data to a peer label. Under a tier whose
// egress is airlock-only, this emission must be dropped by the egress
// handler and logged (egress-tier-restricted); under an open tier it
// crosses as a sealed, registered package.
// --- egress (inlined): a program in a cell holds no keys and has no
// network; its ONLY way out is the daemon's egress socket (SA_EGRESS).
// Frames: [4B BE header length][header JSON {kind, to, bytes, program?}]
// [raw payload bytes].
import net from 'node:net';
function _frame(header, payload) {
  const h = Buffer.from(JSON.stringify({ ...header, bytes: payload.length }), 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(h.length, 0);
  return Buffer.concat([len, h, payload]);
}
async function _send(header, payload) {
  const sockPath = process.env.SA_EGRESS;
  if (!sockPath) throw new Error('SA_EGRESS not set — not inside a cell');
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  await new Promise((resolve, reject) => {
    const c = net.connect(sockPath);
    c.on('connect', () => c.write(_frame(header, buf), () => { c.end(); resolve(); }));
    c.on('error', reject);
  });
}
const emit = (to, payload, opts = {}) => _send({ kind: 'emit', to, program: !!opts.program }, payload);
const cellLog = (text) => _send({ kind: 'log' }, Buffer.from(String(text), 'utf8')).catch(() => {});

await emit('owner', Buffer.from('tierprobe-hello', 'utf8'));
await cellLog('tierprobe emitted to owner');
process.exit(0);
