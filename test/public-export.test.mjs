import { test } from 'node:test';
import assert from 'node:assert/strict';
import { danglingImports, excluded, exportFiles, leakHits, publicPackageJson } from '../scripts/public-export.mjs';

const read = (files) => (p) => Buffer.from(files[p] ?? '');

test('the public export leaves out Solomon\'s source and the operator\'s own material', () => {
  for (const p of ['solomon/server/src/index.ts', 'addons/ronin/index.mjs', 'solomon-strip.json', 'scripts/import-solomon.mjs', 'docs/OPERATOR.md', 'scripts/public-export.mjs']) assert.ok(excluded(p), p);
  for (const p of ['lib/cli.mjs', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'core/skills/trading-agents/SKILL.md']) assert.ok(!excluded(p), p);
  const files = exportFiles();
  assert.ok(files.includes('LICENSE') && files.includes('lib/cli.mjs'));
  assert.ok(!files.some((f) => f.startsWith('solomon/') || f.startsWith('addons/') || f.includes('.wrangler/')), 'no TSS source, no paid add-on, no Wrangler cache');
});

test('the leak gate catches personal data, clients, private-repo wording and secrets, and honours its allow list', () => {
  const files = {
    'a.md': 'mail robbiebrown2026@gmail.com\nsee /Users/yordanrivera/Projects\nThe repo is private for now.',
    'b.mjs': `const k = 'ghp_${'A'.repeat(36)}'; // Valley Titans`,
    'c.md': 'Sol Ghost is the old name.',
    'lib/keychain-seal.mjs': "export const SEAL_SERVICE = 'Sol Ghost Owner Voice';",
    'd.md': 'paths like /Users/o/x and /Users/owner/y are placeholders; AKIAIOSFODNN7EXAMPLE is AWS\'s own example',
    'e.mjs': "const url = 'https://www.ronininc.org/api/dnc/snapshot'; // the Orosolu CRM, Mia's desk",
  };
  const ids = leakHits(Object.keys(files), read(files)).map((h) => `${h.id}@${h.file}`);
  for (const want of ['personal-email@a.md', 'home-path@a.md', 'private-repo-line@a.md', 'secret@b.mjs', 'client-name@b.mjs', 'old-name@c.md', 'ronin-crm@e.mjs', 'orosolu@e.mjs', 'mia-persona@e.mjs']) assert.ok(ids.includes(want), want);
  assert.ok(!ids.some((i) => i.endsWith('@lib/keychain-seal.mjs') || i.endsWith('@d.md')), ids.join(', '));
});

test('a kept file that imports something left out is reported', () => {
  const src = { 'scripts/x.mjs': "import { a } from '../solomon/scripts/y.mjs';\nimport { b } from './fine.mjs';" };
  assert.deepEqual(danglingImports(Object.keys(src), (p) => src[p]), [{ file: 'scripts/x.mjs', imports: '../solomon/scripts/y.mjs' }]);
});

test('the public package.json has no script that reaches into an add-on', () => {
  const pkg = JSON.parse(publicPackageJson(JSON.stringify({ scripts: { test: 'node --test "test/*.test.mjs" "addons/*/test/*.test.mjs"', 'proof:floor': 'node --test addons/ronin/test/x.test.mjs', icons: 'swift x' } })));
  assert.deepEqual(pkg.scripts, { test: 'node --test "test/*.test.mjs"', icons: 'swift x' });
});

test('the public tree names no Solomon and no TSS, except the bundled engine\'s interface names', () => {
  const hits = (text) => leakHits(['x.mjs'], () => Buffer.from(text)).filter((h) => h.id === 'solomon-name').length;
  for (const prose of ["Solomon's vault", 'the Solomon window app', 'built by TSS', 'a solomon turn', 'tss-wiring.md']) assert.ok(hits(prose) >= 1, prose);
  for (const iface of ['SOLOMON_DATA_DIR', '~/.solomon-secure', '~/.Solomon/knowledge', 'Resources/solomon-runtime', 'Contents/MacOS/Solomon',
    "join(app, 'Contents', 'MacOS', 'Solomon')", 'solomon-bootstrap-corpus.mjs', 'x-solomon-voice-attestation', "FORK_DIR = 'solomon'", 'Solomon.app'])
    assert.equal(hits(iface), 0, iface);
  assert.equal(hits("the vault (~/.solomon-secure) is Solomon's"), 1, 'an interface name never excuses the prose around it');
});
