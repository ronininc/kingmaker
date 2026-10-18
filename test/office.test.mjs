// Kingmaker's office stack (lib/office.mjs): real Word, Excel, PowerPoint and PDF files from a model's JSON spec, on the
// bundled MIT libraries only, into the owner's folder, never over an existing file.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fillPdfForm, freshPath, officeLibs, pageList, parseOfficeSpec, renderOffice, safeName, splitPdf, stampPdf } from '../lib/office.mjs';

const isZip = (buf) => buf[0] === 0x50 && buf[1] === 0x4b;
const has = (buf, s) => buf.includes(Buffer.from(s));

test('a spec is found in the model\'s reply and checked', () => {
  const s = parseOfficeSpec('<think>plan</think>\nHere:\n```json\n{"kind":"docx","title":"Menu","sections":[{"heading":"Tacos","bullets":["Al pastor $3"]}]}\n```');
  assert.equal(s.kind, 'docx');
  assert.equal(parseOfficeSpec('{"kind":"exe","title":"x"}'), null, 'only the four kinds');
  assert.equal(parseOfficeSpec('{"kind":"xlsx","title":"x","sheets":[]}'), null, 'an empty one is not a file');
  assert.equal(parseOfficeSpec('no json'), null);
});

test('file names are safe, stay in the folder, and never overwrite', () => {
  assert.equal(safeName('../../etc/passwd', 'docx'), 'etc passwd.docx');
  assert.equal(safeName('Menú de Lupita', 'pdf'), 'Menu de Lupita.pdf');
  assert.equal(safeName('', 'xlsx'), 'Kingmaker.xlsx');
  const d = mkdtempSync(join(tmpdir(), 'office-'));
  try {
    const a = freshPath(d, 'Menu.docx'); writeFileSync(a, 'x');
    assert.equal(freshPath(d, 'Menu.docx'), join(d, 'Menu 2.docx'));
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('Word, Excel, PowerPoint and PDF files are written and are what they say', async () => {
  const d = mkdtempSync(join(tmpdir(), 'office-'));
  try {
    const doc = await renderOffice({ kind: 'docx', title: 'Proposal for Hector Tacos', subtitle: 'Website and online ordering',
      sections: [{ heading: 'What you get', paragraphs: ['A fast site with your menu.'], bullets: ['Online ordering', 'Spanish and English'], numbered: ['Call', 'Build'],
        table: { header: ['Item', 'Price'], rows: [['Site', '$500'], ['Ordering', '$200']] } }] }, { dir: d });
    const db = readFileSync(doc.path);
    assert.ok(doc.ok && isZip(db) && has(db, 'word/document.xml'), 'a .docx (a zip with word/document.xml)');

    const xl = await renderOffice({ kind: 'xlsx', title: 'Price list', sheets: [{ name: 'Menu', header: ['Item', 'Price', 'Qty'], rows: [['Taco', 3.5, '2', '=B2*C2'], ['Burrito', 9, 1, '=B3*C3'], ['Bad', 0, 0, '=WEBSERVICE("http://x")']], money: [1], total: true }] }, { dir: d });
    const { ExcelJS } = await officeLibs(); const wb = new ExcelJS.Workbook(); await wb.xlsx.load(readFileSync(xl.path));
    const ws = wb.getWorksheet('Menu');
    assert.equal(ws.getCell('B2').value, 3.5); assert.equal(ws.getCell('C2').value, 2, 'a number typed as text is a number');
    assert.equal(ws.getCell('D2').value.formula, 'B2*C2', 'a cell worked out from others is a formula');
    assert.equal(ws.getCell('D4').value, '=WEBSERVICE("http://x")', 'a formula that reaches outside the sheet stays text');
    assert.equal(ws.getCell('B5').value.formula, 'SUM(B2:B4)'); assert.equal(ws.getColumn(2).numFmt, '"$"#,##0.00');

    const pp = await renderOffice({ kind: 'pptx', title: 'Kingmaker', subtitle: 'Your AI, on your Mac', slides: [{ title: 'Private', bullets: ['Runs on your Mac'], notes: 'Say it slowly' }, { title: 'Free', bullets: ['No AI fees'] }] }, { dir: d });
    const pb = readFileSync(pp.path);
    assert.ok(isZip(pb) && has(pb, 'ppt/slides/slide3.xml'), 'a cover plus two slides');

    const pdf = await renderOffice({ kind: 'pdf', title: 'Menú “Especial” — Lupita', sections: [{ heading: 'Tacos', paragraphs: ['word '.repeat(2000)], bullets: ['Al pastor'] }] }, { dir: d });
    const { pdfLib } = await officeLibs(); const loaded = await pdfLib.PDFDocument.load(readFileSync(pdf.path));
    assert.ok(loaded.getPageCount() >= 2, 'long text flows onto more pages; curly quotes and accents never crash it');

    const two = await renderOffice({ kind: 'pdf', title: 'Both', merge: [pdf.path, pdf.path] }, { dir: d });
    assert.equal((await pdfLib.PDFDocument.load(readFileSync(two.path))).getPageCount(), loaded.getPageCount() * 2);
    assert.deepEqual(pageList('1-2, 4, 9', 4), [0, 1, 3]);
    const firstPage = await splitPdf(two.path, '1');
    assert.equal((await pdfLib.PDFDocument.load(firstPage)).getPageCount(), 1);
    assert.ok((await stampPdf(pdf.path, 'PAID')).length > 0);
    const again = await renderOffice({ kind: 'docx', title: 'Proposal for Hector Tacos', sections: [{ paragraphs: ['v2'] }] }, { dir: d });
    assert.notEqual(again.path, doc.path, 'never over an existing file');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('a PDF form is filled by field name; names it doesn\'t have are reported, not guessed', async () => {
  const d = mkdtempSync(join(tmpdir(), 'office-'));
  try {
    const { pdfLib: { PDFDocument } } = await officeLibs();
    const doc = await PDFDocument.create(); const page = doc.addPage([300, 300]); const form = doc.getForm();
    form.createTextField('business_name').addToPage(page, { x: 20, y: 200, width: 200, height: 20 });
    form.createCheckBox('agree').addToPage(page, { x: 20, y: 150, width: 15, height: 15 });
    const f = join(d, 'form.pdf'); writeFileSync(f, await doc.save());
    const r = await fillPdfForm(f, { business_name: 'Lupita Cenaduria', agree: 'yes', ssn: '123' });
    assert.deepEqual(r.filled, ['business_name', 'agree']); assert.deepEqual(r.unknown, ['ssn']);
    const back = (await PDFDocument.load(r.buffer)).getForm();
    assert.equal(back.getTextField('business_name').getText(), 'Lupita Cenaduria'); assert.equal(back.getCheckBox('agree').isChecked(), true);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('the bundle carries its licences and nothing unlicensed', () => {
  const lic = readFileSync(new URL('../vendor/office/THIRD_PARTY_LICENSES.txt', import.meta.url), 'utf8');
  for (const p of ['docx@9.8.1', 'exceljs@4.4.0', 'pptxgenjs@4.0.1', 'pdf-lib@1.17.1', 'jszip@']) assert.ok(lic.includes(`==== ${p}`), p);
  assert.ok(!lic.includes('==== buffers@'), 'buffers (no licence) is left out');
  assert.ok(existsSync(new URL('../scripts/build-office-vendor.sh', import.meta.url)));
});

test('the office skill: the local model answers with a spec and Kingmaker makes the real file', async () => {
  const { connectorTurn } = await import('../lib/connectors.mjs');
  const { builtInSkills } = await import('../lib/core-pack.mjs');
  const office = builtInSkills(null).find((c) => c.name === 'office');
  assert.ok(office?.enabled && office.verdict === 'clean' && office.license === 'Ronin', 'the office skill ships, clean, under Ronin\'s licence');
  const d = mkdtempSync(join(tmpdir(), 'office-'));
  try {
    const seen = [];
    const fetchImpl = async (_u, init) => { seen.push(JSON.parse(init.body)); return new Response(JSON.stringify({ message: { content: '```json\n{"kind":"xlsx","title":"Price list","sheets":[{"name":"Menu","header":["Item","Price"],"rows":[["Taco",3.5]],"money":[1]}]}\n```\nA price list.' } }), { status: 200 }); };
    const r = await connectorTurn(office, 'make me a price list for tacos', { fetchImpl, officeOpts: { dir: d } });
    assert.match(r.text, /^Made Price list\.xlsx in /); assert.ok(existsSync(r.file));
    assert.match(seen[0].messages[0].content, /kingmaker-renderer: office/, 'the skill itself is the instructions');
    const bad = await connectorTurn(office, 'x', { fetchImpl: async () => new Response(JSON.stringify({ message: { content: 'Sorry, I need more details.' } }), { status: 200 }), officeOpts: { dir: d } });
    assert.match(bad.text, /couldn't put that into a file/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
