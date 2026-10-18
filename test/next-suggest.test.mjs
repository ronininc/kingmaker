import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanSuggestion, suggestNext } from '../lib/next-suggest.mjs';

test('a suggestion is one short command line, or nothing', () => {
  assert.equal(cleanSuggestion('"Make the ad shorter and add a call to action"'), 'Make the ad shorter and add a call to action');
  assert.equal(cleanSuggestion('<think>hmm</think>\nNext command: open the job board\nbecause…'), 'open the job board');
  assert.equal(cleanSuggestion('/expand_on_ad_with_personal_story'), null, 'never a /program tag');
  assert.equal(cleanSuggestion('/notify kingmaker-ad-created'), null, 'the 2026-10-15 junk: a slash command and an id');
  assert.equal(cleanSuggestion('notify creator'), null, 'two words is not a command');
  assert.equal(cleanSuggestion('Make the ad shorter'), 'Make the ad shorter');
  assert.equal(cleanSuggestion('NONE'), null);
  assert.equal(cleanSuggestion(''), null);
  assert.equal(cleanSuggestion('make an ad', 'Make an ad'), null, 'never the same thing again');
  assert.equal(cleanSuggestion('one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen'), null, 'too long');
});

const reply = (content, ok = true) => async () => ({ ok, json: async () => ({ message: { content } }) });
test('the local router writes it; slow, down or unsure suggests nothing', async () => {
  assert.equal(await suggestNext({ asked: 'make an ad about Kingmaker', answer: 'Kingmaker: your Mac, at your word.', fetchImpl: reply('Make a 15-second video script from this ad') }), 'Make a 15-second video script from this ad');
  assert.equal(await suggestNext({ asked: 'x', answer: 'y', fetchImpl: async () => { throw new Error('down'); } }), null);
  assert.equal(await suggestNext({ asked: 'x', answer: 'y', fetchImpl: reply('', false) }), null);
  assert.equal(await suggestNext({ asked: '', answer: 'y', fetchImpl: reply('anything') }), null);
});
