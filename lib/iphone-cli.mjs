// `kingmaker iphone …` — the owner's own controls for the iPhone bridge (iphone-bridge.mjs). Trust, policy and the
// do-not-call sync live ONLY here (never in the MCP registry), and trusting a contact takes their Touch ID.
import { runProcess, buildHelper, createBridge, iphoneDir, ollamaDecider, resolveHelper, runLoop } from './iphone-bridge.mjs';
import { TOKEN_ACCOUNT, TOKEN_SERVICE, loadDnc, snapshotFrom, syncDnc, writeSnapshot } from './iphone-dnc.mjs';
import { ronin } from './addons.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const IPHONE_USAGE = `kingmaker iphone <command>
  build                         compile the native helper (Swift, Apple frameworks only)
  status                        permissions, iPhone Mirroring, do-not-call snapshot
  see [--json]                  read the phone screen (text + tap points)
  tap <text> | tap --at X Y     tap by on-screen text, or at window points
  type "<text>" [--submit]      type into the focused field
  press <button>                home | app-switcher | spotlight | return | delete | escape
  swipe [up|down|left|right]
  open <app>                    open an app through Spotlight
  call <contact>                call a contact from the iPhone's SIM (Touch ID)
  text <contact> "<message>" [--sms]   iMessage (or SMS) a contact (Touch ID)
  trust <contact> [--channels imessage,sms,call]   let agents reach this contact without asking each time (Touch ID)
  untrust <contact>             make them ask again (Touch ID)
  policy                        who is trusted
  dnc sync | dnc import <file> | dnc status   the CRM do-not-call list, kept on this Mac
  do "<goal>" [--model M] [--steps N]         the local see → decide → act loop (Ollama on 127.0.0.1)`;

const flag = (args, name) => args.includes(name);
const opt = (args, name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const words = (args) => { const out = []; for (let i = 0; i < args.length; i++) { if (args[i].startsWith('--')) { if (['--channels', '--model', '--steps', '--at'].includes(args[i])) i += args[i] === '--at' ? 2 : 1; continue; } out.push(args[i]); } return out; };

function printScreen(s) {
  console.log(`screen: ${s.screen} · ${s.window.w}×${s.window.h} pt · ${s.elements.length} text elements · ${s.ms} ms`);
  for (const e of s.elements) console.log(`  (${String(e.x).padStart(3)},${String(e.y).padStart(3)})  ${e.text}`);
}

function report(r) {
  if (r.ok) console.log(`✓ ${JSON.stringify({ ...r, screen: undefined }, null, 0)}`);
  else console.log(`✗ ${r.refusal ?? r.error ?? 'failed'}`);
  if (r.screen) printScreen(r.screen);
  return r.ok ? 0 : 1;
}

async function crmToken(run = runProcess) {
  const r = await run('/usr/bin/security', ['find-generic-password', '-s', TOKEN_SERVICE, '-a', TOKEN_ACCOUNT, '-w']);
  return r.code === 0 ? r.stdout.trim() : null;
}

export async function cmdIphone(args, { paths }) {
  const [sub = 'status', ...rest] = args;
  const stateDir = iphoneDir(paths);
  if (sub === 'build') {
    try { console.log(`Built ${await buildHelper()}.`); return 0; } catch (e) { console.error(`✗ ${e.message}`); return 1; }
  }
  const bridge = createBridge({ stateDir });
  const w = words(rest);
  switch (sub) {
    case 'status': {
      const s = await bridge.status();
      if (flag(rest, '--json')) { console.log(JSON.stringify(s, null, 2)); return 0; }
      const mark = (b) => (b ? '✓' : '✗');
      console.log(`helper            ${s.helper ? `✓ ${s.helper}` : `✗ not built: kingmaker iphone build (${resolveHelper()})`}`);
      console.log(`Screen Recording  ${mark(s.screenRecording)}   Accessibility ${mark(s.accessibility)}   Contacts ${s.contacts ?? '?'}`);
      console.log(`iPhone Mirroring  ${s.window ? `✓ window ${Math.round(s.window.w)}×${Math.round(s.window.h)}` : s.mirroringRunning ? '… running, no phone window (unlock / reconnect)' : '✗ not open'}`);
      console.log(`do-not-call list  ${s.dnc.ok ? `✓ ${s.dnc.numbers} numbers, synced ${s.dnc.fetchedAt}` : `✗ ${s.dnc.reason}: kingmaker iphone dnc sync`}`);
      return 0;
    }
    case 'see': { const s = await bridge.see(); if (flag(rest, '--json')) console.log(JSON.stringify(s, null, 2)); else printScreen(s); return 0; }
    case 'tap': {
      const at = rest.indexOf('--at');
      return report(await (at >= 0 ? bridge.tap({ x: Number(rest[at + 1]), y: Number(rest[at + 2]) }) : bridge.tap({ text: w.join(' ') })));
    }
    case 'type': return report(await bridge.type({ text: w.join(' '), submit: flag(rest, '--submit') }));
    case 'press': return report(await bridge.press({ button: w[0] }));
    case 'swipe': return report(await bridge.swipe({ direction: w[0] ?? 'up' }));
    case 'open': return report(await bridge.openApp({ name: w.join(' ') }));
    case 'call': return report(await bridge.placeCall({ to: w.join(' ') }));
    case 'text': return report(await bridge.sendMessage({ to: w[0], text: w.slice(1).join(' '), channel: flag(rest, '--sms') ? 'sms' : 'imessage' }));
    case 'trust': case 'untrust': {
      const channels = String(opt(rest, '--channels') ?? 'imessage,sms').split(',');
      const r = await bridge.setTrust({ to: w.join(' '), channels, trusted: sub === 'trust' });
      console.log(r.ok ? (r.trusted ? `✓ Agents may now ${r.channels.join('/')} ${r.contact} without asking you each time.` : `✓ Agents ask you again before contacting ${r.contact}.`) : `✗ ${r.refusal}`);
      return r.ok ? 0 : 1;
    }
    case 'policy': {
      const p = await bridge.readPolicy();
      const list = Array.isArray(p.trusted) ? p.trusted : [];
      console.log(list.length ? list.map((t) => `  ${t.name}: ${t.channels.join(', ')} (since ${t.addedAt})`).join('\n') : 'Nobody is trusted: every call and message waits for your Touch ID.');
      return 0;
    }
    case 'dnc': {
      const file = join(stateDir, 'dnc-snapshot.json');
      const [verb = 'status', arg] = w;
      try {
        if (verb === 'sync') { const s = await syncDnc(file, { token: await crmToken(), url: ronin?.DNC_URL, tokenPrefix: ronin?.DNC_TOKEN_PREFIX }); console.log(`✓ ${s.phones.length} do-not-call numbers from ${s.source}${s.truncated ? ' — the CRM says the list is incomplete, so outbound stays blocked' : ''}.`); return 0; }
        if (verb === 'import') { const s = snapshotFrom(JSON.parse(readFileSync(arg, 'utf8')), { source: `file:${arg}` }); writeSnapshot(file, s); console.log(`✓ ${s.phones.length} do-not-call numbers imported.`); return 0; }
        const d = loadDnc(file); console.log(d.ok ? `✓ ${d.count} numbers, synced ${d.fetchedAt}` : `✗ ${d.reason}`); return d.ok ? 0 : 1;
      } catch (e) { console.error(`✗ ${e.message}`); return 1; }
    }
    case 'do': {
      const goal = w.join(' ').trim();
      if (!goal) { console.error('usage: kingmaker iphone do "<goal>"'); return 2; }
      const r = await runLoop({ bridge, goal, decide: ollamaDecider({ model: opt(rest, '--model') ?? 'qwen3:1.7b' }), maxSteps: Number(opt(rest, '--steps') ?? 12), onStep: (s, res) => console.log(`  ${res.ok ? '✓' : '✗'} ${JSON.stringify(s)}${res.refusal ? ` — ${res.refusal}` : ''}`) });
      console.log(r.done ? `✓ done${r.reason ? `: ${r.reason}` : ''}` : `■ ${r.reason}`);
      return r.done ? 0 : 1;
    }
    default: console.log(IPHONE_USAGE); return sub === 'help' ? 0 : 2;
  }
}
