import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ruleLane, routeLane, writerModel, WRITER_MODEL } from '../lib/fast-route.mjs';
import { FLOOR_ROLES, GRANITE_8GB } from '../lib/mac-profiles.mjs';
import { imagePrompt, imageLaneSetup, makeImage } from '../lib/image-lane.mjs';

test('the rules are sure of the obvious lanes; actions and CRM records keep their gates', () => {
  assert.equal(ruleLane('send Hector a WhatsApp saying I am late'), 'act');
  assert.equal(ruleLane('text Yordi the pay link'), 'act');
  assert.equal(ruleLane('draft a proposal for the taqueria merchant'), 'act', 'CRM records go to the governed brain');
  assert.equal(ruleLane('open youtube'), 'open');
  assert.equal(ruleLane('make a poster for the taco night'), 'image');
  assert.equal(ruleLane('write a summary of the crest timings'), 'write');
  assert.equal(ruleLane('how many files are on my desktop'), 'lookup', 'a real fact: no number+unit to compute');
  // A calculation/estimate the model can work out — the writer answers it, it does NOT go to web search.
  assert.equal(ruleLane('how many words on average would fit inside 10 million characters'), 'write');
  assert.equal(ruleLane('how many pages is 5000 words'), 'write');
  assert.equal(ruleLane('roughly how many minutes is 90000 seconds'), 'write');
  assert.equal(ruleLane('calculate 15% of 240'), 'write');
  assert.equal(ruleLane('a haiku about Phoenix heat'), null, 'the router decides the rest');
  // A question the writer answers from what it knows is not a lookup: web research pasted source sentences back.
  for (const q of ['what is the capital of Japan', 'who wrote Pride and Prejudice', 'how many legs does a spider have', 'what day comes after Tuesday'])
    assert.equal(ruleLane(q), null, `${q}: the router decides, not the lookup rule`);
  // What changes, what's on this Mac, or an explicit search still goes to lookup.
  for (const q of ['what is the weather in Phoenix today', 'who won the Super Bowl last year', 'what is the latest news about Apple', 'who is the CEO of Apple',
    'what is the price of bitcoin', 'how many files are on my desktop', 'what is on my calendar', 'find the nearest taqueria', 'search for taco trucks in Mesa'])
    assert.equal(ruleLane(q), 'lookup', q);
});

const reply = (content, ok = true) => async () => ({ ok, json: async () => ({ message: { content } }) });
test('the router decides what the rules leave, reading the lane even when the small model keeps talking', async () => {
  assert.deepEqual((await routeLane('a haiku about heat', { fetchImpl: reply('{"lane":"write","text":"Phoenix heat so') })).lane, 'write');
  assert.equal((await routeLane('a haiku about heat', { fetchImpl: reply('{"lane":"write"}') })).by, 'router');
});

test('unsure or down, the governed brain takes it: a wrong guess never skips a gate', async () => {
  assert.equal((await routeLane('a haiku', { fetchImpl: reply('{"lane":"teleport"}') })).lane, 'act');
  assert.equal((await routeLane('a haiku', { fetchImpl: async () => { throw new Error('down'); } })).lane, 'act');
  assert.equal((await routeLane('a haiku', { fetchImpl: reply('', false) })).by, 'default');
});

test('the image lane: the prompt drops the verb; a Mac without the engine says so instead of failing', async () => {
  assert.equal(imagePrompt('Please make a poster for taco night!'), 'a poster for taco night, pure illustration, high quality, sharp detail, clean composition');
  // No word about words unless the owner asked for some: those words make the model invent lettering.
  for (const ask of ['make an image of a crown', 'draw a red truck at sunset']) assert.doesNotMatch(imagePrompt(ask), /\b(text|words?|captions?|letter(?:s|ing)?)\b/i);
  assert.match(imagePrompt('make a poster that says "Taco Night" in red'), /^a poster that says "Taco Night" in red, the words spelled exactly as given/);
  assert.match(imagePrompt('a logo for Ronin Inc'), /the words spelled exactly as given/);
  const setup = imageLaneSetup({ state: '/nowhere', env: {}, home: '/nowhere', exists: () => false });
  assert.equal(setup.ready, false);
  const r = await makeImage('make a poster', { setup });
  assert.equal(r.ok, false); assert.match(r.reason, /isn't set up/);
});

test('the write lane uses the model pinned in the bar, else the floor writer', () => {
  // Since the metered-doctrine rework the unpinned default is the starter floor's writer — the smallest
  // sufficient writer, the same on every Mac — not the 8b the class table used to pick for bigger Macs.
  // (WRITER_MODEL itself still exists: the connector and trading lanes default to it, outside this lane.)
  assert.equal(writerModel(null), GRANITE_8GB);
  assert.equal(writerModel(null), FLOOR_ROLES.writer);
  assert.equal(writerModel(''), GRANITE_8GB);
  assert.equal(writerModel('huihui_ai/gemma3-abliterated:12b'), 'huihui_ai/gemma3-abliterated:12b');
  assert.equal(writerModel('  dolphin3:8b '), 'dolphin3:8b');
  assert.equal(writerModel('gpt-oss:20b; rm -rf /'), GRANITE_8GB, 'only an Ollama tag');
  assert.equal(writerModel('hf.co/mradermacher/Qwen3.6-27B-heretic-i1-GGUF:i1-Q4_K_M'), 'hf.co/mradermacher/Qwen3.6-27B-heretic-i1-GGUF:i1-Q4_K_M', 'a Hugging Face GGUF');
  assert.equal(writerModel('a/b/c/d:q'), GRANITE_8GB);
  assert.equal(writerModel('a'.repeat(200)), GRANITE_8GB);
  assert.equal(WRITER_MODEL, 'huihui_ai/qwen3-abliterated:8b', 'the constant is unchanged for its other lanes');
});

test('the router is told what a lookup is, so general knowledge stays with the writer', async () => {
  const { ROUTER_SYSTEM } = await import('../lib/fast-route.mjs');
  assert.match(ROUTER_SYSTEM, /write = answer from general knowledge/);
  assert.match(ROUTER_SYSTEM, /lookup = facts that change or need a live source/);
});
