// tooluser — the CAPABILITY fixture (Addendum I). Inside the cell it:
//   1. writes a plugin-shaped module into scratch and dynamic-imports it
//      (plugin loading intact),
//   2. runs CLI tools via child_process (tool calling intact),
//   3. emits the combined result through the governed egress.
// If the cell cost the agent any of these, acceptance fails — the
// protection extends; the capability stays.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
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

const scratch = process.env.SA_SCRATCH;
const pluginPath = `${scratch}/plugin-greeter.mjs`;
fs.writeFileSync(pluginPath, 'export function greet(name) { return `plugin says hello, ${name}`; }\n');
const plugin = await import(pathToFileURL(pluginPath).href);
const greeting = plugin.greet('owner');

const cliOut = execFileSync(process.execPath, ['--version'], { encoding: 'utf8' }).trim();
const echoOut = execFileSync('/bin/echo', ['cli-tool-ran'], { encoding: 'utf8' }).trim();

const summary = `${greeting} | node ${cliOut} | ${echoOut}`;
await emit('owner', Buffer.from(summary, 'utf8'));
await cellLog(`tooluser capability-ok: ${summary}`);
console.log(summary);
process.exit(0);
