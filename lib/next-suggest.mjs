// lib/next-suggest.mjs — after each answer, the bar's input box shows one suggested next command in a soft off colour
// (Tab or → takes it), the one that would better get the owner what they're after. The lightweight local router model
// (qwen3 1.7B abliterated, already warm for the fast lanes) writes it: local, about a quarter second, nothing sent anywhere.
// Nothing is suggested when it's unsure, slow or down.
import { ROUTER_MODEL } from './fast-route.mjs';
import { meter, meterFail } from './token-meter.mjs';

const SYS = 'You help the owner use Kingmaker, an assistant on their Mac that writes, opens apps, makes pictures, works their CRM job board and messages people with their OK. '
  + 'Given what the owner asked and what Kingmaker answered, write the ONE next command the owner could type to get closer to what they want: '
  + 'more specific, or the natural next step. Imperative, under 12 words, in the owner\'s voice, no quotes, no explanation. If there is no useful next step, answer NONE.';

const ask = (asked, answer) => `The owner asked: ${String(asked).slice(0, 600)}\nKingmaker answered: ${String(answer || '(nothing yet)').slice(0, 1200)}\nNext command:`;
// Two worked examples steer a small model to the shape: one plain sentence the owner would type.
const EXAMPLES = [
  ['write a summary of the Hector Tacos account', 'Hector Tacos: Clover since March, $18k a month, terminal offline twice this week.', 'Draft a check-in text to Hector about the terminal'],
  ['open youtube', 'Opened YouTube in Chrome.', 'NONE'],
];

/** Pure: a model's reply → a clean one-line suggestion, or null. */
export function cleanSuggestion(raw, asked = '') {
  let t = String(raw || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim().split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '';
  // A slash command or an id-looking thing ("/notify kingmaker-ad-created", 2026-10-15) is never a suggestion: a leading /
  // in the bar names a program to drive, and the small model invents ones that don't exist.
  if (/^["'`]*\//.test(t) || /\b[a-z0-9]+(?:[-_][a-z0-9]+){2,}\b/i.test(t)) return null;
  t = t.replace(/^(next command|suggestion|try|command)\s*:\s*/i, '').replace(/^["'“”‘’`*\s-]+|["'“”‘’`*\s]+$/g, '').replace(/\s+/g, ' ').trim();
  // A real next command is a short sentence (three words or more): "notify creator" isn't one.
  if (!t || /^none\b/i.test(t) || t.length < 4 || t.length > 90 || t.split(' ').length > 14 || t.split(' ').length < 3) return null;
  if (t.toLowerCase() === String(asked).trim().toLowerCase()) return null;
  return t;
}

/** One suggestion for what to type next, or null. Never throws. */
export async function suggestNext({ asked, answer, model = ROUTER_MODEL, base = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434', timeoutMs = 6000, fetchImpl = fetch } = {}) {
  if (!String(asked || '').trim()) return null;
  try {
    const r = await fetchImpl(`${base.replace(/\/$/, '')}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, stream: false, think: false, keep_alive: '30m', options: { temperature: 0.4, num_predict: 32 },
        messages: [{ role: 'system', content: SYS }, ...EXAMPLES.flatMap(([a, b, c]) => [{ role: 'user', content: ask(a, b) }, { role: 'assistant', content: c }]),
          { role: 'user', content: ask(asked, answer) }] }),
      signal: AbortSignal.timeout(timeoutMs) });
    const j = r.ok ? await r.json() : null;
    if (j) meter(j, { kind: 'router', model }); else meterFail({ kind: 'router', model });
    return j ? cleanSuggestion(j?.message?.content, asked) : null;
  } catch (error) { meterFail({ kind: 'router', model, error }); return null; }
}
