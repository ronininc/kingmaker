#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const shard = Number(process.env.KINGMAKER_TEST_SHARD ?? 0);
const shards = Number(process.env.KINGMAKER_TEST_SHARDS ?? 1);
const timeoutMs = Number(process.env.KINGMAKER_TEST_FILE_TIMEOUT_MS ?? 180_000);
const outputDir = process.env.KINGMAKER_TEST_OUTPUT_DIR || 'test-results';

if (!Number.isInteger(shard) || !Number.isInteger(shards) || shard < 0 || shards < 1 || shard >= shards) throw new Error('invalid shard configuration');
if (!Number.isFinite(timeoutMs) || timeoutMs < 1_000) throw new Error('test file timeout must be at least 1000 ms');

async function testFiles() {
  const root = (await readdir('test')).filter((name) => name.endsWith('.test.mjs')).map((name) => join('test', name));
  const addons = [];
  for (const addon of await readdir('addons', { withFileTypes: true })) {
    if (!addon.isDirectory()) continue;
    const directory = join('addons', addon.name, 'test');
    try {
      addons.push(...(await readdir(directory)).filter((name) => name.endsWith('.test.mjs')).map((name) => join(directory, name)));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return [...root, ...addons].sort().filter((_, index) => index % shards === shard);
}

function runFile(file) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, ['--test', '--test-force-exit', file], { env: process.env, detached: process.platform !== 'win32' });
    const chunks = [];
    const collect = (chunk) => { chunks.push(chunk); process.stdout.write(chunk); };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      const signal = (name) => {
        try {
          if (process.platform === 'win32') child.kill(name);
          else process.kill(-child.pid, name);
        } catch { /* process already ended */ }
      };
      signal('SIGTERM');
      setTimeout(() => signal('SIGKILL'), 5_000).unref();
    }, timeoutMs);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ file, status: timedOut ? 'timeout' : code === 0 ? 'pass' : 'fail', code, signal, elapsedMs: Date.now() - started, output: Buffer.concat(chunks).toString('utf8') });
    });
  });
}

await mkdir(outputDir, { recursive: true });
const files = await testFiles();
const results = [];
for (const file of files) {
  console.log(`\n=== ${file} (timeout ${timeoutMs} ms) ===`);
  const result = await runFile(file);
  results.push(result);
  await writeFile(join(outputDir, `${file.replaceAll('/', '__')}.log`), result.output);
  console.log(`=== ${result.status.toUpperCase()} ${file} in ${result.elapsedMs} ms ===`);
}
const summary = {
  shard,
  shards,
  timeoutMs,
  files: results.length,
  pass: results.filter((r) => r.status === 'pass').length,
  fail: results.filter((r) => r.status === 'fail').length,
  timeout: results.filter((r) => r.status === 'timeout').length,
  results: results.map(({ output, ...result }) => result),
};
await writeFile(join(outputDir, `shard-${shard}.json`), `${JSON.stringify(summary, null, 2)}\n`);
console.log(`\nTEST_SHARD_SUMMARY ${JSON.stringify({ ...summary, results: undefined })}`);
process.exitCode = summary.fail || summary.timeout ? 1 : 0;
