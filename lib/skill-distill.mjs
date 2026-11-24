// Transferable skill declarations use a closed vocabulary. Local work and the
// evidence used to review it are kept outside the package.
import { createHash } from 'node:crypto';
import { SCAN_RULES_VERSION, scanSourceText } from '../scripture-armor/scan.mjs';
import { textProblems } from './library-scan.mjs';

export const SKILL_PACKAGE_SCHEMA = 'kingmaker.skill-package/1';
const MAX_PACKAGE_BYTES = 16 * 1024;
const PACKAGE_FIELDS = ['intent', 'parameterSlots', 'steps', 'failureConditions', 'syntheticChecks'];
const INTENT_STEPS = {
  'normalize-text': ['trim-text', 'collapse-whitespace'],
  'deduplicate-records': ['deduplicate-records'],
  'count-records': ['count-records'],
};
const STEP_TYPES = {
  'trim-text': { input: 'text', output: 'text' },
  'collapse-whitespace': { input: 'text', output: 'text' },
  'deduplicate-records': { input: 'records', output: 'records' },
  'count-records': { input: 'records', output: 'count' },
};
const FIXTURES = {
  'sample-text': { type: 'text', empty: false },
  'empty-text': { type: 'text', empty: true },
  'sample-records': { type: 'records', empty: false },
  'empty-records': { type: 'records', empty: true },
};

const digestOf = (bytes) => createHash('sha256').update(bytes).digest('hex');
const refuse = (reason) => ({ ok: false, reason });
const looksSecret = (value) => typeof value === 'string' && textProblems(value).includes('looks like a key or token');
const indexIn = (index, length) => Number.isInteger(index) && index >= 0 && index < length;

class InvalidDeclaration extends Error {}

function requireField(condition, reason = 'invalid-declaration') {
  if (!condition) throw new InvalidDeclaration(reason);
}

function requireEnum(value, allowed, reason) {
  requireField(!looksSecret(value), 'secret-material');
  requireField(allowed.includes(value), reason);
  return value;
}

function requireRecord(value, keys) {
  requireField(value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype);
  requireField(Reflect.ownKeys(value).length === keys.length && keys.every((key) => {
    const field = Object.getOwnPropertyDescriptor(value, key);
    return field?.enumerable && Object.hasOwn(field, 'value');
  }));
}

function projectList(value, max, project) {
  requireField(Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype);
  requireField(value.length > 0 && value.length <= max && Reflect.ownKeys(value).length === value.length + 1);
  return Array.from({ length: value.length }, (_, index) => {
    const item = Object.getOwnPropertyDescriptor(value, index);
    requireField(item?.enumerable && Object.hasOwn(item, 'value'));
    return project(item.value);
  });
}

// Explicit projection supplies the canonical field order. The grammar has no
// literal values, user-chosen names, IO, executable code, or connector actions.
function projectDeclaration(draft, fields = PACKAGE_FIELDS) {
  requireRecord(draft, fields);
  const intent = requireEnum(draft.intent, Object.keys(INTENT_STEPS));
  const parameterSlots = projectList(draft.parameterSlots, 8, (slot) => requireEnum(slot, ['text', 'records']));

  const outputTypes = [];
  const usedSlots = new Set();
  const steps = projectList(draft.steps, 24, (step) => {
    requireRecord(step, ['type', 'input']);
    const type = requireEnum(step.type, Object.keys(STEP_TYPES), 'unsafe-capability');
    requireRecord(step.input, ['from', 'index']);
    const from = requireEnum(step.input.from, ['slot', 'step']);
    const { index } = step.input;
    const available = from === 'slot' ? parameterSlots : outputTypes;
    requireField(indexIn(index, available.length) && available[index] === STEP_TYPES[type].input);
    if (from === 'slot') usedSlots.add(index);
    outputTypes.push(STEP_TYPES[type].output);
    return { type, input: { from, index } };
  });
  requireField(usedSlots.size === parameterSlots.length && INTENT_STEPS[intent].includes(steps.at(-1).type));

  const failedSlots = new Set();
  const failureConditions = projectList(draft.failureConditions, parameterSlots.length, (condition) => {
    requireRecord(condition, ['type', 'slot']);
    const type = requireEnum(condition.type, ['empty-input']);
    const { slot } = condition;
    requireField(indexIn(slot, parameterSlots.length) && !failedSlots.has(slot));
    failedSlots.add(slot);
    return { type, slot };
  });

  const coveredFailures = new Set();
  const syntheticChecks = projectList(draft.syntheticChecks, 16, (check) => {
    requireRecord(check, ['fixture', 'slot', 'expect']);
    const fixture = requireEnum(check.fixture, Object.keys(FIXTURES));
    const { slot } = check;
    requireField(indexIn(slot, parameterSlots.length) && FIXTURES[fixture].type === parameterSlots[slot]);
    const expect = requireEnum(check.expect, ['completed', 'empty-input']);
    const willFail = FIXTURES[fixture].empty && failedSlots.has(slot);
    requireField(expect === (willFail ? 'empty-input' : 'completed'));
    if (willFail) coveredFailures.add(slot);
    return { fixture, slot, expect };
  });
  requireField(coveredFailures.size === failedSlots.size && syntheticChecks.some((check) => !FIXTURES[check.fixture].empty));
  return { schema: SKILL_PACKAGE_SCHEMA, intent, parameterSlots, steps, failureConditions, syntheticChecks };
}

const serialize = (skill) => Buffer.from(`${JSON.stringify(skill)}\n`, 'utf8');

// The bundled source-lane scanner consumes this same UTF-8 text. The closed
// grammar and byte round trip below precede the scan, including on import.
function scanWithArmor(bytes) {
  return scanSourceText(bytes.toString('utf8'), 'skill-package.json', digestOf(bytes));
}

function manifestFor(skill, digest) {
  return {
    schema: SKILL_PACKAGE_SCHEMA,
    id: `skill-${digest.slice(0, 24)}`,
    version: '1',
    digest,
    syntheticChecks: skill.syntheticChecks,
    permissions: [],
  };
}

/** Verify the exact bytes against a digest from the approved local record. */
export async function verifySkillPackage(input, expectedDigest, { scanPackage = scanWithArmor } = {}) {
  if (!(input instanceof Uint8Array) || input.byteLength > MAX_PACKAGE_BYTES) return refuse('invalid-package');
  const bytes = Buffer.from(input);
  const digest = digestOf(bytes);
  if (digest !== expectedDigest) return refuse('digest-mismatch');
  const text = bytes.toString('utf8');
  if (looksSecret(text)) return refuse('secret-material');

  let skill;
  try {
    const decoded = JSON.parse(text);
    if (decoded?.schema !== SKILL_PACKAGE_SCHEMA) return refuse('invalid-package');
    skill = projectDeclaration(decoded, ['schema', ...PACKAGE_FIELDS]);
    if (!serialize(skill).equals(bytes)) return refuse('noncanonical-package');
  } catch (error) {
    return refuse(error instanceof InvalidDeclaration ? error.message : 'invalid-package');
  }

  const scanBytes = Buffer.from(bytes);
  try {
    const report = await scanPackage(scanBytes);
    if (!scanBytes.equals(bytes) || report?.target_sha256 !== digest) return refuse('armor-digest-mismatch');
    if (report.format !== 'scripture-armor-scan/1' || report.target_class !== 'source'
      || report.engine?.name !== 'scripture-lexical' || report.engine.rules !== SCAN_RULES_VERSION
      || report.verdict !== 'pass' || report.analysis_confidence !== 'full' || report.override !== null
      || !Array.isArray(report.findings) || report.findings.some((finding) => finding?.severity !== 'info')) {
      return refuse('armor-refused');
    }
  } catch {
    return refuse('armor-unavailable');
  }
  return { ok: true, manifest: manifestFor(skill, digest) };
}

/** Review evidence locally before releasing any transferable bytes. The trusted
 * reviewer independently verifies provenance and redistribution rights and
 * rules out confidential know-how for this digest. Its evidence stays local. */
export async function prepareSkillContribution(draft, { provenance, reviewProvenance, scanPackage } = {}) {
  let bytes;
  try {
    bytes = serialize(projectDeclaration(draft));
  } catch (error) {
    return refuse(error instanceof InvalidDeclaration ? error.message : 'invalid-declaration');
  }
  if (provenance == null || typeof reviewProvenance !== 'function') return refuse('provenance-unverified');
  const digest = digestOf(bytes);
  const reviewBytes = Buffer.from(bytes);
  try {
    const review = await reviewProvenance({ bytes: reviewBytes, digest, provenance });
    if (!reviewBytes.equals(bytes) || review?.digest !== digest || review.provenance !== 'verified') {
      return refuse('provenance-unverified');
    }
    if (review.redistributionRights !== 'authorized') return refuse('rights-unverified');
    if (review.confidentialKnowHow !== 'absent') return refuse('confidentiality-unverified');
  } catch {
    return refuse('provenance-unverified');
  }
  const verified = await verifySkillPackage(bytes, digest, { scanPackage });
  return verified.ok ? { ...verified, bytes } : verified;
}
