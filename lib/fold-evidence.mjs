// lib/fold-evidence.mjs — the fold-evidence supply for the reflex layer: the Evidence stage's
// working surface behind Jev (ARCHITECTURE, jev-bili-seat-2026-11-13). Ingest lanes fold raw
// material (crawls, transcripts, page dumps) into a tiered fold index over a content-addressed
// store whose originals stay byte-exact (billion-context 0.1.213, governed install: auto-update
// off, advisory force-install off, feeds pinned dead, retention set deliberately). This module
// is how the decision path reads that index:
//
//   surface — the active fold blocks (Tier 3 first: the broadest, cheapest scan), attached to
//             a decision request's state so the classifier scores over the folds, not the raw
//             ingest. Summaries are an INDEX, never the record.
//   receipt — decompress(blockId, full) through the engine's own MCP surface: the byte-exact
//             original messages a block covers, with their SHA-256. A verdict that STANDS on a
//             block stands on its receipt, never on its summary.
//
// The engine is called, never embedded: the transport spawns `bili mcp` (stdio JSON-RPC) bound
// to a running governed proxy via BILI_MCP_PROXY and to one conversation via
// BILI_CONVERSATION_ID — the binding the artifact itself demands (an unbound shim refuses to
// guess a conversation, by design). Every failure here is fail-open for the reflex layer: no
// evidence is a normal day, never a hard fail (the layer's own fallback doctrine).
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants as FS, mkdtempSync, realpathSync, lstatSync, chmodSync } from 'node:fs';
import { open, lstat, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, normalize, sep } from 'node:path';
import { minimalEnv } from './child-env.mjs';

// ── Child environment (2026-11-16): the shim gets the minimum, never Kingmaker's full environment. ──
// `bili mcp` reads exactly these (billion-context src/mcp.ts:66,92,93,101). CLAUDE_CODE_SESSION_ID is deliberately
// NOT allowed: inherited from a Claude Code parent it would OVERRIDE BILI_CONVERSATION_ID (mcp.ts:92) and bind the
// shim to the wrong conversation. Anything else a caller passes is refused, not silently forwarded.
export const BILI_ENV_KEYS = Object.freeze(['BILI_MCP_PROXY', 'BILI_CONVERSATION_ID', 'BILI_MCP_NO_ORPHAN_ADOPT']);
export function biliChildEnv(explicit = {}, from = process.env) {
  const set = {};
  for (const [k, v] of Object.entries(explicit ?? {})) {
    if (v === undefined || v === null || v === '') continue;
    if (!BILI_ENV_KEYS.includes(k)) throw new Error(`fold-evidence transport: environment variable ${k} is not passed to bili (allowed: ${BILI_ENV_KEYS.join(', ')})`);
    set[k] = String(v);
  }
  if (set.BILI_MCP_PROXY) {
    let u; try { u = new URL(set.BILI_MCP_PROXY); } catch { throw new Error('fold-evidence transport: BILI_MCP_PROXY is not a URL'); }
    if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) || u.username || u.password) throw new Error('fold-evidence transport: BILI_MCP_PROXY must be a loopback http origin without credentials');
  }
  return minimalEnv({ set, from });
}

// ── Spill receipts (2026-11-16): large restores are read ONLY from Kingmaker's own spill directory. ──
// Kingmaker names the file (decompress toFile = <spillDir>/receipt-<id>-<uuid>.txt; billion-context
// src/decompress-shared.ts resolveToFileTarget/toFilePointer write exactly there, mode 0600) and accepts a reply that
// names exactly that path. The read: lexical checks → directory checks (real dir, ours, 0700) → open with
// O_NOFOLLOW|O_NONBLOCK (a symlink or FIFO swapped in fails) → every further check on the OPEN descriptor (regular
// file, one link, ours, size cap) → read from that descriptor only. A path swapped after open cannot redirect it.
export const SPILL_MAX_BYTES = 32 * 1024 * 1024;
export function createSpillDir(parent) {
  const dir = realpathSync(mkdtempSync(join(realpathSync(parent), 'fold-receipts-')));
  chmodSync(dir, 0o700);
  return dir;
}
const NAME_OK = /^[A-Za-z0-9._-]{1,200}$/;
export async function readSpillFile(p, { dir, maxBytes = SPILL_MAX_BYTES, expected = null, _beforeOpen = null, _afterOpen = null } = {}) {
  const refuse = (why) => { const e = new Error(`fold-evidence: spill read refused — ${why}`); e.code = 'SPILL_REFUSED'; throw e; };
  if (typeof dir !== 'string' || !isAbsolute(dir)) refuse('no spill directory configured');
  if (typeof p !== 'string' || p.includes('\0') || !isAbsolute(p)) refuse('path is not absolute');
  if (normalize(p) !== p || p.split(sep).includes('..')) refuse('path is not normalized');
  if (expected !== null && p !== expected) refuse('path is not the one Kingmaker asked for');
  if (dirname(p) !== dir || !NAME_OK.test(basename(p))) refuse('path is outside the spill directory');
  const d = await lstat(dir).catch(() => null);
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (!d || !d.isDirectory() || d.isSymbolicLink() || (uid !== null && d.uid !== uid) || (d.mode & 0o077) !== 0) refuse('spill directory is not a private directory owned by this user');
  if (_beforeOpen) await _beforeOpen(p);
  let fh;
  try { fh = await open(p, FS.O_RDONLY | (FS.O_NOFOLLOW ?? 0) | (FS.O_NONBLOCK ?? 0)); }
  catch (e) { refuse(e.code === 'ELOOP' || e.code === 'EMLINK' ? 'path is a symlink' : `cannot open (${e.code ?? 'error'})`); }
  try {
    if (_afterOpen) await _afterOpen(p);
    const st = await fh.stat();
    if (!st.isFile()) refuse('not a regular file');
    if (st.nlink > 1) refuse('file has other hard links'); // 0 = unlinked after open: still the opened file
    if (uid !== null && st.uid !== uid) refuse('file is not owned by this user');
    if (st.size > maxBytes) refuse(`file exceeds ${maxBytes} bytes`);
    const buf = Buffer.alloc(Math.min(st.size, maxBytes) + 1);
    let n = 0, r;
    while (n < buf.length && (r = await fh.read(buf, n, buf.length - n, n)).bytesRead > 0) n += r.bytesRead;
    if (n > maxBytes) refuse(`file exceeds ${maxBytes} bytes`);
    try { return new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(0, n)); }
    catch { refuse('file is not valid UTF-8'); }
  } finally { await fh.close(); }
}

/** The tool registration for the brain's tool-calling layer (name, purpose, parameter schema) —
 *  the Kingmaker-side face of the engine's MCP tools (acp_status / decompress / search_context). */
export const FOLD_EVIDENCE_TOOLS = [
  {
    name: 'fold_evidence_surface',
    purpose: 'List the active fold blocks (tier, topic, sizes) covering previously ingested material — the Evidence surface a decision is scored over. Folded summaries are an index; exact values live in the blocks’ originals.',
    parameters: {
      type: 'object',
      properties: {
        conversationId: { type: 'string', description: 'The fold-store conversation to read (bound at wiring time; omit to use the bound conversation).' },
      },
    },
  },
  {
    name: 'fold_evidence_receipt',
    purpose: 'Restore one fold block’s byte-exact original messages (decompress, full) — the receipt a standing verdict rests on. Returns the text plus its SHA-256.',
    parameters: {
      type: 'object',
      properties: {
        blockId: { type: 'string', description: 'Fold block id, e.g. "b23".' },
      },
      required: ['blockId'],
    },
  },
];

/** Pure: SHA-256 of a text, hex — the receipt fingerprint recorded in the audit trail. */
export const sha256Hex = (text) => createHash('sha256').update(String(text), 'utf8').digest('hex');

/** Pure: parse `acp_status` output into the active block list. Status lines look like:
 *    b22 (T2)  723→100  32 msgs  "Tier-2 distillation"
 *  (summary tokens → original tokens are the two numbers around the arrow). Counts
 *  ≥ 1000 are humanized by the engine ("1.7K→106") and expanded here (K = ×1000,
 *  rounded) — a digits-only pattern silently drops those blocks from the surface. */
export function parseAcpStatus(text) {
  const blocks = [];
  const re = /\b(b\d+)\s+\(T(\d)\)\s+([\d.]+K?)→([\d.]+K?)\s+(\d+)\s+msgs?\s+"([^"]*)"/g;
  const tok = (s) => (s.endsWith('K') ? Math.round(parseFloat(s) * 1000) : Number(s));
  let m;
  while ((m = re.exec(String(text ?? ''))) !== null) {
    blocks.push({
      blockId: m[1],
      tier: Number(m[2]),
      summaryTokens: tok(m[3]),
      originalTokens: tok(m[4]),
      messages: Number(m[5]),
      topic: m[6],
    });
  }
  return blocks;
}

/** Pure: a decompress tool reply is either inline text or a spill-file notice (large restores
 *  are written to a file by the engine: "[Block b23 content — 80 item(s), full]\nContent
 *  (47529 chars) written to: /tmp/acp-decompress-….txt\nUse the read tool to access it."). */
export function parseDecompressReply(text) {
  const s = String(text ?? '');
  const spill = s.match(/written to:\s+(\S+)\s*\n/);
  if (spill) {
    const items = s.match(/—\s+(\d+)\s+item\(s\)/);
    const chars = s.match(/Content \((\d+) chars\)/);
    return { kind: 'file', path: spill[1], items: items ? Number(items[1]) : null, chars: chars ? Number(chars[1]) : null };
  }
  return { kind: 'inline', text: s };
}

/** A minimal MCP stdio client for `bili mcp` — newline-delimited JSON-RPC, id-matched,
 *  initialize handshake, lazy spawn. `call(name, args)` resolves with the tool's text content
 *  and throws a named error on a tool error or a dead shim, so callers can fail open. */
export function createBiliMcpTransport({ command = 'bili', args = ['mcp'], env = {}, spawnImpl = spawn, timeoutMs = 5_000, maxLineBytes = 8 * 1024 * 1024, parentEnv = process.env } = {}) {
  const childEnv = biliChildEnv(env, parentEnv); // validated once, up front: a bad variable fails at wiring, not mid-call
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('fold-evidence transport: timeoutMs must be positive');
  if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes <= 0) throw new Error('fold-evidence transport: maxLineBytes must be positive');
  let child = null;
  let buf = '';
  let seq = 0;
  let ready = null;
  const pending = new Map();
  const failAll = (err) => {
    for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(err); }
    pending.clear();
  };
  // A dead/timed-out shim is never reused. Detach state before killing it, so its
  // eventual exit cannot reject calls belonging to a replacement process.
  const reset = (err, source = child) => {
    if (source !== child) return;
    child = null; ready = null; buf = '';
    failAll(err);
    try { source?.kill(); } catch { /* already gone */ }
  };

  function ensure() {
    if (child) return child;
    const proc = spawnImpl(command, args, { env: { ...childEnv }, stdio: ['pipe', 'pipe', 'pipe'] });
    child = proc;
    // Diagnostics must not fill a pipe and block the shim. Never put potentially
    // private diagnostic output into the evidence or error text.
    proc.stderr?.resume();
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (d) => {
      if (child !== proc) return;
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const rawLine = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (Buffer.byteLength(rawLine) > maxLineBytes) {
          reset(new Error('fold-evidence transport: response exceeds line limit'), proc); return;
        }
        const line = rawLine.trim();
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        const entry = pending.get(msg?.id);
        if (entry) {
          pending.delete(msg.id); clearTimeout(entry.timer);
          if (msg.error) entry.reject(new Error(`fold-evidence transport: ${msg.error.message ?? 'rpc error'}`));
          else entry.resolve(msg.result);
        }
      }
      if (Buffer.byteLength(buf) > maxLineBytes) reset(new Error('fold-evidence transport: response exceeds line limit'), proc);
    });
    proc.on('error', (err) => reset(new Error(`fold-evidence transport: ${err.message}`), proc));
    proc.on('exit', () => reset(new Error('fold-evidence transport: bili mcp exited'), proc));
    proc.stdin.on('error', (err) => reset(new Error(`fold-evidence transport: ${err.message}`), proc));
    return proc;
  }
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => reset(new Error(`fold-evidence transport: ${method} timed out after ${timeoutMs} ms`)), timeoutMs);
    pending.set(id, { resolve, reject, timer });
    try { ensure().stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); }
    catch (err) { reset(new Error(`fold-evidence transport: ${err.message}`)); }
  });
  const init = () => (ready ??= (async () => {
    await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'kingmaker-fold-evidence', version: '1.0' } });
    ensure().stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');
  })());

  return {
    async call(name, argsObj = {}) {
      try { await init(); }
      catch (err) { ready = null; throw err; }
      const result = await rpc('tools/call', { name, arguments: argsObj });
      const text = (result?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
      if (result?.isError) throw new Error(`fold-evidence: tool "${name}" errored: ${text.slice(0, 200)}`);
      return text;
    },
    close() { reset(new Error('fold-evidence transport: closed')); },
  };
}

/**
 * The evidence port the reflex layer consumes. `transport` is anything with
 * call(name, args) → text (createBiliMcpTransport in production; a scripted fake in tests).
 * gather(payload) → { blocks } — the surface to attach to a decision state: active blocks,
 * Tier 3 first (broadest scan), then Tier 2, then Tier 1, ids ascending inside a tier.
 * receipt(blockId) → { blockId, text, chars, sha256 } — the byte-exact originals. With `spillDir`, Kingmaker asks the
 * engine to write the restore to a file IT names inside that private directory and reads it back through
 * readSpillFile (bounded, no symlinks/hardlinks/traversal); the file is removed after reading. Without `spillDir`,
 * a spill reply is refused (fail closed) — inline replies still work. `read(path, opts)` may be injected for tests.
 */
export function createFoldEvidence({ transport, spillDir = null, read = readSpillFile, maxSpillBytes = SPILL_MAX_BYTES, maxSurfaceBlocks = 16, log = () => {} } = {}) {
  if (!transport || typeof transport.call !== 'function') throw new Error('fold-evidence: a transport with call(name, args) is required');
  if (spillDir !== null) {
    const st = lstatSync(spillDir, { throwIfNoEntry: false });
    if (!isAbsolute(spillDir) || !st?.isDirectory() || st.isSymbolicLink() || realpathSync(spillDir) !== spillDir) throw new Error('fold-evidence: spillDir must be an absolute, real (non-symlink) directory — use createSpillDir()');
  }
  return {
    async gather() {
      const statusText = await transport.call('acp_status', {});
      const blocks = parseAcpStatus(statusText)
        .sort((a, b) => b.tier - a.tier || Number(a.blockId.slice(1)) - Number(b.blockId.slice(1)))
        .slice(0, maxSurfaceBlocks);
      return { blocks };
    },
    async receipt(blockId) {
      if (typeof blockId !== 'string' || !/^b\d{1,9}$/.test(blockId)) throw new Error('fold-evidence: blockId must look like "b23"');
      const expected = spillDir ? join(spillDir, `receipt-${blockId}-${randomUUID()}.txt`) : null;
      const reply = await transport.call('decompress', { blockId, full: true, ...(expected ? { toFile: expected } : {}) });
      const parsed = parseDecompressReply(reply);
      let text;
      if (parsed.kind === 'file') {
        if (!spillDir) { log('fold_receipt_spill_refused', { blockId }); const e = new Error('fold-evidence: spill read refused — no spill directory configured'); e.code = 'SPILL_REFUSED'; throw e; }
        try { text = await read(parsed.path, { dir: spillDir, maxBytes: maxSpillBytes, expected }); }
        finally { if (parsed.path === expected) await unlink(expected).catch(() => {}); }
      } else text = parsed.text;
      return { blockId, text, chars: text.length, sha256: sha256Hex(text) };
    },
    /** Ad-hoc relevance lookup for callers that need it (not on the reflex hot path). */
    async search(query) {
      return transport.call('search_context', { query: String(query ?? '').slice(0, 500) });
    },
    tools: FOLD_EVIDENCE_TOOLS,
  };
}
