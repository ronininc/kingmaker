// lib/flow.mjs — the setup screen's steps (the owner, 2026-10-15: "whenever doing any kind of connector … it should pull up
// a screen like this that showcases the active process as it happens, and the neural lines going to the bucket should stop
// pulsing as soon as each part of the task is done"). The engine says what each step of a setup is doing, as it happens;
// the bar draws the owner's words at the top, one card per step under it, and a line from the words to each card that
// pulses only while that step is working. Nothing here is a guess: a step is "done" only when the engine saw it done.
//
// A flow: { id, ask, title, done, steps: [{ id, kind, caption, state, url?, lines?, rows? }] }
//   kind   page (a site's page) · secret (a hidden key) · log (what ran, line by line) · table (what's now in reach)
//   state  waiting · active · done · failed · skipped

const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };

/** One setup, told to the bar step by step. emit(flow) gets a copy every time something changes. */
export function createFlow({ id, ask, title, steps, emit }) {
  const flow = { id: String(id), ask: String(ask || title || '').slice(0, 200), title: String(title || '').slice(0, 120), done: false,
    steps: steps.map((s) => ({ state: 'waiting', ...s })) };
  const send = () => { try { emit(JSON.parse(JSON.stringify(flow))); } catch { /* the bar is gone */ } };
  const settle = () => { flow.done = flow.steps.some((s) => s.state === 'failed') || flow.steps.every((s) => ['done', 'skipped'].includes(s.state)); };
  send();
  return {
    get id() { return flow.id; },
    get done() { return flow.done; },
    /** One step's new state (and caption, lines, rows…). */
    step(stepId, state, patch = {}) {
      const s = flow.steps.find((x) => x.id === stepId);
      if (!s || flow.done) return;
      Object.assign(s, patch, { state });
      settle(); send();
    },
    /** The step that was working fails with this caption; the ones after it never ran. */
    fail(caption) {
      if (flow.done) return;
      const s = flow.steps.find((x) => x.state === 'active') || flow.steps.find((x) => x.state === 'waiting');
      if (s) Object.assign(s, { state: 'failed', caption: String(caption || 'It stopped.').slice(0, 300) });
      for (const x of flow.steps) if (x.state === 'waiting') x.state = 'skipped';
      flow.done = true; send();
    },
  };
}

/** Pure: a key's setup (connect my CRM, add a provider's key): its page, the hidden paste, the check and seal, ready. */
export function keyFlowSteps({ label = 'it', keyPageUrl = null } = {}) {
  const h = host(keyPageUrl || '');
  return [
    { id: 'page', kind: 'page', url: keyPageUrl || null, caption: h ? `${label}'s key page: ${h}. "Key page" opens it in Chrome.` : `Get a key from ${label}.`, state: h ? 'done' : 'skipped' },
    { id: 'secret', kind: 'secret', caption: 'Paste the key into the green field. It stays hidden.', state: 'active' },
    { id: 'check', kind: 'log', lines: ['› verify key', '› save credential'], caption: 'Checking it, then sealing it in this Mac\'s vault.' },
    { id: 'ready', kind: 'log', lines: ['connector ready'], caption: `${label} connected.` },
  ];
}

/** Pure: a connector being added (CLI, MCP server, skill, repo): REA reads it, MCP registers it, ready. */
export function connectorFlowSteps(spec = {}) {
  const what = spec.name || spec.url || spec.command || spec.path || spec.kind || 'the connector';
  return [
    { id: 'read', kind: 'log', lines: [`› read ${String(what).slice(0, 60)}`], caption: 'REA reads it first: what it runs, what it reaches, what it sends.', state: 'active' },
    { id: 'connect', kind: 'log', lines: ['› register with Kingmaker\'s MCP hub'], caption: 'Connecting it through Kingmaker.', state: spec.kind === 'mcp' ? 'waiting' : 'skipped' },
    { id: 'ready', kind: 'log', lines: ['connector ready'], caption: `${String(what).slice(0, 60)} is in reach.` },
  ];
}
