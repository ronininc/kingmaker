// A bounded method author for literal text exports. The owner supplies the bytes,
// and the author assembles only the conductor's existing file operations.
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { METHODS_SCHEMA } from './brain-library.mjs';
import { runRequest } from './execution-loop.mjs';
import { runLeanHarness } from './lean-harness.mjs';
import { createMethodConductor } from './method-conductor.mjs';

const FILE_NAME = /^[a-z0-9][a-z0-9_-]{0,79}\.(?:txt|md)$/i;
const METHOD_REQUEST = 'literal text export';
const METHOD_ID = 'draft-literal-text-export';
const MAX_CONTENT_BYTES = 8192;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function exportInputs(filename, content) {
  if (typeof filename !== 'string' || !FILE_NAME.test(filename)) {
    return { error: 'Use a simple .txt or .md filename for the new export.' };
  }
  if (typeof content !== 'string' || !content.trim() || content.includes('\0') || Buffer.byteLength(content) > MAX_CONTENT_BYTES) {
    return { error: 'Supply literal text up to 8 KiB for the new export.' };
  }
  return { filename, content };
}

export function textExportIntent(text) {
  const request = String(text ?? '').trim();
  const quoted = /^(?:please\s+)?(?:save|export|write)\s+(?:"([\s\S]*)"|“([\s\S]*)”)\s+(?:as|to)\s+(.+)$/i.exec(request);
  const spoken = /^(?:please\s+)?(?:save|export|write)\s+(?:the\s+)?(?:literal\s+)?text\s+([\s\S]+?)\s+(?:as|to)\s+(.+)$/i.exec(request);
  const named = /^(?:please\s+)?(?:create|make)\s+(?:a\s+)?(?:plain\s+)?(?:text|markdown)\s+file\s+(?:named|called)\s+(.+?)\s+containing\s+([\s\S]+)$/i.exec(request);
  if (!quoted && !spoken && !named) return null;
  const filename = (quoted?.[3] ?? spoken?.[2] ?? named[1]).trim().replace(/[.!?]$/, '').replace(/^["“]|["”]$/g, '').replace(/\s+dot\s+(txt|md)$/i, '.$1');
  const unquoted = spoken?.[1] ?? named?.[2];
  const literal = unquoted && /^(?:"([\s\S]*)"|“([\s\S]*)”)$/.exec(unquoted);
  const content = quoted?.[1] ?? quoted?.[2] ?? literal?.[1] ?? literal?.[2] ?? unquoted;
  return exportInputs(filename, content);
}

function draftTextExport() {
  const spec = {
    id: METHOD_ID, version: '0.1', title: 'Literal text export', domain: 'text', kind: 'draft',
    inputs: { filename: 'export.txt', content: '' },
    steps: [
      { id: 'inspect-output', type: 'inspect', path: '{{inputs.filename}}', into: 'target' },
      { id: 'require-new-output', type: 'guard', assert: { var: 'target', field: 'exists', equals: false }, else: { reason: 'the output already exists' } },
      { id: 'write-output', type: 'render', path: '{{inputs.filename}}', template: '{{inputs.content}}', createOnly: true },
    ],
  };
  const text = '# Literal text export\n\nCreates a new text export from the supplied filename and literal content.\n\n'
    + '```kingmaker-method\n' + JSON.stringify(spec, null, 2) + '\n```\n';
  const file = METHOD_ID + '.method.md';
  const index = JSON.stringify({ schema: METHODS_SCHEMA, methods: [{ id: METHOD_ID, title: spec.title, file, quality: { tier: 'draft', score: 0 } }] });
  const indexUrl = new URL('file:///missing-method/index.json');
  const conductor = createMethodConductor({
    indexUrl,
    readText: async (url) => String(url) === indexUrl.href ? index : text,
    toolProvider: null,
  });
  return { text, sha256: sha256(text), conduct: (workDir, inputs) => conductor.conduct(METHOD_ID, { workDir, inputs }) };
}

async function verifyExport(workDir, { filename, content }) {
  const path = join(workDir, filename);
  const entries = await readdir(workDir);
  const stat = await lstat(path);
  const expected = Buffer.from(content);
  if (entries.length !== 1 || entries[0] !== filename || !stat.isFile() || stat.nlink !== 1 || stat.size !== expected.length) {
    throw new Error('The workspace does not contain exactly the expected regular export.');
  }
  const actual = await readFile(path);
  if (!actual.equals(expected)) throw new Error('The exported bytes differ from the requested text.');
  return { path, bytes: actual.length, sha256: sha256(actual) };
}

async function testTextExportMethod(method = draftTextExport()) {
  const scratch = await mkdtemp(join(tmpdir(), 'kingmaker-export-check-'));
  const fixture = { filename: 'fixture.txt', content: 'Synthetic text: café, {{inputs.filename}}.\n' };
  try {
    const positive = await method.conduct(scratch, fixture);
    if (positive.status !== 'completed') throw new Error('The synthetic export did not complete.');
    const expected = await verifyExport(scratch, fixture);

    const negative = await method.conduct(scratch, { ...fixture, content: 'Synthetic collision' });
    if (negative.status !== 'halted' || negative.haltedAt !== 'require-new-output') {
      throw new Error('The synthetic overwrite was not refused at the output guard.');
    }
    const after = await verifyExport(scratch, fixture);
    return {
      status: 'tested',
      distillate: {
        id: METHOD_ID, text: method.text, sha256: method.sha256,
        checks: { positive: { sha256: expected.sha256 }, collision: { haltedAt: negative.haltedAt, sha256: after.sha256 } },
      },
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function authorTextExport({ workDir, inputs }) {
  const method = draftTextExport();
  const tested = await testTextExportMethod(method);
  const conduction = await method.conduct(workDir, inputs);
  const artifact = conduction.status === 'completed' ? await verifyExport(workDir, inputs) : null;
  return { status: conduction.status, artifact, reason: conduction.reason, conduction, distillate: tested.distillate };
}

const REVIEWED_TEXT_EXPORT = draftTextExport();

async function artifactDirectory(runtimeHome) {
  // This is the pre-existing Artifacts surface. Refuse redirection of either child.
  let directory = runtimeHome;
  for (const name of ['data', 'artifacts']) {
    directory = join(directory, name);
    await mkdir(directory, { mode: 0o700 }).catch((error) => { if (error.code !== 'EEXIST') throw error; });
    if (!(await lstat(directory)).isDirectory()) throw new Error('The Artifacts folder is unavailable.');
  }
  return mkdtemp(join(directory, 'export-'));
}

export async function runApprovedTextExport(intent, { runtimeHome, reviewedConductor = null }) {
  const inputs = exportInputs(intent?.filename, intent?.content);
  if (inputs.error) return { status: 'refused', reason: inputs.error };

  let workDir, outDir;
  let verified = false;
  try {
    workDir = await mkdtemp(join(tmpdir(), 'kingmaker-export-'));
    const run = reviewedConductor
      ? await runRequest(METHOD_REQUEST, { workDir, inputs, loopOpts: { remote: false, sandboxPosture: false, conductor: reviewedConductor, authorMissingMethod: authorTextExport } })
      : await runLeanHarness({
        intent: 'literal-text-export', inputReferences: [], permittedWrites: [inputs.filename],
        expectedOutput: { kind: 'text-file', path: inputs.filename }, acceptanceChecks: ['exact-bytes', 'create-only'],
        budget: { maxSteps: 3, maxObservations: 0, maxRepairs: 0, deadlineMs: 30_000 },
      }, {
        reviewedMethods: [{
          intent: 'literal-text-export', reviewed: true, digest: REVIEWED_TEXT_EXPORT.sha256,
          run: async () => {
            const conduction = await REVIEWED_TEXT_EXPORT.conduct(workDir, inputs);
            return { ok: conduction.status === 'completed', reason: conduction.reason, outputs: { export: join(workDir, inputs.filename) }, trace: conduction.trace, metrics: { modelCalls: 0, toolCalls: conduction.trace.length } };
          },
        }],
        verify: async () => ({ ok: true, artifact: await verifyExport(workDir, inputs), receipt: { methodSha256: REVIEWED_TEXT_EXPORT.sha256 } }),
      });
    if (run.conduction?.status !== 'completed') {
      if (!run.ok) return { status: 'refused', reason: run.conduction?.reason ?? run.reason ?? 'The reviewed method could not complete this local export.' };
    }

    // Never trust an author's artifact path. Re-read the approved staging path.
    const staged = await verifyExport(workDir, inputs);
    outDir = await artifactDirectory(runtimeHome);
    await copyFile(staged.path, join(outDir, inputs.filename), constants.COPYFILE_EXCL);
    const artifact = await verifyExport(outDir, inputs);
    verified = true;
    return {
      status: 'completed', artifact,
      method: run.conduction?.method.id ?? METHOD_ID,
      metrics: run.metrics ?? { modelCalls: 0, toolCalls: run.conduction?.trace?.length ?? 0 },
      distillate: reviewedConductor ? (run.authoring?.distillate ?? null)
        : { id: METHOD_ID, text: REVIEWED_TEXT_EXPORT.text, sha256: REVIEWED_TEXT_EXPORT.sha256, checks: null },
      learn: () => testTextExportMethod(REVIEWED_TEXT_EXPORT),
    };
  } catch (error) {
    return { status: 'failed', reason: error.message };
  } finally {
    if (workDir) await rm(workDir, { recursive: true, force: true });
    if (outDir && !verified) await rm(outDir, { recursive: true, force: true });
  }
}

/** Use the device desk's existing owner gate and report through the calling surface. */
export async function offerTextExport(text, { desk, say, runtimeHome, onArtifact = () => {}, onLearning = () => {} }) {
  const intent = textExportIntent(text);
  if (!intent) return false;
  if (intent.error || desk?.pending()) {
    await say(intent.error ?? 'An action is already waiting for your answer.');
    return true;
  }
  if (!desk) {
    await say('Text export needs the Kingmaker owner approval desk.');
    return true;
  }
  desk.holdForOwner('text-export', async () => {
    const result = await runApprovedTextExport(intent, { runtimeHome });
    if (result.status !== 'completed') {
      await say(`Export stopped. ${result.reason}`);
      return;
    }
    await onArtifact(result);
    await say(`Verified ${intent.filename} (${result.artifact.bytes} bytes). Open it in Artifacts. This export contains only the text you supplied.`);
    // Learning is outside the delivery wait. Its failure cannot revoke the file.
    void result.learn?.().then(onLearning).catch((error) => onLearning({ status: 'failed', reason: String(error?.message || error) }));
  });
  await say(`Create ${intent.filename} in Kingmaker’s Artifacts from the text you supplied? Say yes or no.`);
  return true;
}
