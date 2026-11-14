/**
 * xerj tests — pure contract checks. Network is never touched: the
 * egress guard validates URL strings only; the index scan reads via
 * an injected fake reader.
 */

import { readFileSync } from 'node:fs';
import {
  XERJ_PIN,
  buildGovernedEnv,
  buildServerConfig,
  validateHubConfig,
  validateCommand,
  gateTool,
  gateRequest,
  buildEgressGuard,
  validateIndexJob,
  validateEmbedder,
} from '../lib/xerj-contract.mjs';

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}`); }
}

const descriptor = JSON.parse(readFileSync(new URL('../descriptor.json', import.meta.url), 'utf8'));

// 1. Pins + fork-required recorded.
check('pin records the audited commit', XERJ_PIN.auditedCommit === descriptor.pin.auditedCommit);
check('fork-required feedback fix recorded', XERJ_PIN.forkRequired.some((f) => /feedback\.rs/.test(f)));

// 2. X1 — feedback kill-switch: pinned, un-unpinnable, tool refused.
const e1 = buildGovernedEnv({ callerEnv: { XERJ_DISABLE_FEEDBACK: 'false' } });
check('caller cannot un-pin the feedback kill-switch (X1)', e1.ok === false && /pinned/.test(e1.reason));
const e2 = buildGovernedEnv({});
check('governed env sets the kill-switch', e2.ok === true && e2.env.XERJ_DISABLE_FEEDBACK === 'true');
check('xerj_field_report tool refuses (X1)', gateTool('xerj_field_report').ok === false && /never leave/.test(gateTool('xerj_field_report').reason));
check('ordinary search tool passes', gateTool('xerj_search').ok === true);
check('feedback command refuses (X1)', validateCommand(['feedback', '--submit']).ok === false);

// 3. X1/X2 — egress: vendor endpoints refused, loopback allowed.
const guard = buildEgressGuard({});
check('egress to xerj.org field-report refused', guard.check('https://xerj.org/api/field-report').ok === false);
check('egress to hub.xerj.org refused', guard.check('https://hub.xerj.org/catalogue').ok === false);
check('egress to huggingface refused (neural download path)', guard.check('https://huggingface.co/model').ok === false);
check('loopback server allowed', guard.check('http://127.0.0.1:9200/_search').ok === true);

// 4. X2 — hub hosted must be off.
check('hub config without hosted-off refuses (X2)', validateHubConfig({}).ok === false && /hub\.xerj\.org/.test(validateHubConfig({}).reason));
check('hub hosted off passes', validateHubConfig({ hosted: 'off' }).ok === true);

// 5. X3 — no open mode: admin key required, --insecure forbidden, loopback only.
const s1 = buildServerConfig({});
check('server config without admin key refuses (X3)', s1.ok === false && /OPEN MODE/.test(s1.reason));
const s2 = buildServerConfig({ adminKeyRef: 'vault:xerj-admin', insecure: true });
check('--insecure refuses even with a key (X3)', s2.ok === false && /--insecure/.test(s2.reason));
const s3 = buildServerConfig({ adminKeyRef: 'vault:xerj-admin', bind: '0.0.0.0' });
check('wide bind refuses', s3.ok === false && /loopback only/.test(s3.reason));
const s4 = buildServerConfig({ adminKeyRef: 'vault:xerj-admin' });
check('governed server config builds', s4.ok === true && s4.config.auth.enabled === true && s4.config.hub.hosted === 'off' && s4.config.embedder.kind === 'lexical');
check('admin key is a reference, not a value', s4.config.auth.admin_api_key_ref === 'vault:xerj-admin' && !JSON.stringify(s4).includes('sk-'));

// 6. X4 — init refused.
check('xerj init refuses (X4)', validateCommand(['init']).ok === false && /\.claude\/skills/.test(validateCommand(['init']).reason));
check('xerj autoindex command passes the command gate', validateCommand(['autoindex', '/work/src']).ok === true);

// 7. X7 — share creation refused at the request gate.
check('POST /_share refuses (X7)', gateRequest({ method: 'POST', path: '/_share' }).ok === false && /guest key/.test(gateRequest({ method: 'POST', path: '/_share' }).reason));
check('search request passes', gateRequest({ method: 'GET', path: '/codebase/_search' }).ok === true);

// 8. X5 — index scope + secret scan (injected reader).
const files = ['/work/src/a.mjs', '/work/src/b.mjs'];
const cleanReader = async (p) => `// ${p}\nexport const x = 1;\n`;
const j1 = await validateIndexJob({ folder: '/work/src', allowedRoots: ['/work'], files, readFile: cleanReader });
check('clean in-scope index job passes', j1.ok === true && j1.filesScanned === 2);
const j2 = await validateIndexJob({ folder: '/home/robbie', allowedRoots: ['/work'], files: [], readFile: cleanReader });
check('out-of-scope folder refuses (X5)', j2.ok === false && /declared index roots/.test(j2.reason));
const dirtyReader = async (p) => (p.endsWith('b.mjs') ? 'const k = "AKIAIOSFODNN7EXAMPLE";\n' : 'clean\n');
const j3 = await validateIndexJob({ folder: '/work/src', allowedRoots: ['/work'], files, readFile: dirtyReader });
check('AWS key in a file refuses the job, naming the file not the secret (X5)', j3.ok === false && /b\.mjs/.test(j3.reason) && !/AKIAIOSFODNN7EXAMPLE/.test(j3.reason));
const keyReader = async () => '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n';
const j4 = await validateIndexJob({ folder: '/work/src', allowedRoots: ['/work'], files: [files[0]], readFile: keyReader });
check('private key block refuses the job (X5)', j4.ok === false && /private key block/.test(j4.reason));

// 9. X6 — embedder posture.
check('lexical embedder passes (pinned default)', validateEmbedder({ kind: 'lexical' }).ok === true);
check('neural from hub id refuses (X6)', validateEmbedder({ kind: 'neural' }).ok === false && /HuggingFace/.test(validateEmbedder({ kind: 'neural' }).reason));
check('neural local with matching pin passes', validateEmbedder({ kind: 'neural', localDir: '/models/minilm', weightsSha256: 'a'.repeat(64), pinnedWeightsSha256: 'a'.repeat(64) }).ok === true);
check('neural local with wrong hash refuses', validateEmbedder({ kind: 'neural', localDir: '/models/minilm', weightsSha256: 'b'.repeat(64), pinnedWeightsSha256: 'a'.repeat(64) }).ok === false);

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail === 0 ? 0 : 1);
