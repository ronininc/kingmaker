// server.mjs — the incumbent loopback surface server (DESIGN §5.1: KEPT as core architecture both mountings).
// Binds 127.0.0.1 ONLY. Serves the rendered surface at /, the CSS, posture JSON at /state.json.
// The surface's only write door is POST /intent (intent flags + job submissions — §4.4 write path (a));
// session prefs go to prefs.json (write path (b)). It can write nothing else (§4.4).
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderSurface } from './surface/render.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export function startSurfaceServer({ stateDir, auditPath, port = 0, sunShown = () => false } = {}) {
  const css = readFileSync(join(here, 'surface', 'surface.css'), 'utf8');
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/surface.css') { res.writeHead(200, { 'content-type': 'text/css' }); return res.end(css); }
    if (url.pathname === '/state.json') {
      const rec = JSON.parse(readFileSync(join(stateDir, 'ronin-state.json'), 'utf8'));
      res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(rec));
    }
    if (url.pathname === '/intent' && req.method === 'POST') {
      let body = ''; req.on('data', (c) => { body += c; });
      req.on('end', () => {
        let v; try { v = JSON.parse(body); } catch { res.writeHead(400); return res.end('{"ok":false,"error":"bad json"}'); }
        if (v.kind === 'pref') { writeFileSync(join(stateDir, 'prefs.json'), JSON.stringify(v.prefs ?? {}, null, 2)); }
        else if (v.kind === 'intent') { writeFileSync(join(stateDir, 'intent.json'), JSON.stringify({ intent: v.intent ?? null, at: new Date().toISOString() }, null, 2)); }
        else { res.writeHead(400); return res.end('{"ok":false,"error":"kind must be intent|pref"}'); }
        res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}');
      });
      return;
    }
    if (url.pathname === '/') {
      const rec = JSON.parse(readFileSync(join(stateDir, 'ronin-state.json'), 'utf8'));
      const entries = readFileSync(auditPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(renderSurface(rec, entries, { sun: sunShown() }));
    }
    res.writeHead(404); res.end('not found');
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}
