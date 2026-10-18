// lib/local-turn.mjs — one turn on a local model (Ollama on this Mac), for the Kingmaker bar's model picker and the write
// lane. Text only: it answers, it doesn't act (the governed brain, "kingmaker", is the one that drives programs). Qwen3's
// thinking is left out.
//
// The system message is the same every turn while the owner's settings are (the fixed line plus `brief`), so Ollama
// reuses what it already read of it; what was picked for this turn (`turnBrief`, lib/instructions.mjs conductParts) goes
// ahead of the owner's words in the user message instead (after OpenHuman's cacheable prefix, 2026-10-15).
import { meter, meterFail } from './token-meter.mjs';

export const LOCAL_SYSTEM = 'You are a local language model answering a question on the owner\'s Mac. You can only write text: you cannot open apps or websites, look at pages, make images or files, send messages, or do anything on the computer. Never say you will or can do those things. If asked to, say in one sentence to ask Kingmaker with the model picker on Auto, which can. Answer plainly and briefly.';

export async function localModelTurn(model, text, { brief = '', turnBrief = '', temperature = null, context = null, base = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434', fetchImpl = fetch } = {}) {
  const options = { ...(temperature == null ? {} : { temperature }), ...(context == null ? {} : { num_ctx: context }) };
  const r = await fetchImpl(`${base.replace(/\/$/, '')}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, stream: false, ...(Object.keys(options).length ? { options } : {}), messages: [
      { role: 'system', content: LOCAL_SYSTEM + (brief ? `\n\n${brief}` : '') },
      { role: 'user', content: turnBrief ? `${turnBrief}\n\n${text}` : text }] }),
    signal: AbortSignal.timeout(180_000) }).catch((error) => { meterFail({ lane: 'writer', model, error }); throw error; });
  if (!r.ok) { meterFail({ lane: 'writer', model }); throw new Error(`the local model ${model} answered ${r.status}`); }
  const j = await r.json(); meter(j, { lane: 'writer', kind: 'turn', model });
  return String(j?.message?.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim() || '(no answer)';
}
