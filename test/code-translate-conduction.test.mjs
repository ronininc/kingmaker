// test/code-translate-conduction.test.mjs — the translator's verification contract,
// proven end to end through the SHIPPED method (catalog/methods/code-translate.method.md),
// the SHIPPED catalog indexes, the real bench records, and the real caller — with a
// fixture reasoner standing in for the model (the model pass itself is fixture-grade
// here; the live-model proof is a seat act — see the design). The parse check travels
// the conductor's check-tool → declare path, the only execution path:
//
//   fixture 1 — langcheck NOT staged (the shipped catalog's honest state):
//               the conduction completes, the parse step stays declared, the grade is
//               STRUCT and the record says parseCheck "exit=" — an unverified
//               translation is never delivered as verified.
//   fixture 2 — langcheck staged through the Brain Library lane (a fixture bundle
//               carrying a contract-faithful checker, staged exactly like the real
//               one: parts on disk, pins in the index, pull, hash-verify,
//               materialize): the parse step EXECUTES, exits 0, and the grade is
//               PARSE with the record's parseCheck "exit=0". (The shipped bundle
//               itself gets this same workout in the build's proof run, where the
//               staging package is present.)
//   fixture 3 — the reasoner returns unparseable code: the parse check FAILS the
//               conduction — no record is written, the result is failed/NONE, and
//               the broken translation is left on disk as evidence only.
//   fixture 4 — the surface rule end to end: surface "blender-script" picks python
//               with targetChosenBy "surface", no explicit target anywhere.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import { buildLibrary, loadToolsIndex, planParts, toolPlatformKey } from '../lib/brain-library.mjs';
import { runCodeTranslation } from '../lib/code-translate.mjs';
import { enrichRecords, loadBenchRecords } from '../lib/execution-loop.mjs';
import { createMethodConductor } from '../lib/method-conductor.mjs';
import { createToolStreamingProvider } from '../lib/tool-streaming.mjs';

const PLATFORM = toolPlatformKey();
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const SOURCE_JS = "function slugify(text) {\n  return text.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');\n}\n";
const TRANSLATION_PY = '# kingmaker-translate: translated from javascript to python\nimport re\n\ndef slugify(text):\n    return re.sub(r"[^a-z0-9]+", "-", text.lower().strip()).strip("-")\n';
const BROKEN_PY = '# kingmaker-translate: translated from javascript to python\ndef slugify(text:\n    return broken(\n';

function notOnPath(name) {
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    if (dir && existsSync(join(dir, name))) return false;
  }
  return true;
}

// ── a minimal stored-zip writer (the fixture bundle's packaging) ──
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function zipStore(entries) {
  const chunks = []; const central = []; let offset = 0;
  for (const [name, content, mode] of entries) {
    const nameBuf = Buffer.from(name); const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const crc = crc32(data); const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(data.length, 18); head.writeUInt32LE(data.length, 22); head.writeUInt16LE(nameBuf.length, 26);
    chunks.push(head, nameBuf, data);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 6); cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(data.length, 20); cen.writeUInt32LE(data.length, 24); cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(((mode & 0xffff) << 16) >>> 0, 38); cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf); offset += 30 + nameBuf.length + data.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  const cenSize = central.reduce((n, b) => n + b.length, 0);
  end.writeUInt32LE(cenSize, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, ...central, end]);
}

// A real, if minimal, checker honoring the langcheck verdict contract: real system
// checkers, OK/FAIL/NO-CHECKER lines, exit 0/1/0. The shipped bundle adds the
// TypeScript lane and richer reporting; the contract under test is identical.
const FIXTURE_LANGCHECK = `#!/usr/bin/env node
const { execFileSync } = require('node:child_process');
const { extname } = require('node:path');
const file = process.argv[2];
const ext = extname(file).toLowerCase();
function check(cmd, args, language, checker) {
  try { execFileSync(cmd, args, { stdio: 'pipe' }); console.log(\`langcheck: OK \${language} \${file} (checker: \${checker})\`); }
  catch { console.log(\`langcheck: FAIL \${language} \${file} (checker: \${checker})\`); process.exit(1); }
}
if (ext === '.py') check('python3', ['-m', 'py_compile', file], 'python', 'python3 -m py_compile');
else if (ext === '.js' || ext === '.mjs') check('node', ['--check', file], 'javascript', 'node --check');
else if (ext === '.sh') check('bash', ['-n', file], 'bash', 'bash -n');
else console.log(\`langcheck: NO-CHECKER \${file} — the fixture bundle covers .py/.js/.sh only\`);
`;

async function stagedLangcheckProvider(stateDir, payloadDir) {
  const zip = zipStore([['langcheck', FIXTURE_LANGCHECK, 0o100755]]);
  const plan = planParts(zip.length, Math.ceil(zip.length / 2));
  assert.equal(plan.length, 2, 'the fixture bundle is carried in two parts');
  const partDir = join(payloadDir, 'langcheck', PLATFORM);
  await mkdir(partDir, { recursive: true });
  const parts = [];
  for (const p of plan) {
    const bytes = zip.subarray(p.start, p.start + p.size);
    const name = `langcheck-1.0.0-${PLATFORM}.zip.part${String(p.index + 1).padStart(2, '0')}`;
    await writeFile(join(partDir, name), bytes);
    parts.push({ name, size: p.size, sha256: sha256(bytes) });
  }
  const tool = {
    id: 'langcheck', name: 'Langcheck (fixture)', version: '1.0.0', license: 'mit',
    homepage: null, provides: ['langcheck'], note: 'conduction fixture for the translator tests',
    quality: { tier: 'vetted', score: 80, basis: 'test fixture honoring the langcheck verdict contract' },
    platforms: {
      [PLATFORM]: {
        release: `langcheck-1.0.0-${PLATFORM}`, archive: `langcheck-1.0.0-${PLATFORM}.zip`, format: 'zip',
        bin: 'langcheck', payloadStatus: 'staged', size: zip.length, sha256: sha256(zip), parts,
      },
    },
  };
  return createToolStreamingProvider({ stateDir, toolPayloadDir: payloadDir, toolsIndex: [tool] });
}

async function realRecords() {
  return enrichRecords(await loadBenchRecords(), buildLibrary().models);
}

test('fixture 1: langcheck unstaged — completes at STRUCT, record honest about the unrun check', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'km-tc-unstaged-state-'));
  const payloadDir = await mkdtemp(join(tmpdir(), 'km-tc-unstaged-payloads-'));
  const workDir = await mkdtemp(join(tmpdir(), 'km-tc-unstaged-work-'));
  const conductor = createMethodConductor({ toolProvider: createToolStreamingProvider({ stateDir, toolPayloadDir: payloadDir, toolsIndex: loadToolsIndex() }) });
  const r = await runCodeTranslation({
    sourceText: SOURCE_JS, sourceLanguage: 'javascript', explicitTarget: 'python',
    records: await realRecords(), workDir, conductor,
    complete: async () => TRANSLATION_PY,
  });
  assert.equal(r.status, 'completed');
  assert.equal(r.model, 'huihui_ai/qwen2.5-coder-abliterate:1.5b');
  assert.equal(r.targetChosenBy, 'explicit');
  assert.equal(r.verification.tier, 'STRUCT');
  assert.equal(r.verification.checks.find((c) => c.name === 'parse').ran, false);
  const record = JSON.parse(await readFile(join(workDir, 'translated.py.translation.json'), 'utf8'));
  assert.equal(record.schema, 'kingmaker.code-translation/1');
  assert.equal(record.targetChosenBy, 'explicit');
  assert.equal(record.checkerFound, false);
  assert.equal(record.parseCheck, 'exit=');
  assert.equal(record.model, 'huihui_ai/qwen2.5-coder-abliterate:1.5b');
  assert.equal(await readFile(join(workDir, 'translated.py'), 'utf8'), TRANSLATION_PY);
});

test('fixture 2: langcheck staged — the parse check executes through the library lane and earns PARSE',
  { skip: PLATFORM !== 'linux-x64' || !notOnPath('langcheck') ? 'needs linux-x64 and no langcheck on PATH' : false }, async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'km-tc-staged-state-'));
    const payloadDir = await mkdtemp(join(tmpdir(), 'km-tc-staged-payloads-'));
    const workDir = await mkdtemp(join(tmpdir(), 'km-tc-staged-work-'));
    const conductor = createMethodConductor({ toolProvider: await stagedLangcheckProvider(stateDir, payloadDir) });
    const r = await runCodeTranslation({
      sourceText: SOURCE_JS, sourceLanguage: 'javascript', explicitTarget: 'python',
      records: await realRecords(), workDir, conductor,
      complete: async () => TRANSLATION_PY,
    });
    assert.equal(r.status, 'completed');
    assert.equal(r.verification.tier, 'PARSE');
    const parse = r.verification.checks.find((c) => c.name === 'parse');
    assert.equal(parse.ran, true);
    assert.equal(parse.exitCode, 0);
    assert.equal(parse.checker, 'python3 -m py_compile');
    const record = JSON.parse(await readFile(join(workDir, 'translated.py.translation.json'), 'utf8'));
    assert.equal(record.checkerFound, true);
    assert.equal(record.parseCheck, 'exit=0');
    assert.equal(record.model, 'huihui_ai/qwen2.5-coder-abliterate:1.5b');
  });

test('fixture 3: a broken translation fails its parse — conduction fails, no record, evidence kept',
  { skip: PLATFORM !== 'linux-x64' || !notOnPath('langcheck') ? 'needs linux-x64 and no langcheck on PATH' : false }, async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'km-tc-broken-state-'));
    const payloadDir = await mkdtemp(join(tmpdir(), 'km-tc-broken-payloads-'));
    const workDir = await mkdtemp(join(tmpdir(), 'km-tc-broken-work-'));
    const conductor = createMethodConductor({ toolProvider: await stagedLangcheckProvider(stateDir, payloadDir) });
    const r = await runCodeTranslation({
      sourceText: SOURCE_JS, sourceLanguage: 'javascript', explicitTarget: 'python',
      records: await realRecords(), workDir, conductor,
      complete: async () => BROKEN_PY,
    });
    assert.equal(r.status, 'failed');
    assert.equal(r.haltedAt, 'parse-check');
    assert.equal(r.verification.tier, 'NONE');
    assert.match(r.reason, /exit 1/);
    // The broken translation stays on disk as evidence; the provenance record —
    // which would have attested the delivery — was never written.
    assert.equal(await readFile(join(workDir, 'translated.py'), 'utf8'), BROKEN_PY);
    await assert.rejects(() => access(join(workDir, 'translated.py.translation.json')), /ENOENT/);
  });

test('fixture 4: the surface rule fires end to end (blender-script → python)', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'km-tc-surface-state-'));
  const payloadDir = await mkdtemp(join(tmpdir(), 'km-tc-surface-payloads-'));
  const workDir = await mkdtemp(join(tmpdir(), 'km-tc-surface-work-'));
  const conductor = createMethodConductor({ toolProvider: createToolStreamingProvider({ stateDir, toolPayloadDir: payloadDir, toolsIndex: loadToolsIndex() }) });
  const r = await runCodeTranslation({
    sourceText: SOURCE_JS, sourceLanguage: 'javascript', surface: 'blender-script',
    requestText: 'port this helper so the render box can run it',
    records: await realRecords(), workDir, conductor,
    complete: async () => TRANSLATION_PY,
  });
  assert.equal(r.status, 'completed');
  assert.equal(r.targetLanguage, 'python');
  assert.equal(r.targetChosenBy, 'surface');
  const record = JSON.parse(await readFile(join(workDir, 'translated.py.translation.json'), 'utf8'));
  assert.equal(record.targetChosenBy, 'surface');
});
