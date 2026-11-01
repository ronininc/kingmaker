#!/usr/bin/env node
// mesh-tee.mjs — a TCP tee proxy for the Closure 4 battery, run as its
// OWN process. (It must be: the battery drives the armor CLI with
// spawnSync, which blocks the battery's event loop — an in-process
// proxy would freeze mid-exchange and the traffic would lie about the
// product.) Usage: mesh-tee.mjs <listenPort> <targetPort> <captureFile>
// Every byte in both directions is appended to the capture file.
import net from 'node:net';
import fs from 'node:fs';

const [listenPort, targetPort, captureFile] = process.argv.slice(2);
const server = net.createServer((c) => {
  const up = net.connect(Number(targetPort), '127.0.0.1');
  c.on('data', (d) => { fs.appendFileSync(captureFile, d); up.write(d); });
  up.on('data', (d) => { fs.appendFileSync(captureFile, d); c.write(d); });
  c.on('error', () => { try { up.destroy(); } catch {} });
  up.on('error', () => { try { c.destroy(); } catch {} });
});
server.listen(Number(listenPort), '127.0.0.1', () => {
  console.log(`tee ${listenPort} -> ${targetPort}`);
});
