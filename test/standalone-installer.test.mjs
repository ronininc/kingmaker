import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { main as releaseParts } from '../scripts/release-parts.mjs';
import { signManifestBytes } from '../lib/release-signing.mjs';
import { fakeTools, makeFixtureApp } from './fixtures/installer-fixtures.mjs';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
test('standalone Kingmaker installs from signed local payload with no Launcher bytes or account', {skip: process.platform !== 'darwin', timeout: 60_000}, async (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'km-standalone-local-')));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const resources = join(dir,'resources'), payload = join(dir,'payload'), home = join(dir,'home');
  for (const d of [resources,payload,home]) mkdirSync(d);
  const env = {HOME:home, PATH: process.env.PATH, KINGMAKER_PATH:fakeTools(join(dir,'bin'), {
    'xcode-select':'echo /Library/Developer/CommandLineTools', brew:'exit 0', ollama:'exit 0',
    peekaboo:'exit 0', sox:'exit 0', 'python3.12':'exit 0'
  }), KINGMAKER_OLLAMA_URL:'http://127.0.0.1:9/none'};
  const app = makeFixtureApp(join(dir,'build'), {padBytes: 4096});
  const name = 'Kingmaker-0.2.0.tar.gz.part01', file = join(payload,name);
  execFileSync('/usr/bin/tar', ['-czf', file, '-C', dirname(app), 'Kingmaker.app']);
  const bytes = readFileSync(file);
  const launcher = {archive:'Ronin-Launcher-0.1.0-arm64.zip', size:23, sha256:'a'.repeat(64), required:true};
  assert.equal(existsSync(join(payload,launcher.archive)), false, 'no optional Launcher asset is available');
  const manifestObj = {
    schema:'kingmaker.release/1', tag:'v0.2.0', version:'0.2.0', repo:'ronininc/kingmaker',
    app:{bundleId:'com.ronininc.solghost', format:'tar+gzip', size:bytes.length, sha256:sha(bytes)},
    parts:[{name,size:bytes.length,sha256:sha(bytes)}], launcher,
    searxng:{script:'Contents/Resources/kingmaker-runtime/scripts/solomon-searxng-native-setup.mjs'},
    knowledge:{script:'Contents/Resources/kingmaker-runtime/scripts/solomon-bootstrap-corpus.mjs', totalMB:3, corpora:[]}
  };
  const {publicKey,privateKey} = generateKeyPairSync('rsa',{modulusLength:2048});
  // Ephemeral fixture key lives only in a temporary resource bundle. The unmodified
  // engine still runs its real detached-signature, content hash and codesign gates.
  cpSync(new URL('../installer/engine.sh', import.meta.url), join(resources,'engine.sh'));
  writeFileSync(join(resources,'kingmaker-release-public.pem'), publicKey.export({format:'pem',type:'spki'}));
  const manifestFile = join(resources,'kingmaker-manifest.json');
  const sigFile = join(resources,'kingmaker-manifest.json.sig');
  const setManifest = (obj) => {
    const manifest = Buffer.from(JSON.stringify(obj));
    writeFileSync(manifestFile,manifest);
    writeFileSync(sigFile,signManifestBytes(manifest,privateKey));
  };
  setManifest(manifestObj);
  const run = (prefix, flags = ['--without-launcher']) => execFileSync('/bin/bash', [
    join(resources,'engine.sh'),'--wake-word','Kingmaker','--prefix',prefix,'--source',payload,...flags
  ],{env, encoding:'utf8',stdio:['ignore','pipe','pipe']});
  const prefix = join(dir,'first');
  const log = run(prefix);
  assert.match(log,/Release signature verified/);
  assert.match(log,/Installing Kingmaker undocked/);
  assert.match(log,/"launched":false/);
  assert.ok(existsSync(join(prefix,'Applications','Kingmaker.app')));
  assert.equal(existsSync(join(prefix,'Applications','Ronin Launcher.app')),false);
  const earlier = join(dir,'launcher-first');
  const existing = join(earlier,'Applications','Ronin Launcher.app','Contents');
  mkdirSync(existing,{recursive:true});
  writeFileSync(join(existing,'marker'),'previous independent Launcher');
  run(earlier);
  assert.ok(existsSync(join(earlier,'Applications','Kingmaker.app')));
  assert.equal(readFileSync(join(existing,'marker'),'utf8'),'previous independent Launcher');
  assert.throws(() => run(join(dir,'explicit-opt-in'),[]), (error) => /The Ronin Launcher failed to download/.test(error.stdout));
  assert.equal(existsSync(join(dir,'explicit-opt-in','Applications','Kingmaker.app')),false);
  const output = [];
  const tree = 'a'.repeat(40);
  assert.equal(await releaseParts({
    argv: ['--app', app, '--out', join(dir,'release'), '--offline', '--dry-run',
      '--tree-repo', 'ronininc/kingmaker', '--tree-commit', tree, '--harness-only'],
    env: {...env, KINGMAKER_ALLOW_ADHOC: '1'},
    offlineDigests: async () => ({}),
    out: line => output.push(line),
  }), 0, output.join('\n'));
  const release = JSON.parse(output.at(-1));
  assert.equal(release.distribution, 'harness-only');
  assert.deepEqual(release.issuance, {tree:{repo:'ronininc/kingmaker',commit:tree,version:'0.2.0'},installer:{repo:'ronininc/kingmaker',commit:tree,version:'0.2.0'}});
  assert.equal('launcher' in release, false);
  assert.equal(existsSync(join(dir,'release')), false);
  // The signed fixture uses its original archive bytes and digest, not the dry-run stream.
  const standalone = {...manifestObj, distribution: release.distribution, issuance: release.issuance};
  delete standalone.launcher;
  setManifest(standalone);
  const withoutOptInFlag = join(dir,'signed-harness-only');
  const standaloneLog = run(withoutOptInFlag,[]);
  assert.match(standaloneLog,/Release signature verified/);
  assert.match(standaloneLog,/Installing Kingmaker undocked/);
  assert.ok(existsSync(join(withoutOptInFlag,'Applications','Kingmaker.app')));
  assert.equal(existsSync(join(withoutOptInFlag,'Applications','Ronin Launcher.app')),false);
  setManifest({...standalone, launcher});
  assert.throws(() => run(join(dir,'contradictory'),[]), (error) => /A harness-only release cannot carry a Ronin Launcher/.test(error.stdout));
  assert.equal(existsSync(join(dir,'contradictory','Applications','Kingmaker.app')),false);
  setManifest(standalone);
  writeFileSync(manifestFile,JSON.stringify({...standalone, distribution: 'tampered'}));
  assert.throws(() => run(join(dir,'tampered')), (error) => /signature/i.test(error.stdout));
  assert.equal(existsSync(join(dir,'tampered','Applications','Kingmaker.app')),false);
  setManifest(standalone);
  rmSync(sigFile);
  assert.throws(() => run(join(dir,'unsigned')), (error) => /This release is not signed/.test(error.stdout));
  assert.equal(existsSync(join(dir,'unsigned','Applications','Kingmaker.app')),false);
});
