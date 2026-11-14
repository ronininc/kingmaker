/**
 * angelslim tests — descriptor + stub logic only. No compression runs,
 * no network, no weights touched.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ANGELSLIM_KIND,
  COMPRESSION_METHODS,
  buildCompressionJob,
  validateJobOutput,
  createAngelSlimRunner,
} from '../lib/angelslim-job.mjs';

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}`); }
}

const dir = mkdtempSync(join(tmpdir(), 'km42-as-'));
const HASH_IN = 'b'.repeat(64);
const HASH_OUT = 'c'.repeat(64);

// 1. A well-formed job builds with the cell pattern baked in.
const built = buildCompressionJob({ jobId: 'job-1', modelIn: { path: '/models/qwen3-32b', sha256: HASH_IN }, method: 'int4-awq' });
check('job builds', built.ok === true && built.job.kind === ANGELSLIM_KIND);
check('job is cell-shaped (template + deny-all egress + no credentials)', built.job.template.includes(ANGELSLIM_KIND) && built.job.egress.mode === 'deny-all' && built.job.credentials.length === 0);
check('input hash recorded on the job', built.job.modelIn.sha256 === HASH_IN);
check('method vocabulary registered (upstream README families)', COMPRESSION_METHODS.length >= 6 && COMPRESSION_METHODS.every((m) => m.family === 'quantization'));

// 2. Unhashed inputs and unknown methods refuse.
check('missing input hash refuses', buildCompressionJob({ jobId: 'j', modelIn: { path: '/m' }, method: 'int4-awq' }).ok === false);
check('malformed input hash refuses', buildCompressionJob({ jobId: 'j', modelIn: { path: '/m', sha256: 'short' }, method: 'int4-awq' }).ok === false);
check('unknown method refuses', buildCompressionJob({ jobId: 'j', modelIn: { path: '/m', sha256: HASH_IN }, method: 'zip-it' }).ok === false);

// 3. Output acceptance: hashed out or it does not enter the library.
check('hashed output accepted', validateJobOutput(built.job, { modelOut: { path: '/models/qwen3-32b-awq', sha256: HASH_OUT } }).ok === true);
check('unhashed output refused', validateJobOutput(built.job, { modelOut: { path: '/models/x' } }).ok === false);
check('output == input hash refused (no compression happened)', validateJobOutput(built.job, { modelOut: { path: '/models/x', sha256: HASH_IN } }).ok === false);
check('foreign job kind refused', validateJobOutput({ kind: 'other' }, { modelOut: { path: '/x', sha256: HASH_OUT } }).ok === false);

// 4. The stub runner: tap discipline exactly like LittleBrother full.
let executorCalls = 0;
const executor = async () => { executorCalls++; return { modelOut: { path: '/x', sha256: HASH_OUT } }; };
const tap = async (t) => t === 'founder-token';

const noVerifier = createAngelSlimRunner({ executor, auditPath: join(dir, 'a1.jsonl') });
check('no tap verifier → refuse (fail-closed)', (await noVerifier.run(built.job, { tapToken: 'founder-token' })).ok === false);

const runner = createAngelSlimRunner({ verifyTap: tap, executor, auditPath: join(dir, 'a2.jsonl') });
check('no tap → refuse', (await runner.run(built.job)).ok === false);
check('bad tap → refuse', (await runner.run(built.job, { tapToken: 'nope' })).ok === false);
const stub = await runner.run(built.job, { tapToken: 'founder-token' });
check('valid tap → stub record (verified:false, no output)', stub.ok === true && stub.stub === true && stub.verified === false && stub.modelOut === null);
check('executor was NEVER invoked by the stub', executorCalls === 0);
check('runner audit chain verifies', runner.verifyAudit().ok === true);

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail === 0 ? 0 : 1);
