import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildPayload } from '../scripts/build-payload.mjs';
import { buildPortableInstallers } from '../scripts/build-portable-installers.mjs';

test('portable Linux and Windows bundles preserve one verified payload and platform launchers', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'kingmaker-portable-test-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const payload = buildPayload({ out: join(root, 'payload') });
  const artifacts = buildPortableInstallers({ payload: payload.tar, out: join(root, 'out'), version: payload.version });
  assert.deepEqual(artifacts.map((x) => x.platform), ['linux', 'windows']);
  for (const artifact of artifacts) { assert.match(artifact.sha256, /^[a-f0-9]{64}$/); assert.ok(artifact.size > 0); }
  const linux = execFileSync('tar', ['-tf', join(root, 'out', artifacts[0].name)], { encoding: 'utf8' });
  assert.match(linux, /\/kingmaker\n/); assert.match(linux, /\/install\.sh\n/); assert.match(linux, /\/UNIT\.json\n/); assert.match(linux, /\/engine\/payload\.json\n/);
  const windows = execFileSync('unzip', ['-Z1', join(root, 'out', artifacts[1].name)], { encoding: 'utf8' });
  assert.match(windows, /\/kingmaker\.cmd\n/); assert.match(windows, /\/install\.ps1\n/); assert.match(windows, /\/UNIT\.json\n/); assert.match(windows, /\/engine\/payload\.json\n/);
  const metadata = JSON.parse(readFileSync(join(root, 'out', 'portable-artifacts.json')));
  assert.equal(metadata.status, 'installer-candidate'); assert.equal(metadata.version, payload.version);

  execFileSync('tar', ['-xzf', join(root, 'out', artifacts[0].name), '-C', root]);
  const linuxUnit = join(root, `Kingmaker-${payload.version}-linux-x64`);
  const home = join(root, 'home'), installRoot = join(root, 'installed');
  execFileSync('/bin/sh', [join(linuxUnit, 'install.sh')], { encoding: 'utf8', env: { ...process.env, HOME: home, KINGMAKER_ENGINE_HOME: installRoot } });
  assert.equal(JSON.parse(readFileSync(join(installRoot, 'UNIT.json'))).version, payload.version);
  assert.equal(JSON.parse(readFileSync(join(installRoot, 'engine', 'package.json'))).version, payload.version);
  assert.ok(existsSync(join(home, '.local', 'bin', 'kingmaker')));
  assert.match(execFileSync(join(installRoot, 'kingmaker'), ['version'], { encoding: 'utf8' }), new RegExp(payload.version.replaceAll('.', '\\.')));

  writeFileSync(join(installRoot, 'preserve-me'), 'existing install');
  const bad = JSON.parse(readFileSync(join(linuxUnit, 'UNIT.json'))); bad.version = '0.0.0';
  writeFileSync(join(linuxUnit, 'UNIT.json'), `${JSON.stringify(bad)}\n`);
  assert.throws(() => execFileSync('/bin/sh', [join(linuxUnit, 'install.sh')], { encoding: 'utf8', env: { ...process.env, HOME: home, KINGMAKER_ENGINE_HOME: installRoot } }));
  assert.equal(readFileSync(join(installRoot, 'preserve-me'), 'utf8'), 'existing install');
  assert.throws(() => execFileSync('/bin/sh', [join(linuxUnit, 'install.sh')], { encoding: 'utf8', env: { ...process.env, HOME: home, KINGMAKER_ENGINE_HOME: home } }));

  const ps = readFileSync(new URL('../platform/windows/install.ps1', import.meta.url), 'utf8');
  for (const required of ["$ErrorActionPreference = 'Stop'", 'KINGMAKER_ENGINE_HOME', 'Refusing an unsafe Kingmaker install directory', 'UNIT.json', 'payload.json', 'Move-Item -LiteralPath $Dest -Destination $Backup', 'Move-Item -LiteralPath $Backup -Destination $Dest']) assert.match(ps, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});
