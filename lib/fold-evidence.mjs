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
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

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
export function createBiliMcpTransport({ command = 'bili', args = ['mcp'], env = {}, spawnImpl = spawn } = {}) {
  let child = null;
  let buf = '';
  let seq = 0;
  const pending = new Map();
  const failAll = (err) => { for (const [, rej] of pending) rej(err); pending.clear(); };

  function ensure() {
    if (child) return child;
    child = spawnImpl(command, args, { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        const settle = pending.get(msg.id);
        if (settle) { pending.delete(msg.id); settle(msg); }
      }
    });
    child.on('error', (err) => failAll(new Error(`fold-evidence transport: ${err.message}`)));
    child.on('exit', () => { failAll(new Error('fold-evidence transport: bili mcp exited')); child = null; });
    return child;
  }
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, (msg) => (msg.error ? reject(new Error(`fold-evidence transport: ${msg.error.message ?? 'rpc error'}`)) : resolve(msg.result)));
    ensure().stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  let ready = null;
  const init = () => (ready ??= (async () => {
    await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'kingmaker-fold-evidence', version: '1.0' } });
    ensure().stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');
  })());

  return {
    async call(name, argsObj = {}) {
      await init();
      const result = await rpc('tools/call', { name, arguments: argsObj });
      const text = (result?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
      if (result?.isError) throw new Error(`fold-evidence: tool "${name}" errored: ${text.slice(0, 200)}`);
      return text;
    },
    close() { try { child?.kill(); } catch { /* already gone */ } child = null; },
  };
}

/**
 * The evidence port the reflex layer consumes. `transport` is anything with
 * call(name, args) → text (createBiliMcpTransport in production; a scripted fake in tests).
 * gather(payload) → { blocks } — the surface to attach to a decision state: active blocks,
 * Tier 3 first (broadest scan), then Tier 2, then Tier 1, ids ascending inside a tier.
 * receipt(blockId) → { blockId, text, chars, sha256 } — the byte-exact originals, spill files
 * resolved through the injected read (fs readFile by default).
 */
export function createFoldEvidence({ transport, read = (p) => readFile(p, 'utf8'), maxSurfaceBlocks = 16, log = () => {} } = {}) {
  if (!transport || typeof transport.call !== 'function') throw new Error('fold-evidence: a transport with call(name, args) is required');
  return {
    async gather() {
      const statusText = await transport.call('acp_status', {});
      const blocks = parseAcpStatus(statusText)
        .sort((a, b) => b.tier - a.tier || Number(a.blockId.slice(1)) - Number(b.blockId.slice(1)))
        .slice(0, maxSurfaceBlocks);
      return { blocks };
    },
    async receipt(blockId) {
      const reply = await transport.call('decompress', { blockId, full: true });
      const parsed = parseDecompressReply(reply);
      const text = parsed.kind === 'file' ? await read(parsed.path) : parsed.text;
      return { blockId, text, chars: text.length, sha256: sha256Hex(text) };
    },
    /** Ad-hoc relevance lookup for callers that need it (not on the reflex hot path). */
    async search(query) {
      return transport.call('search_context', { query: String(query ?? '').slice(0, 500) });
    },
    tools: FOLD_EVIDENCE_TOOLS,
  };
}
