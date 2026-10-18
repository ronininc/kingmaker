import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSkillFolder, skillMarkdown, skillSlug } from '../lib/skill-create.mjs';
import { skillMeta } from '../lib/core-pack.mjs';

test('a new skill is a folder with a SKILL.md Kingmaker\'s skill reader understands', () => {
  const state = mkdtempSync(join(tmpdir(), 'sk-'));
  const r = createSkillFolder(state, { name: 'Taco Truck Ads!', description: 'Writes "short" ads for taco trucks', instructions: 'Always mention the salsa.\nKeep it under 20 words.' });
  assert.equal(r.ok, true); assert.equal(r.name, 'taco-truck-ads');
  const md = readFileSync(join(r.dir, 'SKILL.md'), 'utf8');
  const meta = skillMeta(md);
  assert.equal(meta.name, 'taco-truck-ads');
  assert.match(meta.description, /Writes 'short' ads for taco trucks/);
  assert.match(md, /Always mention the salsa\./);
  assert.equal(createSkillFolder(state, { name: 'taco truck ads', instructions: 'x' }).ok, false, 'never overwrites');
  assert.equal(createSkillFolder(state, { name: '', instructions: 'x' }).ok, false);
  assert.equal(createSkillFolder(state, { name: 'empty' }).ok, false, 'it has to do something');
  assert.equal(existsSync(join(state, 'skills', 'empty')), false);
  assert.equal(skillSlug('  Ünïcode — Name '), 'unicode-name');
  assert.match(skillMarkdown({ name: 'x', description: 'only a line' }), /only a line\n$/);
});
