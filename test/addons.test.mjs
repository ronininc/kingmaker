// The free Kingmaker runs without its paid add-ons (lib/addons.mjs). KINGMAKER_ADDONS=off runs an owner's checkout as the
// free edition; the public repo has no addons/ folder at all, so there it is the only edition.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../lib/cli.mjs', import.meta.url));
const free = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, KINGMAKER_ADDONS: 'off', SOL_GHOST_HOME: '/tmp/km-free-edition' } });

test('without the Ronin add-on its commands say so and exit 2; nothing else changes', () => {
  for (const args of [['pair'], ['crm-lock', 'status'], ['owner-call', 'status'], ['office', 'muse', 'status'], ['text-watch', 'status']]) {
    const r = free(args);
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.stderr, /part of the Ronin add-on \(from Ronin Launcher\), which isn't installed here/);
  }
  const help = free(['help']);
  assert.doesNotMatch(help.stdout, /owner-call|kingmaker pair|office muse|Ronin CRM/, 'the free edition does not advertise them');
  assert.match(help.stdout, /kingmaker markets/);
});

test('the add-on loader is the only way in: no core module imports an add-on file directly', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const lib = fileURLToPath(new URL('../lib/', import.meta.url));
  const direct = readdirSync(lib).filter((f) => f.endsWith('.mjs') && f !== 'addons.mjs')
    .filter((f) => /(?:from |import\()\s*['"]\.\.\/addons\//.test(readFileSync(lib + f, 'utf8')));
  assert.deepEqual(direct, []);
});
