// lib/crm-skills.mjs — the connected CRM's skills as the bar's /name picks. The CRM's MCP tools are its skills; Solomon's
// server lists them with their gates (GET /api/kingmaker-jobs/skills, owner console only) through its vault-sealed CRM
// connection, so the bar never holds a CRM token. A pick goes back to Solomon's own turn as "CRM skill <tool>: <the rest>",
// which its CRM bridge runs as that one tool, filled, resolved and gated (a 'confirm' skill waits for "go ahead").
// OWNER ONLY: the bar asks for them only when Customize → "CRM skills in /" is on (off by default); a Kingmaker with no
// CRM connected gets none. The CRM is never in the public connector catalog.
import { JOBS_ROUTE } from './crm-jobs.mjs';

export const SKILLS_ROUTE = `${JOBS_ROUTE}/skills`;
const NAME = /^[a-z0-9][\w.-]{0,79}$/i;
const GATES = new Set(['read', 'auto', 'confirm']);
const clip = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/** Pure: a skill name the bar may send (a CRM tool name), or null. */
export function skillName(v) { const s = String(v ?? '').trim(); return NAME.test(s) ? s : null; }

/** Pure: the server's answer → the bar's picks [{name,title,description,gate}] (bounded, unknown gates read as confirm). */
export function skillPicks(data) {
  const out = [];
  for (const s of Array.isArray(data?.skills) ? data.skills : []) {
    const name = skillName(s?.name);
    if (!name || out.some((o) => o.name === name)) continue;
    out.push({ name, title: clip(s.title, 80) || name.replace(/_/g, ' '), description: clip(s.description, 200), gate: GATES.has(s?.gate) ? s.gate : 'confirm' });
    if (out.length >= 200) break;
  }
  return out;
}

/** Pure: the turn Solomon's CRM bridge reads for a picked skill. */
export function skillTurnText(name, text) {
  const rest = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 4000);
  return rest ? `CRM skill ${name}: ${rest}` : `CRM skill ${name}`;
}

/** Pure: why the list is empty, in the owner's words, from the server's answer. */
export function skillsProblem(r) {
  if (r?.ok) return null;
  const e = r?.json?.error;
  if (e === 'CRM_NOT_CONNECTED') return 'No CRM is connected to Solomon, so there are no CRM skills.';
  if (e === 'CRM_LIST_FAILED') return `The CRM didn't list its skills${r?.json?.detail ? `: ${clip(r.json.detail, 160)}` : '.'}`;
  if (r?.status === 404) return 'This Solomon is too old to list CRM skills. Update Kingmaker.';
  return `Couldn't read the CRM's skills (${e || (r?.status ? `HTTP ${r.status}` : 'no answer')}).`;
}
