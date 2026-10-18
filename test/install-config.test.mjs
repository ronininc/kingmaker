// The wake word: chosen on the install screen, cemented at install (read-only install.json), mishearings generated
// from the word itself; a legacy install (no install.json) keeps "ghost" as well as the default "Kingmaker".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_WAKE_WORD, foldSpelling, installConfigJson, matchWakeWord, namesWakeWord, readInstallConfig, validateWakeWord, wakeWordForms } from '../lib/install-config.mjs';
import { createWakeState, DEFAULT_WAKE_PHRASES, isMuteCommand, isOffCommand, LEGACY_WAKE_PHRASES, wakeSetup } from '../lib/voice.mjs';
import { wakeWordLine } from '../lib/cli.mjs';

const stateWith = (config) => {
  const dir = mkdtempSync(join(tmpdir(), 'km-install-'));
  if (config !== undefined) writeFileSync(join(dir, 'install.json'), typeof config === 'string' ? config : JSON.stringify(config), { mode: 0o444 });
  return dir;
};
const stateFor = (setup) => createWakeState({ wakePhrases: setup.phrases, wakeWord: setup.word, names: setup.names, sleepPhrases: setup.sleepPhrases, idleMs: 1000 });

test('the wake word rule: 1 to 3 words of letters, not a command word', () => {
  for (const ok of ['Kingmaker', 'Jarvis', 'hey there buddy', 'Nova', '  Sol   Ghost ']) assert.equal(validateWakeWord(ok).ok, true, ok);
  assert.equal(validateWakeWord('  Sol   Ghost ').word, 'Sol Ghost', 'whitespace collapsed, casing kept');
  for (const bad of ['', '   ', 'a b c d', 'R2D2', 'José', 'hey-you', 'X', 'yes', 'Cancel', 'go ahead', 'a'.repeat(21), 'abcdefghij abcdefghij abcdefghijk'])
    assert.equal(validateWakeWord(bad).ok, false, `refused: ${JSON.stringify(bad)} (${validateWakeWord(bad).reason})`);
  assert.equal(DEFAULT_WAKE_WORD, 'Kingmaker');
});

test('cemented: install.json is read back exactly; a missing or broken one is a legacy install', () => {
  const json = installConfigJson({ wakeWord: 'Jarvis', release: 'v0.2.0', cementedAt: '2026-10-08T00:00:00.000Z' });
  const dir = stateWith(json);
  assert.deepEqual(readInstallConfig(dir), { cemented: true, wakeWord: 'Jarvis', release: 'v0.2.0', cementedAt: '2026-10-08T00:00:00.000Z' });
  assert.equal(statSync(join(dir, 'install.json')).mode & 0o777, 0o444, 'read-only after install');
  assert.match(JSON.parse(readFileSync(join(dir, 'install.json'), 'utf8')).note, /delete Kingmaker and install it again/);
  assert.deepEqual(readInstallConfig(stateWith()), { cemented: false, reason: 'missing' });
  assert.equal(readInstallConfig(stateWith('{not json')).reason, 'invalid');
  assert.equal(readInstallConfig(stateWith({ schema: 'kingmaker.install/1', wakeWord: 'R2D2' })).reason, 'invalid');
  assert.equal(readInstallConfig(stateWith({ schema: 'other/1', wakeWord: 'Jarvis' })).reason, 'invalid');
  assert.throws(() => installConfigJson({ wakeWord: 'yes' }), /command word/);
});

test('mishearings are generated from the word: spacing, plurals, one slip after folding; short names stay exact', () => {
  const forms = wakeWordForms('Kingmaker');
  assert.deepEqual(forms.variants.sort(), ['king maker', 'king-maker', 'kingmaker']);
  assert.ok(forms.phrases.includes('hey king maker') && forms.phrases.includes('kingmaker wake up'));
  for (const heard of ['kingmaker', 'king maker', 'King-Maker', 'kingmakers', "kingmaker's", 'kingmacker', 'kin maker', 'kingmaka', 'cingmaker'])
    assert.equal(namesWakeWord(heard, 'Kingmaker'), true, heard);
  for (const heard of ['making her', 'king', 'kingdom', 'pacemaker', 'king of the hill']) assert.equal(namesWakeWord(heard, 'Kingmaker'), false, heard);
  assert.equal(namesWakeWord('al', 'Al'), true);
  assert.equal(namesWakeWord('all', 'Al'), false, 'a short name never matches loosely');
  assert.equal(foldSpelling('Phoenix'), foldSpelling('fenix').replace('e', 'oe'), 'ph folds to f');
  assert.deepEqual(matchWakeWord('Hey king maker, open Notes.', 'Kingmaker'), { addressed: true, command: 'open Notes.' });
  assert.deepEqual(matchWakeWord('Wake up Kingmaker', 'Kingmaker'), { addressed: true, command: '' });
  assert.deepEqual(matchWakeWord('Kingmaker wake up', 'Kingmaker'), { addressed: true, command: '' });
  assert.equal(matchWakeWord('the kingmaker said', 'Kingmaker').addressed, false, 'the name must lead');
});

test('a cemented word wakes it, and "ghost" no longer does', () => {
  const install = readInstallConfig(stateWith(installConfigJson({ wakeWord: 'Jarvis' })));
  const setup = wakeSetup({ install, env: { SOL_GHOST_WAKE_PHRASES: 'hey ghost' }, spotter: ['hey atlas'] });
  assert.equal(setup.cemented, true);
  assert.equal(setup.word, 'Jarvis');
  assert.deepEqual(setup.ignored, ['SOL_GHOST_WAKE_PHRASES'], 'the environment cannot change a cemented word');
  assert.ok(!setup.phrases.some((p) => /ghost|atlas/.test(p)), 'no Ghost forms, no desktop spotter word');
  assert.deepEqual(stateFor(setup).handle('Jarvis, open Notes', 0), { action: 'command', text: 'open Notes', woke: true });
  assert.deepEqual(stateFor(setup).handle('Hey Jarvis', 0), { action: 'wake', text: '' });
  for (const old of ['Hey ghost, open Notes', 'Ghost wake up', 'Sol Ghost, open Notes', 'Kingmaker, open Notes', 'Hey Atlas open Notes'])
    assert.equal(stateFor(setup).handle(old, 0).action, 'ignore', `${old}: not its name any more`);
  const awake = stateFor(setup);
  awake.wakeNow(0);
  assert.equal(awake.handle('go to sleep, Jarvis', 10).action, 'sleep', 'its own name may trail a mute');
  assert.equal(stateFor(setup).handle('Jarvis, shut down', 0).action, 'off');
  assert.equal(isOffCommand('turn jarvis off', setup.names), true);
  assert.equal(isMuteCommand('that is all ghost', setup.names), false);
  assert.match(wakeWordLine(install, setup), /"Jarvis" \(cemented at install.*delete Kingmaker and install it again.*SOL_GHOST_WAKE_PHRASES is ignored/);
});

test('the default cemented word is Kingmaker, heard as "king maker" too', () => {
  const install = readInstallConfig(stateWith(installConfigJson({ wakeWord: 'Kingmaker' })));
  const setup = wakeSetup({ install, env: {} });
  assert.deepEqual(stateFor(setup).handle('King maker, open my Chrome.', 0), { action: 'command', text: 'open my Chrome.', woke: true });
  assert.deepEqual(stateFor(setup).handle('Hey king-maker open notes', 0), { action: 'command', text: 'open notes', woke: true }, 'one token, two words');
  assert.equal(stateFor(setup).handle('hey ghost open notes', 0).action, 'ignore');
});

test('legacy install (no install.json): the default Kingmaker AND the old ghost names wake it', () => {
  const install = readInstallConfig(stateWith());
  const setup = wakeSetup({ install, env: {}, spotter: ['hey atlas'] });
  assert.equal(setup.cemented, false);
  assert.equal(setup.word, 'Kingmaker');
  assert.ok(LEGACY_WAKE_PHRASES.every((p) => DEFAULT_WAKE_PHRASES.includes(p)) && DEFAULT_WAKE_PHRASES[0].includes('king'), 'Kingmaker forms first, then the Ghost forms');
  for (const said of ['Hey ghost, open Notes', 'Kingmaker, open Notes', 'king maker open Notes', 'Sol Ghost, open Notes', 'Hey Atlas, open Notes'])
    assert.equal(stateFor(setup).handle(said, 0).action, 'command', said);
  assert.match(wakeWordLine(install, setup), /"Kingmaker" \(the default; no word was cemented at install, so "ghost" and "Sol Ghost" still wake it too\)/);
  const broken = readInstallConfig(stateWith('{'));
  assert.match(wakeWordLine(broken, wakeSetup({ install: broken, env: {} })), /could not be read/);
  // With no options the wake state is a legacy install's (what every older test and caller gets).
  assert.equal(createWakeState({ idleMs: 1000 }).handle('Hey ghost open Notes', 0).action, 'command');
});

test('the installer can write it once, read-only, and nothing in Kingmaker rewrites it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'km-cement-'));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'install.json');
  writeFileSync(file, installConfigJson({ wakeWord: 'Kingmaker' }), { mode: 0o444 });
  chmodSync(file, 0o444);
  assert.throws(() => writeFileSync(file, '{}'), /EACCES|EPERM/, 'a stray write fails: the file is read-only');
  const lib = ['cli.mjs', 'voice.mjs', 'install-config.mjs', 'session.mjs', 'runtime.mjs'].map((f) => readFileSync(new URL(`../lib/${f}`, import.meta.url), 'utf8')).join('\n');
  assert.doesNotMatch(lib, /writeFileSync\([^)]*INSTALL_CONFIG_FILE|writeFileSync\([^)]*install\.json/, 'no code path in Kingmaker writes install.json');
});
