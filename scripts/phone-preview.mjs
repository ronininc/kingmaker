#!/usr/bin/env node
// scripts/phone-preview.mjs — the phone app with SAMPLE data, on this Mac only, for screenshots and design checks (never
// for a phone: no pairing, no Kingmaker, nothing real is said or sent). Every page carries a "PREVIEW · sample data" tag.
//
//   node scripts/phone-preview.mjs [--port 3199]      → http://127.0.0.1:3199/
//
// Screens:  /                the conversation (sample turns)
//           /?call=1         the call screen (Kingmaker speaking: the crest pulses)
//           /?call=walkie    the walkie-talkie fallback (hold to talk)
//           /?call=incoming  the CRM calling the owner (Answer / Decline)
//           /pair            the pairing screen
//           /setup           the first-time setup (certificate, trust, open)
// Load them at phone size (iPhone 13 mini 375×812 … 17 Pro Max 440×956).
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { PREVIEW_PAGES } from '../lib/phone-companion.mjs';
import { PHONE_ICON } from '../lib/phone-icon.mjs';

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const PORT = Number(arg('--port', 3199));
const ICON = PHONE_ICON;
const now = () => new Date().toISOString();
const SAMPLE = [
  { who: 'You', text: 'how many files are on my desktop' },
  { who: 'Kingmaker', text: '11 files and 6 folders on your Desktop.' },
  { who: 'You (said)', text: 'what’s on my calendar this afternoon' },
  { who: 'Kingmaker', text: 'Two things: the Quik Burrito walkthrough at 2:00 and a call with Ana at 4:30.' },
  { who: 'field', text: '✓ On your Mac: 2026-10-15 iPhone storefront.jpg' },
];
const TAG = '<div style="position:fixed;z-index:99;left:50%;transform:translateX(-50%);bottom:calc(env(safe-area-inset-bottom) + 4px);font:600 9px -apple-system,sans-serif;letter-spacing:.14em;color:#000;background:#E8BA45;border-radius:6px;padding:2px 6px;opacity:.85">PREVIEW · SAMPLE DATA</div>';
// Sample mode: the call screen opens by itself and shows a state (?call=1 speaking, ?call=walkie hold-to-talk).
const AUTOCALL = `<script>(()=>{const q=window.__pc;if(!q)return;
 const go=()=>{const el=document.getElementById('call');if(q==='incoming'){el.className='on incoming';document.getElementById('cst').textContent='Incoming call';document.getElementById('line').textContent='Ronin CRM is calling';return}
  el.className='on'+(q==='walkie'?' walkie':'');document.getElementById('cst').textContent=q==='walkie'?'Hold to talk':'Speaking';
  document.getElementById('line').textContent=q==='walkie'?'The connection is weak: switched to hold-to-talk.':'Two things: the Quik Burrito walkthrough at 2:00 and a call with Ana at 4:30.';
  if(q==='walkie')document.getElementById('mode').textContent='Switch to a live call';
  if(q!=='walkie'){let t=0;setInterval(()=>{t+=.12;const v=(Math.sin(t)*.5+.5)*.05+.01;const o=document.getElementById('orb');o.style.transform='scale('+(1+v*3.2).toFixed(3)+')';o.style.setProperty('--glow',(0.35+v*9).toFixed(2))},60)}};
 setTimeout(go,50)})()</script>`;

const send = (res, code, type, body) => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body); };
createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/icon.png') return existsSync(ICON) ? send(res, 200, 'image/png', readFileSync(ICON)) : send(res, 404, 'text/plain', '');
  if (url.pathname === '/manifest.webmanifest' || url.pathname === '/sw.js') return send(res, 404, 'text/plain', '');
  if (url.pathname === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
    for (const l of SAMPLE) res.write(`data: ${JSON.stringify({ at: now(), ...l })}\n\n`);
    const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
    return void req.on('close', () => clearInterval(ping));
  }
  if (url.pathname === '/turn' || url.pathname === '/voice/turn') return send(res, 200, 'application/json', JSON.stringify({ ok: true, heard: '(sample) what’s next today' }));
  if (url.pathname === '/voice/say') return send(res, 204, 'text/plain', '');
  if (url.pathname.startsWith('/field/') || url.pathname === '/unpair' || url.pathname === '/pair-code') return send(res, 200, 'application/json', '{"ok":true}');
  const page = url.pathname === '/pair' ? PREVIEW_PAGES.pair() : url.pathname === '/setup' ? PREVIEW_PAGES.setup(`http://127.0.0.1:${PORT}`) : url.pathname === '/' ? PREVIEW_PAGES.app() : null;
  if (!page) return send(res, 404, 'text/plain', 'not found');
  // The page moves itself to its resume link at once, so the sample's ?call= is read before its own script runs.
  const early = "<script>window.__pc=new URLSearchParams(location.search).get('call')</script>";
  send(res, 200, 'text/html; charset=utf-8', page.replace('<script>', `${early}<script>`).replace('</body>', `${TAG}${url.pathname === '/' ? AUTOCALL : ''}</body>`));
}).listen(PORT, '127.0.0.1', () => console.log(`Phone preview (sample data, this Mac only): http://127.0.0.1:${PORT}/  ·  /?call=1  ·  /?call=walkie  ·  /pair  ·  /setup`));
