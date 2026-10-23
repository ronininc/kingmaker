#!/usr/bin/env node
// scripts/mint-entitlement.mjs — OWNER-ONLY. Mint a ronin.entitlement/1 for a paid add-on, signed with Ronin's install-
// certificate private key (ES256), and write the envelope to a file. It is exactly what lib/addons.mjs
// verifyEntitlementEnvelope accepts and what update-host/worker.js serves an add-on to: { payload, sig, alg: 'ES256' },
// payload = the claims as JSON, sig = ECDSA P-256 SHA-256 over the payload's UTF-8 bytes, ASN.1/DER, standard base64.
//
//   node scripts/mint-entitlement.mjs --sku addon.ronin-office (--this-mac | --install <installId> [--device <sha256>])
//        [--days N | --no-expiry] [--order <ref>] [--key <private.pem>] [--out <file>] [--pub <public.pem>]
//
//   --sku        the add-on's sku (addon.<id>), e.g. addon.ronin-office
//   --this-mac   the installId and device hash THIS Mac's Kingmaker already uses: the install certificate the installer
//                stored in the login Keychain (service com.ronininc.ronin-launcher, account kingmaker-install-cert). A Mac
//                with none (it enrolled before certificates) gets owner-<hostname> and the installer's device hash, said in the output
//   --install    an installId by hand (with --device for the device hash; omit it to bind the install id only)
//   --days N     expires N days from now. --no-expiry (the default) never expires; revoke it at the update host instead
//   --order      an opaque order ref. Without one, the update host keys revocation by "<installId>:<sku>"
//   --key        the private key (PKCS#8 PEM). Default: ~/.solomon-secure/ronin-install-cert/cert-private-pkcs8.pem. Read
//                here, used to sign, never printed or copied
//   --out        where to write the envelope (0600). Default ./ronin-entitlement.json
//   --pub        the public key the minted envelope must verify against before it is written. Default: the pinned
//                lib/ronin-install-cert-public.pem, so a key that Kingmaker would refuse is never written
import { createHash, createPrivateKey, createPublicKey, createSign } from 'node:crypto';
import { chmodSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir, hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CERT_KEY_PEM, verifyEntitlementEnvelope } from '../lib/addons.mjs';
import { pubkeyFingerprint } from '../lib/release-signing.mjs';

export const ENTITLEMENT_SCHEMA = 'ronin.entitlement/1';
export const ENTITLEMENT_ISSUER = 'ronin-update-host';
export const DEFAULT_KEY_PATH = join(homedir(), '.solomon-secure', 'ronin-install-cert', 'cert-private-pkcs8.pem');
export const DEFAULT_OUT = 'ronin-entitlement.json';
/** Where the installer stored this Mac's install certificate (installer/engine.sh): the login Keychain. */
export const CERT_KEYCHAIN = Object.freeze({ service: 'com.ronininc.ronin-launcher', account: 'kingmaker-install-cert' });

const DAY_MS = 86_400_000;
const SKU_RE = /^addon\.[a-z0-9][a-z0-9-]{0,38}$/;
const INSTALL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/; // an installId is an opaque label (the host's /enroll issues UUIDs; owner-<host> is allowed)
const DEVICE_RE = /^[0-9a-f]{16,64}$/i;
const ORDER_RE = /^[\w.:/+=@-]{1,128}$/;

/** The sha256 of this Mac's hardware UUID — the device hash the installer enrolled with (never the UUID itself). */
export function thisMacDeviceHash(run = execFileSync) {
  const out = String(run('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf8' }));
  const uuid = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(out)?.[1];
  if (!uuid) throw new Error('could not read this Mac\'s hardware id');
  return sha256Hex(uuid + '\n'); // the installer pipes awk's line (with its newline) through shasum
}
const sha256Hex = (s) => createHash('sha256').update(s).digest('hex');

/** `owner-<this Mac's local hostname>`, lowercased to [a-z0-9-] and at most 64 characters. */
export function ownerInstallId(run = execFileSync, host = hostname) {
  let name = '';
  try { name = String(run('/usr/sbin/scutil', ['--get', 'LocalHostName'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })).trim(); } catch { /* fall back below */ }
  const slug = (name || String(host())).toLowerCase().replace(/\.local$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 57);
  return `owner-${slug || 'mac'}`;
}

/**
 * The installId and device hash this Mac's Kingmaker already uses: the claims of the install certificate in the login
 * Keychain. `run(cmd, args)` returns stdout (injectable for tests). Returns { installId, deviceSha256, source, note }.
 *
 * A Mac that enrolled before certificates were issued has none, and the engine keeps no install or device id on disk
 * (install.json holds the wake word and release, update.json the host and key). Then, and only when the Keychain says
 * the item is not there, the id is `owner-<hostname>` and the device hash is computed exactly as the installer enrolls
 * it (sha256 of the hardware UUID), and `source` says so. Any other Keychain failure (locked, denied) throws.
 */
export function readThisMac({ run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), deviceHash = () => thisMacDeviceHash(), hostId = () => ownerInstallId() } = {}) {
  let raw;
  try { raw = String(run('/usr/bin/security', ['find-generic-password', '-s', CERT_KEYCHAIN.service, '-a', CERT_KEYCHAIN.account, '-w'])).trim(); }
  catch (e) {
    if (e?.status !== 44) throw new Error(`could not read the install certificate from the login Keychain (${CERT_KEYCHAIN.service} / ${CERT_KEYCHAIN.account}): unlock the login Keychain and allow it, or pass --install <installId> --device <sha256> by hand.`);
    return { installId: hostId(), deviceSha256: String(deviceHash()).toLowerCase(), source: 'derived', note: 'no install certificate is stored on this Mac (it enrolled before certificates were issued), and Kingmaker keeps no install id on disk: using the install id owner-<hostname> and the device hash computed the way the installer does (sha256 of the hardware UUID).' };
  }
  // `security -w` prints a value with unprintable bytes as hex; the certificate is plain JSON, so decode only that case.
  if (raw && !raw.startsWith('{') && /^([0-9a-f]{2})+$/i.test(raw)) raw = Buffer.from(raw, 'hex').toString('utf8');
  let claims;
  try { claims = JSON.parse(JSON.parse(raw).payload); } catch { throw new Error('the install certificate in the Keychain is not readable (expected { payload, sig, alg }).'); }
  const installId = String(claims?.installId || ''), cert = String(claims?.deviceSha256 || '');
  if (!INSTALL_RE.test(installId)) throw new Error('the install certificate carries no usable installId.');
  if (!DEVICE_RE.test(cert)) throw new Error('the install certificate carries no usable device hash.');
  let note = null;
  try { const here = deviceHash(); if (here && here.toLowerCase() !== cert.toLowerCase()) note = 'the certificate\'s device hash differs from this Mac\'s hardware id hash (a restored or migrated Mac?); the certificate\'s value is used, as the installer enrolled it.'; } catch { /* the cross-check is advisory */ }
  return { installId, deviceSha256: cert.toLowerCase(), source: 'certificate', note };
}

/**
 * Build and sign an entitlement. Pure but for the clock. Returns { envelope, claims }.
 *   privateKeyPem  PKCS#8 (or SEC1) PEM of a P-256 key; any other key type is refused
 *   days           expires that many days from `now`; null/undefined = never
 */
export function mintEntitlement({ privateKeyPem, sku, installId, deviceSha256 = null, days = null, order = null, now = Date.now }) {
  if (!SKU_RE.test(String(sku || ''))) throw new Error('--sku must look like addon.<id> (e.g. addon.ronin-office).');
  if (!INSTALL_RE.test(String(installId || ''))) throw new Error('the installId must be 3-64 letters, digits, . _ or -.');
  if (deviceSha256 && !DEVICE_RE.test(String(deviceSha256))) throw new Error('the device hash must be 16-64 hex characters.');
  if (order && !ORDER_RE.test(String(order))) throw new Error('--order may hold letters, digits and . _ : / + = @ - only (max 128).');
  if (days != null && !(Number.isFinite(days) && days > 0 && days <= 36500)) throw new Error('--days must be a positive number.');
  let key;
  try { key = createPrivateKey(privateKeyPem); } catch { throw new Error('the private key is not a readable PEM key.'); }
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error('the private key is not an ECDSA P-256 key (ES256).');
  const at = now();
  const claims = {
    schema: ENTITLEMENT_SCHEMA, issuer: ENTITLEMENT_ISSUER, installId: String(installId),
    ...(deviceSha256 ? { deviceSha256: String(deviceSha256).toLowerCase() } : {}),
    sku, grantedAt: new Date(at).toISOString(), expiresAt: days == null ? null : new Date(at + days * DAY_MS).toISOString(),
    ...(order ? { order: String(order) } : {}),
  };
  const payload = JSON.stringify(claims);
  const sig = createSign('sha256').update(Buffer.from(payload, 'utf8')).sign({ key, dsaEncoding: 'der' }).toString('base64');
  return { envelope: { payload, sig, alg: 'ES256' }, claims };
}

/** The public key's fingerprint, from a PEM path or buffer (for the printed line; never the private key). */
const pubFingerprint = (pem) => pubkeyFingerprint(createPublicKey(pem).export({ type: 'spki', format: 'pem' }));

export function parseArgs(argv) {
  const o = { sku: null, install: null, device: null, thisMac: false, days: null, noExpiry: false, order: null, key: DEFAULT_KEY_PATH, out: DEFAULT_OUT, pub: null, help: false };
  const val = (i, name) => { if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new Error(`${name} needs a value`); return argv[i + 1]; };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--sku') o.sku = val(i++, a);
    else if (a === '--install') o.install = val(i++, a);
    else if (a === '--device') o.device = val(i++, a);
    else if (a === '--this-mac') o.thisMac = true;
    else if (a === '--days') { o.days = Number(val(i++, a)); if (!(o.days > 0)) throw new Error('--days must be a positive number'); }
    else if (a === '--no-expiry') o.noExpiry = true;
    else if (a === '--order') o.order = val(i++, a);
    else if (a === '--key') o.key = val(i++, a);
    else if (a === '--out') o.out = val(i++, a);
    else if (a === '--pub') o.pub = val(i++, a);
    else if (a === '--help' || a === '-h') o.help = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (o.days != null && o.noExpiry) throw new Error('--days and --no-expiry are opposites; pick one');
  return o;
}

const USAGE = (() => {
  const lines = readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n');
  const from = lines.findIndex((l) => l.startsWith('//   node scripts/'));
  const to = lines.findIndex((l, i) => i > from && !l.startsWith('//'));
  return lines.slice(from, to).map((l) => l.replace(/^\/\/ ?/, '')).join('\n');
})();

/**
 * The CLI. `io` is injectable: { out, err, now, thisMac }. Returns the exit code; prints no key material, ever.
 */
export function run(argv, io = {}) {
  const out = io.out ?? ((s) => console.log(s)), err = io.err ?? ((s) => console.error(s));
  let o;
  try { o = parseArgs(argv); } catch (e) { err(`mint-entitlement: ${e.message}\n\n${USAGE}`); return 2; }
  if (o.help) { out(USAGE); return 0; }
  try {
    if (!o.sku) throw new Error('--sku is required (e.g. --sku addon.ronin-office)');
    if (o.thisMac && o.install) throw new Error('--this-mac and --install are two ways to say which Mac; pick one');
    if (!o.thisMac && !o.install) throw new Error('say which Mac: --this-mac, or --install <installId> [--device <sha256>]');
    let installId = o.install, deviceSha256 = o.device, source = 'by hand';
    if (o.thisMac) {
      const mac = (io.thisMac ?? readThisMac)();
      installId = mac.installId; deviceSha256 = mac.deviceSha256; source = mac.source === 'derived' ? 'DERIVED: no install certificate on this Mac, so owner-<hostname> and the installer\'s device hash' : 'this Mac\'s install certificate';
      if (mac.note) err(`note: ${mac.note}`);
    }
    let privateKeyPem;
    try {
      const mode = statSync(o.key).mode;
      if (mode & 0o077) err(`warning: ${o.key} is readable by other users (mode ${(mode & 0o777).toString(8)}); chmod 600 it.`);
      privateKeyPem = readFileSync(o.key);
    } catch { throw new Error(`could not read the private key at ${o.key} (pass --key <path>)`); }
    const { envelope, claims } = mintEntitlement({ privateKeyPem, sku: o.sku, installId, deviceSha256, days: o.noExpiry ? null : o.days, order: o.order, now: io.now ?? Date.now });
    // Refuse to write what Kingmaker would refuse: the envelope must verify against the pinned (or given) public key.
    const pubPem = readFileSync(o.pub ? resolve(o.pub) : CERT_KEY_PEM);
    if (!verifyEntitlementEnvelope(envelope, pubPem)) throw new Error(`the minted entitlement does not verify against ${o.pub ? o.pub : 'the pinned lib/ronin-install-cert-public.pem'}: this is not the key that matches it. Nothing written.`);
    writeFileSync(o.out, `${JSON.stringify(envelope)}\n`, { mode: 0o600 });
    try { chmodSync(o.out, 0o600); } catch { /* best effort */ }
    out(`Minted ${claims.sku} for install ${claims.installId} (${source}${claims.deviceSha256 ? `, device ${claims.deviceSha256.slice(0, 12)}…` : ', no device binding'})`);
    out(`  expires:   ${claims.expiresAt ?? 'never'}${claims.order ? `\n  order:     ${claims.order}` : '\n  revoke as: install id or "<installId>:<sku>" at the update host'}`);
    out(`  verifies:  against public key ${pubFingerprint(pubPem)}`);
    out(`  written:   ${o.out} (0600)`);
    return 0;
  } catch (e) { err(`mint-entitlement: ${e.message}`); return 1; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(run(process.argv.slice(2)));
