import { deflateSync } from 'node:zlib';
// A real, deterministic PNG made in memory: no downloads, private images or image-generation service.
const crc32 = (bytes) => { let c = 0xffffffff; for (const b of bytes) { c ^= b; for (let i = 0; i < 8; i++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0); } return (c ^ 0xffffffff) >>> 0; };
export function colorImage(red = true) {
  const chunk = (name, data) => { const type = Buffer.from(name), len = Buffer.alloc(4), crc = Buffer.alloc(4); len.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([type, data]))); return Buffer.concat([len, type, data, crc]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(64); header.writeUInt32BE(64, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc(64 * (1 + 64 * 3));
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) pixels[y * 193 + 1 + x * 3 + (red ? 0 : 2)] = 255;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}
export const writerJob = (i) => ({ prompt: `a two-sentence description of a fictional cobalt lighthouse, variation ${i + 1}`, validate: (s) => /cobalt/i.test(s) && /lighthouse/i.test(s) && s.trim().split(/[.!?]+(?:\s|$)/).filter((p) => /\w/.test(p)).length === 2 && s.split(/\s+/).length <= 90 });
// Check a deliberately small program grammar without executing model-controlled code.
export function validateCode(text) {
  const code = String(text).replace(/^```(?:javascript|js)?\s*|\s*```$/g, '').trim();
  return /^function\s+add\s*\(\s*a\s*,\s*b\s*\)\s*\{\s*return\s+a\s*\+\s*b\s*;?\s*\}$/.test(code);
}
export const PROBES = [
  { lane: 'coder', prompt: 'Return only JavaScript source: function add(a, b) that returns a + b. No explanation.', validate: validateCode },
  { lane: 'vision', prompt: 'What is the dominant color of this image? Answer with only the color name.', image: true, validate: (s, red) => new RegExp(`^${red ? 'red' : 'blue'}[.!]?$`, 'i').test(s.trim()) },
  { lane: 'reasoning', prompt: 'All blickets are daxes. No dax is a wug. Can a blicket be a wug? Answer "No" followed by one sentence explaining why.', validate: (s) => /^no\b/i.test(s.trim()) && /dax/i.test(s) && /no|cannot|not/i.test(s.slice(2)) },
];
