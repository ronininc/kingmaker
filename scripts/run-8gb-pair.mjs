#!/usr/bin/env node
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { assessPairedBench } from '../lib/paired-bench-outcome.mjs';

const argv = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const at = arg.indexOf('=');
  return at < 0 ? [arg, true] : [arg.slice(0, at), arg.slice(at + 1)];
}));
const required = ['--out', '--median-host', '--median-model', '--jev-model', '--jev-command-json', '--jev-prompt-file'];
for (const key of required) if (!argv[key]) throw new Error(`missing ${key}`);
const command = JSON.parse(argv['--jev-command-json']);
if (!Array.isArray(command) || !command.every((x) => typeof x === 'string')) throw new Error('--jev-command-json must be a JSON string array');
const memoryPattern = new RegExp(argv['--memory-match'] || 'ollama|llama-(embedding|server)|gguf_score');
const medianHost = argv['--median-host'].replace(/\/$/, '');
const rows = [];
let runPeakMb = 0;

function swapMb() {
  const text = execFileSync('/usr/sbin/sysctl', ['-n', 'vm.swapusage'], { encoding: 'utf8' });
  return Number(/used = ([\d.]+)M/.exec(text)?.[1]);
}

function freeDiskMb() {
  const text = execFileSync('/bin/df', ['-k', '/System/Volumes/Data'], { encoding: 'utf8' });
  const fields = text.trim().split('\n').at(-1).trim().split(/\s+/);
  return Number(fields[3]) / 1024;
}

function matchingRssMb() {
  const text = execFileSync('/bin/ps', ['-axo', 'rss=,command='], { encoding: 'utf8' });
  return text.split('\n').reduce((sum, line) => {
    if (!memoryPattern.test(line)) return sum;
    const rss = Number(/^\s*(\d+)/.exec(line)?.[1] || 0);
    return sum + rss / 1024;
  }, 0);
}

async function measured(fn) {
  const startSwap = swapMb();
  let peak = matchingRssMb();
  const timer = setInterval(() => { peak = Math.max(peak, matchingRssMb()); }, 200);
  const started = performance.now();
  try {
    const value = await fn();
    peak = Math.max(peak, matchingRssMb());
    runPeakMb = Math.max(runPeakMb, peak);
    return { value, elapsed_s: Number(((performance.now() - started) / 1000).toFixed(3)), peak_memory_mb: Number(peak.toFixed(1)), swap_delta_mb: Number((swapMb() - startSwap).toFixed(1)) };
  } finally { clearInterval(timer); }
}

async function ollamaPs() {
  const response = await fetch(`${medianHost}/api/ps`);
  if (!response.ok) throw new Error(`Ollama ps HTTP ${response.status}`);
  return (await response.json()).models?.map((m) => ({ name: m.name, size: m.size, size_vram: m.size_vram })) ?? [];
}

async function medianTurn() {
  const response = await fetch(`${medianHost}/api/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
    model: argv['--median-model'], prompt: 'In one sentence: what is a sales tax?', stream: false, think: false,
    keep_alive: argv['--keep-alive'] || '10m', options: { temperature: 0, num_predict: 80, num_ctx: 2048 },
  }) });
  if (!response.ok) throw new Error(`median HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  return response.json();
}

async function unloadMedian() {
  const response = await fetch(`${medianHost}/api/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
    model: argv['--median-model'], keep_alive: 0,
  }) });
  if (!response.ok) throw new Error(`median unload HTTP ${response.status}`);
}

function jevTurn(promptFile) {
  return new Promise((resolve, reject) => {
    const [exe, ...args] = command.map((part) => part.replaceAll('{prompt}', promptFile));
    const child = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`JEV command rc=${code}: ${stderr.slice(-500)}`));
      const lines = stdout.split(/\r?\n/).filter((line) => line.trim());
      try { resolve(JSON.parse(lines.at(-1))); }
      catch (error) { reject(new Error(`JEV command did not end with JSON: ${error.message}`)); }
    });
  });
}

const temp = mkdtempSync(join(tmpdir(), 'kingmaker-pair-'));
const prompt = join(temp, 'jev-prompt.txt');
writeFileSync(prompt, readFileSync(argv['--jev-prompt-file']));
try {
  writeFileSync(argv['--out'], '');
  for (let step = 0; step < 6; step += 1) {
    let row;
    try {
      const minimumDiskMb = Number(argv['--min-disk-mb'] || 768);
      const availableDiskMb = freeDiskMb();
      if (availableDiskMb < minimumDiskMb) throw new Error(`disk safety gate: ${availableDiskMb.toFixed(1)} MiB free is below ${minimumDiskMb} MiB`);
      if (step % 2 === 0) {
        const m = await measured(medianTurn);
        row = { step, arm: 'median', model: argv['--median-model'], ...m, model_calls: 1,
          response: m.value.response, load_s: Number(((m.value.load_duration || 0) / 1e9).toFixed(3)), loaded_after: await ollamaPs() };
        delete row.value;
        if (argv['--exclusive'] === true) {
          await unloadMedian();
          row.unloaded_for_next_arm = true;
        }
      } else {
        const m = await measured(() => jevTurn(prompt));
        row = { step, arm: 'jev', model: argv['--jev-model'], ...m,
          score: m.value.score, scored_through_head: m.value.scored_through_head === true,
          model_calls: m.value.model_calls, load_evidence: m.value.load_evidence,
          loaded_after: [...await ollamaPs(), ...(m.value.loaded_after || []),
            ...(m.value.loaded ? [{ name: argv['--jev-model'], source: 'internal', ephemeral: true }] : [])] };
        delete row.value;
      }
    } catch (error) {
      row = { step, arm: step % 2 === 0 ? 'median' : 'jev', model: step % 2 === 0 ? argv['--median-model'] : argv['--jev-model'], error: error.message };
    }
    rows.push(row); appendFileSync(argv['--out'], `${JSON.stringify(row)}\n`); console.log(JSON.stringify(row));
  }
  const assessment = assessPairedBench(rows, { expectedMedian: argv['--median-model'], expectedJev: argv['--jev-model'] });
  const summary = { ...assessment, elapsed_s: Number(rows.reduce((n, r) => n + (r.elapsed_s || 0), 0).toFixed(3)), peak_memory_mb: Number(runPeakMb.toFixed(1)), swap_delta_mb: Number((rows.reduce((n, r) => n + (r.swap_delta_mb || 0), 0)).toFixed(1)) };
  writeFileSync(`${argv['--out']}.summary.json`, `${JSON.stringify(summary, null, 2)}\n`);
  if (!assessment.pass) process.exitCode = 1;
} finally { rmSync(temp, { recursive: true, force: true }); }
