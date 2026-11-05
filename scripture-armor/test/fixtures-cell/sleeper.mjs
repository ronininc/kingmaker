// sleeper — runs past any sane wall-clock cap so the battery can prove
// the kill + destroy path. Writes a heartbeat into scratch while alive.
import fs from 'node:fs';

const started = Date.now();
const iv = setInterval(() => {
  try {
    fs.writeFileSync(`${process.env.SA_SCRATCH}/heartbeat.txt`, `${Date.now() - started}\n`);
  } catch {}
}, 250);
setTimeout(() => { clearInterval(iv); process.exit(0); }, 120000);
