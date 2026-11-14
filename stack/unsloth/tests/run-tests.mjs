/**
 * unsloth contract tests — contract logic only. No training, no GPU,
 * no network: runners are injected fakes.
 */

import { readFileSync } from 'node:fs';
import {
  UNSLOTH_PIN,
  validateVersionPins,
  buildTrainingJob,
  acceptTrainingResult,
  runTraining,
  buildStudioLaunchConfig,
  checkDownload,
} from '../lib/unsloth-contract.mjs';

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}`); }
}

const descriptor = JSON.parse(readFileSync(new URL('../descriptor.json', import.meta.url), 'utf8'));
const CORPUS = 'a'.repeat(64);
const MODEL = 'b'.repeat(64);
const tap = async (t) => t === 'founder-token';

// 1. Pin record: split licensing is the whole shape.
check('pin names the intake commit', UNSLOTH_PIN.commit.startsWith('c280b6f') && descriptor.commit === UNSLOTH_PIN.commit);
check('core is Apache-2.0, studio is AGPL external-only', UNSLOTH_PIN.coreLicense === 'Apache-2.0' && UNSLOTH_PIN.studioLicense === 'AGPL-3.0' && UNSLOTH_PIN.studioPosture === 'external-only');
check('descriptor agrees with pin', descriptor.license.core === 'Apache-2.0' && descriptor.license.studio === 'AGPL-3.0');

// 2. Version pin discipline.
check('exact pins pass', validateVersionPins({ torch: '2.6.0', trl: '==0.18.2' }).ok === true);
check('floor range refused', validateVersionPins({ transformers: '>=4.52.4' }).ok === false);
check('tilde range refused', validateVersionPins({ peft: '~=0.18.0' }).ok === false);
check('bare name refused', validateVersionPins({ datasets: 'latest' }).ok === false);
check('empty map refused', validateVersionPins({}).ok === false);

// 3. Training job: corpus hashed in.
const built = buildTrainingJob({ corpusSha256: CORPUS, corpusRows: 103915, baseModel: 'unsloth/Qwen3-8B' });
check('job builds with corpus hash', built.ok === true && built.job.kind === 'unsloth-finetune' && built.job.corpusRows === 103915);
check('job refuses unhashed corpus', buildTrainingJob({ baseModel: 'x' }).ok === false);
check('job refuses short hash', buildTrainingJob({ corpusSha256: 'abc123', baseModel: 'x' }).ok === false);
check('job refuses missing base model', buildTrainingJob({ corpusSha256: CORPUS }).ok === false);
check('job declares HF egress only', JSON.stringify(built.job.egressHosts) === JSON.stringify(['huggingface.co', '*.huggingface.co']));

// 4. Download egress pre-flight.
check('HF model URL allowed', checkDownload(built.job, 'https://huggingface.co/unsloth/Qwen3-8B/resolve/main/config.json').ok === true);
check('HF CDN subdomain allowed', checkDownload(built.job, 'https://cdn-lfs.huggingface.co/repos/abc').ok === true);
check('off-allowlist host refused', checkDownload(built.job, 'https://example.com/model.bin').ok === false);
check('credentialed URL refused', checkDownload(built.job, 'https://user:pass@huggingface.co/x').ok === false);

// 5. Result: model hashed out, never equal to the input.
check('result accepted with fresh model hash', acceptTrainingResult(built.job, { modelSha256: MODEL }).ok === true);
check('result refused without model hash', acceptTrainingResult(built.job, {}).ok === false);
check('result refused when hash equals corpus', acceptTrainingResult(built.job, { modelSha256: CORPUS }).ok === false);

// 6. Run: tap-gated, runner injected.
check('run refuses without tap verifier', (await runTraining(built.job, { tapToken: 'founder-token' })).ok === false);
check('run refuses with bad tap', (await runTraining(built.job, { tapToken: 'nope', verifyTap: tap, runner: async () => 1 })).ok === false);
let runnerCalls = 0;
check('valid tap with no runner = stub record', (await runTraining(built.job, { tapToken: 'founder-token', verifyTap: tap })).stub === true && runnerCalls === 0);
const ran = await runTraining(built.job, { tapToken: 'founder-token', verifyTap: tap, runner: async (j) => { runnerCalls++; return { steps: 42, model: j.baseModel }; } });
check('valid tap runs the injected runner once', ran.ok === true && ran.stub === false && runnerCalls === 1 && ran.output.steps === 42);

// 7. Studio posture: loopback pin, tunnel refusal, env pin.
const studio = buildStudioLaunchConfig();
check('studio default config is loopback, no tunnel', studio.ok === true && studio.config.host === '127.0.0.1' && studio.config.tunnel === false && studio.config.external === true);
check('studio wide bind refused', buildStudioLaunchConfig({ host: '0.0.0.0' }).ok === false);
check('studio LAN bind refused', buildStudioLaunchConfig({ host: '192.168.1.50' }).ok === false);
check('studio tunnel refused', buildStudioLaunchConfig({ tunnel: true }).ok === false);
check('studio telemetry env pinned', studio.config.env.HF_HUB_DISABLE_TELEMETRY === '1');
check('studio env cannot unpin telemetry', buildStudioLaunchConfig({ env: { HF_HUB_DISABLE_TELEMETRY: '0' } }).ok === false);
check('studio env echoing the pin is allowed', buildStudioLaunchConfig({ env: { HF_HUB_DISABLE_TELEMETRY: '1' } }).ok === true);

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail === 0 ? 0 : 1);
