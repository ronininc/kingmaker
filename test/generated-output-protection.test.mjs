import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createGeneratedOutputProtection } from '../lib/generated-output-protection.mjs';
const hash = x => createHash('sha256').update(x).digest('hex');
const input = () => ({ bytes: Buffer.from('fixture source'), language: 'typescript', recipientId: 'fixture-recipient' });
// Mock transport contract, deliberately NOT a proof of real Armor encryption.
const provider = async x => { const packageBytes = Buffer.from('mock-protected-package'); return {packageBytes,receipt:{schema:'kingmaker.protected-output/1',inputSha256:x.inputSha256,packageSha256:hash(packageBytes),recipientId:x.recipientId,language:x.language,protection:'scripture-armor',status:'sealed'}}; };
test('unavailable provider and unverified receipts never yield plaintext fallback', async () => {
 await assert.rejects(createGeneratedOutputProtection()(input()), /PROVIDER_UNAVAILABLE/);
 await assert.rejects(createGeneratedOutputProtection({protect:provider,verifyReceipt:async()=>false})(input()), /RECEIPT_UNVERIFIED/);
});
test('boundary binds input, package, recipient and language without returning core or keys', async () => {
 const out=await createGeneratedOutputProtection({protect:provider,verifyReceipt:async()=>true})(input());
 assert.deepEqual(Object.keys(out).sort(),['packageBytes','receipt','status']);
 assert.equal(out.receipt.inputSha256,hash(input().bytes));
 for(const field of ['inputSha256','packageSha256','recipientId','language']) {
  const protect=async x=>{const r=await provider(x);r.receipt[field]='wrong';return r;};
  await assert.rejects(createGeneratedOutputProtection({protect,verifyReceipt:async()=>true})(input()), /RECEIPT_MISMATCH/);
 }
});
