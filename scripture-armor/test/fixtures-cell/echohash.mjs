// echohash — the §2.8 probe program: reads its own image file, emits
// its SHA-256 to the peer label "owner", attempts a direct TCP
// connection (must fail — a cell has no route), writes scratch, exits 0.
import fs from 'node:fs';
import net2 from 'node:net';
import crypto from 'node:crypto';
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

const self = fs.readFileSync(process.argv[1]);
const digest = crypto.createHash('sha256').update(self).digest('hex');
await emit('owner', Buffer.from(digest, 'utf8'));

const netResult = await new Promise((resolve) => {
  const s = net2.connect({ host: '127.0.0.1', port: 9 });
  const timer = setTimeout(() => { s.destroy(); resolve('timeout'); }, 3000);
  s.on('connect', () => { clearTimeout(timer); s.destroy(); resolve('CONNECTED'); });
  s.on('error', (e) => { clearTimeout(timer); resolve(`failed:${e.code || e.message}`); });
});
await cellLog(`echohash net-attempt: ${netResult} sha256: ${digest}`);

fs.writeFileSync(`${process.env.SA_SCRATCH}/scratch-note.txt`, `ran ${new Date().toISOString()}\n`);
console.log(`echohash sha256 ${digest} net ${netResult}`);
process.exit(0);
