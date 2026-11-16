#!/usr/bin/env node
// scripts/storage-bench.mjs — read/write speed of Kingmaker's verified saves on given folders (e.g. a scratch exFAT /
// FAT32 disk image vs an internal temp dir). Writes only inside <dir>/km-bench-<random>/ and removes it afterwards.
//   node scripts/storage-bench.mjs --dir /tmp/x --dir /scratch/m1-exfat [--mb 8] [--reps 3] [--small 200] [--json out.json]
// Reads are measured right after writing, so they are mostly served from the page cache: they are NOT cold-media reads.
import { mkdirSync, openSync, readFileSync, rmSync, writeSync, fsyncSync, closeSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { safeWriteFile } from '../lib/external-storage.mjs';

const args = process.argv.slice(2);
const dirs = args.flatMap((a, i) => (args[i - 1] === '--dir' ? [a] : []));
const num = (n, d) => { const i = args.indexOf(n); return i >= 0 ? Number(args[i + 1]) : d; };
const MB = num('--mb', 8), REPS = num('--reps', 3), SMALL = num('--small', 200);
const out = [];
for (const dir of dirs) {
  const root = join(dir, `km-bench-${randomBytes(4).toString('hex')}`); mkdirSync(root, { recursive: true });
  try {
    const buf = randomBytes(MB << 20);
    const r = { dir, mb: MB, reps: REPS, rawWriteMBs: [], verifiedWriteMBs: [], readMBs: [], smallVerifiedOpsPerSec: null, smallBytes: 2048 };
    for (let i = 0; i < REPS; i++) {
      let t = performance.now();
      const fd = openSync(join(root, `raw-${i}.bin`), 'w'); writeSync(fd, buf); fsyncSync(fd); closeSync(fd);
      r.rawWriteMBs.push(+(MB / ((performance.now() - t) / 1000)).toFixed(1));
      rmSync(join(root, `raw-${i}.bin`));
      t = performance.now();
      await safeWriteFile(join(root, `v-${i}.bin`), buf, { root });
      r.verifiedWriteMBs.push(+(MB / ((performance.now() - t) / 1000)).toFixed(1));
      t = performance.now(); readFileSync(join(root, `v-${i}.bin`));
      r.readMBs.push(+(MB / ((performance.now() - t) / 1000)).toFixed(1));
      rmSync(join(root, `v-${i}.bin`));
    }
    const small = randomBytes(2048);
    const t = performance.now();
    for (let i = 0; i < SMALL; i++) await safeWriteFile(join(root, `m-${i % 20}.method.md`), small, { root });
    r.smallVerifiedOpsPerSec = +(SMALL / ((performance.now() - t) / 1000)).toFixed(0);
    const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
    Object.assign(r, { medianRawWriteMBs: med(r.rawWriteMBs), medianVerifiedWriteMBs: med(r.verifiedWriteMBs), medianReadMBs: med(r.readMBs) });
    out.push(r);
  } finally { rmSync(root, { recursive: true, force: true }); }
}
const jsonAt = args.indexOf('--json');
if (jsonAt >= 0) writeFileSync(args[jsonAt + 1], JSON.stringify(out, null, 2));
for (const r of out) console.log(`${r.dir}: raw write+fsync ${r.medianRawWriteMBs} MB/s, verified save ${r.medianVerifiedWriteMBs} MB/s, read (warm) ${r.medianReadMBs} MB/s, ${r.smallVerifiedOpsPerSec} verified 2 KiB saves/s  [${MB} MiB × ${REPS}]`);
