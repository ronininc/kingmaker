/**
 * freemocap tests — the external-only posture, enforced structurally.
 * Includes a self-scan: this component's own sources must contain no
 * import of the upstream project, in any form.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  FREEMOCAP_DESCRIPTOR,
  validateExternalDescriptor,
  guardSpecifier,
} from '../lib/freemocap-external.mjs';

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}`); }
}

const descriptor = JSON.parse(readFileSync(new URL('../descriptor.json', import.meta.url), 'utf8'));

// 1. The frozen descriptor and the JSON record agree on the posture.
check('descriptor is external-only + AGPL + Solomon-excluded',
  FREEMOCAP_DESCRIPTOR.external === true && FREEMOCAP_DESCRIPTOR.distribution === 'external-only' &&
  FREEMOCAP_DESCRIPTOR.license === 'AGPL-3.0' && FREEMOCAP_DESCRIPTOR.solomon === 'excluded');
check('JSON record matches the module descriptor', descriptor.external === true && descriptor.licensePosture.class === 'agpl-external' && descriptor.licensePosture.solomon.startsWith('EXCLUDED'));
check('descriptor validates clean', validateExternalDescriptor(FREEMOCAP_DESCRIPTOR).ok === true);

// 2. Every drift toward linkage or shipment is refused.
check('external:false refused', validateExternalDescriptor({ ...FREEMOCAP_DESCRIPTOR, external: false }).ok === false);
check("distribution 'shipped' refused", validateExternalDescriptor({ ...FREEMOCAP_DESCRIPTOR, distribution: 'shipped' }).ok === false);
check("solomon 'included' refused", validateExternalDescriptor({ ...FREEMOCAP_DESCRIPTOR, solomon: 'included' }).ok === false);
check('a linkage field refused', validateExternalDescriptor({ ...FREEMOCAP_DESCRIPTOR, pipPackage: 'freemocap' }).ok === false);
check('license drift refused', validateExternalDescriptor({ ...FREEMOCAP_DESCRIPTOR, license: 'MIT' }).ok === false);

// 3. The specifier tripwire.
check('guard passes ordinary specifiers', guardSpecifier('./other-module.mjs') === true && guardSpecifier('node:crypto') === true);
let threw = false;
try { guardSpecifier('freemocap'); } catch { threw = true; }
check('guard throws on a freemocap specifier', threw);
threw = false;
try { guardSpecifier('../vendor/freemocap/index.js'); } catch { threw = true; }
check('guard throws on a freemocap path', threw);

// 4. Self-scan: no source file in this component imports the upstream
//    project, and the only imports anywhere are the shared stack lib or
//    node builtins. (This test file itself is scanned too — it refers
//    to the project by the RELATIVE component path only, and mentions
//    the name in prose, which the import-focused scan ignores.)
const componentRoot = new URL('..', import.meta.url).pathname;
function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else if (entry.name.endsWith('.mjs')) yield p;
  }
}
let scanned = 0;
let importViolations = [];
for (const file of walk(componentRoot)) {
  scanned++;
  const src = readFileSync(file, 'utf8');
  for (const m of src.matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g)) {
    const spec = m[1];
    const allowed = spec.startsWith('.') || spec.startsWith('node:');
    if (!allowed) importViolations.push(`${file}: ${spec}`);
    if (/freemocap/i.test(spec) && !spec.startsWith('.')) importViolations.push(`${file}: upstream import ${spec}`);
  }
}
check('self-scan covered the component sources', scanned >= 2);
check('no bare/upstream imports in the component', importViolations.length === 0);

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail === 0 ? 0 : 1);
