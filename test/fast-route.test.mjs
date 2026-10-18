import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ruleLane, routeLane, writerModel, WRITER_MODEL } from '../lib/fast-route.mjs';
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

test('the write lane uses the model pinned in the bar, else WRITER_MODEL', () => {
  assert.equal(writerModel(null), WRITER_MODEL);
  assert.equal(writerModel(''), WRITER_MODEL);
  assert.equal(writerModel('huihui_ai/gemma3-abliterated:12b'), 'huihui_ai/gemma3-abliterated:12b');
  assert.equal(writerModel('  dolphin3:8b '), 'dolphin3:8b');
  assert.equal(writerModel('gpt-oss:20b; rm -rf /'), WRITER_MODEL, 'only an Ollama tag');
  assert.equal(writerModel('hf.co/mradermacher/Qwen3.6-27B-heretic-i1-GGUF:i1-Q4_K_M'), 'hf.co/mradermacher/Qwen3.6-27B-heretic-i1-GGUF:i1-Q4_K_M', 'a Hugging Face GGUF');
  assert.equal(writerModel('a/b/c/d:q'), WRITER_MODEL);
  assert.equal(writerModel('a'.repeat(200)), WRITER_MODEL);
});
