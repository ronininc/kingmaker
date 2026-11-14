// Tests for lib/unlimited-ocr-contract.mjs. Run: node tests/run-tests.mjs
import assert from 'node:assert/strict';
import { OCR_PIN, decideOcrInvocation } from '../lib/unlimited-ocr-contract.mjs';

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed += 1; console.log(`  ok - ${name}`); };

const goodCuda = {
  hostClass: 'cuda-node',
  modelRevision: OCR_PIN.modelRevision,
  repoCommit: OCR_PIN.repoCommit,
  codeSource: 'vendored-snapshot',
  inputPath: '/docs/report.pdf',
};

ok('a pinned CUDA-node invocation is admitted', decideOcrInvocation(goodCuda).allow === true);
ok('Apple Silicon without a spike receipt is refused (CUDA gate)', decideOcrInvocation({ ...goodCuda, hostClass: 'apple-silicon' }).allow === false);
ok('Apple Silicon WITH a spike receipt is admitted', decideOcrInvocation({ ...goodCuda, hostClass: 'apple-silicon', spikeReceipt: 'spike-2026-10-21' }).allow === true);
ok('a drifted model revision is refused', decideOcrInvocation({ ...goodCuda, modelRevision: 'deadbeef' }).reasons.some((r) => r.includes('not the pin')));
ok('a drifted repo commit is refused', decideOcrInvocation({ ...goodCuda, repoCommit: 'deadbeef' }).allow === false);
ok('hub-downloaded code is refused (trust_remote_code)', decideOcrInvocation({ ...goodCuda, codeSource: 'hub-download' }).reasons.some((r) => r.includes('trust_remote_code')));
ok('a non-document input is refused', decideOcrInvocation({ ...goodCuda, inputPath: '/tmp/payload.exe' }).allow === false);
ok('an image document is admitted', decideOcrInvocation({ ...goodCuda, inputPath: '/scans/page3.png' }).allow === true);
ok('an unknown host class is refused', decideOcrInvocation({ ...goodCuda, hostClass: 'browser' }).allow === false);
ok('every refusal names its reason', decideOcrInvocation({}).reasons.length >= 4);

console.log(`unlimited-ocr-contract: ${passed}/${passed} checks passed`);
