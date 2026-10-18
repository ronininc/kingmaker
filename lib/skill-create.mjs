// lib/skill-create.mjs — a new skill from the bar's Skills tab (the owner, 2026-10-15: "i still dont see skill creation …
// as options in my side bar"). A skill is a folder with a SKILL.md (its name, what it's for, then its instructions); the
// owner's own go in the data folder (skills/<name>/), and the new folder is added like any skill connector, so REA reads
// it first (lib/rea.mjs) and the setup screen shows that happening.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const skillsHome = (state) => join(state, 'skills');
export const skillSlug = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, 48);

/** Pure: the SKILL.md for a name, a one-line description and the instructions. */
export function skillMarkdown({ name, description = '', instructions = '' }) {
  const clean = (s, n) => String(s || '').replace(/\r/g, '').trim().slice(0, n);
  const oneLine = clean(description, 300).replace(/\s+/g, ' ').replace(/"/g, "'");
  return `---\nname: ${skillSlug(name)}\ndescription: "${oneLine}"\n---\n\n# ${clean(name, 80)}\n\n${clean(instructions, 20_000) || oneLine}\n`;
}

/** Write a new skill's folder. → { ok, dir, name } or { ok: false, error } (a name already taken is never overwritten). */
export function createSkillFolder(state, spec = {}) {
  const name = skillSlug(spec.name);
  if (!name) return { ok: false, error: 'A skill needs a name.' };
  if (!String(spec.instructions || spec.description || '').trim()) return { ok: false, error: 'Say what the skill does.' };
  const dir = join(skillsHome(state), name);
  if (existsSync(dir)) return { ok: false, error: `There's already a skill called ${name}.` };
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, 'SKILL.md'), skillMarkdown(spec), { mode: 0o600 });
  return { ok: true, dir, name };
}
