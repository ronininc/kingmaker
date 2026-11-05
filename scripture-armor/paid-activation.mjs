import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = 'ronin.scripture-armor-paid-activation/v1';
const FILE = 'paid-activation.json';

function canonical(record) {
  return JSON.stringify({ schema: record.schema, product: record.product, signFp: record.signFp, sealFp: record.sealFp, activatedAt: record.activatedAt, entitlementVerifiedAt: record.entitlementVerifiedAt, entitlementTermEnd: record.entitlementTermEnd });
}

function markerPath(identityDir) { return path.join(identityDir, FILE); }

export function recordPaidActivation(identityDir, identity, entitlement, at = new Date().toISOString()) {
  const record = {
    schema: SCHEMA,
    product: 'scripture-armor',
    signFp: identity.signFp,
    sealFp: identity.sealFp,
    activatedAt: at,
    entitlementVerifiedAt: entitlement.verifiedAt,
    entitlementTermEnd: entitlement.term.endsAt,
  };
  record.signature = crypto.sign(null, Buffer.from(canonical(record)), identity.signPriv).toString('base64url');
  fs.mkdirSync(identityDir, { recursive: true, mode: 0o700 });
  const file = markerPath(identityDir);
  const temp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  fs.renameSync(temp, file);
  fs.chmodSync(file, 0o600);
  return record;
}

export function loadPaidActivation(identityDir, identity) {
  const file = markerPath(identityDir);
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (record?.schema !== SCHEMA || record?.product !== 'scripture-armor'
      || record?.signFp !== identity.signFp || record?.sealFp !== identity.sealFp
      || typeof record?.activatedAt !== 'string'
      || !Number.isInteger(record?.entitlementVerifiedAt) || !Number.isInteger(record?.entitlementTermEnd)
      || typeof record?.signature !== 'string') return null;
    const signature = Buffer.from(record.signature, 'base64url');
    return crypto.verify(null, Buffer.from(canonical(record)), identity.signPub, signature) ? record : null;
  } catch { return null; }
}

export function hasPaidActivation(identityDir, identity) { return Boolean(identity && loadPaidActivation(identityDir, identity)); }
