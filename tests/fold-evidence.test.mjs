// Tests for the fold-evidence supply (lib/fold-evidence.mjs) and its seam in the reflex layer
// (lib/reflex-layer.mjs): the parsers against the engine's real output shapes, the evidence
// port's gather/receipt behavior over a scripted transport, and the layer's contract — fold
// index attached to the decision state before scoring, receipts pulled (and fingerprinted in
// the audit) when a verdict stands, fail-open when the supply is down, and byte-identical
// behavior when no evidence port is wired.
// Run: node tests/fold-evidence.test.mjs
import assert from 'node:assert/strict';
import { createFoldEvidence, parseAcpStatus, parseDecompressReply, sha256Hex, FOLD_EVIDENCE_TOOLS } from '../lib/fold-evidence.mjs';
import { createReflexLayer } from '../lib/reflex-layer.mjs';

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed += 1; console.log(`  ok - ${name}`); };

/* ---------------- parsers (fixtures: the engine's real output, captured live 2026-11-13) ---------------- */
const STATUS_TEXT = `ACTIVE SURFACE: pack=default | host=billion-context 0.1.213 (133f3525c)

COMPRESSED BLOCKS — 2 active (132 summary, 980 original)
  Tier usage: T2: 100 (1 blocks) | T3: 32 (1 blocks)

  b22 (T2)  723→100  32 msgs  "Tier-2 distillation"
  b23 (T3)  257→32  80 msgs  "Tier-3 index"`;
{
  const blocks = parseAcpStatus(STATUS_TEXT);
  ok('status parses both active blocks', blocks.length === 2);
  ok('T3 block parsed with tier and sizes', blocks[1].blockId === 'b23' && blocks[1].tier === 3 && blocks[1].summaryTokens === 257 && blocks[1].originalTokens === 32 && blocks[1].messages === 80);
  ok('T2 block topic parsed', blocks[0].blockId === 'b22' && blocks[0].topic === 'Tier-2 distillation');
  ok('empty status parses to no blocks', parseAcpStatus('no blocks here').length === 0);
  const humanized = parseAcpStatus('  b8 (T2)  1.7K→106  25 msgs  "Humanized count block"');
  ok('humanized-count block is not dropped', humanized.length === 1 && humanized[0].blockId === 'b8');
  ok('K suffix expands ×1000 (rounded)', humanized[0].summaryTokens === 1700 && humanized[0].originalTokens === 106);
}
{
  const spill = parseDecompressReply('[Block b23 content — 80 item(s), full]\nContent (47529 chars) written to: /tmp/acp-decompress-b23-1.txt\nUse the read tool to access it.');
  ok('spill reply parsed as file with items/chars', spill.kind === 'file' && spill.path === '/tmp/acp-decompress-b23-1.txt' && spill.items === 80 && spill.chars === 47529);
  const inline = parseDecompressReply('[user]\nhello world');
  ok('inline reply parsed as text', inline.kind === 'inline' && inline.text.includes('hello world'));
  ok('sha256Hex matches the known empty-string digest', sha256Hex('') === 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
}

/* ---------------- the evidence port over a scripted transport ---------------- */
const fakeTransport = (handlers) => ({
  calls: [],
  async call(name, args) {
    this.calls.push({ name, args });
    const h = handlers[name];
    if (!h) throw new Error(`no handler for ${name}`);
    return typeof h === 'function' ? h(args) : h;
  },
});
{
  const transport = fakeTransport({
    acp_status: STATUS_TEXT,
    decompress: '[Block b23 content — 2 item(s), full]\nContent (11 chars) written to: /tmp/spill-b23.txt\nUse the read tool to access it.',
  });
  const evidence = createFoldEvidence({ transport, read: async () => 'hello world' });
  const surface = await evidence.gather({ questions: {} });
  ok('gather sorts the surface Tier 3 first', surface.blocks[0].blockId === 'b23' && surface.blocks[1].blockId === 'b22');
  const receipt = await evidence.receipt('b23');
  ok('receipt resolves the spill file and fingerprints it', receipt.chars === 11 && receipt.sha256 === sha256Hex('hello world'));
  ok('receipt asked for a full decompress', transport.calls.find((c) => c.name === 'decompress')?.args.full === true);
  ok('tool registration carries name, purpose and parameters', FOLD_EVIDENCE_TOOLS.length === 2 && FOLD_EVIDENCE_TOOLS.every((t) => t.name && t.purpose && t.parameters?.type === 'object'));
}
{
  const evidence = createFoldEvidence({ transport: fakeTransport({ acp_status: () => { throw new Error('engine down'); } }) });
  await assert.rejects(() => evidence.gather({}), /engine down/);
  ok('gather surfaces transport failure to the caller (the layer fails open on it)', true);
}

/* ---------------- the reflex-layer seam ---------------- */
const REQ = {
  decision: {
    state: { text: 'Ingested crawl batch 7 — decide whether it is already covered by the fold index.' },
    questions: { covered: { options: ['covered', 'novel'] } },
  },
};
const mkRouter = (kind, probs) => ({
  config: { model: 'laya' },
  calibration: { timeoutMs: 2000 },
  seen: null,
  async decide(payload) {
    this.seen = payload;
    return [{ questionName: 'covered', kind, answer: { probabilities: probs, answer: Object.keys(probs)[0] } }];
  },
});
const spy = () => { const f = async (...args) => { f.calls.push(args); return { answeredBy: 'spy' }; }; f.calls = []; return f; };
const auditSpy = () => { const f = (entry) => { f.entries.push(entry); }; f.entries = []; return f; };
const surfaceBlocks = [{ blockId: 'b23', tier: 3, summaryTokens: 257, originalTokens: 32, messages: 80, topic: 'Tier-3 index' }];

{
  // auto-proceed: state enriched before scoring; receipt pulled; audit fingerprinted, text-free.
  const router = mkRouter('auto-proceed', { covered: 0.97, novel: 0.03 });
  const audit = auditSpy();
  const evidence = {
    async gather() { return { blocks: surfaceBlocks }; },
    async receipt(blockId) { return { blockId, text: 'the exact originals', chars: 19, sha256: sha256Hex('the exact originals') }; },
  };
  const layer = createReflexLayer({ router, audit, reasoning: spy(), evidence });
  const result = await layer.handle(REQ);
  ok('auto-proceed answered by reflex', result.answeredBy === 'reflex');
  ok('router scored over the fold index (state.evidence.foldIndex)', router.seen.state.evidence.foldIndex[0].blockId === 'b23');
  ok('caller state kept alongside the fold index', router.seen.state.text.includes('crawl batch 7'));
  ok('result carries the receipt text for the standing verdict', result.evidence.receipts[0].text === 'the exact originals');
  const entry = audit.entries.find((e) => e.action === 'reflex.auto-proceed');
  ok('audit records the blocks and the receipt fingerprint', entry.meta.evidence.blocks[0] === 'b23' && entry.meta.evidenceReceipts[0].sha256 === sha256Hex('the exact originals'));
  ok('audit never carries receipt text', !JSON.stringify(entry).includes('the exact originals'));
}
{
  // route-to-reasoning: surface rides the ctx; no receipts pulled (the verdict does not stand).
  const router = mkRouter('route-to-reasoning', { covered: 0.7, novel: 0.3 });
  let receiptCalls = 0;
  const evidence = {
    async gather() { return { blocks: surfaceBlocks }; },
    async receipt() { receiptCalls += 1; throw new Error('must not be called'); },
  };
  const reasoning = spy();
  const layer = createReflexLayer({ router, audit: auditSpy(), reasoning, evidence });
  await layer.handle(REQ);
  ok('routed verdict carries the surface as context', reasoning.calls[0][1].evidenceSurface?.[0].blockId === 'b23');
  ok('no receipts pulled for a routed verdict', receiptCalls === 0);
}
{
  // evidence down: decision proceeds on the caller's state, failure audited, never a hard fail.
  const router = mkRouter('auto-proceed', { covered: 0.95, novel: 0.05 });
  const audit = auditSpy();
  const evidence = { async gather() { throw new Error('bili mcp unreachable'); }, async receipt() { throw new Error('n/a'); } };
  const layer = createReflexLayer({ router, audit, reasoning: spy(), evidence });
  const result = await layer.handle(REQ);
  ok('evidence failure still answers', result.answeredBy === 'reflex');
  ok('router saw the caller state untouched', router.seen.state.evidence === undefined);
  ok('evidence failure is audited by name', audit.entries.some((e) => e.action === 'reflex.evidence-unavailable'));
  ok('no evidence block on a receipt-less result', result.evidence === undefined);
}
{
  // no evidence port: the layer behaves exactly as before the seam existed.
  const router = mkRouter('auto-proceed', { covered: 0.99, novel: 0.01 });
  const layer = createReflexLayer({ router, audit: auditSpy(), reasoning: spy() });
  const result = await layer.handle(REQ);
  ok('no-port layer answers as before', result.answeredBy === 'reflex' && result.evidence === undefined && router.seen.state.evidence === undefined);
}

console.log(`\nfold-evidence: ${passed} assertions passed`);
