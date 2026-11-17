// The sandbox profile needs an absolute, symlink-free folder: a relative workDir used to deny every write (run t14).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { createFixture } from '../lib/method-decisions.mjs';
const have = fs.existsSync('/usr/bin/sandbox-exec') && fs.existsSync('/usr/bin/python3');
test('a relative workDir still gives a working sandboxed fixture', { skip: have ? false : 'needs macOS sandbox-exec and python3' }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'km-fxpath-')); const cwd = process.cwd();
  t.after(() => { process.chdir(cwd); fs.rmSync(root, { recursive: true, force: true }); });
  process.chdir(root); fs.mkdirSync('kit');
  fs.writeFileSync('kit/sim.py', "import json,sys,os\na=sys.argv[1:];run=a[a.index('--run')+1];os.makedirs(run,exist_ok=True);print(json.dumps({'t':0}))\n");
  const L = (s) => s.split(' ');
  const fx = createFixture({ root: 'kit', plan: { setup: { argv: L('python3 sim.py init --run runs/x') }, observe: { argv: L('python3 sim.py observe --run runs/x') }, act: { argv: L('python3 sim.py step --run runs/x --heat HEAT') } }, decision: { name: 'heat' }, workDir: 'rel/work' });
  assert.ok(path.isAbsolute(fx.dir));
  assert.deepEqual(fx.start({}).obs, [{ t: 0 }]);
});
