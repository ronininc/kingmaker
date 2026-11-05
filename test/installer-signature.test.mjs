import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('first install refuses a release with no detached manifest signature', { skip: process.platform !== 'darwin' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'km-installer-signature-'));
  try {
    const resources = join(dir, 'resources'), prefix = join(dir, 'prefix'); mkdirSync(resources); mkdirSync(prefix);
    cpSync(new URL('../installer/engine.sh', import.meta.url), join(resources, 'engine.sh'));
    cpSync(new URL('../lib/kingmaker-release-public.pem', import.meta.url), join(resources, 'kingmaker-release-public.pem'));
    writeFileSync(join(resources, 'kingmaker-manifest.json'), JSON.stringify({ schema: 'kingmaker.release/1', tag: 'fixture', version: 'fixture', repo: 'ronininc/Kingmaker' }));
    let output = '';
    try {
      execFileSync('/bin/bash', [join(resources, 'engine.sh'), '--wake-word', 'Kingmaker', '--prefix', prefix, '--no-launch'], { encoding: 'utf8', env: { ...process.env, HOME: join(dir, 'home') }, stdio: ['ignore', 'pipe', 'pipe'] });
      assert.fail('unsigned first install unexpectedly succeeded');
    } catch (error) { output = `${error.stdout ?? ''}${error.stderr ?? ''}`; }
    assert.match(output, /This release is not signed\. Refusing it\./);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('raw installer CLI cannot override the embedded release public key', () => {
  let output = '';
  try {
    execFileSync('/bin/bash', [new URL('../installer/engine.sh', import.meta.url).pathname, '--release-pubkey', '/tmp/attacker.pem'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    assert.fail('release public-key override unexpectedly succeeded');
  } catch (error) { output = `${error.stdout ?? ''}${error.stderr ?? ''}`; }
  assert.match(output, /unknown argument --release-pubkey/);
});
