// Every place that says which macOS Kingmaker needs says the same thing (it said 13 while Ollama needed 14: a Mac on 13
// would install, then fail). One number, MIN_MACOS; Hands of Horus alone needs 15, and is left out below it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MIN_MACOS } from '../lib/release-manifest.mjs';
import { BREW_TOOLS } from '../scripts/release-parts.mjs';

const src = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const major = MIN_MACOS.split('.')[0];

test('every declared macOS minimum is the same one', () => {
  assert.equal(MIN_MACOS, '14.0', 'Ollama dropped macOS 13 (0.12.4); the voice server needs 14');
  for (const plist of ['app/Info.plist', 'installer/Info.plist'])
    assert.match(src(plist), new RegExp(`<key>LSMinimumSystemVersion</key><string>${MIN_MACOS.replace('.', '\\.')}</string>`), plist);
  assert.match(src('scripts/build-installer.sh'), new RegExp(`-target arm64-apple-macos${MIN_MACOS.replace('.', '\\.')}\\b`), 'the installer app is built for it');
  const engine = src('installer/engine.sh');
  assert.match(engine, new RegExp(`\\[ "\\$\\{MACOS%%\\.\\*\\}" -ge ${major} \\]`), 'the installer\'s preflight refuses below it');
  assert.match(engine, new RegExp(`needs macOS ${major} \\(Sonoma\\) or newer`), 'and says so in plain words');
  assert.match(src('README.md'), new RegExp(`macOS ${major} or newer`));
  assert.match(src('docs/SYSTEM-REQUIREMENTS.md'), new RegExp(`\\| Kingmaker\\.app, Kingmaker Installer \\| ${MIN_MACOS.replace('.', '\\.')} \\|`));
  assert.doesNotMatch(engine + src('app/Info.plist') + src('installer/Info.plist') + src('scripts/build-installer.sh'), /macos13|<string>13\.0<\/string>|-ge 13\b/, 'no 13 left behind');
});

test('Hands of Horus needs macOS 15: it is the only tool with its own floor, and the installer leaves it out below', () => {
  assert.deepEqual(BREW_TOOLS.filter((t) => t.minMacos).map((t) => [t.formula, t.minMacos]), [['openclaw/tap/peekaboo', '15.0']]);
  assert.match(src('installer/engine.sh'), /minm="\$\(mf "brew\.\$i\.minMacos"\)"/);
});
