// lib/kingmaker.mjs — Kingmaker's entry (the app and bin/kingmaker start here). It checks that the whole payload is on
// this Mac (lib/payload.mjs) BEFORE any of Kingmaker loads, because a missing file would otherwise stop the process while
// it is still loading, with an error no owner can act on (0.2.6: a red icon). Then it hands over to lib/cli.mjs.
// Imports nothing but lib/payload.mjs and Node built-ins.
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkPayload, payloadProblem } from './payload.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const problem = payloadProblem(checkPayload(root));
if (problem) {
  console.error(`✗ ${problem}`);
  process.exit(78); // EX_CONFIG: the app shows the line above and stays down instead of restarting into the same crash
}
const { main } = await import(pathToFileURL(join(root, 'lib', 'cli.mjs')).href);
main(process.argv.slice(2)).then((code) => { if (typeof code === 'number') process.exit(code); }, (error) => { console.error(error); process.exit(1); });
