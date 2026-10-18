// lib/artifacts.mjs — everything Kingmaker made, for the bar's Artifacts tab (the owner, 2026-10-15: "an artifact section";
// "mass edit and delete … artifacts"). Only Kingmaker's own output folders are read: its one hidden folder (lib/kingmaker-
// home.mjs: documents, pictures, ads and reels, reports, field uploads), the visible folders an older version used and
// its ads left on the Desktop (until they're moved in), and the engine's own media and artifact
// folders. Never anywhere else, so the list (and a delete from it) can't reach the owner's other files.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { reportsDir } from './evidence.mjs';
import { kingmakerHome } from './kingmaker-home.mjs';

const KINDS = { image: /^\.(png|jpe?g|heic|gif|webp|tiff?)$/i, video: /^\.(mp4|mov|m4v|webm)$/i, audio: /^\.(wav|mp3|m4a|aiff?)$/i,
  document: /^\.(docx?|xlsx?|pptx?|pdf|md|txt|rtf|csv|html?)$/i };
export const kindOf = (file) => Object.entries(KINDS).find(([, re]) => re.test(extname(file)))?.[0] ?? 'file';

/** The folders Kingmaker writes to, each with what it's called in the bar. `match` narrows a shared folder (the Desktop). */
export function artifactRoots({ home = homedir(), runtimeHome = null, env = process.env } = {}) {
  const roots = [
    { dir: kingmakerHome(env, home), where: 'Kingmaker' },
    { dir: join(home, 'Documents', 'Kingmaker'), where: 'Documents' },
    { dir: join(home, 'Pictures', 'Kingmaker'), where: 'Pictures' },
    { dir: join(home, 'Desktop'), where: 'Desktop', match: /^Kingmaker (Ad|Reel)\b.*\.(mp4|mov)$/i },
    { dir: reportsDir(env, home), where: 'Reports' },
  ];
  if (runtimeHome) for (const d of ['generated-media', 'artifacts', 'evidence-screenshots']) roots.push({ dir: join(runtimeHome, 'data', d), where: d === 'evidence-screenshots' ? 'Screenshots' : 'Made by Kingmaker' });
  return roots;
}

/** Everything in those folders (one level down too), newest first. → [{ name, path, kind, bytes, at, where }] */
export function listArtifacts(opts = {}, { max = 300 } = {}) {
  const out = [];
  const seen = new Set();
  for (const r of artifactRoots(opts)) {
    if (!existsSync(r.dir)) continue;
    const walk = (dir, depth) => {
      let entries = [];
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        const p = join(dir, e.name);
        if (e.isDirectory()) { if (depth < 1 && !r.match) walk(p, depth + 1); continue; }
        if (!e.isFile() || (r.match && !r.match.test(e.name)) || seen.has(p)) continue;
        let st; try { st = statSync(p); } catch { continue; }
        seen.add(p);
        out.push({ name: e.name, path: p, kind: kindOf(e.name), bytes: st.size, at: Math.round(st.mtimeMs), where: r.where });
      }
    };
    walk(r.dir, 0);
  }
  return out.sort((a, b) => b.at - a.at).slice(0, max);
}

/** Pure: is this path one of Kingmaker's artifacts (inside its folders, matching a shared folder's rule)? */
export function isArtifactPath(path, opts = {}) {
  const p = resolve(String(path || ''));
  return artifactRoots(opts).some((r) => {
    const d = resolve(r.dir);
    if (!p.startsWith(d + sep)) return false;
    return !r.match || (p.slice(d.length + 1).indexOf(sep) < 0 && r.match.test(p.slice(d.length + 1)));
  });
}
