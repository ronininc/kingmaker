// lib/office.mjs — Kingmaker's open office stack: Word, Excel, PowerPoint and PDF files written by Kingmaker itself, on a
// stock Mac (2026-10-15: Anthropic's docx/xlsx/pptx/pdf skills are "All rights reserved" and can't ship in Kingmaker).
// The local model never writes file bytes: it answers with a small JSON spec (core/skills/office/SKILL.md), and this
// module renders it with MIT libraries bundled into vendor/office/office-libs.mjs (docx, exceljs, pptxgenjs, pdf-lib;
// scripts/build-office-vendor.sh), on Kingmaker's own Node. No Python, no Homebrew, no Office needed to make the files.
// Files go only into Kingmaker's hidden folder (Files/Documents, lib/kingmaker-home.mjs) and never overwrite one already there.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FOLDERS, kingmakerHome } from './kingmaker-home.mjs';

export const OFFICE_LIBS = fileURLToPath(new URL('../vendor/office/office-libs.mjs', import.meta.url));
export const KINDS = Object.freeze(['docx', 'xlsx', 'pptx', 'pdf']);
let libs = null;
/** The bundled libraries, loaded on first use only (about 2 MB). */
export async function officeLibs() { libs ||= await import(OFFICE_LIBS); return libs; }

const text = (v, n = 4000) => String(v ?? '').replace(/\r/g, '').slice(0, n);
const list = (v, n = 200) => (Array.isArray(v) ? v.slice(0, n) : []);

/** The folder Kingmaker writes office files into. */
export const officeDir = ({ home = homedir(), dir = null, env = process.env } = {}) => resolve(dir || join(kingmakerHome(env, home), FOLDERS.documents));

/** Pure: a safe file name for `title` with `ext` (letters, digits, spaces, - and _ only; never a path). */
export function safeName(title, ext) {
  const base = text(title, 120).normalize('NFKD').replace(/[\/\\]+/g, ' ').replace(/[^\w\s.-]+/g, '').replace(/[.\s]+/g, ' ').trim().replace(/\s/g, ' ') || 'Kingmaker';
  return `${base.slice(0, 80).trim()}.${ext}`;
}

/** A path in `dir` for `name` that doesn't exist yet ("Menu.docx", then "Menu 2.docx"…). Never outside `dir`. */
export function freshPath(dir, name) {
  mkdirSync(dir, { recursive: true });
  const ext = extname(name), stem = basename(name, ext);
  for (let i = 1; i < 1000; i += 1) {
    const p = resolve(dir, i === 1 ? `${stem}${ext}` : `${stem} ${i}${ext}`);
    if (!p.startsWith(resolve(dir) + sep)) throw new Error('a file name tried to leave the office folder');
    if (!existsSync(p)) return p;
  }
  throw new Error('too many files with that name');
}

/** Pure: the office spec in a model's reply (a ```json block or the first {...}), checked, or null. */
export function parseOfficeSpec(reply) {
  const s = String(reply || '').replace(/<think>[\s\S]*?<\/think>/g, '');
  const raw = /```(?:json)?\s*([\s\S]*?)```/.exec(s)?.[1] ?? s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1);
  let spec = null; try { spec = JSON.parse(raw); } catch { return null; }
  if (!spec || !KINDS.includes(spec.kind)) return null;
  const ok = { docx: () => list(spec.sections).length, xlsx: () => list(spec.sheets).length, pptx: () => list(spec.slides).length,
    pdf: () => list(spec.sections).length || list(spec.merge).length || spec.stamp || spec.fill || spec.split }[spec.kind]();
  return ok ? spec : null;
}

// ── Word ────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** spec: { title, subtitle?, sections: [{ heading?, paragraphs?: [..], bullets?: [..], numbered?: [..], table?: { header, rows } }] } → Buffer */
export async function docxBuffer(spec) {
  const { docx } = await officeLibs();
  const { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, AlignmentType, LevelFormat } = docx;
  const children = [new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(text(spec.title, 200) || 'Untitled')] })];
  if (spec.subtitle) children.push(new Paragraph({ children: [new TextRun({ text: text(spec.subtitle, 300), italics: true })] }));
  for (const sec of list(spec.sections)) {
    if (sec.heading) children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(text(sec.heading, 200))] }));
    for (const p of list(sec.paragraphs)) children.push(new Paragraph({ children: [new TextRun(text(p))], spacing: { after: 120 } }));
    for (const b of list(sec.bullets)) children.push(new Paragraph({ bullet: { level: 0 }, children: [new TextRun(text(b, 1000))] }));
    for (const n of list(sec.numbered)) children.push(new Paragraph({ numbering: { reference: 'km-numbers', level: 0 }, children: [new TextRun(text(n, 1000))] }));
    if (sec.table && list(sec.table.rows).length) {
      const header = list(sec.table.header, 20), rows = list(sec.table.rows, 500);
      const cell = (v, bold = false) => new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: text(v, 500), bold })] })] });
      children.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE },
        rows: [...(header.length ? [new TableRow({ tableHeader: true, children: header.map((h) => cell(h, true)) })] : []), ...rows.map((r) => new TableRow({ children: list(r, 20).map((v) => cell(v)) }))] }));
      children.push(new Paragraph(''));
    }
  }
  const doc = new Document({ creator: 'Kingmaker', title: text(spec.title, 200),
    numbering: { config: [{ reference: 'km-numbers', levels: [{ level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.START }] }] },
    sections: [{ children }] });
  return Packer.toBuffer(doc);
}

// ── Excel ───────────────────────────────────────────────────────────────────────────────────────────────────────────
/** spec: { title, sheets: [{ name, header: [..], rows: [[..]], money?: [colIndex], total?: true }] } → Buffer */
export async function xlsxBuffer(spec) {
  const { ExcelJS } = await officeLibs();
  const wb = new ExcelJS.Workbook(); wb.creator = 'Kingmaker'; wb.title = text(spec.title, 200);
  const used = new Set();
  for (const [i, sh] of list(spec.sheets, 30).entries()) {
    let name = text(sh.name, 31).replace(/[\\/?*[\]:]/g, ' ').trim() || `Sheet ${i + 1}`;
    while (used.has(name.toLowerCase())) name = `${name.slice(0, 28)} ${i + 1}`;
    used.add(name.toLowerCase());
    const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: list(sh.header).length ? 1 : 0 }] });
    const header = list(sh.header, 50), rows = list(sh.rows, 20_000), money = new Set(list(sh.money, 50).map(Number));
    if (header.length) { const r = ws.addRow(header.map((h) => text(h, 200))); r.font = { bold: true }; }
    // A cell is a number, a formula ("=B2+C2", the sheet's own references only), or text.
    const cellOf = (v) => (typeof v === 'number' || (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim())) ? Number(v)
      : typeof v === 'string' && /^=[A-Z0-9$:+\-*/()., ]{1,200}$/i.test(v.trim()) && !/\b(WEBSERVICE|HYPERLINK|CALL|REGISTER|EXEC|INDIRECT|RTD|DDE)\b/i.test(v) ? { formula: v.trim().slice(1) }
        : text(v, 2000));
    for (const row of rows) ws.addRow(list(row, 50).map(cellOf));
    const width = Math.max(header.length, ...rows.map((r) => list(r, 50).length), 1);
    for (let c = 1; c <= width; c += 1) {
      const col = ws.getColumn(c);
      col.width = Math.min(60, Math.max(10, ...[header[c - 1], ...rows.map((r) => r?.[c - 1])].map((v) => String(v ?? '').length + 2)));
      if (money.has(c - 1)) col.numFmt = '"$"#,##0.00';
    }
    if (sh.total && rows.length) {
      const first = header.length ? 2 : 1, last = first + rows.length - 1, letter = (n) => ws.getColumn(n).letter;
      const total = ws.addRow([]); total.getCell(1).value = 'Total'; total.font = { bold: true };
      for (let c = 2; c <= width; c += 1) if (rows.some((r) => typeof r?.[c - 1] === 'number' || /^(-?\d+(\.\d+)?|=.+)$/.test(String(r?.[c - 1] ?? '').trim())))
        total.getCell(c).value = { formula: `SUM(${letter(c)}${first}:${letter(c)}${last})` };
    }
  }
  if (!wb.worksheets.length) wb.addWorksheet('Sheet 1');
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ── PowerPoint ──────────────────────────────────────────────────────────────────────────────────────────────────────
/** spec: { title, subtitle?, slides: [{ title, bullets?: [..], notes? }] } → Buffer. Kingmaker's look: black, white, green. */
export async function pptxBuffer(spec) {
  const { PptxGenJS } = await officeLibs();
  const p = new PptxGenJS(); p.layout = 'LAYOUT_WIDE'; p.author = 'Kingmaker'; p.title = text(spec.title, 200);
  const cover = p.addSlide(); cover.background = { color: '0B0B0B' };
  cover.addText(text(spec.title, 200) || 'Untitled', { x: 0.6, y: 2.4, w: 12, h: 1.4, fontSize: 44, bold: true, color: 'FFFFFF' });
  if (spec.subtitle) cover.addText(text(spec.subtitle, 300), { x: 0.6, y: 3.8, w: 12, h: 0.8, fontSize: 22, color: '4ADE80' });
  for (const s of list(spec.slides, 100)) {
    const sl = p.addSlide(); sl.background = { color: 'FFFFFF' };
    sl.addText(text(s.title, 200), { x: 0.6, y: 0.4, w: 12, h: 0.9, fontSize: 32, bold: true, color: '0B0B0B' });
    const bullets = list(s.bullets, 12).map((b) => ({ text: text(b, 400), options: { bullet: true, breakLine: true } }));
    if (bullets.length) sl.addText(bullets, { x: 0.8, y: 1.5, w: 11.6, h: 5.2, fontSize: 20, color: '222222', valign: 'top' });
    if (s.notes) sl.addNotes(text(s.notes, 3000));
  }
  return Buffer.from(await p.write({ outputType: 'nodebuffer' }));
}

// ── PDF ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** spec: { title, sections: [{ heading?, paragraphs?: [..], bullets?: [..] }] } → a plain, readable PDF (Letter). */
export async function pdfBuffer(spec) {
  const { pdfLib } = await officeLibs();
  const { PDFDocument, StandardFonts, rgb } = pdfLib;
  const doc = await PDFDocument.create(); doc.setTitle(text(spec.title, 200)); doc.setCreator('Kingmaker');
  const font = await doc.embedFont(StandardFonts.Helvetica), bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const W = 612, H = 792, M = 56, maxW = W - 2 * M;
  let page = doc.addPage([W, H]), y = H - M;
  // The standard fonts are WinAnsi only: anything else becomes '?', never a crash.
  const ansi = (s) => text(s, 20_000).replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/…/g, '...').replace(/[^\x20-\x7e\xa0-\xff\n]/g, '?');
  const wrap = (s, f, size) => {
    const out = [];
    for (const para of ansi(s).split('\n')) {
      let line = '';
      for (const w of para.split(/\s+/)) { const t = line ? `${line} ${w}` : w; if (f.widthOfTextAtSize(t, size) > maxW && line) { out.push(line); line = w; } else line = t; }
      out.push(line);
    }
    return out;
  };
  const write = (s, { f = font, size = 11, gap = 4, indent = 0 } = {}) => {
    for (const line of wrap(s, f, size)) {
      if (y - size < M) { page = doc.addPage([W, H]); y = H - M; }
      page.drawText(line, { x: M + indent, y: y - size, size, font: f, color: rgb(0.07, 0.07, 0.07) }); y -= size + gap;
    }
  };
  write(spec.title || 'Untitled', { f: bold, size: 22, gap: 10 });
  for (const sec of list(spec.sections)) {
    if (sec.heading) { y -= 6; write(sec.heading, { f: bold, size: 15, gap: 6 }); }
    for (const p of list(sec.paragraphs)) { write(p); y -= 6; }
    for (const b of list(sec.bullets)) write(`-  ${b}`, { indent: 10 });
  }
  return Buffer.from(await doc.save());
}

/** Merge PDFs (paths) into one → Buffer. */
export async function mergePdfs(paths) {
  const { pdfLib: { PDFDocument } } = await officeLibs();
  const out = await PDFDocument.create();
  for (const p of list(paths, 200)) { const src = await PDFDocument.load(readFileSync(p), { ignoreEncryption: true }); for (const pg of await out.copyPages(src, src.getPageIndices())) out.addPage(pg); }
  return Buffer.from(await out.save());
}

/** Pure: "1-3, 5" → [0,1,2,4] within `count` pages. */
export function pageList(ranges, count) {
  const out = [];
  for (const part of String(ranges || '').split(',')) {
    const m = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(part); if (!m) continue;
    const a = Number(m[1]), b = Number(m[2] || m[1]);
    for (let i = Math.min(a, b); i <= Math.max(a, b); i += 1) if (i >= 1 && i <= count && !out.includes(i - 1)) out.push(i - 1);
  }
  return out;
}

/** Keep only some pages of a PDF ("1-3, 5") → Buffer. */
export async function splitPdf(path, ranges) {
  const { pdfLib: { PDFDocument } } = await officeLibs();
  const src = await PDFDocument.load(readFileSync(path), { ignoreEncryption: true }), out = await PDFDocument.create();
  const pages = pageList(ranges, src.getPageCount());
  if (!pages.length) throw new Error(`no pages in "${ranges}" (it has ${src.getPageCount()})`);
  for (const pg of await out.copyPages(src, pages)) out.addPage(pg);
  return Buffer.from(await out.save());
}

/** Write a line of text on every page (e.g. "PAID", "DRAFT", a date) → Buffer. */
export async function stampPdf(path, words) {
  const { pdfLib: { PDFDocument, StandardFonts, rgb, degrees } } = await officeLibs();
  const doc = await PDFDocument.load(readFileSync(path), { ignoreEncryption: true }), f = await doc.embedFont(StandardFonts.HelveticaBold);
  const t = text(words, 60).replace(/[^\x20-\x7e]/g, '?');
  for (const pg of doc.getPages()) { const { width, height } = pg.getSize(); pg.drawText(t, { x: width * 0.18, y: height * 0.45, size: 54, font: f, color: rgb(0.85, 0.1, 0.1), opacity: 0.35, rotate: degrees(30) }); }
  return Buffer.from(await doc.save());
}

/** Fill a PDF form's fields ({ name: value }); unknown names are listed, not guessed. → { buffer, filled, unknown, fields } */
export async function fillPdfForm(path, values) {
  const { pdfLib: { PDFDocument, PDFCheckBox, PDFDropdown, PDFOptionList, PDFRadioGroup, PDFTextField } } = await officeLibs();
  const doc = await PDFDocument.load(readFileSync(path), { ignoreEncryption: true }), form = doc.getForm();
  const fields = form.getFields().map((f) => f.getName()), filled = [], unknown = [];
  for (const [k, v] of Object.entries(values || {})) {
    if (!fields.includes(k)) { unknown.push(k); continue; }
    const f = form.getField(k); // the bundle is minified: tell field types apart by class, never by name
    if (f instanceof PDFCheckBox) (v === true || /^(yes|true|x|1|on)$/i.test(String(v)) ? f.check() : f.uncheck());
    else if (f instanceof PDFDropdown || f instanceof PDFOptionList || f instanceof PDFRadioGroup) f.select(String(v));
    else if (f instanceof PDFTextField) f.setText(text(v, 2000));
    else { unknown.push(k); continue; }
    filled.push(k);
  }
  return { buffer: Buffer.from(await doc.save()), filled, unknown, fields };
}

// ── One spec in, one file out ───────────────────────────────────────────────────────────────────────────────────────
/**
 * Render a spec (parseOfficeSpec) into the office folder. A pdf spec may also be { merge: [paths] }, { split: { path,
 * pages } }, { stamp: { path, text } } or { fill: { path, values } }; those read only the files named. → { ok, path, kind, note? }
 */
export async function renderOffice(spec, { dir = officeDir() } = {}) {
  if (!spec || !KINDS.includes(spec.kind)) return { ok: false, error: 'not an office spec' };
  const name = (ext) => freshPath(dir, safeName(spec.title || spec.name, ext));
  let buf, note = null;
  if (spec.kind === 'docx') buf = await docxBuffer(spec);
  else if (spec.kind === 'xlsx') buf = await xlsxBuffer(spec);
  else if (spec.kind === 'pptx') buf = await pptxBuffer(spec);
  else if (list(spec.merge).length) buf = await mergePdfs(spec.merge);
  else if (spec.split?.path) buf = await splitPdf(spec.split.path, spec.split.pages);
  else if (spec.stamp?.path) buf = await stampPdf(spec.stamp.path, spec.stamp.text);
  else if (spec.fill?.path) { const r = await fillPdfForm(spec.fill.path, spec.fill.values); buf = r.buffer; if (r.unknown.length) note = `Not in the form: ${r.unknown.join(', ')}. Its fields: ${r.fields.join(', ')}.`; }
  else buf = await pdfBuffer(spec);
  const path = name(spec.kind);
  writeFileSync(path, buf);
  return { ok: true, path, kind: spec.kind, bytes: buf.length, note };
}
