// test/fixtures/fake-ollama.mjs — a stand-in for Ollama's HTTP API on a free loopback port, for testing what Kingmaker
// SENDS (after OpenHuman's scripted-upstream e2e tests and OpenJarvis's tests/agents/fake_engine.py, read 2026-10-15:
// ideas only). Replies come from a script, in order; every request is kept, so a test asserts on the schema held to,
// the tools advertised, the system message and how many calls a lane made. No real model and no network.
//
//   const o = await fakeOllama([{ content: '{"lane":"write"}' }, …]);   process.env-free: pass o.base to the lane
//   o.chats → every /api/chat body, in order        o.reply(…) queues more        await o.close()
// A script entry: { content } (the message text), { tool_calls }, { status, error } (an HTTP failure), or a function
// (body) → one of those, to answer from what was asked. When the script runs out the reply is `fallback`.
import { createServer } from 'node:http';

export async function fakeOllama(script = [], { models = ['fake:1b'], version = '0.31.1', fallback = { content: '' }, promptEvalCount = 40 } = {}) {
  const queue = [...script], requests = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      let body = null; try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
      requests.push({ method: req.method, path: req.url, body });
      const send = (status, json) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(json)); };
      if (req.url === '/api/version') return send(200, { version });
      if (req.url === '/api/tags') return send(200, { models: models.map((name) => ({ name, model: name })) });
      if (req.url === '/api/ps') return send(200, { models: [] });
      if (req.url !== '/api/chat' && req.url !== '/api/generate') return send(404, { error: 'not found' });
      let next = queue.length ? queue.shift() : fallback;
      if (typeof next === 'function') next = next(body) ?? fallback;
      if (next.status && next.status >= 400) return send(next.status, { error: next.error ?? 'scripted failure' });
      const content = next.content ?? '';
      const stats = { done: true, total_duration: 1e8, load_duration: 1e6, prompt_eval_count: next.promptEvalCount ?? promptEvalCount, prompt_eval_duration: 2e7, eval_count: Math.max(1, Math.ceil(content.length / 4)), eval_duration: 5e7 };
      if (req.url === '/api/generate') return send(200, { model: body?.model, response: content, ...stats });
      send(200, { model: body?.model, message: { role: 'assistant', content, ...(next.tool_calls ? { tool_calls: next.tool_calls } : {}) }, ...stats });
    });
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base, requests,
    get chats() { return requests.filter((r) => r.path === '/api/chat').map((r) => r.body); },
    reply: (...entries) => { queue.push(...entries); },
    left: () => queue.length,
    close: () => new Promise((done) => { server.closeAllConnections?.(); server.close(() => done()); }),
  };
}
