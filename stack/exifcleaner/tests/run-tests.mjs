/**
 * exifcleaner tests — the external line, enforced. No app is run,
 * nothing is imported from upstream; the suite also self-scans this
 * component to prove no upstream import exists.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  EXIFCLEANER_PIN,
  EXIFCLEANER_DESCRIPTOR,
  validateExternalDescriptor,
  guardSpecifier,
  validatePinRecord,
} from '../lib/exifcleaner-external.mjs';

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}`); }
}
function throws(fn) { try { fn(); return false; } catch { return true; } }

const descriptor = JSON.parse(readFileSync(new URL('../descriptor.json', import.meta.url), 'utf8'));

// 1. The descriptor on disk IS a valid external registration.
check('on-disk descriptor validates as external', validateExternalDescriptor(descriptor).ok === true);
check('module descriptor constant validates', validateExternalDescriptor(EXIFCLEANER_DESCRIPTOR).ok === true);
check('descriptor and module agree on posture', descriptor.external === true && EXIFCLEANER_DESCRIPTOR.external === true && descriptor.id === 'exifcleaner');

// 2. Drift toward linkage refuses.
check('non-external record refuses', validateExternalDescriptor({ ...EXIFCLEANER_DESCRIPTOR, external: false }).ok === false);
check('linkage field refuses', validateExternalDescriptor({ ...EXIFCLEANER_DESCRIPTOR, npmPackage: 'exifcleaner' }).ok === false);
check('shippable distribution refuses', validateExternalDescriptor({ ...EXIFCLEANER_DESCRIPTOR, distribution: 'bundled' }).ok === false);

// 3. The tripwire.
check('guardSpecifier throws on an exifcleaner specifier', throws(() => guardSpecifier('exifcleaner')));
check('guardSpecifier throws on a path into the app', throws(() => guardSpecifier('/opt/ExifCleaner/resources/app.asar')));
check('guardSpecifier passes unrelated specifiers', guardSpecifier('./lib/governance.mjs') === true);

// 4. Pin posture: release hash starts empty (unsigned upstream —
//    intake records it out-of-band), and the record is well-formed.
check('pin ships unpinned on purpose', EXIFCLEANER_PIN.expectedReleaseSha256 === null && EXIFCLEANER_PIN.status === 'UNPINNED');
check('pin record validates as well-formed-but-unpinned', (() => { const v = validatePinRecord(); return v.ok && v.pinned === false; })());
check('descriptor pin agrees with module pin', descriptor.pin.commit === EXIFCLEANER_PIN.commit && descriptor.pin.release === EXIFCLEANER_PIN.release);

// 5. Self-scan: no file in this component imports upstream code.
const compRoot = new URL('..', import.meta.url).pathname;
let scanned = 0;
for (const dir of ['lib', 'tests']) {
  for (const f of readdirSync(join(compRoot, dir))) {
    if (!f.endsWith('.mjs')) continue;
    scanned++;
    const src = readFileSync(join(compRoot, dir, f), 'utf8');
    const imports = [...src.matchAll(/(?:from\s+|import\s*\(\s*)['"]([^'"]+)['"]/g)].map((m) => m[1]);
    check(`self-scan: ${dir}/${f} imports no upstream code`, imports.every((s) => s.startsWith('.') || s.startsWith('node:')));
  }
}

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail === 0 ? 0 : 1);
