// lib/render-carriage.mjs — Multi-node render carriage over the fleet layer.
//
// Doctrine (owner, 2026-11-14, final form): CREATED vs CONSUMED. Pins vet
// what the system CONSUMES; issued hashes seal and credit what the system
// CREATES. "Things that Kingmaker makes after vetting materials do not need
// to match hashes. They are created by the system. Their hash should be
// issued upon completion for verification that they were built by the
// system, not manipulated, so each part gives credit to its original
// source."
//
// CONSUMED — scene assets are materials: fleet nodes claim frame CHUNKS
// from the conductor and pull the assets as pin-verified portions through
// the fleet layer (lib/brain-library-fleet.mjs), byte-exact, refused by pin
// on any mismatch. This class is unchanged: anything that executes or
// drives execution is vetted before use.
//
// CREATED — rendered frames are creations, not materials. There is NO
// acceptance-by-matching for a frame: not against a pre-existing pin, not
// against another rendering, not against a pixel hash. At render completion
// the node strips the frame's PNG metadata (renders carry no metadata —
// separate owner ruling), ISSUES the frame's hash, and attaches a provenance
// record { frame, jobId, chunkId, nodeId, sourceAssets: the pins of the
// vetted inputs it was rendered from, issuedAt }. The conductor records the
// issued hash + provenance — the frame's credit to its source — and accepts
// the frame on issuance. The only post-issuance check is tamper-evidence: a
// frame's bytes must still match ITS OWN issued hash when pulled and at
// assembly. A mismatch means the artifact was manipulated after the system
// built it: the attempt is refused, the node named + excluded, and the
// chunk re-issued — the re-render is a NEW creation with its own newly
// issued hash + provenance, never a match attempt against the first
// rendering's anything. No re-render is ever triggered by byte disagreement
// between creations.
//
// The conductor is the job's rendezvous (claim/submit below); node discovery
// on a live mesh rides the fleet directory / Headscale (see
// lib/brain-library-fleet-directory.mjs). Live-mesh carriage is NOT proven by
// this module's loopback receipts — the same wall as fleet v1.

import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileSource } from './brain-library-access.mjs';
import { buildPortionManifest, createFleetNode, createFleetSource } from './brain-library-fleet.mjs';

export const RENDER_CARRIAGE_PROTOCOL = 'kingmaker.render-carriage/1';
export const ASSET_PORTION_BYTES = 1024;
export const FRAME_PORTION_BYTES = 4096;

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const pad4 = (n) => String(n).padStart(4, '0');

function carriageError(code, message, extra = {}) {
  const err = new Error(`render-carriage: ${message}`);
  err.code = code;
  return Object.assign(err, extra);
}

export const assetItemId = (jobId, name) => `render:${jobId}:asset:${name}`;
export const frameItemId = (jobId, frame) => `render:${jobId}:frame:${pad4(frame)}`;
export const frameFileName = (frame) => `frame_${pad4(frame)}.png`;

/** Split a frame range into chunk assignments. Pure; frames are 1-based inclusive. */
export function planChunks({ frameStart, frameEnd, chunkFrames }) {
  if (!Number.isInteger(frameStart) || !Number.isInteger(frameEnd) || frameEnd < frameStart) {
    throw new Error('render-carriage: frameStart/frameEnd must be integers with frameEnd >= frameStart');
  }
  if (!Number.isInteger(chunkFrames) || chunkFrames <= 0) throw new Error('render-carriage: chunkFrames must be a positive integer');
  const chunks = [];
  for (let start = frameStart, index = 0; start <= frameEnd; start += chunkFrames, index++) {
    const frames = [];
    for (let f = start; f <= Math.min(start + chunkFrames - 1, frameEnd); f++) frames.push(f);
    chunks.push({ chunkId: `chunk-${index}`, index, frames });
  }
  return chunks;
}

/**
 * Pull one fleet item whole, through the fleet source's per-portion pin
 * verification, then check the whole-item pin on the assembled bytes.
 * Returns { data, receipts } — the fleet layer's own attempt receipts.
 */
export async function fetchVerifiedItem({ descriptor, peers, meshToken = null, fetchImpl = fetch }) {
  const source = createFleetSource({ descriptor, peers, meshToken, fetchImpl });
  const data = await source.readRange(0, descriptor.size);
  if (data.length !== descriptor.size || sha256(data) !== descriptor.sha256) {
    throw carriageError('CARRIAGE_WHOLE_PIN_MISMATCH', `"${descriptor.id}" assembled to ${data.length} bytes whose sha256 does not match the committed whole pin`, { id: descriptor.id });
  }
  return { data, receipts: source.stats().receipts };
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Read a PNG's IHDR dimensions, or null when the bytes are not a PNG. */
export function pngDimensions(data) {
  if (data.length < 24 || !data.subarray(0, 8).equals(PNG_SIGNATURE) || data.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

/*
 * PNG chunks a rendered frame keeps at issuance. Everything else — tEXt,
 * zTXt, iTXt, tIME, pHYs, eXIf, and any other ancillary chunk — is metadata,
 * and renders carry no metadata (owner ruling, 2026-11-14). The keep set is
 * the chunks that carry the pixels or govern their identical decode: IHDR,
 * PLTE, tRNS (palette alpha), the colour chunks (gAMA, cHRM, sRGB, iCCP),
 * sBIT (significant bits), IDAT, IEND.
 */
const PNG_KEEP_CHUNKS = new Set(['IHDR', 'PLTE', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP', 'sBIT', 'IDAT', 'IEND']);

/**
 * Strip a PNG's metadata chunks, keeping only PNG_KEEP_CHUNKS, byte-for-byte
 * (chunk length/type/data/CRC are copied verbatim — nothing is re-encoded).
 * Throws CARRIAGE_NOT_A_PNG on a bad signature or a truncated chunk.
 */
export function stripPngMetadata(data) {
  if (data.length < 8 || !data.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw carriageError('CARRIAGE_NOT_A_PNG', 'frame bytes do not start with the PNG signature');
  }
  const parts = [data.subarray(0, 8)];
  let offset = 8;
  let sawIend = false;
  while (offset < data.length) {
    if (offset + 8 > data.length) throw carriageError('CARRIAGE_NOT_A_PNG', `truncated PNG chunk header at byte ${offset}`);
    const length = data.readUInt32BE(offset);
    const type = data.toString('latin1', offset + 4, offset + 8);
    const end = offset + 8 + length + 4;
    if (end > data.length) throw carriageError('CARRIAGE_NOT_A_PNG', `truncated PNG chunk ${type} at byte ${offset}`);
    if (PNG_KEEP_CHUNKS.has(type)) parts.push(data.subarray(offset, end));
    if (type === 'IEND') { sawIend = true; break; }
    offset = end;
  }
  if (!sawIend) throw carriageError('CARRIAGE_NOT_A_PNG', 'PNG has no IEND chunk');
  return Buffer.concat(parts);
}

/** The chunk type names present in a PNG, in file order (proof/test helper). */
export function pngChunkTypes(data) {
  if (data.length < 8 || !data.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  const types = [];
  let offset = 8;
  while (offset + 8 <= data.length) {
    const length = data.readUInt32BE(offset);
    const type = data.toString('latin1', offset + 4, offset + 8);
    types.push(type);
    offset += 8 + length + 4;
    if (type === 'IEND') break;
  }
  return types;
}

/**
 * A creation's provenance record must bind the frame, this job, this chunk,
 * and the submitting node, and must credit the vetted inputs it was created
 * from (sourceAssets: [{ id, sha256 }] — the pins of the consumed materials).
 * Anything less is not an issuance the conductor can record.
 */
function assertProvenance(provenance, { frame, jobId, chunkId, nodeId }) {
  const bad = (why) => carriageError('CARRIAGE_PROVENANCE_INVALID', `frame ${frame} from ${nodeId} carries no recordable issuance: ${why}`, { frame });
  if (!provenance || typeof provenance !== 'object') throw bad('provenance record missing');
  if (provenance.frame !== frame) throw bad(`provenance.frame is ${provenance.frame}, expected ${frame}`);
  if (provenance.jobId !== jobId) throw bad(`provenance.jobId is ${provenance.jobId}, expected ${jobId}`);
  if (provenance.chunkId !== chunkId) throw bad(`provenance.chunkId is ${provenance.chunkId}, expected ${chunkId}`);
  if (provenance.nodeId !== nodeId) throw bad(`provenance.nodeId is ${provenance.nodeId}, expected ${nodeId}`);
  if (!Array.isArray(provenance.sourceAssets) || provenance.sourceAssets.length === 0
    || provenance.sourceAssets.some((a) => !a?.id || !a?.sha256)) {
    throw bad('sourceAssets must credit at least one vetted input by id + pin');
  }
  if (!provenance.issuedAt) throw bad('issuedAt missing');
}

/* ------------------------------------------------------------------ */
/* Conductor                                                           */
/* ------------------------------------------------------------------ */

/**
 * The render conductor: publishes the job's assets on a fleet node, leases
 * chunks to claiming nodes, records each submitted frame's issued hash +
 * provenance, and assembles the finished sequence. Frame acceptance is
 * issuance, never matching (see the doctrine note at the top of this file);
 * the pull of a submitted frame is checked only against that frame's own
 * issued record — tamper-evidence. All events accumulate on `receipts`.
 */
export function createRenderConductor({ jobId, framesDir, meshToken = null, now = () => Date.now() } = {}) {
  if (!jobId) throw new Error('render-carriage: jobId is required');
  if (!framesDir) throw new Error('render-carriage: framesDir is required');
  const receipts = [];
  const record = (entry) => { receipts.push({ t: now(), ...entry }); return entry; };
  let chunks = null;
  let assetNode = null;
  let assetUrl = null;
  let assetDescriptors = [];
  const acceptedFrames = new Map(); // frame -> { descriptor, provenance, nodeId, path }
  let server = null;

  const jobDone = () => !!chunks && chunks.every((c) => c.status === 'done');

  function plan({ frameStart, frameEnd, chunkFrames }) {
    chunks = planChunks({ frameStart, frameEnd, chunkFrames }).map((c) => ({
      ...c, status: 'pending', leasedTo: null, exclude: [], attempts: [],
    }));
    record({ event: 'job-planned', jobId, frameStart, frameEnd, chunkFrames, chunks: chunks.map((c) => ({ chunkId: c.chunkId, frames: c.frames })) });
    return chunks;
  }

  async function publishAssets(assetSources, { portionBytes = ASSET_PORTION_BYTES } = {}) {
    const manifests = new Map();
    for (const [id, source] of assetSources) manifests.set(id, await buildPortionManifest(source, { portionBytes }));
    assetNode = createFleetNode({ nodeId: `conductor:${jobId}`, sources: assetSources, manifests, meshToken });
    const { url } = await assetNode.listen(0, '127.0.0.1');
    assetUrl = url;
    assetDescriptors = [...manifests.values()];
    record({ event: 'assets-published', url, assets: assetDescriptors.map((d) => ({ id: d.id, size: d.size, sha256: d.sha256, portions: d.portionSha256.length })) });
    return { url, descriptors: assetDescriptors };
  }

  function claim(nodeId) {
    const chunk = chunks?.find((c) => c.status === 'pending' && !c.exclude.includes(nodeId));
    if (!chunk) return { chunk: null, jobDone: jobDone() };
    chunk.status = 'leased';
    chunk.leasedTo = nodeId;
    record({ event: 'chunk-claimed', chunkId: chunk.chunkId, frames: chunk.frames, nodeId });
    return { chunk: { chunkId: chunk.chunkId, frames: chunk.frames }, jobDone: false };
  }

  /**
   * A node announces the frames it created for its leased chunk:
   * frames = [{ descriptor, provenance }] — the descriptor carries the hash
   * the node ISSUED for the frame at render completion; provenance is the
   * creation record ({ frame, jobId, chunkId, nodeId, sourceAssets,
   * issuedAt }). The conductor records the issuance and pulls each frame;
   * the pulled bytes are checked only against that frame's own issued hash
   * (tamper-evidence — the artifact must be the one the system built). A
   * mismatch refuses the whole attempt: the attempt's staged frames are
   * discarded, the node is named + excluded, and the chunk returns to
   * pending, where the re-render is a new creation with its own issuance.
   */
  async function submit({ nodeId, chunkId, fleetUrl, frames, pullReceipts = [] }) {
    const chunk = chunks?.find((c) => c.chunkId === chunkId);
    if (!chunk || chunk.status !== 'leased' || chunk.leasedTo !== nodeId) {
      return { accepted: false, reason: 'chunk-not-leased-to-node', chunkId, nodeId };
    }
    for (const r of pullReceipts) record({ event: 'asset-pull-receipt', nodeId, ...r });
    const attempt = { nodeId, outcomes: [] };
    const staged = new Map();
    let refusal = null;
    for (const entry of frames) {
      const descriptor = entry?.descriptor ?? entry;
      const provenance = entry?.provenance ?? null;
      const frame = Number(descriptor.id.split(':').pop());
      try {
        assertProvenance(provenance, { frame, jobId, chunkId, nodeId });
        const { data, receipts: pull } = await fetchVerifiedItem({ descriptor, peers: [fleetUrl], meshToken });
        staged.set(frame, { descriptor, provenance, data });
        attempt.outcomes.push({ frame, outcome: 'accepted', issuedSha256: descriptor.sha256, portions: pull.filter((r) => r.outcome === 'accepted').length });
      } catch (e) {
        refusal = {
          frame, code: e?.code ?? 'CARRIAGE_SUBMIT_FAILED', issuedSha256: descriptor.sha256,
          basis: e?.code === 'CARRIAGE_PROVENANCE_INVALID' ? 'issuance-record-invalid' : 'issued-hash-mismatch',
          message: String(e?.message ?? e).slice(0, 240),
        };
        attempt.outcomes.push({ frame, outcome: 'refused', code: refusal.code, basis: refusal.basis });
        break;
      }
    }
    chunk.attempts.push(attempt);
    if (refusal) {
      chunk.status = 'pending';
      chunk.leasedTo = null;
      chunk.exclude.push(nodeId);
      record({ event: 'frame-refused', chunkId, nodeId, frame: refusal.frame, code: refusal.code, basis: refusal.basis, issuedSha256: refusal.issuedSha256, message: refusal.message, reissued: true, excludedNode: nodeId });
      return { accepted: false, refusedFrame: refusal.frame, code: refusal.code, chunkId, jobDone: jobDone() };
    }
    await mkdir(framesDir, { recursive: true });
    for (const [frame, { descriptor, provenance, data }] of staged) {
      const file = path.join(framesDir, frameFileName(frame));
      await writeFile(file, data);
      acceptedFrames.set(frame, { descriptor, provenance, nodeId, path: file });
      record({ event: 'frame-accepted', chunkId, nodeId, frame, issuedSha256: descriptor.sha256, bytes: data.length, portions: descriptor.portionSha256.length, provenance });
    }
    chunk.status = 'done';
    chunk.leasedTo = null;
    record({ event: 'chunk-done', chunkId, nodeId, frames: chunk.frames });
    return { accepted: true, chunkId, frames: [...staged.keys()], jobDone: jobDone() };
  }

  /**
   * Assemble the finished sequence: every planned frame must be present and
   * still hash to ITS OWN issued hash (tamper-evidence at rest — the stored
   * artifact must be the creation the system issued), then ffmpeg
   * concatenates in order and ffprobe counts the frames in the result.
   */
  async function assemble({ outPath, fps = 24, frameStart, frameEnd }) {
    if (!jobDone()) throw carriageError('CARRIAGE_JOB_INCOMPLETE', 'assembly refused: the job is not complete');
    const planned = chunks.flatMap((c) => c.frames);
    for (const frame of planned) {
      const held = acceptedFrames.get(frame);
      if (!held) throw carriageError('CARRIAGE_FRAME_MISSING', `frame ${frame} has no recorded issuance`, { frame });
      const data = await readFile(held.path);
      if (sha256(data) !== held.descriptor.sha256) {
        throw carriageError('CARRIAGE_FRAME_TAMPERED_AT_REST', `stored frame ${frame} no longer matches its own issued hash — manipulated after issuance`, { frame });
      }
    }
    record({ event: 'assembly-verified', frames: planned.length, note: 'every stored frame re-hashed against its own issued hash' });
    await runProcess('ffmpeg', ['-y', '-v', 'error', '-framerate', String(fps), '-start_number', String(frameStart ?? planned[0]), '-i', path.join(framesDir, 'frame_%04d.png'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', outPath]);
    const probe = await runProcess('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames,width,height', '-of', 'json', outPath]);
    const stream = JSON.parse(probe.stdout).streams?.[0] ?? {};
    const frameCount = Number(stream.nb_read_frames);
    const assembled = await readFile(outPath);
    const result = { outPath, frameCount, expectedFrames: planned.length, width: stream.width, height: stream.height, bytes: assembled.length, sha256: sha256(assembled) };
    if (frameCount !== planned.length) throw carriageError('CARRIAGE_ASSEMBLY_COUNT', `assembled file holds ${frameCount} frames, expected ${planned.length}`, result);
    record({ event: 'assembled', ...result });
    return result;
  }

  function authorized(req) {
    if (!meshToken) return true;
    return req.headers['x-kingmaker-mesh-token'] === meshToken;
  }

  async function handler(req, res) {
    const send = (status, body) => {
      if (res.destroyed) return;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    try {
      if (!authorized(req)) return send(403, { error: 'mesh admission refused' });
      const url = new URL(req.url, 'http://carriage.local');
      if (req.method === 'GET' && url.pathname === '/v1/carriage/status') {
        return send(200, {
          protocol: RENDER_CARRIAGE_PROTOCOL, jobId, jobDone: jobDone(), assetUrl,
          assets: assetDescriptors.map((d) => ({ id: d.id, sha256: d.sha256 })),
          chunks: (chunks ?? []).map((c) => ({ chunkId: c.chunkId, frames: c.frames, status: c.status, leasedTo: c.leasedTo, exclude: c.exclude, attempts: c.attempts.length })),
          receipts,
        });
      }
      if (req.method === 'POST' && url.pathname === '/v1/carriage/claim') {
        const body = await readJsonBody(req);
        if (!body?.nodeId) return send(400, { error: 'nodeId is required' });
        return send(200, { ...claim(body.nodeId), assetUrl, assets: assetDescriptors });
      }
      if (req.method === 'POST' && url.pathname === '/v1/carriage/submit') {
        const body = await readJsonBody(req);
        if (!body?.nodeId || !body?.chunkId || !body?.fleetUrl || !Array.isArray(body?.frames)) return send(400, { error: 'nodeId, chunkId, fleetUrl, frames[] are required' });
        return send(200, await submit(body));
      }
      return send(404, { error: 'unknown carriage path' });
    } catch (e) {
      return send(500, { error: String(e?.message ?? e) });
    }
  }

  return {
    jobId, receipts, plan, publishAssets, claim, submit, assemble, jobDone,
    acceptedFrames: () => new Map(acceptedFrames),
    chunks: () => chunks,
    async listen(port = 0, host = '127.0.0.1') {
      server = createServer(handler);
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
      const address = server.address();
      return { url: `http://${host}:${address.port}`, port: address.port };
    },
    async close() {
      await assetNode?.close().catch(() => {});
      if (!server) return;
      const s = server; server = null;
      s.closeAllConnections?.();
      await new Promise((resolve) => s.close(() => resolve()));
    },
  };
}

/* ------------------------------------------------------------------ */
/* Worker                                                              */
/* ------------------------------------------------------------------ */

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const parts = [];
    req.on('data', (c) => parts.push(c));
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(parts).toString('utf8') || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function runProcess(cmd, args, { cwd, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(carriageError('CARRIAGE_PROCESS_FAILED', `${cmd} exited ${code}: ${stderr.slice(-400)}`, { cmd, code, stdout: stdout.slice(-400) }));
    });
  });
}

async function carriagePost(url, body, meshToken) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(meshToken ? { 'x-kingmaker-mesh-token': meshToken } : {}) },
    body: JSON.stringify(body),
  });
  if (res.status !== 200) throw carriageError('CARRIAGE_CONDUCTOR_REFUSED', `${url} answered HTTP ${res.status}`, { url });
  return res.json();
}

/**
 * One node's render loop: claim a chunk, pull the assets pin-verified (the
 * consumed-materials class — byte-exact), render with Blender (the conducted
 * tool path: `blender --background --python`, run in the node's own work dir
 * with PWD in agreement — the 2026-11-13 lesson), then ISSUE each created
 * frame: strip its PNG metadata, hash the stripped bytes, attach the
 * provenance record crediting the vetted inputs, serve the frame from a
 * fleet node, and submit the issuance to the conductor.
 *
 * `corruptOnClaim` (proof hook, 1-based): on that claim, AFTER the chunk's
 * first frame is issued, flip bytes in the served file — the artifact no
 * longer matches its own issued hash, so the tamper-evidence refusal leg is
 * exercised end to end.
 */
export async function runRenderWorker({
  nodeId, conductorUrl, blenderBin, workDir,
  meshToken = null, framePortionBytes = FRAME_PORTION_BYTES,
  pollMs = 250, maxIdlePolls = 240, corruptOnClaim = 0,
} = {}) {
  if (!nodeId || !conductorUrl || !blenderBin || !workDir) throw new Error('render-carriage: nodeId, conductorUrl, blenderBin, workDir are required');
  const summary = { nodeId, claims: 0, renderedChunks: [], refusedChunks: [], assetPulls: [], done: false };
  const assetsDir = path.join(workDir, 'assets');
  await mkdir(assetsDir, { recursive: true });
  let assetsReady = false;
  let pullReceiptsSent = false;
  let scenePath = null;
  let sourceAssetPins = []; // [{ id, sha256 }] — the vetted inputs, credited in every provenance record
  let idle = 0;

  for (;;) {
    const reply = await carriagePost(`${conductorUrl}/v1/carriage/claim`, { nodeId }, meshToken);
    if (!reply.chunk) {
      if (reply.jobDone) { summary.done = true; return summary; }
      if (++idle > maxIdlePolls) { summary.stalled = true; return summary; }
      await new Promise((r) => setTimeout(r, pollMs));
      continue;
    }
    idle = 0;
    summary.claims++;
    const { chunkId, frames } = reply.chunk;

    if (!assetsReady) {
      sourceAssetPins = reply.assets.map((d) => ({ id: d.id, sha256: d.sha256 }));
      for (const descriptor of reply.assets) {
        const { data, receipts } = await fetchVerifiedItem({ descriptor, peers: [reply.assetUrl], meshToken });
        const file = path.join(assetsDir, descriptor.id.split(':').pop());
        await writeFile(file, data);
        if (file.endsWith('.py')) scenePath = file;
        summary.assetPulls.push({ id: descriptor.id, sha256: descriptor.sha256, portionsAccepted: receipts.filter((r) => r.outcome === 'accepted').length });
      }
      assetsReady = true;
    }

    const outDir = path.join(workDir, `render-${chunkId}`);
    await mkdir(outDir, { recursive: true });
    const env = {
      ...process.env, PWD: workDir,
      CARRIAGE_FRAME_START: String(frames[0]), CARRIAGE_FRAME_END: String(frames[frames.length - 1]),
      CARRIAGE_OUT_DIR: outDir,
    };
    await runProcess(blenderBin, ['--background', '--python', scenePath], { cwd: workDir, env });
    // A green exit is not a render: every claimed frame file must exist.
    for (const frame of frames) {
      if (!existsSync(path.join(outDir, frameFileName(frame)))) {
        throw carriageError('CARRIAGE_RENDER_MISSING_ARTIFACT', `${nodeId} exited Blender without producing frame ${frame} for ${chunkId}`, { frame, chunkId });
      }
    }

    // ISSUANCE — the frame is a creation, not a material. Strip its PNG
    // metadata (renders carry none), issue its hash over the stripped bytes,
    // and bind its provenance: the vetted inputs it was created from. The
    // stripped bytes are the frame from here on — what is served is exactly
    // what was issued, so any later byte change is tamper-evidence.
    const jobId = currentJobId(reply);
    const issuedAt = new Date().toISOString();
    const sources = new Map();
    const issued = [];
    for (const frame of frames) {
      const file = path.join(outDir, frameFileName(frame));
      await writeFile(file, stripPngMetadata(await readFile(file)));
      const id = frameItemId(jobId, frame);
      const source = await fileSource({ id, kind: 'render-frame', name: frameFileName(frame), path: file });
      sources.set(id, source);
      const descriptor = await buildPortionManifest(source, { portionBytes: framePortionBytes });
      issued.push({ descriptor, provenance: { frame, jobId, chunkId, nodeId, sourceAssets: sourceAssetPins, issuedAt } });
    }
    const manifests = new Map(issued.map(({ descriptor }) => [descriptor.id, descriptor]));

    // Proof hook: tamper AFTER issuance — the served bytes stop matching the
    // frame's own issued hash.
    let corruptedFrame = null;
    if (corruptOnClaim === summary.claims) {
      const frame = frames[0];
      const file = path.join(outDir, frameFileName(frame));
      const tampered = Buffer.from(await readFile(file));
      const at = Math.floor(tampered.length / 2);
      for (let i = 0; i < 64; i++) tampered[at + i] ^= 0xff;
      await writeFile(file, tampered);
      corruptedFrame = frame;
    }

    const fleetNode = createFleetNode({ nodeId, sources, manifests, meshToken });
    const { url: fleetUrl } = await fleetNode.listen(0, '127.0.0.1');
    try {
      const result = await carriagePost(`${conductorUrl}/v1/carriage/submit`, {
        nodeId, chunkId, fleetUrl,
        frames: issued,
        pullReceipts: pullReceiptsSent ? [] : summary.assetPulls.map((p) => ({ event: 'asset-pull', id: p.id, sha256: p.sha256, portionsAccepted: p.portionsAccepted })),
      }, meshToken);
      pullReceiptsSent = true;
      if (result.accepted) summary.renderedChunks.push({ chunkId, frames, issued: issued.map(({ descriptor, provenance }) => ({ frame: provenance.frame, sha256: descriptor.sha256 })), ...(corruptedFrame ? { corruptedFrame } : {}) });
      else summary.refusedChunks.push({ chunkId, frames, code: result.code, refusedFrame: result.refusedFrame, corruptedFrame });
      if (result.jobDone) { summary.done = true; return summary; }
    } finally {
      await fleetNode.close();
    }
  }
}

// The job id rides the asset ids (render:<jobId>:asset:<name>); the worker
// learns it from the first claim reply rather than being told out of band.
function currentJobId(claimReply) {
  const id = claimReply?.assets?.[0]?.id ?? '';
  const m = id.match(/^render:(.+):asset:/);
  if (!m) throw new Error('render-carriage: claim reply carried no asset id to learn the job id from');
  return m[1];
}
