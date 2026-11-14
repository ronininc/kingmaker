/**
 * anatomy tests — pure gate checks. No Chrome, no rendering, no network.
 */

import { readFileSync } from 'node:fs';
import {
  ANATOMY_PIN,
  scanFigureHtml,
  validateFigureJob,
} from '../lib/anatomy-gate.mjs';

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}`); }
}

const descriptor = JSON.parse(readFileSync(new URL('../descriptor.json', import.meta.url), 'utf8'));
const DIR = '/work/figures';
const cleanFigure = '<!doctype html><svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';
const dirtyFigure = '<!doctype html><img src="https://evil.example/track.png"><svg></svg>';
const fetchFigure = '<!doctype html><script>fetch("http://127.0.0.1:9999/x")</script>';

// 1. Pin + descriptor agreement.
check('pin records the audited commit', ANATOMY_PIN.auditedCommit === descriptor.pin.auditedCommit && ANATOMY_PIN.license === 'MIT');

// 2. N1 — target confinement.
const t1 = validateFigureJob({ target: `${DIR}/lock.html`, figuresDir: DIR, html: cleanFigure });
check('local figure inside the figures dir passes', t1.ok === true && t1.target === `${DIR}/lock.html`);
const t2 = validateFigureJob({ target: 'https://example.com/figure.html', figuresDir: DIR });
check('remote http target refuses (N1)', t2.ok === false && /local figures only/.test(t2.reason));
const t3 = validateFigureJob({ target: '/home/robbie/.ssh/keys.html', figuresDir: DIR });
check('file target outside the figures dir refuses (N1)', t3.ok === false && /outside the declared figures directory/.test(t3.reason));
const t4 = validateFigureJob({ target: `file://${DIR}/gauge.html`, figuresDir: DIR, html: cleanFigure });
check('file:// target inside the dir passes', t4.ok === true);

// 3. N1 — self-containment scan.
check('clean figure passes the scan', scanFigureHtml(cleanFigure).ok === true);
check('external img refuses the scan', scanFigureHtml(dirtyFigure).ok === false && /not self-contained/.test(scanFigureHtml(dirtyFigure).reason));
check('fetch() refuses the scan', scanFigureHtml(fetchFigure).ok === false);
const t5 = validateFigureJob({ target: `${DIR}/x.html`, figuresDir: DIR, html: dirtyFigure });
check('job with external-referencing figure refuses', t5.ok === false && /self-contained/.test(t5.reason));

// 4. N2 — publish never runs.
const p1 = validateFigureJob({ action: 'publish', target: `${DIR}/lock.html`, figuresDir: DIR });
check('publish action refuses (N2)', p1.ok === false && /force-pushes/.test(p1.reason));
const p2 = validateFigureJob({ action: 'submit-to-gallery', target: `${DIR}/lock.html`, figuresDir: DIR });
check('gallery submit refuses (N2)', p2.ok === false && /N2/.test(p2.reason));

// 5. Ordinary render/print actions pass with a clean local figure.
check('print action passes', validateFigureJob({ action: 'print', target: `${DIR}/a.html`, figuresDir: DIR, html: cleanFigure }).ok === true);

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail === 0 ? 0 : 1);
