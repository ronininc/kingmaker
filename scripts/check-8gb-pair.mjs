#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { assessPairedBench, parseJsonl } from '../lib/paired-bench-outcome.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const at = arg.indexOf('=');
  return at < 0 ? [arg, true] : [arg.slice(0, at), arg.slice(at + 1)];
}));
const path = args['--input'];
if (!path) throw new Error('usage: check-8gb-pair.mjs --input=<jsonl> [--median=<tag>] [--jev=<tag>]');
const result = assessPairedBench(parseJsonl(readFileSync(path, 'utf8')), {
  expectedMedian: args['--median'], expectedJev: args['--jev'],
});
console.log(JSON.stringify(result, null, 2));
if (!result.pass) process.exitCode = 1;
