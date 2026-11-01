#!/usr/bin/env node
// scripts/phone-companion.mjs — the iPhone companion (lib/phone-companion.mjs) by hand. Kingmaker's engine runs it itself
// (kingmaker://companion?op=start|stop, the control line `companion start|stop|status`); this is for a run without it.
//
//   node scripts/phone-companion.mjs [--port 3091] [--host name.local] [--icon icon.png] [--link-file f.json]
//                                                             serve (prints the pairing link and code)
//   node scripts/phone-companion.mjs devices                  the paired phones (on the Mac)
//   node scripts/phone-companion.mjs unpair <id|all>          unpair one phone, or every one (on the Mac)
import { writeFileSync } from 'node:fs';
import { COMPANION_PORT, createCompanion, deviceStore } from '../lib/phone-companion.mjs';
import { PHONE_ICON } from '../lib/phone-icon.mjs';

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };

// On the Mac, without a server: list or unpair (a running server sees the change on the phone's next request).
const cmd = process.argv[2];
if (cmd === 'devices' || cmd === 'unpair') {
  const store = deviceStore(), list = store.shown();
  if (cmd === 'devices') {
    if (!list.length) console.log('No phones paired.');
    for (const d of list) console.log(`${d.id}  ${d.name}  paired ${d.pairedAt}  last seen ${d.lastSeen || '—'}  from ${d.ip}`);
  } else {
    const which = process.argv[3];
    if (!which) { console.error('usage: phone-companion unpair <id|all>'); process.exit(2); }
    if (!list.length) { console.log('No phones paired.'); process.exit(0); }
    const n = store.unpair(which);
    if (!n) { console.error(`No paired phone ${which}.`); process.exit(1); }
    console.log(which === 'all' ? `Unpaired ${n} phone${n === 1 ? '' : 's'}.` : `Unpaired ${which}.`);
  }
  process.exit(0);
}

const companion = createCompanion({
  port: Number(arg('--port', COMPANION_PORT)), host: arg('--host', null), icon: arg('--icon', process.env.KINGMAKER_PHONE_ICON || PHONE_ICON),
  log: (event, d) => {
    console.log(`${event} ${JSON.stringify(d)}`);
    // By hand, this terminal is the Mac's screen: show the next link and code after each pairing.
    if (event === 'paired' || event === 'code_replaced') { const p = companion.pairLink({ fresh: false }); console.log(`next: ${p.link}  code ${p.code}`); }
  },
});
try {
  const s = await companion.start(), p = companion.pairLink({ fresh: false });
  const out = arg('--link-file', null); if (out) writeFileSync(out, JSON.stringify(p), { mode: 0o600 });
  console.log(`Kingmaker companion: app ${s.app}  setup ${s.setup}`);
  console.log(`pair: ${p.link}  code ${p.code}`);
} catch (e) {
  console.error(`Couldn't start the companion: ${e.code === 'EADDRINUSE' ? `port ${e.port} is taken (is Kingmaker already running it?)` : e.message}`);
  process.exit(1);
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => void companion.stop().then(() => process.exit(0)));
