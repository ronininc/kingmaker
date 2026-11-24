#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const at = arg.indexOf('='); return at < 0 ? [arg, true] : [arg.slice(0, at), arg.slice(at + 1)];
}));
const host = String(args['--host'] || 'http://127.0.0.1:11435').replace(/\/$/, '');
const model = args['--model'], out = args['--out'];
if (!model || !out) throw new Error('usage: run-8gb-category.mjs --model=TAG --out=FILE [--host=URL]');
const prompt = 'What is 19 + 23? Output only the decimal number.';
const swap = () => Number(/used = ([0-9.]+)M/.exec(execFileSync('/usr/sbin/sysctl', ['vm.swapusage'], { encoding: 'utf8' }))?.[1]);
const rss = () => execFileSync('/bin/ps', ['-axo', 'rss=,command='], { encoding: 'utf8' }).split('\n').reduce((sum, line) => /ollama/i.test(line) && !/run-8gb-category|rg -i/.test(line) ? sum + (Number(line.trim().split(/\s+/)[0]) || 0) : sum, 0) / 1024;
const post = async (path, body) => {
  const response = await fetch(host + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
};
await post('/api/generate', { model, keep_alive: 0 });
const rows = [], swapStart = swap();
for (let turn = 0; turn < 3; turn++) {
  const beforeSwap = swap(), started = performance.now(); let peak = rss(), running = true;
  const sampler = (async () => { while (running) { peak = Math.max(peak, rss()); await new Promise((resolve) => setTimeout(resolve, 200)); } })();
  let response;
  try { response = await post('/api/generate', { model, prompt, stream: false, think: false, keep_alive: '5m', options: { temperature: 0 } }); }
  finally { running = false; await sampler; }
  const text = String(response.response || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  rows.push({ turn, cold: turn === 0, model, passed: text === '42', response: text, elapsed_s: (performance.now() - started) / 1000,
    load_s: Number(response.load_duration || 0) / 1e9, prompt_tokens: response.prompt_eval_count ?? null, output_tokens: response.eval_count ?? null,
    model_calls: 1, peak_memory_mb: peak, swap_delta_mb: swap() - beforeSwap });
}
await post('/api/generate', { model, keep_alive: 0 });
const summary = { pass: rows.every((row) => row.passed), model, turns: rows.length, model_calls: rows.reduce((n, row) => n + row.model_calls, 0),
  peak_memory_mb: Math.max(...rows.map((row) => row.peak_memory_mb)), swap_delta_mb: swap() - swapStart, rows };
writeFileSync(out, JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary));
process.exitCode = summary.pass ? 0 : 1;
