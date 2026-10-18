import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexArgs, codexEnv, createChatgptBrain } from '../lib/chatgpt-brain.mjs';
import { chosenModelEnv, findModel, MODEL_CATALOG, modelsFor } from '../lib/models.mjs';
import { BRAIN_ROLES } from '../lib/profile.mjs';
import { resolveBrain } from '../lib/claude-brain.mjs';
import { createGrokBrain, grokArgs, grokEnv, parseGrokOutput } from '../lib/grok-brain.mjs';

test('chatgpt lane: chosen by name, never bills the API, only Kingmaker MCP', () => {
  assert.equal(resolveBrain({}, 'chatgpt'), 'chatgpt');
  assert.equal(codexEnv({ OPENAI_API_KEY: 'k', HOME: '/h' }).OPENAI_API_KEY, undefined);
  const a = codexArgs({ text: 'hi', port: 4999, outFile: '/o', bin: '/km' });
  assert.ok(a.join(' ').includes('mcp_servers.kingmaker.command="/km"'));
  assert.ok(a.includes('--ignore-user-config'));
  assert.ok(a.at(-1).endsWith('Owner said: hi'));
  assert.equal(a[a.indexOf('--sandbox') + 1], 'read-only', 'an interactive turn never gets a writable sandbox');
  assert.ok(!a.includes('workspace-write'));
  assert.ok(!/AGENTS\.md|CLAUDE\.md|add one short line/.test(a.at(-1)), 'it is not told to edit a memory file it cannot write');
  assert.ok(codexArgs({ text: 'x', resume: true, port: 1, outFile: '/o' }).slice(0, 3).join(' ') === 'exec resume --last');
});

test('chatgpt lane closes stdin so an argv prompt cannot wait forever', async () => {
  const state = mkdtempSync(join(tmpdir(), 'km-chatgpt-stdin-'));
  let ended = 0;
  const run = (_bin, args, _opts, cb) => {
    const out = args[args.indexOf('--output-last-message') + 1];
    writeFileSync(out, 'READY');
    queueMicrotask(() => cb(null, '', ''));
    return { stdin: { end: () => { ended++; } } };
  };
  const brain = createChatgptBrain({ paths: { state }, port: 4999, say: async () => {}, env: { HOME: state }, run });
  const result = await brain.runTurn('status');
  assert.equal(result.ok, true);
  assert.equal(ended, 1);
});

test('chatgpt lane: speaks the last message and resumes after the first turn', async () => {
  const state = mkdtempSync(join(tmpdir(), 'km-gpt-'));
  const said = []; const calls = [];
  const run = (bin, args, opts, cb) => { calls.push(args); writeFileSync(args[args.indexOf('--output-last-message') + 1], 'Two follow-ups due today.'); cb(null, '', ''); };
  const brain = createChatgptBrain({ paths: { state }, port: 4999, say: async (l) => said.push(l), env: { HOME: state }, run });
  await brain.runTurn('what is due');
  await brain.runTurn('next');
  assert.deepEqual(said, ['Two follow-ups due today.', 'Two follow-ups due today.']);
  assert.equal(calls[0][1], '-c');
  assert.equal(calls[1][1], 'resume');
});

test('grok lane: cached login only, only Kingmaker MCP, bounded headless turns', () => {
  assert.equal(resolveBrain({}, 'grok'), 'grok');
  const env = grokEnv({ XAI_API_KEY: 'metered', GROK_API_KEY: 'also-metered', HOME: '/h', PATH: '/bin' });
  assert.equal(env.XAI_API_KEY, undefined);
  assert.equal(env.GROK_API_KEY, undefined);
  const args = grokArgs({ text: 'hi', sessionId: 'session-1', model: 'grok-4.7' });
  assert.ok(args.includes('--no-auto-update'));
  assert.equal(args[args.indexOf('--tools') + 1], 'MCPTool');
  assert.ok(args.includes('--always-approve') && args.includes('--disable-web-search'));
  assert.deepEqual(args.slice(-2), ['--resume', 'session-1']);
  assert.deepEqual(parseGrokOutput('{"text":"Hello.","stopReason":"end_turn","sessionId":"s1"}'), { ok: true, text: 'Hello.', sessionId: 's1', stopReason: 'end_turn' });
  assert.equal(parseGrokOutput('{"text":"partial","stopReason":"cancelled"}').ok, false);
  // Grok Build 1.0.x prints one pretty-printed object over many lines; the last line alone is just "}".
  assert.deepEqual(parseGrokOutput('{\n  "text": "Ready.",\n  "stopReason": "end_turn",\n  "sessionId": "s2",\n  "usage": {\n    "input_tokens": 1\n  }\n}\n'), { ok: true, text: 'Ready.', sessionId: 's2', stopReason: 'end_turn' });
});

test('grok lane: writes only Kingmaker MCP config, speaks, and resumes its exact session', async () => {
  const state = mkdtempSync(join(tmpdir(), 'km-grok-'));
  const said = []; const calls = [];
  const run = (bin, args, opts, cb) => {
    calls.push({ bin, args, opts });
    cb(null, JSON.stringify({ text: 'Two items are due.', stopReason: 'end_turn', sessionId: 'grok-session-1' }), '');
  };
  const brain = createGrokBrain({ paths: { state }, port: 4999, say: async (line) => said.push(line), env: { HOME: state, XAI_API_KEY: 'never-pass-me' }, run });
  await brain.runTurn('what is due');
  await brain.runTurn('next');
  assert.deepEqual(said, ['Two items are due.', 'Two items are due.']);
  assert.ok(!calls[0].args.includes('--resume'));
  assert.deepEqual(calls[1].args.slice(-2), ['--resume', 'grok-session-1']);
  assert.equal(calls[0].opts.env.XAI_API_KEY, undefined);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(state, 'grok-brain', '.mcp.json'), 'utf8')).mcpServers), ['kingmaker']);
});

test('catalog: ids unique, 8 GB has stock and abliterated picks, nothing big for 8 GB', () => {
  assert.equal(new Set(MODEL_CATALOG.map((x) => x.id)).size, MODEL_CATALOG.length);
  const eight = modelsFor(8);
  assert.ok(eight.some((x) => x.abliterated) && eight.some((x) => !x.abliterated));
  assert.ok(eight.every((x) => x.gb <= 5.5));
  assert.ok(modelsFor(16).length > eight.length);
  assert.equal(findModel('qwen3-8b-abl').tag, 'huihui_ai/qwen3-abliterated:8b');
});

test('chosen model pins the brain roles only when installed, operator pins win', () => {
  const tag = 'qwen3:4b';
  assert.deepEqual(chosenModelEnv(tag, [], {}, BRAIN_ROLES), {});
  const pins = chosenModelEnv(tag, [tag], { SOLOMON_DRAFT_MODEL: 'mine' }, BRAIN_ROLES);
  assert.equal(pins.SOLOMON_OLLAMA_MODEL, tag);
  assert.equal(pins.SOLOMON_DRAFT_MODEL, undefined);
});

test('drive library: .gguf files become pickable models, shards and projectors skipped', async () => {
  const { mkdirSync, writeFileSync: w } = await import('node:fs');
  const { scanGguf, ggufName } = await import('../lib/models.mjs');
  const d = mkdtempSync(join(tmpdir(), 'km-ssd-'));
  mkdirSync(join(d, 'qwen'));
  w(join(d, 'qwen', 'Qwen3-8B-abliterated.Q4_K_M.gguf'), 'x');
  w(join(d, 'Llama-3.2-3B.Q4_K_M.gguf'), 'x');
  w(join(d, 'big-00002-of-00003.gguf'), 'x');
  w(join(d, 'mmproj-gemma.gguf'), 'x');
  const found = scanGguf(d);
  assert.deepEqual(found.map((x) => x.tag).sort(), ['local/llama-3.2-3b.q4_k_m', 'local/qwen3-8b-abliterated.q4_k_m']);
  assert.equal(found.find((x) => x.tag.includes('qwen')).abliterated, true);
  assert.equal(ggufName('A B.gguf'), 'local/a-b');
});
