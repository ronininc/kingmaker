// lib/core-pack.mjs — Kingmaker's built-in capabilities (the owner, 2026-10-15: "It should also come preloaded with all
// of my Ronin skills as core functionalities … the open art stack and the open source office stack and the website
// resources stack. It all belongs inside Kingmaker. It is my gift to the world").
//
// Two kinds of built-in skill, both ordinary skill connectors (a folder with SKILL.md) that are always there:
//   core     <app>/core/skills/<name>/  shipped with Kingmaker, source-available like the rest of it.
//   private  <state>/private-skills/<name>/  the owner's own install only, never in the repo: skills tied to the
//            owner's proprietary CRM (the public product rule: that CRM is never a public capability).
// They get REA's treatment like any connector (lib/rea.mjs), are never written into connectors.json, and can't be
// removed (a built-in one can only be turned off by taking its folder out). The stacks around them (art, office,
// website resources) are described in core/pack.json: what ships inside the app, what installs on first use, licences.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect } from './rea.mjs';

export const CORE_SKILLS_DIR = fileURLToPath(new URL('../core/skills/', import.meta.url));
export const PACK_PATH = fileURLToPath(new URL('../core/pack.json', import.meta.url));
export const privateSkillsDir = (state) => join(state, 'private-skills');

const slug = (v) => String(v ?? '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
const reaCache = new Map(); // dir → { stamp, rea }: a skill folder is inspected once per change, not on every listing

/** Pure: a SKILL.md's frontmatter name and description (folded `>-` blocks included). */
export function skillMeta(text) {
  const fm = /^---\n([\s\S]*?)\n---/.exec(String(text || ''))?.[1] || '';
  const field = (k) => {
    const m = new RegExp(`^${k}:[ \\t]*(.*)$`, 'm').exec(fm);
    if (!m) return '';
    let v = m[1].trim();
    if (/^[>|][-+]?$/.test(v)) { // a folded block: the indented lines after it
      const after = fm.slice(m.index + m[0].length).split('\n').slice(1);
      const lines = []; for (const l of after) { if (/^\s+\S/.test(l)) lines.push(l.trim()); else if (l.trim()) break; }
      v = lines.join(' ');
    }
    return v.replace(/^["']|["']$/g, '').trim();
  };
  return { name: field('name'), description: field('description') };
}

function stampOf(dir) {
  let newest = 0, files = 0;
  const walk = (d, depth) => { if (depth > 4 || files > 400) return; for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p, depth + 1); else { files += 1; newest = Math.max(newest, statSync(p).mtimeMs); } } };
  try { walk(dir, 0); } catch { /* unreadable: inspected fresh */ }
  return `${files}:${newest}`;
}

/** The built-in skills in one folder, as connector records. origin: 'core' | 'private'. */
export function skillsIn(root, origin, { inspectImpl = inspect } = {}) {
  if (!root || !existsSync(root)) return [];
  const out = [];
  for (const e of readdirSync(root, { withFileTypes: true })) {
    const dir = join(root, e.name), file = join(dir, 'SKILL.md');
    if (!e.isDirectory() || !existsSync(file)) continue;
    const stamp = stampOf(dir), hit = reaCache.get(dir);
    const rea = hit?.stamp === stamp ? hit.rea : inspectImpl([dir], { prose: true });
    reaCache.set(dir, { stamp, rea });
    const meta = skillMeta(readFileSync(file, 'utf8'));
    // A shipped skill must be one Kingmaker may give away: an open licence or Ronin's own (REA reads it). The owner's
    // private skills never leave their Mac, so their licence doesn't matter.
    const lic = rea.license || { license: 'none', redistributable: false };
    const unlicensed = origin === 'core' && !lic.redistributable;
    out.push({ license: lic.license,
      id: `${origin}_${slug(e.name)}`, kind: 'skill', name: slug(e.name), title: meta.name || e.name, description: meta.description.slice(0, 600),
      target: file, source: origin === 'core' ? 'Kingmaker core' : 'Owner private', builtIn: origin,
      verdict: rea.verdict, findings: (rea.findings || []).slice(0, 20), notes: rea.notes, enabled: rea.verdict !== 'rejected' && !unlicensed,
      summary: unlicensed ? `Not shipped: its licence (${lic.license}) doesn't let Kingmaker give it away. ${rea.summary}` : rea.summary,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Every built-in skill: the shipped core ones, then the owner's private ones (a private one never shadows a core name). */
export function builtInSkills(state, { coreDir = CORE_SKILLS_DIR, inspectImpl } = {}) {
  const core = skillsIn(coreDir, 'core', { inspectImpl });
  const names = new Set(core.map((c) => c.name));
  return [...core, ...(state ? skillsIn(privateSkillsDir(state), 'private', { inspectImpl }).filter((c) => !names.has(c.name)) : [])];
}

/** The pack's description (core/pack.json), {} when missing. */
export function loadPack(path = PACK_PATH) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return {}; }
}

/**
 * Pure: the built-in skill a request is about, by the words of its name and description, or null. Only a clear match
 * counts (two distinct content words, or the skill's own name), so ordinary talk never wanders into a skill.
 */
const STOP = new Set('a an and the for of to in on with or by from use when this that it its is are be as at your you their our any all every not no into via one two make build create'.split(' '));
export function pickBuiltInSkill(request, skills) {
  const words = new Set(String(request || '').toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) || []);
  let best = null;
  for (const s of skills || []) {
    if (!s.enabled) continue;
    if (s.name.split('-').length > 1 && String(request || '').toLowerCase().includes(s.name.replace(/-/g, ' '))) return s;
    const key = new Set(`${s.name.replace(/-/g, ' ')} ${s.description}`.toLowerCase().match(/[a-z][a-z0-9-]{3,}/g)?.filter((w) => !STOP.has(w)) || []);
    const hits = [...words].filter((w) => key.has(w)).length;
    if (hits >= 2 && (!best || hits > best.hits)) best = { s, hits };
  }
  return best?.s || null;
}
