import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSkillFolder, skillMarkdown, skillSlug } from '../lib/skill-create.mjs';
import { skillMeta } from '../lib/core-pack.mjs';

test('a new skill is a folder with a SKILL.md Kingmaker\'s skill reader understands', () => {
  const state = mkdtempSync(join(tmpdir(), 'sk-'));
  const r = createSkillFolder(state, { methodId:'file-review' });
  assert.equal(r.ok, true); assert.equal(r.name, 'file-review');
  const md = readFileSync(join(r.dir, 'SKILL.md'), 'utf8');
  const meta = skillMeta(md);
  assert.equal(meta.name, 'file-review');
  assert.match(meta.description, /Review a selected file/);
  assert.match(md, /Read only that file locally/);
  assert.equal(createSkillFolder(state, { name: 'taco truck ads', instructions: 'x' }).ok, false, 'never overwrites');
  assert.equal(createSkillFolder(state, { name: '', instructions: 'x' }).ok, false);
  assert.equal(createSkillFolder(state, { name: 'empty' }).ok, false, 'it has to do something');
  assert.equal(existsSync(join(state, 'skills', 'empty')), false);
  assert.equal(skillSlug('  Ünïcode — Name '), 'unicode-name');
  assert.match(skillMarkdown({ name: 'x', description: 'only a line' }), /only a line\n$/);
});
