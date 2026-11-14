#!/usr/bin/env node
// Measure the streaming layer on THIS machine, in isolation: a synthetic file in a temp
// directory (or a directory you name, e.g. on an external drive), read through
// lib/brain-library-access.mjs. It touches no live app data, starts no model, and fetches
// nothing from the network. Each control is varied on its own:
//   portion size      how much one read asks for
//   reuse cache       how many bytes of already-read blocks are kept
// Usage:
//   node scripts/streaming-bench.mjs [--size-mb 64] [--dir <where the test file goes>] [--json <report file>]
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, openSync, writeSync, closeSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createBrainLibraryAccess, fileSource } from '../lib/brain-library-access.mjs';

const args = process.argv.slice(2);
const opt = (n, d = null) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const sizeMb = Number(opt('size-mb', 64));
const base = opt('dir') ? resolve(opt('dir')) : tmpdir();
mkdirSync(base, { recursive: true });
const work = mkdtempSync(join(base, 'kingmaker-streaming-bench-'));
const file = join(work, 'synthetic-library.bin');
const fd = openSync(file, 'w'); const fileHash = createHash('sha256');
for (let i = 0; i < sizeMb; i++) { const b = randomBytes(1024 * 1024); fileHash.update(b); writeSync(fd, b); }
closeSync(fd);
const size = sizeMb * 1024 * 1024;
const expected = fileHash.digest('hex');

function counted(source) {
  const c = { reads: 0, bytes: 0 };
  return { c, source: { ...source, readRange: async (s, l) => { c.reads++; const d = await source.readRange(s, l); c.bytes += d.length; return d; } } };
}
async function measure(label, opts, run) {
  const { c, source } = counted(await fileSource({ id: 'lib', kind: 'knowledge', path: file, sha256: expected }));
  const access = createBrainLibraryAccess({ sources: { lib: source }, storeDir: join(work, `store-${label}`), cacheDir: join(work, `cache-${label}`), stateDir: join(work, `state-${label}`), ...opts });
  global.gc?.();
  const rss0 = process.memoryUsage().rss; let peak = rss0;
  const tick = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 5);
  const t0 = process.hrtime.bigint();
  const consumed = await run(access);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  clearInterval(tick); peak = Math.max(peak, process.memoryUsage().rss);
  return { case: label, ms: Number(ms.toFixed(1)), source_reads: c.reads, bytes_from_source: c.bytes, bytes_consumed: consumed, peak_rss_growth_mb: Number(((peak - rss0) / 1048576).toFixed(1)), reuse: access.reuseStats() };
}

const results = [];
for (const portion of [65_536, 262_144, 1_048_576]) {
  results.push(await measure(`sequential-${portion / 1024}KiB`, {}, async (a) => (await a.streamThrough('lib', { portionBytes: portion })).bytes));
}
const repeats = 200, block = 65_536;
for (const budget of [0, 8 * 1048576]) {
  results.push(await measure(`repeat-same-8-blocks-cache-${budget / 1048576}MiB`, { reuseCacheBytes: budget }, async (a) => {
    let n = 0; for (let i = 0; i < repeats; i++) n += (await a.readPortion('lib', { start: (i % 8) * block, length: block })).data.length; return n;
  }));
}
for (const budget of [0, 8 * 1048576]) {
  results.push(await measure(`sparse-random-cache-${budget / 1048576}MiB`, { reuseCacheBytes: budget }, async (a) => {
    let n = 0, x = 12345;
    for (let i = 0; i < repeats; i++) { x = (x * 1103515245 + 12345) % 2147483648; const start = Math.floor((x / 2147483648) * (size - block)); n += (await a.readPortion('lib', { start, length: block })).data.length; }
    return n;
  }));
}
results.push(await measure('download-then-verify', {}, async (a) => (await a.download('lib')).bytes));

const report = { machine: `${process.platform}-${process.arch}`, node: process.version, file_mb: sizeMb, dir: base, at: new Date().toISOString(), results };
rmSync(work, { recursive: true, force: true });
if (opt('json')) writeFileSync(resolve(opt('json')), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
