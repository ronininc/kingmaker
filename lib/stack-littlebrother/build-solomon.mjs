/**
 * build-solomon.mjs
 *
 * Produces the Solomon bundle: LittleBrother with the public-source
 * boundary ONLY. The cut is physical, per the boundary spec:
 *
 *   - the full-only module is NOT copied into the bundle;
 *   - the block in lib/littlebrother.mjs that loads it (delimited by
 *     __LB_FULL_BEGIN__ / __LB_FULL_END__) is stripped from the copy, so
 *     the bundle's core contains no reference to it at all;
 *   - after building, every file in the bundle is scanned for forbidden
 *     references and the build FAILS if any survive.
 *
 * A method that doesn't exist can't be invoked. This build is how that
 * sentence stays true.
 *
 * Usage: node build-solomon.mjs [outDir]   (default ./bundle-solomon)
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const LIB = join(ROOT, 'lib');
const outDir = process.argv[2]
  ? (isAbsolute(process.argv[2]) ? process.argv[2] : resolve(process.argv[2]))
  : join(ROOT, 'bundle-solomon');
const outLib = join(outDir, 'lib');

const BEGIN = '__LB_FULL_BEGIN__';
const END = '__LB_FULL_END__';

// Files that ship in the Solomon bundle. The full-only module is
// deliberately absent from this list — that absence is the point.
const SHIP_FILES = ['audit-log.mjs', 'methods-public.mjs', 'littlebrother.mjs'];

// Strings that must not appear anywhere in the bundle (case-insensitive).
const FORBIDDEN = [
  'methods-full',
  'phonelookup',
  'personlookup',
  'breachquery',
  'createfullmethods',
  '__lb_full',
];

function stripFullBlock(source, filename) {
  const lines = source.split('\n');
  const begin = lines.findIndex((l) => l.includes(BEGIN));
  const end = lines.findIndex((l) => l.includes(END));
  if (begin === -1 || end === -1 || end < begin) {
    throw new Error(`build-solomon: strip markers not found in ${filename} — refusing to ship an unstripped core`);
  }
  lines.splice(begin, end - begin + 1);
  return lines.join('\n');
}

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else yield p;
  }
}

mkdirSync(outLib, { recursive: true });

for (const file of SHIP_FILES) {
  let source = readFileSync(join(LIB, file), 'utf8');
  if (file === 'littlebrother.mjs') {
    source = stripFullBlock(source, file);
  }
  writeFileSync(join(outLib, file), source, 'utf8');
}

writeFileSync(
  join(outDir, 'README.md'),
  [
    '# LittleBrother — Solomon build',
    '',
    'Public-source boundary ONLY. The full-only method set is not present',
    'in this bundle: its module was not copied and the loading code was',
    'stripped at build time. See ../boundary-spec.md for the boundary law.',
    '',
  ].join('\n'),
  'utf8'
);

// Verify: no forbidden reference survives anywhere in the bundle.
const violations = [];
for (const file of walk(outDir)) {
  const text = readFileSync(file, 'utf8').toLowerCase();
  for (const needle of FORBIDDEN) {
    if (text.includes(needle)) {
      violations.push(`${file}: contains '${needle}'`);
    }
  }
}
if (violations.length > 0) {
  console.error('build-solomon: FORBIDDEN references survived the cut:');
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}

console.log(`build-solomon: bundle written to ${outDir}`);
console.log(`build-solomon: shipped lib files: ${SHIP_FILES.join(', ')}`);
console.log('build-solomon: boundary scan clean — no full-only references present');
