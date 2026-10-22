// Tests for lib/slash-buckets.mjs. Run: node tests/run-tests.mjs
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUCKETS, createBucketRegistry, parseCommand, resolveTool } from '../lib/slash-buckets.mjs';

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed += 1; console.log(`  ok - ${name}`); };

/* parsing */
ok('parses a bucket + order', JSON.stringify(parseCommand('/crm draft the follow-up email')) === JSON.stringify({ command: 'crm', order: 'draft the follow-up email' }));
ok('bare bucket parses with empty order', parseCommand('/codegen').order === '');
ok('plain text is not a command', parseCommand('just a normal message') === null);
ok('a slash mid-sentence is not a command', parseCommand('look at /crm please') === null);

/* registry + surfaces */
const d = mkdtempSync(join(tmpdir(), 'buckets-'));
const reg = createBucketRegistry({ auditPath: join(d, 'audit.jsonl') });
ok('all seven buckets registered', BUCKETS.length === 7 && reg.list().length === 7);
const solomonList = reg.list({ surface: 'solomon' });
ok('Solomon listing physically excludes kingmaker-only buckets', solomonList.length === 5 && solomonList.every((b) => b.surface !== 'kingmaker-only'));
ok('Kingmaker listing includes the private pair', reg.list({ surface: 'kingmaker' }).some((b) => b.command === 'osiris'));

/* assembly */
const crm = reg.assemble('crm');
ok('assembly returns the working set', crm.ok === true && crm.lane === 'standard' && crm.governance.class === 'crm');
ok('assembly grants nothing', Array.isArray(crm.grants) && crm.grants.length === 0 && /grants nothing/.test(crm.note));
const unknown = reg.assemble('nope');
ok('unknown bucket refuses cleanly', unknown.ok === false && unknown.refused === true);
ok('audit chain verifies after assemblies + refusal', reg.verifyAudit().ok !== false);

/* resolution chain order */
{
  const calls = [];
  const stage = (tag, hit) => async () => { calls.push(tag); return hit ? { tool: tag } : null; };
  const used = await resolveTool('router', { have: stage('have', true), find: stage('find', true) });
  ok('use beats every later stage', used.via === 'use' && calls.join() === 'have');
  calls.length = 0;
  const absorbed = await resolveTool('video-use', { have: stage('have', false), find: stage('find', false), absorb: stage('absorb', true), recreate: stage('recreate', true) });
  ok('absorb runs after find misses, before recreate', absorbed.via === 'absorb' && calls.join() === 'have,find,absorb');
  calls.length = 0;
  const recreated = await resolveTool('some-tool', { have: stage('have', false), find: stage('find', false), absorb: stage('absorb', false), recreate: stage('recreate', true) });
  ok('recreate is the last resort before the gap', recreated.via === 'recreate');
  const gap = await resolveTool('ghost', { have: stage('have', false), find: stage('find', false), absorb: stage('absorb', false), recreate: stage('recreate', false) });
  ok('total failure reports the gap, never papers over it', gap.ok === false && gap.via === 'gap');
}

console.log(`slash-buckets: ${passed}/${passed} checks passed`);
