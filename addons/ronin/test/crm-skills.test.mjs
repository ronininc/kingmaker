import './_bind.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SKILLS_ROUTE, skillName, skillPicks, skillTurnText, skillsProblem } from '../crm-skills.mjs';

test('the skills route is the owner console\'s jobs route', () => {
  assert.equal(SKILLS_ROUTE, '/api/kingmaker-jobs/skills');
});

test('only a CRM tool name is a skill name', () => {
  assert.equal(skillName('outreach_control'), 'outreach_control');
  assert.equal(skillName(' recall '), 'recall');
  assert.equal(skillName('../etc'), null);
  assert.equal(skillName('two words'), null);
  assert.equal(skillName(''), null);
});

test('the picks are bounded, deduplicated, and an unknown gate reads as confirm', () => {
  const picks = skillPicks({ skills: [
    { name: 'recall', title: 'Recall', description: 'What the CRM\n remembers.', gate: 'read' },
    { name: 'recall', title: 'again' },
    { name: 'bad name', title: 'x' },
    { name: 'outreach_control', gate: 'yolo', description: 'd'.repeat(500) },
  ] });
  assert.deepEqual(picks.map((p) => `${p.name}:${p.gate}`), ['recall:read', 'outreach_control:confirm']);
  assert.equal(picks[0].description, 'What the CRM remembers.');
  assert.equal(picks[1].title, 'outreach control');
  assert.equal(picks[1].description.length, 200);
  assert.deepEqual(skillPicks(null), []);
});

test('a picked skill becomes the form Solomon\'s CRM bridge reads', () => {
  assert.equal(skillTurnText('recall', '  what did   Ana say '), 'CRM skill recall: what did Ana say');
  assert.equal(skillTurnText('situation_report', ''), 'CRM skill situation_report');
});

test('an empty list says why', () => {
  assert.equal(skillsProblem({ ok: true }), null);
  assert.match(skillsProblem({ ok: false, status: 409, json: { error: 'CRM_NOT_CONNECTED' } }), /No CRM is connected/);
  assert.match(skillsProblem({ ok: false, status: 404, json: {} }), /too old/);
  assert.match(skillsProblem(null), /no answer/);
});
