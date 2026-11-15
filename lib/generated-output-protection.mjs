// Boundary only: the paid Armor implementation is NOT imported or distributed.
// Host wiring must supply an authenticated provider and independently verified receipt.
import { createHash } from 'node:crypto';
const hash = x => createHash('sha256').update(x).digest('hex');
export function createGeneratedOutputProtection({ protect, verifyReceipt } = {}) {
  return async function protectOutput({ bytes, language, recipientId } = {}) {
    if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > 16 * 1024 * 1024
      || !/^[a-z][a-z0-9+#.-]{0,39}$/i.test(language || '')
      || typeof recipientId !== 'string' || !recipientId || recipientId.length > 256) throw new Error('OUTPUT_PROTECTION_INPUT_INVALID');
    if (typeof protect !== 'function' || typeof verifyReceipt !== 'function') throw new Error('OUTPUT_PROTECTION_PROVIDER_UNAVAILABLE');
    const input = Buffer.from(bytes), inputSha256 = hash(input);
    let result;
    try { result = await protect({ bytes: input, language, recipientId, inputSha256 }); }
    catch { throw new Error('OUTPUT_PROTECTION_PROVIDER_FAILED'); }
    finally { input.fill(0); }
    if (!Buffer.isBuffer(result?.packageBytes) || !result.packageBytes.length
      || result.packageBytes.length > 64 * 1024 * 1024) throw new Error('OUTPUT_PROTECTION_PACKAGE_INVALID');
    const packageBytes = Buffer.from(result.packageBytes), packageSha256 = hash(packageBytes);
    const receipt = structuredClone(result.receipt);
    if (receipt?.schema !== 'kingmaker.protected-output/1' || receipt.inputSha256 !== inputSha256
      || receipt.packageSha256 !== packageSha256 || receipt.recipientId !== recipientId
      || receipt.language !== language || receipt.protection !== 'scripture-armor'
      || receipt.status !== 'sealed') throw new Error('OUTPUT_PROTECTION_RECEIPT_MISMATCH');
    let valid = false;
    try { valid = (await verifyReceipt(receipt)) === true; } catch {}
    if (!valid) throw new Error('OUTPUT_PROTECTION_RECEIPT_UNVERIFIED');
    // Return only protected payload + receipt, never provider code/keys or plaintext fallback.
    return { status: 'protected', packageBytes, receipt };
  };
}
