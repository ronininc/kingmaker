// lib/pilot-prompt.mjs — how the pilot model is asked for ONE decision (2026-11-16). Shared by lib/observe-act-loop.mjs
// and the decision checkers so the gate tests exactly what races. The model makes every decision; the code only
// formats prompts, counts votes and parses replies — it never evaluates a rule or chooses an action.
//   plain     one prompt: method + observation → {turn, amount, sheet, rule, reason}
//   votes N   N seeded samples (temperature 0.4); the turn word given by a majority wins; else one deterministic call
//   decompose (small deciders) two model steps: (1) the model reads ONLY the rule conditions and names the rule that
//             applies (majority of N); (2) the model reads that rule's text and decides the turn (majority of N).
// Level words for a one-sided bounded field (--level <field>): the pilot answers a word; the daemon converts it to a value.
export const LEVELS = Object.freeze({ off: 0, low: 0.25, medium: 0.5, high: 0.75, full: 1 });
export const levelValue = (word, [lo, hi]) => { const k = String(word ?? '').toLowerCase().trim(); return k in LEVELS ? lo + (hi - lo) * LEVELS[k] : NaN; };
export function systemPrompt({ guidance, fields, turnField, levelField = null }) {
  return `You are Kingmaker's pilot. You make ONE decision per observation using the method below.\nReply with ONLY a JSON object with these keys: ${turnField ? '"turn" (one of "left", "straight", "right"), "amount" (number 0 to 1, how hard to turn), ' : ''}${levelField ? `"${levelField}_level" (one of "off", "low", "medium", "high", "full"), ` : ''}${Object.entries(fields).filter(([k]) => k !== turnField && k !== levelField).map(([k, [lo, hi]]) => `"${k}" (number ${lo} to ${hi})`).join(', ')}, "rule" (the number of the method rule you applied), "reason" (under 12 words).\nMETHOD:\n${guidance}`;
}
/** Rule lines of a guidance text: { id: '1' | '3a' ..., text, parent }. */
export function ruleLines(guidance) {
  const out = []; let parent = null;
  for (const line of String(guidance).split('\n')) {
    const top = /^(\d+)\.\s+(.*)$/.exec(line); const sub = /^\s+(\d+[a-z])\.\s+(.*)$/.exec(line);
    if (top) { parent = { id: top[1], text: top[2] }; out.push({ ...parent, parent: null }); }
    else if (sub && parent) out.push({ id: sub[1], text: sub[2], parent: parent.id });
  }
  return out;
}
const majority = (items, key) => { const t = {}; for (const x of items) { const k = key(x); if (k) t[k] = (t[k] ?? 0) + 1; } const [best, n] = Object.entries(t).sort((a, b) => b[1] - a[1])[0] ?? [null, 0]; return { best, n }; };

/**
 * decide({ ask, guidance, fields, turnField, userMsg, votes, decompose }) → { d, raw, votes, classify, calls }
 * ask(system, user, options) → { raw, d } (one model call).
 */
export async function decide({ ask, guidance, fields, turnField, userMsg, votes = 1, decompose = false, levelField = null }) {
  let calls = 0; const call = async (s, u, o) => { calls += 1; return ask(s, u, o); };
  const SYSTEM = systemPrompt({ guidance, fields, turnField, levelField });
  const withLevel = (r) => { if (levelField && r?.d) r.d[levelField] = levelValue(r.d[`${levelField}_level`], fields[levelField]); return r; };
  const pickTurn = async (system, user) => {
    if (votes > 1 && turnField) {
      const samples = []; for (let k = 0; k < votes; k += 1) samples.push(await call(system, user, { temperature: 0.4, seed: 1000 + k }));
      const w = (x) => { const t = String(x.d?.turn ?? '').toLowerCase(); return ['left', 'right', 'straight'].includes(t) ? t : null; };
      const { best, n } = majority(samples, w);
      const pick = n > votes / 2 ? samples.find((x) => w(x) === best) : await call(system, user, { temperature: 0 });
      return { ...pick, votes: { samples: samples.map((x) => (x.d ? { turn: x.d.turn, amount: x.d.amount, rule: x.d.rule } : null)), majority: n > votes / 2 ? best : null, tieBreak: n > votes / 2 ? null : 'deterministic model call' } };
    }
    return { ...(await call(system, user, { temperature: 0 })), votes: null };
  };
  const rules = ruleLines(guidance);
  if (!decompose || !(turnField || levelField) || rules.length < 2) { const r = withLevel(await pickTurn(SYSTEM, userMsg)); return { ...r, classify: null, calls }; }
  // (1) the MODEL names the rule whose condition is true (conditions only, in order)
  // a rule's CONDITION = its text before the action (turn rules: before ': turn…'/'"left"…'; level rules: before ': <field>_level')
  const condOf = (t) => (levelField && !turnField ? t.split(new RegExp(`:\\s(?=${levelField}_level\\b)`))[0] : t.split(/:\s(?=[a-z"])/)[0]);
  const condList = rules.map((r) => `${r.id}. ${condOf(r.text)}`).join('\n');
  const CLASSIFY = `You read one observation and say which rule applies. Check the conditions IN ORDER; the FIRST whose condition is true applies (a sub-rule like 3b applies only if its parent's condition is true too). Reply with ONLY JSON {"rule": "<rule id>", "why": "<under 12 words>"}.\nRULE CONDITIONS:\n${condList}`;
  const cls = []; for (let k = 0; k < Math.max(1, votes); k += 1) cls.push(await call(CLASSIFY, userMsg, votes > 1 ? { temperature: 0.4, seed: 2000 + k } : { temperature: 0 }));
  const idOk = (x) => { const id = String(x.d?.rule ?? '').trim().toLowerCase(); return rules.some((r) => r.id === id) ? id : null; };
  let { best: ruleId, n } = majority(cls, idOk);
  if (!(n > Math.max(1, votes) / 2)) { const t = await call(CLASSIFY, userMsg, { temperature: 0 }); ruleId = idOk(t); }
  // A rule with sub-rules is not a decision by itself: the MODEL then picks among its sub-rules (parent condition true).
  let subCls = null;
  const kids = rules.filter((r) => r.parent === ruleId);
  if (kids.length) {
    const parentRule = rules.find((r) => r.id === ruleId);
    const SUB = `You read one observation. It is already decided that this condition is TRUE: "${parentRule.text}". Now check these sub-rule conditions IN ORDER; the FIRST whose condition is true applies. Reply with ONLY JSON {"rule": "<sub-rule id>", "why": "<under 12 words>"}.\nSUB-RULE CONDITIONS:\n${kids.map((r) => `${r.id}. ${condOf(r.text)}`).join('\n')}`;
    const sc = []; for (let k = 0; k < Math.max(1, votes); k += 1) sc.push(await call(SUB, userMsg, votes > 1 ? { temperature: 0.4, seed: 3000 + k } : { temperature: 0 }));
    const kidOk = (x) => { const id = String(x.d?.rule ?? '').trim().toLowerCase(); return kids.some((r) => r.id === id) ? id : null; };
    const m2 = majority(sc, kidOk); let kidId = m2.n > Math.max(1, votes) / 2 ? m2.best : kidOk(await call(SUB, userMsg, { temperature: 0 }));
    subCls = sc.map((x) => x.d?.rule ?? null);
    if (kidId) ruleId = kidId;
  }
  const rule = rules.find((r) => r.id === ruleId);
  if (!rule) { const r = withLevel(await pickTurn(SYSTEM, userMsg)); return { ...r, classify: { samples: cls.map((x) => x.d?.rule ?? null), rule: null, fallback: 'no agreed rule → full method prompt' }, calls }; }
  // (2) the MODEL decides the turn under that rule (full method kept for context; the applicable rule stated first)
  const parent = rule.parent ? rules.find((r) => r.id === rule.parent) : null;
  const FOCUS = `${SYSTEM}\n\nYOU DETERMINED THAT RULE ${rule.id} APPLIES NOW:\n${parent ? `${parent.id}. ${parent.text}\n` : ''}${rule.id}. ${rule.text}\nDecide the ${turnField ? 'turn' : 'level'} by THIS rule.`;
  const r = withLevel(await pickTurn(FOCUS, userMsg));
  return { ...r, classify: { samples: cls.map((x) => x.d?.rule ?? null), sub: subCls, rule: rule.id }, calls };
}
