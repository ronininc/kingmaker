/**
 * anatomy/lib/anatomy-gate.mjs
 *
 * The governed use-gate for Anatomy (wheresryan22/anatomy, MIT) — a
 * SKILL, not a service: the host agent follows SKILL.md and drives
 * headless Chrome over Anatomy's own figures. This gate sits between
 * a figure job and any upstream script: it validates the job on
 * paper before anything is allowed to run. Problems cited as
 * N1..N3 — see ~/workspace/githubprojects-scan/PROBLEMS.md.
 *
 * Rules, each one deliberate:
 *   - TARGETS ARE LOCAL FIGURES, ONLY (N1). Upstream's drive.mjs
 *     will navigate to any http:/https:/file: URL inside a Chrome
 *     launched with --allow-file-access-from-files — a browser in
 *     which file: pages can read the local disk. A governed job's
 *     target must be a file inside the declared figures directory.
 *     Remote targets refuse; there is no research exception, because
 *     the skill's job is rendering OUR figures.
 *   - FIGURES ARE SELF-CONTAINED (N1). The figure HTML is scanned
 *     before driving: any external resource (http/https src, href,
 *     CSS url(), fetch/XHR/WebSocket) refuses the job. A figure that
 *     can phone out or read out is not a figure, it is a payload.
 *   - PUBLISH NEVER RUNS (N2). SKILL.md teaches the agent to share
 *     finished figures to the community gallery via
 *     scripts/publish.mjs "when asked" — a script that force-pushes
 *     to GitHub with the operator's own gh credentials. The "ask"
 *     can arrive inside untrusted content (a brief, a page, a
 *     prompt). In governed use the publish path refuses outright,
 *     no tap override: sharing is a human act done by hand.
 *   - The --allow-file-access-from-files flag itself is hardcoded
 *     in upstream's spawn args — removing it is FORK-REQUIRED (see
 *     PROBLEMS.md). This gate is the our-side mitigation: confined
 *     targets + self-contained figures make the flag reach nothing
 *     but the figure itself.
 */

import { refused } from '../../lib/governance.mjs';

export const ANATOMY_PIN = Object.freeze({
  repo: 'wheresryan22/anatomy',
  license: 'MIT',
  auditedCommit: '1482e8469b0a9e0d8cc18ea2740a01423d29ae80',
  kind: 'agent-skill (SKILL.md + scripts)',
});

// Job actions that must never be reachable in governed use.
export const FORBIDDEN_ACTIONS = Object.freeze(['publish', 'submit-to-gallery', 'share-to-gallery']);

// Static tells of a figure that reaches outside itself.
const EXTERNAL_PATTERNS = Object.freeze([
  { re: /\b(?:src|href)\s*=\s*["']https?:\/\//i, why: 'external src/href' },
  { re: /url\(\s*["']?https?:\/\//i, why: 'external CSS url()' },
  { re: /\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource/i, why: 'network API call' },
  { re: /\bimport\s*\(\s*["']https?:\/\//i, why: 'remote module import' },
]);

function insideDir(path, dir) {
  if (typeof path !== 'string' || typeof dir !== 'string') return false;
  const norm = (p) => p.replace(/\/+$/, '');
  const d = norm(dir);
  const p = norm(path);
  return p === d || p.startsWith(`${d}/`);
}

/**
 * Scan figure HTML for external reach. Returns a refusal or
 * { ok: true }. Pure text scan — the figure is never rendered here.
 */
export function scanFigureHtml(html) {
  if (typeof html !== 'string' || html.length === 0) return refused('figure HTML is empty or not text');
  for (const { re, why } of EXTERNAL_PATTERNS) {
    if (re.test(html)) return refused(`figure is not self-contained: ${why} found (N1) — a governed figure reaches nothing outside itself`);
  }
  return { ok: true };
}

/**
 * Validate a figure job before any upstream script runs.
 *   { action, target, figuresDir, html }
 * action 'render'/'capture'/'print' with a local target + clean
 * HTML passes; 'publish' refuses (N2); remote targets refuse (N1).
 */
export function validateFigureJob({ action = 'render', target, figuresDir, html = null, auditLog = null } = {}) {
  if (FORBIDDEN_ACTIONS.includes(action)) {
    if (auditLog) auditLog.append({ actor: 'anatomy-gate', action: 'job.refused', detail: `action=${action} (N2: publish never runs in governed use)` });
    return refused(`action '${action}' refused: scripts/publish.mjs force-pushes to GitHub with the operator's credentials, and the "ask" can arrive inside untrusted content (N2) — sharing is a human act done by hand`);
  }
  if (!target || !figuresDir) return refused('a figure job needs a target and a declared figures directory');
  if (/^https?:\/\//i.test(target)) {
    return refused(`remote target '${target}' refused: governed jobs drive local figures only (N1)`);
  }
  const filePath = target.replace(/^file:\/\//, '');
  if (!insideDir(filePath, figuresDir)) {
    return refused(`target '${target}' is outside the declared figures directory (N1)`);
  }
  if (html != null) {
    const scan = scanFigureHtml(html);
    if (scan.ok === false) return scan;
  }
  if (auditLog) auditLog.append({ actor: 'anatomy-gate', action: 'job.allowed', detail: `action=${action} target=${filePath}` });
  return { ok: true, target: filePath };
}
