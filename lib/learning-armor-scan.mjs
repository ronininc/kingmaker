// Read-only lexical admission evidence, not a paid binary scan or safety certification.
import { createHash } from 'node:crypto';
export async function scanLearningMethod(text) {
  if (typeof text !== 'string' || !text || Buffer.byteLength(text) > 256 * 1024) throw new Error('LEARNING_ARMOR_INPUT_INVALID');
  const sha256 = createHash('sha256').update(text).digest('hex');
  let record;
  try {
    const { scanSourceText } = await import('../scripture-armor/scan.mjs');
    if (typeof scanSourceText !== 'function') throw new Error('missing scanner');
    // Force source lexical inspection: .md file classification otherwise skips it.
    record = scanSourceText(text, 'candidate.method.md', sha256);
  } catch { throw new Error('LEARNING_ARMOR_SCAN_UNAVAILABLE'); }
  if (record?.format !== 'scripture-armor-scan/1' || record.target_sha256 !== sha256
    || record.target_class !== 'source' || record.engine?.name !== 'scripture-lexical'
    || !Array.isArray(record.findings) || !record.counts) throw new Error('LEARNING_ARMOR_SCAN_INVALID');
  if (record.verdict !== 'pass' || record.counts.high !== 0 || record.counts.critical !== 0
    || record.findings.some(f => ['high', 'critical'].includes(f.severity))) throw new Error('LEARNING_ARMOR_SCAN_REJECTED');
  return { schema: 'kingmaker.learning-armor-scan/1', sha256, record,
    limitation: 'Lexical pattern inspection only; no guarantee of safety, correctness, or rights.' };
}
