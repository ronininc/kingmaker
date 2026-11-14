// lib/crm-jobs.mjs — Kingmaker opens jobs; Solomon first, agents help. A work request said or typed at the bar ("make an
// ad about Kingmaker", "write the proposal", "research X") becomes a job on the CRM's board: Solomon's server calls the
// CRM's open_job through its vault-sealed CRM connection (POST /api/kingmaker-jobs/open, owner console only), and the CRM
// puts the best and cheapest agent on it: Kingmaker on this Mac whenever the Mac can do that kind of work, else Claude,
// then Codex. The bar says who has it, and says the result when it lands (job_result, read every 20 s). The result is on
// the job too.
// Quick actions stay instant and never become jobs: opening things, WhatsApp/text drafts, counts, pictures (the image lane),
// and anything that sends, pays or changes records (the governed brain, with its gates).
import { factsFor } from './core.mjs';

export const JOBS_ROUTE = '/api/kingmaker-jobs';

const LEAD = /^(?:(?:hey\s+)?(?:kingmaker|solomon)[,:\s]+)?(?:please\s+)?(?:(?:can|could|would) you\s+)?(?:go\s+(?:and\s+)?)?/i;
// Deliverables people hand to an agent: written work for the business.
const WORK = /^(make|mak|write|wrte|draft|create|prepare|put together|come up with|produce)\b(?:\s+(?:me|us))?\s+(?:a|an|the|some|my|our|\d+)?\s*(?:[\w'’-]+\s+){0,3}?(ads?|adds?|adverts?|advertisements?|proposals?|pitch(?:es)?|brochures?|newsletters?|blog posts?|articles?|(?:social(?: media)? )?posts?|captions?|campaigns?|scripts?|reports?|briefs?|one-pagers?|press releases?|(?:sales |ad |marketing )?copy|slogans?|taglines?|sales letters?|case stud(?:y|ies)|business plans?|marketing plans?|email sequences?)\b/i;
const RESEARCH = /^(research|look into|find out about|investigate|dig into|do (?:some )?research on)\b/i;
// Quick actions and lanes of their own: never a job.
const QUICK = /\b(whats ?app|imessage|sms|text (?:message|to)|message to|e-?mail to|send|call|ring|pay|charge|refund|open|launch|pull up|how many|count|posters?|logos?|pictures?|images?|photos?|drawings?|icons?|banners?)\b/i;

// With a photo on the turn (the phone's camera), "from these menu photos" names the attachment, not a picture to draw.
const ATTACHED_REF = /\s*\b(?:from|with|using|in|on|of|off|based on)\s+(?:this|that|these|those|the|my)\s+(?:[\w'’-]+\s+){0,2}?(?:photos?|pictures?|pics?|images?|shots?|screenshots?)\b/gi;

/** Pure: a work request for the job board → { request, kind }, or null (everything else keeps its lane). `attached`:
 *  the turn carries a photo, so words that only point at it don't make the line a picture request. */
export function workRequest(text, { attached = false } = {}) {
  const raw = String(text || '').trim();
  const t = (attached ? raw.replace(ATTACHED_REF, '') : raw).replace(LEAD, '').trim();
  if (!t || t.length > 4000 || QUICK.test(t)) return null;
  // The request keeps the owner's own words (the photo they point at included); only the test reads without them.
  const request = attached ? raw.replace(LEAD, '').trim() : t;
  if (RESEARCH.test(t)) return { request, kind: 'research' };
  if (WORK.test(t)) return { request, kind: 'write' };
  return null;
}

const clip = (v, n) => String(v ?? '').replace(/\s+$/g, '').slice(0, n);
/** Pure: the CRM is holding the job only because an allocation is used up (not something the owner must answer). */
export const outOfAllocation = (d) => /allocation/i.test(String(d?.reason ?? d?.waiting ?? '')) && !['queued', 'claimed', 'done', 'landed'].includes(String(d?.status ?? ''));
/** Pure: who has it, in one line. */
export function openedLine(d) {
  const title = d?.job?.title || 'the job';
  const who = d?.agent?.local ? 'Kingmaker on this Mac has it' : `${d?.agent?.name || 'An agent'} has it${d?.why ? ` (${d.why})` : ''}`;
  const wait = d?.status && !['queued', 'claimed'].includes(d.status) ? ` It's waiting: ${clip(d.reason || d.status, 200)}.` : '';
  return `On the board: “${title}”. ${who}.${wait} I'll tell you when it's done.`;
}
/** Pure: what to say (short, spoken) and show (the bar's text, the whole result) for a job that has moved on, or null
 *  while it's still working. */
export function resultLines(d) {
  const title = d?.job?.title || 'the job', agent = d?.parts?.[0]?.agent;
  if (d?.landed) return { said: `Job done: “${title}”${agent ? `, by ${agent}` : ''}. It's in the bar and on the job.`,
    shown: clip(`“${title}”${agent ? ` (${agent})` : ''}:\n\n${d.result || '(no text came back; it is on the job)'}`, 3900) };
  if (d?.stuck && outOfAllocation(d)) return { said: '', shown: null };   // nothing for the owner to do: stay quiet
  if (d?.stuck) return { said: `“${title}” needs you: ${clip(String(d.reason || d.status).replace(/\.+$/, ''), 300)}. It's on the job board.`, shown: null };
  return null;
}

/**
 * The bar's job desk. open(body) / read(taskId) reach Solomon's server (the cli wires them through ownerCall with the
 * launch nonce); say(line) speaks a line and puts it in the bar; show(text) only puts it in the bar. handle(text) → true
 * when it took the line as a job. handle(text, { attachments }): files that ride the job (a field photo from the phone:
 * { kind, path, filename, mimeType, bytes }), named in its detail too, so the agent that takes it knows they're there.
 */
export function createCrmJobs({ open, read, say, show = say, log = () => {}, pollMs = 20_000, maxMs = 45 * 60_000, setTimer = setTimeout, now = Date.now, id = () => `bar-${now().toString(36)}-${Math.random().toString(36).slice(2, 8)}` }) {
  const watching = new Map();
  const watch = (taskId, title, started = now()) => {
    if (!taskId || watching.has(taskId)) return;
    watching.set(taskId, title);
    const tick = async () => {
      const r = await read(taskId).catch(() => null);
      const d = r?.ok ? r.json?.data : null;
      const lines = d ? resultLines(d) : null;
      if (lines) {
        watching.delete(taskId); log('crm_job_landed', { task_id: taskId, status: d.status });
        if (lines.said) await say(lines.said); if (lines.shown) await show(lines.shown);
        return;
      }
      if (now() - started >= maxMs) {
        watching.delete(taskId);
        await say(`“${title}” is still on the board${d?.waiting ? ` (${clip(d.waiting, 200)})` : ''}. The result will be on the job when it lands.`);
        return;
      }
      setTimer(tick, pollMs)?.unref?.();
    };
    setTimer(tick, pollMs)?.unref?.();
  };
  return {
    watching: () => [...watching.keys()],
    async handle(text, { attachments = [] } = {}) {
      const files = (Array.isArray(attachments) ? attachments : []).filter((a) => a && typeof a.path === 'string').slice(0, 10);
      const ask = workRequest(text, { attached: files.length > 0 });
      if (!ask) return false;
      // The owner's own words at the bar: a person asked (so a website the owner asks for may be built).
      // Work about Kingmaker itself carries what Kingmaker is (lib/kingmaker-facts.mjs): the agent can't know it otherwise.
      const attachedLine = files.length ? `Attached from the owner's phone (on the owner's Mac): ${files.map((a) => `${a.filename || a.path} (${a.mimeType || 'file'})`).join(', ')}.` : '';
      const detail = [factsFor(ask.request), attachedLine].filter(Boolean).join('\n\n');
      const r = await open({ ...ask, ...(detail ? { detail } : {}), ...(files.length ? { attachments: files } : {}), asked_by_person: true, request_id: id() }).catch((e) => ({ ok: false, status: 0, json: { error: String(e?.message || e) } }));
      const d = r?.ok ? r.json?.data : null;
      if (!d?.task_id) {
        const error = r?.json?.error || `HTTP ${r?.status ?? '?'}`;
        log('crm_job_not_opened', { error, status: r?.status ?? null });
        // No CRM connected, or one that doesn't take jobs yet: Kingmaker does it right here instead.
        if (['CRM_NOT_CONNECTED', 'CRM_HAS_NO_JOB_TOOLS'].includes(error) || !r?.status || r.status === 404) return false;
        await say(`The CRM didn't open that job: ${clip(r?.json?.detail || error, 300)}`);
        return true;
      }
      // The CRM can't run it now (its allocation is used up): nothing the owner can do about that, so Kingmaker does the
      // work right here instead of announcing a stuck job (soak 2026-10-15: "… needs you: OroSolu's 50% allocation is
      // exhausted. Work is queued …" for a two-sentence ad).
      if (outOfAllocation(d)) { log('crm_job_done_here', { task_id: d.task_id, why: 'allocation' }); return false; }
      log('crm_job_opened', { task_id: d.task_id, agent: d.agent?.id, local: d.agent?.local === true, lane: d.lane });
      await say(openedLine(d));
      watch(d.task_id, d.job?.title || ask.request);
      return true;
    },
  };
}
