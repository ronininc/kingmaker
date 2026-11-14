// egress-relay — a loopback shim between Chromium and the node's sanctioned
// egress proxy. Why it exists (proven 2026-11-13, jev-bili-ingest build):
// the egress proxy kills CONNECT requests that carry a `User-Agent:
// HeadlessChrome/...` header (Chromium sends one; curl and raw sockets send
// none and pass). Playwright's native proxy credentials fail the same way —
// the tunnel dies before auth. The relay accepts the browser's CONNECT on
// 127.0.0.1 and replays a clean CONNECT (Host + preemptive Proxy-Authorization
// only) to the real proxy, then pipes bytes both ways. Plain-HTTP requests
// are forwarded the same way. Credentials come from HTTPS_PROXY in the
// environment and are never printed.
// Usage: node egress-relay.mjs [port] — port 0 (the default) picks an
// ephemeral port, so concurrent captures never collide; prints "READY <port>"
// with the port actually bound.
import http from "node:http";
import net from "node:net";
import { lookup } from "node:dns/promises";

const u = new URL(process.env.HTTPS_PROXY);
const UP_HOST = (await lookup(u.hostname, { family: 4 })).address;
const UP_PORT = Number(u.port || 3128);
const AUTH = "Basic " + Buffer.from(
  `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`,
).toString("base64");

const server = http.createServer((req, res) => {
  // Plain HTTP: forward the absolute-URI request with preemptive auth.
  const target = new URL(req.url);
  const up = net.connect(UP_PORT, UP_HOST, () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`, `Host: ${target.host}`,
      `Proxy-Authorization: ${AUTH}`, "Proxy-Connection: close", "\r\n"];
    up.write(lines.join("\r\n"));
    req.pipe(up);
  });
  up.pipe(res.socket);
  up.on("error", () => { try { res.socket.destroy(); } catch { /* gone */ } });
});
server.on("connect", (req, clientSocket, head) => {
  const up = net.connect(UP_PORT, UP_HOST, () => {
    up.write(`CONNECT ${req.url} HTTP/1.1\r\nHost: ${req.url}\r\nProxy-Authorization: ${AUTH}\r\nProxy-Connection: Keep-Alive\r\n\r\n`);
  });
  let buf = Buffer.alloc(0);
  const onData = (d) => {
    buf = Buffer.concat([buf, d]);
    const idx = buf.indexOf("\r\n\r\n");
    if (idx < 0) return;
    const statusLine = buf.slice(0, idx).toString().split("\r\n")[0];
    up.removeListener("data", onData);
    if (/ 200/.test(statusLine)) {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) up.write(head);
      up.pipe(clientSocket); clientSocket.pipe(up);
    } else {
      clientSocket.write(buf.slice(0, idx + 4));
      clientSocket.end(); up.end();
    }
  };
  up.on("data", onData);
  up.on("error", () => clientSocket.destroy());
  clientSocket.on("error", () => up.destroy());
});
const port = Number(process.argv[2] || 0);
server.listen(port, "127.0.0.1", () => console.log(`READY ${server.address().port}`));
