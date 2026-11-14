// lib/code-translate.mjs — the universal code translator's caller (owner order 2026-11-14;
// design: ~/workspace/code-translator-design-2026-11-14/DESIGN.md).
//
// The translator is a CONDUCTED METHOD (catalog/methods/code-translate.method.md), not new
// engine machinery. This caller is modeled on lib/direct-reasoning.mjs — same seam
// (`complete(model, prompt)`), same one-pass discipline — and does the four things the
// method file by design does not do for itself:
//   1. TARGET RESOLUTION — the target language is resolved BEFORE conduction, by the
//      design's precedence (explicit → method-declared → recipient surface → intent
//      keywords → NO translation). The winning rule's name is recorded verbatim in the
//      provenance record as `targetChosenBy`. No resolved target → no conduction, ever:
//      an unrequested re-languaging is never invented.
//   2. THE PICK — the smallest sufficient coder for the method's declared
//      `weights: { role: 'coder' }` requirement, via the execution loop's own machinery
//      (loadBenchRecords + enrichRecords + resolveWeightsPick). Escalation and
//      no-sufficient-model outcomes pass through untouched, with the selector's
//      considered[] as the receipt; a smaller insufficient model is never substituted.
//   3. CONDUCTION — the method conducted with a reasoner bound to the picked model,
//      hard-enforced to exactly one call.
//   4. THE GRADE — the delivery's verification tier is composed from what the conduction
//      trace shows actually ran (design §3.4): PARSE only when the parse-check step
//      EXECUTED via the library-pulled langcheck tool, exited 0, and the tool's own
//      stdout carries its OK verdict naming the real checker; STRUCT when the
//      conduction's verify steps passed without an executed parse; NONE otherwise.
//      A failed conduction earns no tier. The grade is never read off what was
//      supposed to run.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { freemem, tmpdir, totalmem } from 'node:os';
import { join } from 'node:path';
import { createMethodConductor, parseMethodFile } from './method-conductor.mjs';
import { enrichRecords, loadBenchRecords, pickSmallestSufficient, resolveWeightsPick } from './execution-loop.mjs';
import { buildLibrary } from './brain-library.mjs';

export const TRANSLATE_METHOD_ID = 'code-translate';
const METHOD_FILE_URL = new URL('../catalog/methods/code-translate.method.md', import.meta.url);

/** File extension per language (target artifact naming + the langcheck dispatch key). */
export const EXT_BY_LANGUAGE = Object.freeze({
  javascript: '.js', typescript: '.ts', python: '.py', bash: '.sh', swift: '.swift',
  rust: '.rs', go: '.go', java: '.java', ruby: '.rb', php: '.php', kotlin: '.kt',
  'c#': '.cs', 'c++': '.cpp', openscad: '.scad',
});
/** Language per source-file extension (the caller's stated fact when it infers one). */
export const LANGUAGE_BY_EXT = Object.freeze({
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.ts': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
  '.py': 'python', '.sh': 'bash', '.bash': 'bash', '.swift': 'swift',
  '.rs': 'rust', '.go': 'go', '.rb': 'ruby', '.scad': 'openscad',
});
const LANGUAGE_ALIASES = Object.freeze({ js: 'javascript', ts: 'typescript', py: 'python', sh: 'bash', shell: 'bash', golang: 'go', cpp: 'c++' });

const normalizeLanguage = (s) => {
  const v = String(s ?? '').trim().toLowerCase();
  return LANGUAGE_ALIASES[v] ?? v;
};
export const extForLanguage = (language) => EXT_BY_LANGUAGE[normalizeLanguage(language)] ?? '.out';
export const languageForFile = (name) => {
  const m = /\.[a-z0-9]+$/i['exec'](String(name ?? ''));
  return m ? (LANGUAGE_BY_EXT[m[0].toLowerCase()] ?? null) : null;
};

// Intent keywords (design §2.2 rule 4), in the spirit of weight-hunter's classifyTask
// lanes: a language named in the request wins over a surface named in it. Inference,
// and labeled as such in the record (`targetChosenBy: 'intent-keywords'`).
const INTENT_LANGUAGES = Object.freeze([
  [/\btypescript\b/i, 'typescript'],
  [/\bjavascript\b/i, 'javascript'],
  [/\bpython\b/i, 'python'],
  [/\bswift\b/i, 'swift'],
  [/\bbash\b|\bshell\s+script\b/i, 'bash'],
  [/\brust\b/i, 'rust'],
  [/\bgolang\b|\bin\s+go\b|\bto\s+go\b|\binto\s+go\b/i, 'go'],
  [/\bjava\b/i, 'java'],
  [/\bc\+\+\b|\bcpp\b/i, 'c++'],
  [/\bc#\b|\bcsharp\b/i, 'c#'],
  [/\bruby\b/i, 'ruby'],
  [/\bphp\b/i, 'php'],
  [/\bkotlin\b/i, 'kotlin'],
]);
const INTENT_SURFACES = Object.freeze([
  [/\bblender\b/i, 'blender-script'],
  [/\bopenscad\b/i, 'openscad'],
  [/\binstaller\s+ui\b|\bmac\s+app\b/i, 'installer-ui'],
  [/\bbrowser\b|\bwebsite\b|\bweb\s+page\b|\bsite\b|\bcrm\b/i, 'site-or-crm'],
  [/\bengine\b/i, 'kingmaker-engine'],
]);

/**
 * Pure: resolve the target language by the design's precedence. First rule that fires
 * wins; its name is returned as `targetChosenBy`. Returns null when no rule fires —
 * the caller then conducts nothing.
 *   explicitTarget  — the run names the target (owner's words, a run input)
 *   declaredTarget  — the producing method declares its delivery language
 *   surface         — a recipient-surface name, resolved through `surfaceLanguages`
 *   requestText     — scanned for intent keywords (language first, then surface)
 */
export function resolveTargetLanguage({ explicitTarget = null, declaredTarget = null, surface = null, requestText = null, surfaceLanguages = {} } = {}) {
  const explicit = normalizeLanguage(explicitTarget);
  if (explicit) return { targetLanguage: explicit, targetChosenBy: 'explicit' };
  const declared = normalizeLanguage(declaredTarget);
  if (declared) return { targetLanguage: declared, targetChosenBy: 'method-declared' };
  if (surface && surfaceLanguages?.[surface]) {
    return { targetLanguage: normalizeLanguage(surfaceLanguages[surface]), targetChosenBy: 'surface' };
  }
  const text = String(requestText ?? '');
  if (text) {
    for (const [re, language] of INTENT_LANGUAGES) {
      if (re.test(text)) return { targetLanguage: language, targetChosenBy: 'intent-keywords' };
    }
    for (const [re, name] of INTENT_SURFACES) {
      if (re.test(text) && surfaceLanguages?.[name]) {
        return { targetLanguage: normalizeLanguage(surfaceLanguages[name]), targetChosenBy: 'intent-keywords' };
      }
    }
  }
  return null;
}

/**
 * Pure: compose the delivery's verification tier from the conduction trace (design
 * §3.4). PARSE requires the parse-check step to have EXECUTED through the
 * library-pulled tool, exited 0, and its stdout to carry langcheck's own OK verdict
 * naming the checker that ran — an exit 0 with a NO-CHECKER verdict (the language
 * has no checker in the bundle) is structural evidence, never a parse pass.
 */
export function gradeTranslation(conduction) {
  const trace = conduction?.trace ?? [];
  const checks = [];
  const parseStep = trace.find((t) => t.id === 'parse-check');
  let parseOk = false;
  // "Ran" is read from the execution EVIDENCE in the step's result (the library-tool
  // receipt + a numeric exit code), not from the step's status — a parse check that
  // executed and FAILED carries status 'failed', and it still ran.
  if (parseStep?.result?.executedVia === 'library-tool' && Number.isFinite(parseStep?.result?.exitCode)) {
    const stdout = String(parseStep.result.stdout ?? '');
    const ok = /^langcheck: OK .+ \(checker: ([^)]+)\)/m['exec'](stdout);
    parseOk = parseStep.result.exitCode === 0 && Boolean(ok);
    checks.push({
      name: 'parse', ran: true, exitCode: parseStep.result.exitCode, ok: parseOk,
      checker: ok?.[1] ?? null,
      ...(!ok && parseStep.result.exitCode === 0 ? { outcome: 'no-checker-for-language' } : {}),
    });
  } else {
    checks.push({ name: 'parse', ran: false, exitCode: null, ok: false, checker: null });
  }
  const verifySteps = trace.filter((t) => t.type === 'verify');
  const structOk = conduction?.status === 'completed' && verifySteps.length > 0 && verifySteps.every((t) => t.status === 'executed');
  checks.push({ name: 'structure', ran: verifySteps.length > 0, ok: structOk });
  const tier = conduction?.status !== 'completed' ? 'NONE' : parseOk ? 'PARSE' : structOk ? 'STRUCT' : 'NONE';
  return { tier, checks };
}

/** The shipped method file's spec (its surfaceLanguages defaults + weights declaration). */
export async function loadTranslateMethodSpec({ methodFileUrl = METHOD_FILE_URL } = {}) {
  return parseMethodFile(await readFile(methodFileUrl, 'utf8'));
}

const defaultDevice = () => ({
  ramGb: Math.round(totalmem() / 2 ** 30),
  freeGb: Math.round((freemem() / 2 ** 30) * 10) / 10,
});

/**
 * Translate one artifact. `complete(model, prompt)` is the one local generation
 * (required — the direct-reasoning seam). Source arrives as `sourceText` (written
 * into the workDir by the caller) and/or a `sourceFile` already inside `workDir`.
 * Returns the design §2.5 shape; refusal outcomes (no target, escalation,
 * no sufficient model, failed conduction) return with their receipts and conduct
 * nothing they should not.
 */
export async function runCodeTranslation({
  sourceText = null, sourceFile = null, sourceLanguage = null,
  explicitTarget = null, declaredTarget = null, surface = null, requestText = null,
  targetFile = null, workDir = null, complete, conductor = null,
  records = null, catalogModels = null, device = null, beforeWeights = null,
  surfaceLanguages = null, methodSpec = null,
} = {}) {
  if (typeof complete !== 'function') throw new Error('code-translate: complete() is required — the one local generation seam');
  const spec = methodSpec ?? await loadTranslateMethodSpec().catch(() => null);
  const surfaces = surfaceLanguages ?? spec?.inputs?.surfaceLanguages ?? {};

  // 1. Target resolution — before anything is picked or conducted (design §2.2).
  const resolved = resolveTargetLanguage({ explicitTarget, declaredTarget, surface, requestText, surfaceLanguages: surfaces });
  if (!resolved) {
    return {
      status: 'no-target', sourceLanguage: sourceLanguage ?? null, targetLanguage: null, targetChosenBy: null,
      model: null, evidenced: null, delivery: null, verification: { tier: 'NONE', checks: [] }, conduction: null,
      reason: 'no target language resolved: no explicit target, no method declaration, no known surface, and no language or surface named in the request — no translation was conducted',
    };
  }
  const { targetLanguage, targetChosenBy } = resolved;

  // 2. The workDir + the source artifact inside it (design §2.1: v1 is file-shaped).
  const dir = workDir ?? await mkdtemp(join(tmpdir(), 'kingmaker-translate-'));
  await mkdir(dir, { recursive: true });
  const srcLanguage = sourceLanguage ?? (sourceFile ? languageForFile(sourceFile) : null) ?? 'auto-detect';
  const srcFile = sourceFile ?? `source${EXT_BY_LANGUAGE[normalizeLanguage(srcLanguage)] ?? '.txt'}`;
  if (sourceText != null) await writeFile(join(dir, srcFile), sourceText);
  const outFile = targetFile ?? `translated${extForLanguage(targetLanguage)}`;

  // 3. The pick — the loop's own machinery over the method's declared requirement.
  const requirement = spec?.weights ?? { role: 'coder' };
  const enriched = records ?? enrichRecords(await loadBenchRecords(), catalogModels ?? buildLibrary().models);
  const dev = device ?? defaultDevice();
  const pick = await resolveWeightsPick(enriched, { requirement, device: dev, request: requestText ?? '', beforeWeights });
  if (pick?.escalate) {
    return {
      status: 'escalated', sourceLanguage: srcLanguage, targetLanguage, targetChosenBy,
      model: null, evidenced: null, delivery: null, verification: { tier: 'NONE', checks: [] }, conduction: null,
      escalation: pick.escalate, considered: pick.considered, requirement: pick.requirement,
      reason: pick.escalate.reason,
    };
  }
  if (!pick?.model) {
    // resolveWeightsPick returns null when nothing is sufficient (its considered[]
    // is not carried on that path) — recover the receipt from the selector directly,
    // same records, same requirement, same device: the outcome is identical.
    const base = pickSmallestSufficient(enriched, { requirement, device: dev });
    return {
      status: 'no-sufficient-model', sourceLanguage: srcLanguage, targetLanguage, targetChosenBy,
      model: null, evidenced: null, delivery: null, verification: { tier: 'NONE', checks: [] }, conduction: null,
      considered: base.considered, requirement: base.requirement,
      reason: `no measured model is sufficient for the ${requirement.role ?? 'coder'} requirement on this device — nothing was substituted`,
    };
  }

  // 4. Conduction — one reasoner, bound to the picked model, exactly one call.
  const active = conductor ?? createMethodConductor();
  let calls = 0;
  const conduction = await active.conduct(TRANSLATE_METHOD_ID, {
    workDir: dir,
    inputs: {
      sourceFile: srcFile, sourceLanguage: srcLanguage, targetLanguage, targetChosenBy,
      targetFile: outFile, model: pick.model,
    },
    reasoner: async ({ preamble, prompt, methodText }) => {
      calls += 1;
      if (calls !== 1) throw new Error('code translation runs in one pass');
      return complete(pick.model, [preamble, '', 'Follow this method in one pass. No tools, no web, no other model.', '', String(methodText ?? '').trim(), '', prompt].join('\n'));
    },
  });
  const verification = gradeTranslation(conduction);
  const base = {
    sourceLanguage: srcLanguage, targetLanguage, targetChosenBy,
    model: pick.model, evidenced: pick.evidenced ?? null, delivery: pick.delivery ?? null,
    targetFile: outFile, recordFile: `${outFile}.translation.json`, workDir: dir,
    verification, conduction,
  };
  if (conduction.status !== 'completed') {
    return { ...base, status: 'failed', haltedAt: conduction.haltedAt, reason: conduction.reason };
  }
  if (calls !== 1) throw new Error('code translation runs in one pass');
  return { ...base, status: 'completed' };
}
