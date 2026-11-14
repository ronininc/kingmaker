// Multi-node render carriage — lib/render-carriage.mjs.
// Doctrine (owner, 2026-11-14, final form): CREATED vs CONSUMED. The assets
// a node consumes are vetted byte-exact by pin. The frames a node creates
// are NOT matched against anything — at completion the node issues the
// frame's hash + a provenance record crediting the vetted inputs, and the
// conductor accepts on issuance. The only post-issuance check is
// tamper-evidence against the frame's OWN issued hash; a re-issue is a new
// creation, accepted on its own issuance even when its bytes differ
// entirely from the refused attempt's.
import assert from 'node:assert/strict';
import test from 'node:test';
import { deflateSync, crc32 } from 'node:zlib';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileSource } from '../lib/brain-library-access.mjs';
import { buildPortionManifest, createFleetNode } from '../lib/brain-library-fleet.mjs';
import {
  createRenderConductor, fetchVerifiedItem, frameFileName, frameItemId, planChunks,
  pngChunkTypes, pngDimensions, stripPngMetadata,
} from '../lib/render-carriage.mjs';

/* A structurally valid PNG (real IDAT) of solid colour, built in-test. */
function makePng(width, height, [r, g, b]) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  // Deterministic per-pixel variation: a solid frame deflates to almost
  // nothing and would span a single portion, which is not what the fleet
  // legs are about.
  let seed = (r * 65536 + g * 256 + b) >>> 0;
  const rand = () => { seed = (seed * 1103515245 + 12345) >>> 0; return (seed >>> 16) & 0xff; };
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width * 3; x++) row[1 + x] = rand();
    rows.push(row);
  }
  const idat = deflateSync(Buffer.concat(rows));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0)),
  ]);
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

/** Insert a chunk immediately after IHDR. */
function insertAfterIhdr(png, type, data) {
  const ihdrLen = png.readUInt32BE(8);
  const at = 8 + 4 + 4 + ihdrLen + 4;
  return Buffer.concat([png.subarray(0, at), pngChunk(type, data), png.subarray(at)]);
}

test('planChunks covers the range in order, no overlaps, ragged tail kept', () => {
  const chunks = planChunks({ frameStart: 1, frameEnd: 8, chunkFrames: 2 });
  assert.deepEqual(chunks.map((c) => c.frames), [[1, 2], [3, 4], [5, 6], [7, 8]]);
  const ragged = planChunks({ frameStart: 3, frameEnd: 9, chunkFrames: 4 });
  assert.deepEqual(ragged.map((c) => c.frames), [[3, 4, 5, 6], [7, 8, 9]]);
  assert.throws(() => planChunks({ frameStart: 5, frameEnd: 4, chunkFrames: 2 }));
});

test('pngDimensions reads IHDR and rejects non-PNG bytes', () => {
  assert.deepEqual(pngDimensions(makePng(160, 120, [10, 20, 30])), { width: 160, height: 120 });
  assert.equal(pngDimensions(Buffer.from('not a png at all, just text bytes')), null);
});

test('stripPngMetadata drops metadata chunks and keeps the pixel chunks verbatim', () => {
  let png = makePng(160, 120, [10, 20, 30]);
  png = insertAfterIhdr(png, 'tEXt', Buffer.from('Date\0 2026-11-14 06:00:00', 'latin1'));
  png = insertAfterIhdr(png, 'tIME', Buffer.from([0x07, 0xea, 11, 14, 6, 0, 0]));
  png = insertAfterIhdr(png, 'pHYs', Buffer.from([0, 0, 0x0b, 0x13, 0, 0, 0x0b, 0x13, 1]));
  assert.deepEqual(pngChunkTypes(png), ['IHDR', 'pHYs', 'tIME', 'tEXt', 'IDAT', 'IEND']);

  const stripped = stripPngMetadata(png);
  assert.deepEqual(pngChunkTypes(stripped), ['IHDR', 'IDAT', 'IEND']);
  assert.deepEqual(pngDimensions(stripped), { width: 160, height: 120 });
  // The kept chunks are the original bytes, not a re-encode: stripping a
  // metadata-free PNG is the identity, and stripping is idempotent.
  assert.ok(stripPngMetadata(makePng(160, 120, [10, 20, 30])).equals(makePng(160, 120, [10, 20, 30])));
  assert.ok(stripPngMetadata(stripped).equals(stripped));
  assert.throws(() => stripPngMetadata(Buffer.from('not a png')), (e) => e.code === 'CARRIAGE_NOT_A_PNG');
});

test('fetchVerifiedItem pulls pin-verified portions and refuses tampered serving', async () => {
  const data = makePng(160, 120, [200, 30, 30]);
  const source = { id: 'render:fixture:frame:0001', kind: 'render-frame', name: 'frame_0001.png', size: data.length, sha256: null, readRange: async (s, l) => data.subarray(s, s + l) };
  const { createHash } = await import('node:crypto');
  source.sha256 = createHash('sha256').update(data).digest('hex');
  const descriptor = await buildPortionManifest(source, { portionBytes: 512 });
  assert.ok(descriptor.portionSha256.length > 4, 'fixture frame spans several portions');

  const good = createFleetNode({ nodeId: 'node-good', sources: new Map([[source.id, source]]), manifests: new Map([[source.id, descriptor]]) });
  const { url } = await good.listen(0, '127.0.0.1');
  try {
    const pulled = await fetchVerifiedItem({ descriptor, peers: [url] });
    assert.ok(pulled.data.equals(data));
    assert.ok(pulled.receipts.some((r) => r.outcome === 'accepted'));
  } finally { await good.close(); }

  const tampered = Buffer.from(data); tampered[Math.floor(tampered.length / 2)] ^= 0xff;
  const badSource = { ...source, readRange: async (s, l) => tampered.subarray(s, s + l) };
  const bad = createFleetNode({ nodeId: 'node-bad', sources: new Map([[source.id, badSource]]), manifests: new Map([[source.id, descriptor]]) });
  const { url: badUrl } = await bad.listen(0, '127.0.0.1');
  try {
    await assert.rejects(() => fetchVerifiedItem({ descriptor, peers: [badUrl] }), (e) => e.code === 'FLEET_PORTION_PIN_MISMATCH');
  } finally { await bad.close(); }
});

test('conductor accepts creations on issuance, refuses post-issuance tampering by name, and accepts a wholly different re-creation', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'carriage-test-'));
  const framesDir = path.join(dir, 'accepted');
  const goodDir = path.join(dir, 'good'); const badDir = path.join(dir, 'bad');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(goodDir); await mkdir(badDir);
  try {
    const jobId = 'testjob';
    const assetPin = { id: 'render:testjob:asset:scene.py', sha256: 'b606ea447e2aa0f5ddf71c6313798dae7820d368a143ce6b2cc807d1ba380511' };
    // The two nodes create DIFFERENT frames (different colours): a re-issue
    // is a new creation, so the second node's bytes never equal the first's.
    for (const [frame, colour] of [[1, [220, 40, 40]], [2, [40, 220, 40]]]) {
      await writeFile(path.join(badDir, frameFileName(frame)), makePng(160, 120, colour));
    }
    for (const [frame, colour] of [[1, [30, 30, 220]], [2, [220, 220, 30]]]) {
      await writeFile(path.join(goodDir, frameFileName(frame)), makePng(160, 120, colour));
    }
    // Issue a directory's frames the way a render node does at completion:
    // a portion manifest over the bytes (the issued hash) + a provenance
    // record crediting the vetted input, then serve from a fleet node.
    async function issueFrom(baseDir, nodeId) {
      const sources = new Map(); const manifests = new Map(); const issued = [];
      for (const frame of [1, 2]) {
        const id = frameItemId(jobId, frame);
        const src = await fileSource({ id, kind: 'render-frame', name: frameFileName(frame), path: path.join(baseDir, frameFileName(frame)) });
        sources.set(id, src);
        const descriptor = await buildPortionManifest(src, { portionBytes: 512 });
        manifests.set(id, descriptor);
        issued.push({ descriptor, provenance: { frame, jobId, chunkId: 'chunk-0', nodeId, sourceAssets: [assetPin], issuedAt: new Date().toISOString() } });
      }
      const node = createFleetNode({ nodeId, sources, manifests });
      const { url } = await node.listen(0, '127.0.0.1');
      return { node, url, issued };
    }

    const conductor = createRenderConductor({ jobId, framesDir });
    conductor.plan({ frameStart: 1, frameEnd: 2, chunkFrames: 2 });

    // node-bad issues its frames, then its served bytes are altered — the
    // artifact no longer matches its OWN issued hash: tamper-evidence
    // refusal, by name, and the node is excluded from the chunk.
    const claimBad = conductor.claim('node-bad');
    assert.equal(claimBad.chunk.chunkId, 'chunk-0');
    const bad = await issueFrom(badDir, 'node-bad');
    const badFile = path.join(badDir, frameFileName(1));
    const tampered = Buffer.from(await readFile(badFile)); tampered[Math.floor(tampered.length / 2)] ^= 0xff;
    await writeFile(badFile, tampered);
    const refused = await conductor.submit({ nodeId: 'node-bad', chunkId: 'chunk-0', fleetUrl: bad.url, frames: bad.issued });
    assert.equal(refused.accepted, false);
    assert.equal(refused.code, 'FLEET_PORTION_PIN_MISMATCH');
    await bad.node.close();

    const refusal = conductor.receipts.find((r) => r.event === 'frame-refused');
    assert.ok(refusal, 'a frame-refused receipt exists');
    assert.equal(refusal.nodeId, 'node-bad');
    assert.equal(refusal.frame, 1);
    assert.equal(refusal.basis, 'issued-hash-mismatch');
    assert.equal(conductor.jobDone(), false);
    assert.equal(conductor.claim('node-bad').chunk, null, 'the refused node is excluded from the chunk');

    // node-good's re-render is a NEW creation: entirely different bytes and
    // a different issued hash for the same frame numbers. It is accepted on
    // its own issuance — there is no comparison against node-bad's anything.
    const claimGood = conductor.claim('node-good');
    assert.equal(claimGood.chunk.chunkId, 'chunk-0');
    const good = await issueFrom(goodDir, 'node-good');
    assert.notEqual(good.issued[0].descriptor.sha256, bad.issued[0].descriptor.sha256,
      'the re-creation issues a different hash than the refused attempt');
    const accepted = await conductor.submit({ nodeId: 'node-good', chunkId: 'chunk-0', fleetUrl: good.url, frames: good.issued });
    assert.equal(accepted.accepted, true);
    assert.equal(conductor.jobDone(), true);
    await good.node.close();

    // The acceptance receipt records the issuance: issued hash + provenance
    // crediting the vetted source asset by pin.
    const acceptedReceipt = conductor.receipts.find((r) => r.event === 'frame-accepted' && r.frame === 1);
    assert.equal(acceptedReceipt.issuedSha256, good.issued[0].descriptor.sha256);
    assert.equal(acceptedReceipt.provenance.nodeId, 'node-good');
    assert.deepEqual(acceptedReceipt.provenance.sourceAssets, [assetPin]);

    const outPath = path.join(dir, 'out.mp4');
    const assembled = await conductor.assemble({ outPath, fps: 24, frameStart: 1 });
    assert.equal(assembled.frameCount, 2);
    assert.equal(assembled.width, 160);
    assert.equal(assembled.height, 120);
    await conductor.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
