// An isolated collective for tested skill packages. Callers supply disposable
// state, a test signing key, and the distiller's exact-byte verifier.
import { createHash, randomBytes, randomUUID, sign, verify } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson } from '../vendor/fleet/fleet-packet.mjs';

const PACKAGE_SCHEMA = 'kingmaker.skill-package/1';
const RECEIPT_SCHEMA = 'kingmaker.test-collective-skill-receipt/1';
const MAX_BYTES = 64 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
const CHALLENGE = /^[a-f0-9]{32}$/;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const pinOf = ({ id, version, digest }) => ({ id, version, digest });
const validPin = (pin) => typeof pin?.digest === 'string' && SHA256.test(pin.digest)
  && pin.id === `skill-${pin.digest.slice(0, 24)}` && pin.version === '1';
const samePin = (a, b) => a.id === b.id && a.version === b.version && a.digest === b.digest;
const signatureInput = (receipt) => Buffer.from(canonicalJson(receipt));

async function inspect(bytes, pin, verifyPackage) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_BYTES) return null;
  const exact = Buffer.from(bytes);
  const digest = sha256(exact);
  if (pin && (!validPin(pin) || pin.digest !== digest)) return null;
  let checked;
  try { checked = await verifyPackage(Buffer.from(exact), digest); } catch { return null; }
  const manifest = checked?.manifest;
  if (checked?.ok !== true || manifest?.schema !== PACKAGE_SCHEMA || !validPin(manifest)
      || manifest.digest !== digest || (pin && !samePin(manifest, pin))
      || !Array.isArray(manifest.syntheticChecks) || !manifest.syntheticChecks.length
      || !Array.isArray(manifest.permissions) || manifest.permissions.length !== 0) return null;
  return { bytes: exact, pin: Object.freeze(pinOf(manifest)), permissions: Object.freeze([]) };
}

function verifiedReceipt(receipt, pin, challenge, publicKey) {
  if (!receipt || receipt.schema !== RECEIPT_SCHEMA || !samePin(receipt, pin)
      || receipt.challenge !== challenge || typeof receipt.signature !== 'string'
      || !['accepted', 'refused', 'revoked'].includes(receipt.decision)) return false;
  const { signature, ...unsigned } = receipt;
  try {
    return publicKey.type === 'public' && publicKey.asymmetricKeyType === 'ed25519'
      && verify(null, signatureInput(unsigned), publicKey, Buffer.from(signature, 'base64'));
  } catch { return false; }
}

/** A disposable host. A passing test must return the digest it actually ran. */
export function createTestSkillCollective({ signingKey, verifyPackage, testPackage }) {
  if (signingKey?.type !== 'private' || signingKey.asymmetricKeyType !== 'ed25519'
      || typeof verifyPackage !== 'function' || typeof testPackage !== 'function') {
    throw new Error('The test collective needs an Ed25519 key, package verifier and synthetic test runner.');
  }
  const packages = new Map();
  const pending = new Map();
  const events = [];
  const keyOf = (pin) => `${pin.id}@${pin.version}`;

  function signed(pin, decision, reason = null, challenge = null) {
    const unsigned = { schema: RECEIPT_SCHEMA, ...pin, decision, reason, challenge };
    return Object.freeze({ ...unsigned, signature: sign(null, signatureInput(unsigned), signingKey).toString('base64') });
  }

  function record(pin, decision, reason = null, duplicate = false) {
    const receipt = pin ? signed(pin, decision, reason) : null;
    events.push({ pin, decision, reason, duplicate, receipt });
    return { receipt, duplicate };
  }

  function recordedSubmission(pin, key, duplicate) {
    const entry = packages.get(key);
    if (!entry) return record(pin, 'refused', 'synthetic-checks-failed');
    if (!samePin(entry.pin, pin)) return record(pin, 'refused', 'version-conflict');
    if (entry.revoked) return record(pin, 'refused', 'revoked');
    return record(pin, 'accepted', null, duplicate);
  }

  async function submit({ bytes, pin } = {}) {
    if (!validPin(pin)) return record(null, 'refused', 'invalid-pin');
    pin = Object.freeze(pinOf(pin));
    const checked = await inspect(bytes, pin, verifyPackage);
    if (!checked) return record(pin, 'refused', 'invalid-package');
    const key = keyOf(pin);
    if (packages.has(key)) return recordedSubmission(pin, key, true);
    const inFlight = pending.get(key);
    if (inFlight) {
      await inFlight;
      return recordedSubmission(pin, key, true);
    }

    // Set the in-flight promise before testing so retries share a passing result.
    const settle = Promise.resolve().then(async () => {
      let result;
      try { result = await testPackage(Buffer.from(checked.bytes), pin); } catch { /* recorded as a refusal */ }
      if (result?.ok === true && result.digest === pin.digest) {
        packages.set(key, { ...checked, revoked: false });
      }
    });
    pending.set(key, settle);
    try { await settle; } finally { pending.delete(key); }
    return recordedSubmission(pin, key, false);
  }

  function lookup({ pin, challenge } = {}) {
    if (!validPin(pin) || typeof challenge !== 'string' || !CHALLENGE.test(challenge)) return null;
    pin = pinOf(pin);
    const entry = packages.get(keyOf(pin));
    if (!entry || !samePin(entry.pin, pin)) return { receipt: signed(pin, 'refused', 'package-unavailable', challenge) };
    if (entry.revoked) return { receipt: signed(pin, 'revoked', 'package-revoked', challenge) };
    return { receipt: signed(pin, 'accepted', null, challenge), bytes: Buffer.from(entry.bytes) };
  }

  function revoke(pin) {
    if (!validPin(pin)) return false;
    const entry = packages.get(keyOf(pin));
    if (!entry || !samePin(entry.pin, pin) || entry.revoked) return false;
    entry.revoked = true;
    record(entry.pin, 'revoked', 'package-revoked');
    return true;
  }

  return { submit, lookup, revoke, events: () => events.map((entry) => ({ ...entry })) };
}

const packagePath = (state, lane, pin) => join(state, 'collective-skills', lane, `${pin.digest}.json`);

function savePackage(state, lane, { bytes, pin }) {
  mkdirSync(join(state, 'collective-skills', lane), { recursive: true, mode: 0o700 });
  const target = packagePath(state, lane, pin);
  const temp = `${target}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, bytes, { flag: 'wx', mode: 0o600 });
    renameSync(temp, target);
  } finally {
    try { unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return target;
}

async function permitted(authorize, operation, { pin, permissions }) {
  try { return await authorize?.({ operation, ...pin, permissions }) === true; } catch { return false; }
}

/** Keep the tested artifact before requesting publication and record the result locally. */
export async function publishTestedSkill({ state, bytes, transport, publicKey, verifyPackage, authorize }) {
  const checked = await inspect(bytes, null, verifyPackage);
  if (!checked) return { ok: false, reason: 'invalid-package' };
  const { pin } = checked;
  const path = savePackage(state, 'outbox', checked);
  function record(reason, receipt = null) {
    const outcome = { ok: reason === null, ...pin, reason, receipt, path };
    appendFileSync(join(state, 'collective-skills', 'publication.jsonl'), JSON.stringify(outcome) + '\n', { mode: 0o600 });
    return outcome;
  }
  if (!await permitted(authorize, 'publish', checked)) return record('publication-denied');
  let response;
  try { response = await transport.submit({ bytes: Buffer.from(checked.bytes), pin }); } catch { return record('upload-failed'); }
  const receipt = response?.receipt && Object.freeze({ ...response.receipt });
  if (!verifiedReceipt(receipt, pin, null, publicKey)) return record('unverified-receipt');
  return record(receipt.decision === 'accepted' ? null : (receipt.reason || receipt.decision), receipt);
}

/** A peer uses its own authorization and runner, with current status checked on every call. */
export function createCollectiveSkillPeer({ state, transport, publicKey, verifyPackage, authorize, run }) {
  async function fetchVerified(pin) {
    if (!validPin(pin)) return { ok: false, reason: 'invalid-pin' };
    const challenge = randomBytes(16).toString('hex');
    let response;
    try { response = await transport.lookup({ pin, challenge }); } catch { return { ok: false, reason: 'lookup-failed' }; }
    const receipt = response?.receipt && Object.freeze({ ...response.receipt });
    if (!verifiedReceipt(receipt, pin, challenge, publicKey)) return { ok: false, reason: 'unverified-receipt' };
    if (receipt.decision !== 'accepted') return { ok: false, reason: receipt.reason || receipt.decision, receipt };
    const checked = await inspect(response.bytes, pin, verifyPackage);
    if (!checked) return { ok: false, reason: 'invalid-package' };
    return { ok: true, checked, receipt };
  }

  async function importSkill(pin) {
    if (!validPin(pin)) return { ok: false, reason: 'invalid-pin' };
    pin = Object.freeze(pinOf(pin));
    const fetched = await fetchVerified(pin);
    if (!fetched.ok) return fetched;
    const path = savePackage(state, 'imported', fetched.checked);
    return { ok: true, ...pin, receipt: fetched.receipt, path };
  }

  async function invoke(pin, input) {
    if (!validPin(pin)) return { ok: false, reason: 'invalid-pin' };
    pin = Object.freeze(pinOf(pin));
    let bytes;
    try { bytes = readFileSync(packagePath(state, 'imported', pin)); } catch { return { ok: false, reason: 'not-imported' }; }
    const checked = await inspect(bytes, pin, verifyPackage);
    if (!checked) return { ok: false, reason: 'invalid-package' };
    const fetched = await fetchVerified(pin);
    if (!fetched.ok) return fetched;
    if (!await permitted(authorize, 'invoke', checked)) {
      return { ok: false, reason: 'peer-permission-denied' };
    }
    const artifact = await run({ ...pin, bytes: checked.bytes, input, permissions: checked.permissions });
    return { ok: true, ...pin, artifact };
  }

  return { importSkill, invoke };
}
