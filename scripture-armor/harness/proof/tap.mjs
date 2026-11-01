// proof/tap.mjs — a raw TCP capture proxy: the "observer on the wire".
//
// Everything the engine sends and receives on a tapped leg passes
// through here and is appended byte-for-byte to two files
// (<name>.c2s = client→server, <name>.s2c = server→client). The
// proof reads those files the way any network observer would: what
// is visible on the wire is exactly what is in the capture.

import net from 'node:net';
import fs from 'node:fs';

export function startTap({ listenPort, targetPort, captureBase }) {
  const c2s = fs.createWriteStream(captureBase + '.c2s');
  const s2c = fs.createWriteStream(captureBase + '.s2c');
  const server = net.createServer((client) => {
    const upstream = net.createConnection(targetPort, '127.0.0.1');
    client.on('data', (d) => { c2s.write(d); upstream.write(d); });
    upstream.on('data', (d) => { s2c.write(d); client.write(d); });
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
    client.on('close', () => upstream.end());
    upstream.on('close', () => client.end());
  });
  return new Promise((resolve) => {
    server.listen(listenPort, '127.0.0.1', () => resolve({ server, port: listenPort }));
  });
}

export function readCapture(captureBase, dir) {
  try { return fs.readFileSync(captureBase + dir, 'utf8'); } catch { return ''; }
}
