// initial-sun.mjs — DESIGN §9.5: the Initial Sun is shown exactly once per install. The install record
// marks it shown; a layer reinstall (a re-claim = a new first morning) creates a fresh record and the
// sun rises again. Ordinary launches never re-show it.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
export function sunShouldShow(recordPath) {
  if (!existsSync(recordPath)) { writeFileSync(recordPath, JSON.stringify({ sunShown: false, installedAt: new Date().toISOString() }, null, 2)); return true; }
  return JSON.parse(readFileSync(recordPath, 'utf8')).sunShown !== true;
}
export function sunMarkShown(recordPath) {
  const r = JSON.parse(readFileSync(recordPath, 'utf8')); r.sunShown = true; r.sunShownAt = new Date().toISOString();
  writeFileSync(recordPath, JSON.stringify(r, null, 2));
}
