import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FOLLOW_UP_MS, isEditFollowUp, isShortFollowUp, permissionGrantReply, withFollowUp } from '../lib/follow-up.mjs';

test('a short yes/no or "make it shorter" is a follow-up; a new request is not', () => {
  for (const t of ['yes you may', 'no', 'make it shorter', 'the second one', 'perfect, send it']) assert.equal(isShortFollowUp(t), true, t);
  for (const t of ['write a poem about Phoenix', 'what is the capital of France', '', 'yes '.repeat(12)]) assert.equal(isShortFollowUp(t), false, t);
});

test('a follow-up within ten minutes carries the last written exchange to the writer', () => {
  const last = { asked: 'Draft a message to Kingmaker requesting screen recording access', answer: 'Hi, could you please allow me to record the screen?', at: 1000 };
  const p = withFollowUp('make it friendlier', 'make it friendlier', last, 1000 + 60_000);
  assert.match(p, /The owner asked: "Draft a message to Kingmaker/);
  assert.match(p, /You answered: "Hi, could you please allow me/);
  assert.match(p, /The owner now replies: "make it friendlier"/);
  assert.equal(withFollowUp('make it friendlier', 'make it friendlier', last, 1000 + FOLLOW_UP_MS + 1), 'make it friendlier', 'too late');
  assert.equal(withFollowUp('write a haiku', 'write a haiku', last, 2000), 'write a haiku', 'a new request stands alone');
  assert.equal(withFollowUp('yes', 'yes', null), 'yes');
});

test('"yes you may" to a screen recording ask: Kingmaker says only the owner can, in System Settings', () => {
  const r = permissionGrantReply('yes you may', 'Hi, could you please allow me to record the screen?');
  assert.equal(r.pane, 'Privacy_ScreenCapture');
  assert.match(r.line, /can't grant macOS permissions myself/);
  assert.match(r.line, /Screen & System Audio Recording/);
  assert.equal(permissionGrantReply('you have my permission to use the microphone').pane, 'Privacy_Microphone');
});

test('a yes to anything else still goes to Kingmaker', () => {
  assert.equal(permissionGrantReply('yes', 'Should I text Ana about the camera?'), null, 'mentions a camera, asks no access');
  assert.equal(permissionGrantReply('yes', 'In Acme CRM I will activate the Spring Roofers campaign. Say go ahead to do it.'), null);
  assert.equal(permissionGrantReply('record the screen for me'), null, 'not a yes');
  assert.equal(permissionGrantReply('', 'allow screen recording?'), null);
});

test('an edit to the last answer goes straight to the writer; a yes, no or go ahead never does (it may approve something)', () => {
  for (const t of ['make it shorter', 'another', 'the second one', 'a bit longer', 'rewrite it warmer']) assert.equal(isEditFollowUp(t), true, t);
  for (const t of ['yes', 'yes you may', 'no', 'ok', 'go ahead', 'send it', 'do it', 'write a poem']) assert.equal(isEditFollowUp(t), false, t);
});
