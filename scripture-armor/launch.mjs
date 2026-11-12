#!/usr/bin/env node
// launch.mjs — THE launch command (distribution ruling, 2026-10-24:
// no installer; Scripture Armor ships through Kingmaker and comes up
// with a single copy-paste command). Brings the armor up from a
// bundled tree with sane defaults and no prior setup steps:
//
//     node launch.mjs [--identity-dir <dir>]
//
// Idempotent: if a daemon already answers on the socket, it reports
// the running state and exits 0. First run creates the identity,
// presents the ACTIVATION TERMS in the terminal (terms.mjs) and
// requires the operator to type ACCEPT — no silent setup; the
// acceptance is written to the installation's audit record — then
// serves the vault daemon in the foreground. No UI exists for this
// layer, by ruling; Kingmaker fronts the daemon's API/CLI surfaces.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadIdentity, createIdentity, publicBlock, defaultIdentityDir } from './armor.mjs';
import { assertProductIdentityDir } from './product-paths.mjs';
import { resolveEndpoint } from './daemon-transport.mjs';
import { TERMS_TEXT, hasCurrentAcceptance, recordAcceptance } from './terms.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function parseFlags(args) {
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) flags[args[i].slice(2)] = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true;
  }
  return flags;
}

function readStdinLine() {
  return new Promise((resolve) => {
    let buf = '';
    process.stdin.on('data', (d) => {
      buf += d.toString('utf8');
      const idx = buf.indexOf('\n');
      if (idx >= 0) resolve(buf.slice(0, idx).trim());
    });
    process.stdin.on('end', () => resolve(buf.trim()));
    process.stdin.resume();
  });
}

function daemonAnswers(socketPath) {
  return new Promise((resolve) => {
    const conn = net.createConnection(socketPath);
    let buf = '';
    conn.setTimeout(1500, () => { conn.destroy(); resolve(null); });
    conn.on('connect', () => conn.write(JSON.stringify({ cmd: 'status' }) + '\n'));
    conn.on('data', (d) => {
      buf += d.toString('utf8');
      const idx = buf.indexOf('\n');
      if (idx >= 0) { conn.end(); try { resolve(JSON.parse(buf.slice(0, idx))); } catch { resolve(null); } }
    });
    conn.on('error', () => resolve(null));
  });
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const dir = assertProductIdentityDir(flags['identity-dir'] ? path.resolve(flags['identity-dir']) : defaultIdentityDir());
  const socketPath = resolveEndpoint(flags.socket, dir);

  // 4.4 PHASE-0 COEXISTENCE — ITEM 1 (deliberate, marked deviation from the
  // public line): this is Kingmaker's BUNDLED launch path. It issues the
  // daemon spawn below with explicit --identity-dir/--socket (never bare),
  // and it refuses outright to run against the STANDALONE product's store
  // (~/.scripture-armor) — design rule: Kingmaker never writes to, adopts,
  // or serves the standalone install's identity (COEXISTENCE-REPORT probes
  // 1+2). The bundled default (armor.mjs defaultIdentityDir, coexistence
  // item 2) is the Kingmaker-namespaced store, so a flagless launch is
  // already namespaced; this guard closes the explicit-flag path too.
  // Product policy above rejects the opposite product's store before any key read.

  const running = await daemonAnswers(socketPath);
  if (running && running.ok) {
    console.log(`scripture-armor: already running — ${running.label}, ${running.registry_issued} issued, ${running.pending} pending`);
    return;
  }

  let id = loadIdentity(dir);
  if (!id) {
    id = createIdentity(dir, flags.label || os.hostname());
    console.log('scripture-armor: identity created for this device.');
    console.log(`  label:   ${id.label}`);
    console.log(`  seal fp: ${id.sealFp}`);
    console.log(`  sign fp: ${id.signFp}`);
    console.log('  public block (share this with copies you want to exchange with):');
    console.log(`  ${publicBlock(id)}`);
  }

  if (!hasCurrentAcceptance(dir, 'owner')) {
    console.log('');
    console.log(TERMS_TEXT);
    console.log('Type ACCEPT to activate Scripture Armor under these terms:');
    const line = await readStdinLine();
    if (line !== 'ACCEPT') {
      console.error('scripture-armor: not activated (acceptance not given). Nothing was started.');
      process.exit(1);
    }
    const rec = recordAcceptance(dir, 'owner');
    console.log(`acceptance recorded: ${rec.terms_version} sha256 ${rec.terms_sha256.slice(0, 16)}… at ${rec.accepted_at}`);
  }

  console.log('scripture-armor: starting vault daemon…');
  const child = spawn(process.execPath,
    [path.join(HERE, 'vaultd.mjs'), 'serve', '--identity-dir', dir, '--socket', socketPath],
    { stdio: 'inherit' });
  const forward = (sig) => { try { child.kill(sig); } catch {} };
  process.on('SIGINT', () => forward('SIGINT'));
  process.on('SIGTERM', () => forward('SIGTERM'));
  child.on('exit', (code) => process.exit(code ?? 0));
}

main().catch((err) => {
  console.error(`error: ${err.message}`);
  process.exit(1);
});
