/**
 * lib/universal-file-handler.mjs
 *
 * Kingmaker's background file-handling layer.
 *
 * When Hands of Horus encounters a file Kingmaker doesn't natively handle,
 * this module converts it — locally, no server — into something Kingmaker
 * CAN handle. The Tangerine pattern (drag, convert, done) as a programmatic
 * capability, not a GUI.
 *
 * Detection is by content (magic bytes), not extension. Conversion is via
 * local CLI tools (ffmpeg, sips, pandoc, qpdf). If no conversion path exists,
 * it fails loudly with the file type identified — never silently, never to cloud.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs/promises';

const execFileAsync = promisify(execFile);

// --- Type detection (magic bytes, not extensions) ---------------------------

const MAGIC = [
  { test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff, type: 'image/jpeg' },
  { test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47, type: 'image/png' },
  { test: (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46, type: 'image/gif' },
  { test: (b) => b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP', type: 'image/webp' },
  { test: (b) => b.slice(0, 5).toString() === '%PDF-', type: 'application/pdf' },
  { test: (b) => b.slice(0, 4).toString() === 'ftyp', type: 'video/mp4', offset: 4 },
  { test: (b) => b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3, type: 'video/webm' },
  { test: (b) => b.slice(0, 3).toString() === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0), type: 'audio/mpeg' },
  { test: (b) => b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WAVE', type: 'audio/wav' },
  { test: (b) => b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04, type: 'application/zip' },
  { test: (b) => b.slice(0, 6).toString() === '{"$oid' || b[0] === 0x7b, type: 'application/json', weak: true },
];

export async function detectType(filePath) {
  const fh = await fs.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(16);
    await fh.read(buf, 0, 16, 0);
    for (const m of MAGIC) {
      try {
        if (m.test(buf)) return m.type;
      } catch { /* continue */ }
    }
  } finally {
    await fh.close();
  }
  // Fallback: extension mapping for text formats magic can't see.
  const ext = path.extname(filePath).toLowerCase();
  const extMap = {
    '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv',
    '.json': 'application/json', '.xml': 'application/xml',
    '.html': 'text/html', '.htm': 'text/html',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };
  return extMap[ext] || 'application/octet-stream';
}

// --- Conversion registry ----------------------------------------------------
// Each entry: from-pattern -> to-format -> { tool, args(input, output) }.
// All tools run locally. No network. No upload. Ever.

const CONVERTERS = [
  // Images -> PNG (universal readable)
  {
    from: /^image\//, to: 'image/png', tool: 'sips',
    args: (i, o) => ['-s', 'format', 'png', i, '--out', o],
    alt: { tool: 'convert', args: (i, o) => [i, o] }, // ImageMagick fallback
  },
  // Images -> JPEG
  {
    from: /^image\//, to: 'image/jpeg', tool: 'sips',
    args: (i, o) => ['-s', 'format', 'jpeg', i, '--out', o],
  },
  // Video -> MP4 (H.264)
  {
    from: /^video\//, to: 'video/mp4', tool: 'ffmpeg',
    args: (i, o) => ['-i', i, '-c:v', 'libx264', '-c:a', 'aac', '-y', o],
  },
  // Video -> frame extraction (PNG)
  {
    from: /^video\//, to: 'image/png', tool: 'ffmpeg',
    args: (i, o) => ['-i', i, '-vframes', '1', '-y', o],
  },
  // Audio -> MP3
  {
    from: /^audio\//, to: 'audio/mpeg', tool: 'ffmpeg',
    args: (i, o) => ['-i', i, '-codec:a', 'libmp3lame', '-y', o],
  },
  // Audio -> WAV (lossless, universal)
  {
    from: /^audio\//, to: 'audio/wav', tool: 'ffmpeg',
    args: (i, o) => ['-i', i, '-y', o],
  },
  // Documents -> plain text
  {
    from: /wordprocessingml|application\/pdf|text\//, to: 'text/plain', tool: 'pandoc',
    args: (i, o) => [i, '-t', 'plain', '-o', o],
  },
  // Documents -> PDF
  {
    from: /wordprocessingml|text\/markdown|text\/html/, to: 'application/pdf', tool: 'pandoc',
    args: (i, o) => [i, '-o', o],
  },
  // Video -> audio extraction
  {
    from: /^video\//, to: 'audio/wav', tool: 'ffmpeg',
    args: (i, o) => ['-i', i, '-vn', '-acodec', 'pcm_s16le', '-y', o],
  },
];

async function toolExists(tool) {
  try {
    await execFileAsync('which', [tool]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Find a conversion path from detected type to target type.
 * Returns the converter or null if no path exists.
 */
export function findConverter(fromType, toType) {
  return CONVERTERS.find((c) => c.from.test(fromType) && c.to === toType) || null;
}

/**
 * Convert a file. Detects type by content, finds a converter, runs it locally.
 * Returns { ok: true, outputPath, fromType, toType } or { ok: false, reason }.
 */
export async function convertFile(inputPath, toType, { outputPath = null } = {}) {
  const fromType = await detectType(inputPath);
  if (fromType === toType) {
    return { ok: true, outputPath: inputPath, fromType, toType, noop: true };
  }
  const converter = findConverter(fromType, toType);
  if (!converter) {
    return {
      ok: false,
      reason: `no conversion path: ${fromType} -> ${toType}. File type identified, handler missing.`,
      fromType,
    };
  }

  // Prefer primary tool, fall back to alt.
  const tools = [converter, converter.alt].filter(Boolean);
  const out = outputPath || `${inputPath}.converted-${Date.now()}`;
  for (const t of tools) {
    if (!(await toolExists(t.tool))) continue;
    try {
      await execFileAsync(t.tool, t.args(inputPath, out));
      return { ok: true, outputPath: out, fromType, toType, tool: t.tool };
    } catch (err) {
      // Try next tool.
    }
  }
  return {
    ok: false,
    reason: `conversion tools unavailable for ${fromType} -> ${toType} (tried ${tools.map((t) => t.tool).join(', ')})`,
    fromType,
  };
}

/**
 * The Hands of Horus hook: given a file Kingmaker doesn't natively handle,
 * try to make it handleable. Target types are the formats Kingmaker's
 * engines consume: PNG for vision, WAV for audio, plain text for documents.
 */
const HOH_TARGETS = {
  'image/': 'image/png',
  'video/': 'image/png', // first frame for vision
  'audio/': 'audio/wav',
  'application/pdf': 'text/plain',
  'application/vnd': 'text/plain',
  'text/': 'text/plain',
};

export async function handleUnknownFile(filePath) {
  const fromType = await detectType(filePath);
  const prefix = Object.keys(HOH_TARGETS).find((p) => fromType.startsWith(p));
  if (!prefix) {
    return {
      ok: false,
      reason: `unknown file type: ${fromType}. No handling strategy.`,
      fromType,
    };
  }
  return convertFile(filePath, HOH_TARGETS[prefix]);
}

/** List all supported conversion paths (for the registry / UI). */
export function listConversions() {
  return CONVERTERS.map((c) => ({
    from: c.from.toString(),
    to: c.to,
    tool: c.tool,
  }));
}
