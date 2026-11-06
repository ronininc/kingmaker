// submit-request.mjs — "Submit a request to Ronin Inc": the standard in-product request
// item, Scripture Armor staging (spec: ~/workspace/submit-request-item-2026-11-05/SPEC.md
// §1 + §3.2; record contract ronin.submit-request/1).
//
// THE STANDARD, as it binds this product:
//   • Label, verbatim: "Submit a request to Ronin Inc". It presents as a contact entry
//     point ("Contact Support" / "Contact the Ronin team") with the request types under it.
//   • Fields: request type (brain / method / tool / other), name of the thing, source
//     (repo URL or origin), description of what it does, license if known, free-text notes.
//   • Requester identity is PREFILLED from Armor's own account session and is never a
//     form field: identity-shaped keys inside a submission are never read, so a request
//     can only ever be filed under the signed-in member. Armor's account session proves
//     the member by the registered email (account-session.mjs); that email is the member
//     identity the CRM's Armor funnel keys on, so it fills both requester fields the
//     session can honestly supply (memberId and email are the same account identifier).
//   • On submit the record is written toward the CRM intake as PENDING OWNER GATE. The
//     gate is the owner personally. NOTHING auto-enters any library, and this surface is
//     a PLAIN request surface: Armor does not scan the submission, does not seal it as
//     admitted content, and does not treat filing as any kind of verdict — order-class
//     input is human-gated, never scan-gated. (Armor verifies artifacts, never orders.)
//   • The gate status is set at filing and NO transport, route, or downstream system may
//     move it. A transport's answer is delivery state only.
//   • An acknowledgment goes to the submitter's registered email; its copy is PENDING
//     OWNER REVIEW — this module never invents it and sends no mail. The confirmation
//     the member sees says the request was received and is pending review: no promise,
//     no timeline. Silence after the acknowledgment means pending, never rejection.
//   • Attachments (gap-7 custody): a submitted file lands in a DISPOSABLE vault cell
//     under the product store — copied byte-for-byte, never opened, parsed, scanned, or
//     executed by this surface. The record carries only the custody reference.
//
// Delivery: the record is queued FIRST in the product's own store (queue-first is the
// invariant — a refused or failed send loses nothing), then handed to an injected
// transport. A live transport MUST be the guarded one (submit-transport-guard.mjs:
// destination binding + egress-policy check + vaultd liveness, with this same local
// queue as its fail-closed fallback). flush() retries the queue when the intake answers.

import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { productPaths } from './product-paths.mjs';

export const SUBMIT_REQUEST_LABEL = 'Submit a request to Ronin Inc';
export const SUBMISSION_SCHEMA = 'ronin.submit-request/1';
export const GATE_STATUS = 'PENDING OWNER GATE';
export const PRODUCT_OF_ORIGIN = 'scripture-armor';
export const REQUEST_TYPES = Object.freeze(['brain', 'method', 'tool', 'other']);

/** The form fields, in display order. Identity is deliberately absent — it is prefilled. */
export const REQUEST_FIELDS = Object.freeze([
  { key: 'type', label: 'Request type', required: true, enum: REQUEST_TYPES },
  { key: 'name', label: 'Name of the thing', required: true },
  { key: 'source', label: 'Source (repo URL or origin)', required: true },
  { key: 'description', label: 'What it does', required: true },
  { key: 'license', label: 'License, if known', required: false },
  { key: 'notes', label: 'Notes', required: false },
]);

const clean = (v) => String(v ?? '').trim();

/**
 * The prefill source: Armor's account session (account-session.mjs). Its state proves
 * the member by registered email only — that email is the account identifier the CRM's
 * Armor funnel keys members on, so it is the memberId this product can honestly file.
 * Throws unless the session is authenticated: a request is filed under a signed-in
 * member or not at all.
 */
export function accountFromSession(session) {
  const state = typeof session?.state === 'function' ? session.state() : null;
  if (!state?.authenticated || !clean(state.email)) {
    throw new Error('Sign in and verify your email code first — a request is filed under your signed-in account only.');
  }
  const email = clean(state.email).toLowerCase();
  return { memberId: email, email };
}

/**
 * Pure: build the CRM-intake record from the product account + the member's form input.
 * Throws an Error naming the first problem; a caller shows that name and records nothing.
 * Identity comes ONLY from `account` ({ memberId, email, name? }). Identity-shaped keys
 * in `input` are never read. `attachments` are custody references already landed in the
 * disposable vault (see landAttachment) — references only, never content.
 */
export function buildSubmission({ account, input = {}, attachments = [], now = new Date(), id = randomUUID() } = {}) {
  const memberId = clean(account?.memberId);
  const email = clean(account?.email).toLowerCase();
  if (!memberId || !email) throw new Error('no signed-in member account to prefill the requester identity from');
  const type = clean(input.type);
  if (!REQUEST_TYPES.includes(type)) throw new Error(`request type must be one of: ${REQUEST_TYPES.join(', ')}`);
  const name = clean(input.name);
  if (!name) throw new Error('name of the thing is required');
  const source = clean(input.source);
  if (!source) throw new Error('source (repo URL or origin) is required');
  const description = clean(input.description);
  if (!description) throw new Error('a description of what it does is required');
  const refs = attachments.map((ref) => {
    if (!ref || typeof ref.vaultRef !== 'string' || !ref.vaultRef) throw new Error('attachment references must be landed vault references');
    return { name: clean(ref.name), size: ref.size, sha256: ref.sha256, vaultRef: ref.vaultRef, custody: 'disposable-vault-cell' };
  });
  const submittedAt = (now instanceof Date ? now : new Date(now)).toISOString();
  return {
    schema: SUBMISSION_SCHEMA,
    id,
    submittedAt,
    productOfOrigin: PRODUCT_OF_ORIGIN,
    status: GATE_STATUS,
    gate: 'owner-personal',
    requester: { memberId, email, ...(clean(account?.name) ? { name: clean(account.name) } : {}) },
    request: {
      type,
      name,
      source,
      description,
      license: clean(input.license) || 'unknown',
      notes: clean(input.notes),
    },
    ...(refs.length ? { attachments: refs } : {}),
    acknowledgment: { to: email, copyStatus: 'PENDING OWNER REVIEW' },
  };
}

/** Pure: the confirmation the member sees (spec §1.4 reference wording, verbatim shape).
 *  Received + pending review; no promise, no timeline. */
export function confirmationFor(record) {
  return [
    `${SUBMIT_REQUEST_LABEL} — received.`,
    `Request ${record.id} (${record.request.type}: ${record.request.name}) is recorded and pending review.`,
    'There is no timeline for review, and a request is not accepted until Ronin Inc says so.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// The local queue — the product's own store. A queued record is still
// PENDING OWNER GATE, never a local admission. The record is serialized at
// enqueue; what later moves (delivery receipts) is tracked AROUND that line,
// never inside it, so neither a transport nor a retry can alter the filed
// record — least of all its gate status.
// ---------------------------------------------------------------------------

export function submitQueueDir({ identityDir } = {}) {
  return path.join(identityDir || productPaths().identityDir, 'submit-requests');
}

export function createRequestQueue({ dir } = {}) {
  if (!clean(dir)) throw new Error('a queue directory is required');
  const queueFile = path.join(dir, 'requests-queue.jsonl');
  const deliveredFile = path.join(dir, 'requests-delivered.jsonl');
  const ensure = () => fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const readLines = (file) => {
    try { return fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim()); }
    catch { return []; }
  };
  const rewriteQueue = (lines) => {
    ensure();
    const tmp = `${queueFile}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, lines.length ? `${lines.join('\n')}\n` : '', { mode: 0o600 });
    fs.renameSync(tmp, queueFile);
  };
  return {
    dir, queueFile, deliveredFile,
    enqueue(record) {
      ensure();
      fs.appendFileSync(queueFile, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    },
    pending() {
      return readLines(queueFile).map((line) => JSON.parse(line));
    },
    /** Move one queued record to the delivered log, VERBATIM as filed, with its receipt. */
    acknowledge(id, receipt) {
      const lines = readLines(queueFile);
      const index = lines.findIndex((line) => { try { return JSON.parse(line).id === id; } catch { return false; } });
      if (index < 0) return false;
      const [line] = lines.splice(index, 1);
      ensure();
      fs.appendFileSync(deliveredFile, `${JSON.stringify({ record: JSON.parse(line), receipt, deliveredAt: new Date().toISOString() })}\n`, { mode: 0o600 });
      rewriteQueue(lines);
      return true;
    },
    delivered() {
      return readLines(deliveredFile).map((line) => JSON.parse(line));
    },
  };
}

// ---------------------------------------------------------------------------
// Attachment custody (gap-7): a submitted file lands in a disposable vault
// cell. The bytes are copied and hashed as a custody fact; this surface
// never opens, parses, scans, renders, or executes them. The record carries
// only the reference returned here.
// ---------------------------------------------------------------------------

export function submitVaultDir({ identityDir } = {}) {
  return path.join(identityDir || productPaths().identityDir, 'submit-request-vault');
}

export function landAttachment({ vaultDir, recordId, name, data, sourcePath } = {}) {
  const base = path.basename(String(name || (sourcePath ? path.basename(sourcePath) : '')));
  if (!base || base === '.' || base === '..' || base.length > 256 || /[\\/]/.test(base) || /[\0\r\n]/.test(base)) {
    throw new Error('attachment name must be a plain file name');
  }
  if (!clean(recordId)) throw new Error('a record id is required to land an attachment');
  const cellDir = path.join(vaultDir, recordId);
  fs.mkdirSync(cellDir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(cellDir, 0o700); } catch { /* best effort on exotic filesystems */ }
  const dest = path.join(cellDir, base);
  const hash = createHash('sha256');
  let size = 0;
  const sink = fs.createWriteStream(dest, { mode: 0o600 });
  return new Promise((resolve, reject) => {
    const fail = (error) => { sink.destroy(); try { fs.rmSync(dest, { force: true }); } catch {} reject(error); };
    sink.on('error', fail);
    const pump = (chunk) => { hash.update(chunk); size += chunk.length; if (!sink.write(chunk)) return false; return true; };
    if (Buffer.isBuffer(data)) {
      if (!pump(data)) sink.once('drain', () => sink.end());
      else sink.end();
      sink.on('finish', () => resolve({ name: base, size, sha256: hash.digest('hex'), vaultRef: `armor-vault:submit-requests/${recordId}/${base}` }));
    } else if (clean(sourcePath)) {
      const source = fs.createReadStream(sourcePath);
      source.on('error', fail);
      source.on('data', (chunk) => { if (!pump(chunk)) { source.pause(); sink.once('drain', () => source.resume()); } });
      source.on('end', () => sink.end());
      sink.on('finish', () => resolve({ name: base, size, sha256: hash.digest('hex'), vaultRef: `armor-vault:submit-requests/${recordId}/${base}` }));
    } else {
      fail(new Error('an attachment needs bytes or a source path'));
    }
  });
}

// ---------------------------------------------------------------------------
// The submitter. Queue-first: the record is durable in the local queue
// BEFORE any transport runs, so a guard refusal or a dead intake costs
// nothing — delivery simply stays 'queued-local' until a guarded send (or a
// flush) succeeds. The transport's answer is recorded as delivery state
// only; it cannot change the record's gate status.
// ---------------------------------------------------------------------------

export function createArmorSubmitter({ account, session, queue, queueDir, vaultDir, transport, now } = {}) {
  const theQueue = queue ?? createRequestQueue({ dir: queueDir ?? submitQueueDir() });
  const theVaultDir = vaultDir ?? submitVaultDir();
  const resolveAccount = () => account ?? accountFromSession(session);
  async function attempt(record) {
    if (!transport) return 'queued-local';
    try {
      const receipt = await transport(record);
      const delivery = receipt?.delivery ?? 'sent-to-crm-intake';
      if (delivery === 'sent-to-crm-intake') theQueue.acknowledge(record.id, receipt ?? { delivery });
      return delivery;
    } catch {
      return 'queued-local';
    }
  }
  return {
    queue: theQueue,
    async submit(input = {}, { attachments = [] } = {}) {
      const acct = resolveAccount();
      const id = randomUUID();
      const refs = [];
      for (const attachment of attachments) {
        refs.push(await landAttachment({ vaultDir: theVaultDir, recordId: id, ...attachment }));
      }
      const record = buildSubmission({ account: acct, input, attachments: refs, now: typeof now === 'function' ? now() : now, id });
      theQueue.enqueue(record);
      const delivery = await attempt(record);
      const digest = createHash('sha256').update(JSON.stringify(record)).digest('hex');
      return { ok: true, record, delivery, digest, confirmation: confirmationFor(record) };
    },
    /** Retry every queued record through the transport (the intake answering again). */
    async flush() {
      let delivered = 0;
      const pending = theQueue.pending();
      for (const record of pending) {
        if ((await attempt(record)) === 'sent-to-crm-intake') delivered++;
        else break; // the intake is still not answering; keep the rest queued in order
      }
      return { attempted: pending.length, delivered, stillQueued: theQueue.pending().length };
    },
  };
}
