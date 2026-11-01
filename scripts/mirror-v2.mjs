#!/usr/bin/env node
// scripts/mirror-v2.mjs — the verifying, resumable update-host mirror (finish plan Phase 2).
//
// Why this exists: the v0.4.2 finisher's mirror died on a Cloudflare 502 at
// part08 and left the release half-published, rescued by a hand-written
// recovery script. Mirror v2 makes that failure boring:
//
//   · Every object is verified AFTER upload (read back, sha256 compared).
//   · A run is resumable: objects already present with the right hash are
//     skipped, so a 502 costs a retry, never an orphaned release.
//   · latest.json flips LAST, and only when every object verified. A mirror
//     that cannot complete changes nothing an enrolled Mac can see.
//   · Transient failures (5xx / network) retry with backoff; permanent
//     failures stop the run and name the object.
//
// The transport is injected: production uses wrangler R2 (below); tests use
// an in-memory transport with fault injection — including the part08 502.
//
//   node scripts/mirror-v2.mjs --release <dir> --manifest <kingmaker-manifest.json> --bucket kingmaker-releases [--dry-run]

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLatest, latestProblems, platformObjects } from '../lib/release-platforms.mjs';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const isTransient = (e) => /HTTP 5\d\d|502|503|504|ECONNRESET|ETIMEDOUT|fetch failed|network/i.test(String(e?.message ?? e));

/**
 * mirrorRelease({ objects, latest, transport, maxAttempts, backoffMs, sleep, log })
 *   objects   [{ key, file, sha256, size }] — everything but latest.json
 *   latest    { key, text } — written last, only on a fully verified set
 *   transport { put(key, file), head(key) -> {sha256,size}|null, putText(key, text), getText(key) }
 * Returns { ok, flipped, uploaded: [keys], skipped: [keys], failed: [{key, error}] }.
 */
export async function mirrorRelease({ objects, latest, transport, maxAttempts = 4, backoffMs = 500, sleep, log = () => {} }) {
  const wait = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const uploaded = [];
  const skipped = [];
  const failed = [];

  for (const obj of objects) {
    let done = false;
    let lastErr = null;
    for (let attempt = 1; attempt <= maxAttempts && !done; attempt += 1) {
      try {
        const head = await transport.head(obj.key);
        if (head && head.sha256 === obj.sha256 && head.size === obj.size) {
          skipped.push(obj.key); done = true; log(`= ${obj.key} already mirrored (verified)`); break;
        }
        await transport.put(obj.key, obj.file);
        const after = await transport.head(obj.key);
        if (!after || after.sha256 !== obj.sha256) throw new Error(`post-upload verify failed for ${obj.key} (remote ${after?.sha256?.slice(0, 12) ?? 'absent'} != ${obj.sha256.slice(0, 12)})`);
        uploaded.push(obj.key); done = true; log(`+ ${obj.key} uploaded + verified`);
      } catch (e) {
        lastErr = e;
        if (!isTransient(e) || attempt === maxAttempts) break;
        log(`! ${obj.key}: ${e.message} — retry ${attempt}/${maxAttempts}`);
        await wait(backoffMs * attempt);
      }
    }
    if (!done) failed.push({ key: obj.key, error: String(lastErr?.message ?? lastErr) });
  }

  if (failed.length) {
    log(`✗ mirror incomplete: ${failed.map((f) => f.key).join(', ')} — latest.json NOT flipped`);
    return { ok: false, flipped: false, uploaded, skipped, failed };
  }

  // The flip: only a fully verified object set ever becomes visible.
  const current = await transport.getText(latest.key).catch(() => null);
  if (current !== latest.text) {
    await transport.putText(latest.key, latest.text);
    log(`✓ all ${objects.length} objects verified — ${latest.key} flipped`);
  } else {
    log(`= ${latest.key} already current`);
  }
  return { ok: true, flipped: true, uploaded, skipped, failed };
}

/* ------------------------------------------------------------------ */
/* Wrangler R2 transport (production)                                  */
/* ------------------------------------------------------------------ */

/** Transport over `wrangler r2 object` — put from file; head/get via a
 *  download to a temp file whose sha256 is computed locally (R2's own
 *  metadata is not trusted for the verify; the BYTES are). */
export function wranglerTransport({ bucket, profile, run = spawnSync }) {
  const env = { ...process.env };
  if (env.CLOUDFLARE_API_TOKEN) throw new Error('mirror-v2: CLOUDFLARE_API_TOKEN is set — it overrides wrangler profiles; unset it (the release runbooks depend on profile auth)');
  const wr = (args) => {
    const full = ['r2', 'object', ...args, '--remote'];
    if (profile) full.push('--profile', profile);
    const r = run('wrangler', full, { encoding: 'utf8', env, maxBuffer: 1024 * 1024 * 16 });
    if (r.status !== 0) throw new Error(`wrangler ${args[0]} ${args[1] ?? ''}: HTTP ${(String(r.stderr || r.stdout).match(/\b(5\d\d|4\d\d)\b/) || [])[1] ?? 'error'} ${String(r.stderr || '').trim().slice(-160)}`);
    return r;
  };
  const download = (key) => {
    const tmp = join(tmpdir(), `mirror-v2-${process.pid}-${Math.abs([...key].reduce((a, c) => a * 31 + c.charCodeAt(0) | 0, 7))}.bin`);
    try {
      wr(['get', `${bucket}/${key}`, '--file', tmp]);
      return readFileSync(tmp);
    } catch { return null; } finally { try { unlinkSync(tmp); } catch { /* already gone */ } }
  };
  return {
    async put(key, file) { wr(['put', `${bucket}/${key}`, '--file', file]); },
    async head(key) {
      const bytes = download(key);
      return bytes ? { sha256: sha256(bytes), size: bytes.length } : null;
    },
    async putText(key, text) {
      const tmp = join(tmpdir(), `mirror-v2-${process.pid}-latest.json`);
      writeFileSync(tmp, text);
      try { wr(['put', `${bucket}/${key}`, '--file', tmp]); } finally { try { unlinkSync(tmp); } catch { /* already gone */ } }
    },
    async getText(key) { const b = download(key); return b ? b.toString('utf8') : null; },
  };
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

function arg(argv, name, fallback = undefined) {
  const at = argv.indexOf(name);
  return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback;
}

async function main(argv = process.argv.slice(2)) {
  const releaseDir = arg(argv, '--release');
  const manifestFile = arg(argv, '--manifest');
  const bucket = arg(argv, '--bucket', 'kingmaker-releases');
  if (!releaseDir || !manifestFile) { console.error('usage: mirror-v2.mjs --release <dir> --manifest <file> [--bucket <name>] [--profile <wrangler-profile>] [--dry-run]'); return 2; }
  const manifest = JSON.parse(readFileSync(resolve(manifestFile), 'utf8'));
  const version = String(manifest.version);
  const objects = manifest.parts.map((p) => ({ key: `v${version}/${p.name}`, file: join(resolve(releaseDir), p.name), sha256: p.sha256, size: p.size }));
  objects.push({ key: `v${version}/${manifestFile.split('/').pop()}`, file: resolve(manifestFile), sha256: sha256(readFileSync(resolve(manifestFile))), size: readFileSync(resolve(manifestFile)).length });
  // latest.json (lib/release-platforms.mjs buildLatest): the legacy top
  // level — version, tag, engineSha256, archive — exactly as enrolled Macs
  // already read it, PLUS the platforms map. Non-mac platform artifacts
  // (built on their own hosts; files at <release>/<platform>/<name>) join
  // the object set under v<version>/<platform>/; placeholders add nothing.
  // A latest that fails its own shape check never flips.
  const latestObj = buildLatest({ manifest });
  const latestShapeProblems = latestProblems(latestObj);
  if (latestShapeProblems.length) { console.error(`mirror-v2: the latest.json for ${version} is unsound: ${latestShapeProblems.join('; ')} — nothing mirrored`); return 1; }
  objects.push(...platformObjects({ version, platforms: latestObj.platforms, dir: resolve(releaseDir) }));
  const latest = { key: 'latest.json', text: `${JSON.stringify(latestObj, null, 2)}\n` };
  if (argv.includes('--dry-run')) {
    console.log(JSON.stringify({ bucket, objects: objects.map((o) => o.key), latestKey: latest.key }, null, 2));
    return 0;
  }
  const transport = wranglerTransport({ bucket, profile: arg(argv, '--profile') });
  const result = await mirrorRelease({ objects, latest, transport, log: (l) => console.log(l) });
  console.log(JSON.stringify(result, null, 2));
  return result.ok ? 0 : 1;
}

function invokedDirectly() {
  try { return resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url); } catch { return false; }
}
if (invokedDirectly()) main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(1); });
