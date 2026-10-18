// Kingmaker's update host: release folders in a private R2 bucket, served only to a Mac holding an update key.
// Keys: the operator's hand-made ones (secret UPDATE_KEYS, comma-separated) and one per enrolled Mac (KV DEVICES,
// stored as sha256(key) → {device, name, at, revoked}). POST /enroll is how an installing Mac gets its own key with no
// pasting (operator 2026-10-08: "anyone who downloads it auto gets a Mac key … as easy as possible"): it needs the
// enrollment code the installer carries (secret ENROLL_TOKEN; rotate it if an installer leaks), and any one Mac is
// revoked by setting revoked:true on its record. GET/HEAD only for releases, with Range so a cut-off part resumes.
const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const sha = async (s) => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
async function same(a, b) {
  const [x, y] = await Promise.all([a, b].map((s) => crypto.subtle.digest('SHA-256', enc.encode(s))));
  return crypto.subtle.timingSafeEqual(x, y);
}

export default {
  async fetch(req, env) {
    const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
    const path = new URL(req.url).pathname;
    if (path === '/enroll') return enroll(req, env, token);
    // Public installer download (R2 `public/<name>`, no key; ronininc.org links it): GET|HEAD /download/<name>.dmg|.zip.
    // Only a plain file name is accepted and only the public/ prefix is read, so no release or add-on file is reachable
    // here. Handled before the method check and the key gate; every other path still needs a key.
    if (path.startsWith('/download/') && (req.method === 'GET' || req.method === 'HEAD')) {
      const name = path.slice('/download/'.length);
      if (!/^[\w.-]+\.(dmg|zip)$/.test(name)) return new Response('Not found', { status: 404 });
      const obj2 = await env.RELEASES.get(`public/${name}`, { range: req.headers });
      if (!obj2) return new Response('Not found', { status: 404 });
      const h = new Headers();
      obj2.writeHttpMetadata(h);
      h.set('etag', obj2.httpEtag);
      h.set('accept-ranges', 'bytes');
      h.set('content-disposition', `attachment; filename="${name}"`);
      h.set('cache-control', 'public, max-age=300');
      if (req.headers.has('range') && obj2.range && 'offset' in obj2.range) {
        const start = obj2.range.offset ?? 0;
        const len = obj2.range.length ?? obj2.size - start;
        h.set('content-range', `bytes ${start}-${start + len - 1}/${obj2.size}`);
        h.set('content-length', String(len));
        return new Response(req.method === 'HEAD' ? null : obj2.body, { status: 206, headers: h });
      }
      h.set('content-length', String(obj2.size));
      return new Response(req.method === 'HEAD' ? null : obj2.body, { headers: h });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('Method not allowed', { status: 405 });
    // Paid add-on zips: GET|HEAD /addons/<id>/<version>/<file>. No update key — the entitlement in the
    // x-ronin-entitlement header is the credential (docs/addons.md §4). Handled before the key gate below.
    if (path.startsWith('/addons/')) return serveAddon(req, env);
    const keys = String(env.UPDATE_KEYS || '').split(',').map((k) => k.trim()).filter(Boolean);
    let operator = false;
    for (const k of keys) if (token && await same(k, token)) operator = true;
    // The device's own record (null if the token is not a known device key). Looked up once; a revoked device still
    // has a record, with revoked:true.
    const devRec = !operator && token && env.DEVICES ? await env.DEVICES.get(`key:${await sha(token)}`, 'json') : null;
    // The launcher asks here whether this Mac's install certificate is still good: GET /cert-status with the Mac's
    // update key as the bearer token → {revoked}. This MUST run before the revoked-key rejection below, because a
    // revoked key is exactly when the launcher needs the answer {revoked:true}. Any recognized token (operator or a
    // known device, revoked or not) gets an answer; an unknown token still gets 401.
    if (path === '/cert-status') {
      if (!operator && !devRec) return new Response('Unauthorized', { status: 401 });
      // The launcher/Kingmaker also ask here about a paid-add-on entitlement (docs/addons.md §4): revocation is
      // keyed by the entitlement's own id (?entitlement=, the envelope's order ref) and/or its install id
      // (?install=), so a refund or a lost Mac can kill an add-on just like a revoked install cert. A device key's
      // own record still answers for the install certificate as before.
      return Response.json({ revoked: (await isRevoked(env, entIdFromQuery(req), installIdFromQuery(req))) || Boolean(devRec && devRec.revoked) });
    }
    // Every other path: operator keys always pass; a device key passes only if it is not revoked.
    if (!operator && !(devRec && !devRec.revoked)) return new Response('Unauthorized', { status: 401 });
    // Check-ins: which install asked for latest.json, when, on which version (no IPs, no device details beyond the
    // key's own hash), so the operator can see every install is really checking for updates.
    if (path === '/latest.json' && env.DEVICES) {
      const v = (req.headers.get('x-kingmaker-version') || 'unknown').replace(/[^\w.-]/g, '').slice(0, 20);
      await env.DEVICES.put(`seen:${(await sha(token)).slice(0, 16)}`, JSON.stringify({ at: new Date().toISOString(), version: v }));
    }
    const key = decodeURIComponent(new URL(req.url).pathname.slice(1));
    if (!/^[\w.\-/]+$/.test(key) || key.includes('..')) return new Response('Not found', { status: 404 });
    const obj = await env.RELEASES.get(key, { range: req.headers, onlyIf: req.headers });
    if (!obj) return new Response('Not found', { status: 404 });
    const headers = new Headers();
    obj.writeHttpMetadata(headers);
    headers.set('etag', obj.httpEtag);
    headers.set('accept-ranges', 'bytes');
    headers.set('cache-control', key === 'latest.json' ? 'no-store' : 'private, max-age=0');
    if (!('body' in obj)) return new Response(null, { status: 304, headers });
    if (req.headers.has('range') && obj.range && 'offset' in obj.range) {   // only a request that asked for a range gets a 206
      const start = obj.range.offset ?? 0;
      const len = obj.range.length ?? obj.size - start;
      headers.set('content-range', `bytes ${start}-${start + len - 1}/${obj.size}`);
      headers.set('content-length', String(len));
      return new Response(req.method === 'HEAD' ? null : obj.body, { status: 206, headers });
    }
    headers.set('content-length', String(obj.size));
    return new Response(req.method === 'HEAD' ? null : obj.body, { headers });
  },
};

/* ---------------- paid add-ons (docs/addons.md §4) ---------------- */

// The raw ids from the query, length-bounded but NOT otherwise rewritten — isRevoked derives the KV key losslessly, so
// a lookup matches the serve path's raw signed claim byte-for-byte (an order like `ord/1` or `ord+1` is preserved).
const entIdFromQuery = (req) => (new URL(req.url).searchParams.get('entitlement') || '').slice(0, 128);
const installIdFromQuery = (req) => (new URL(req.url).searchParams.get('install') || '').slice(0, 64);

// The KV marker keys for a revocation. The id is length-bounded and percent-encoded so an opaque order with any
// characters maps to one safe, reversible key — used identically by the serve path and /cert-status; the operator
// revokes by writing `revoked:ent:<encodeURIComponent(order)>` or `revoked:install:<encodeURIComponent(installId)>`.
const revEntKey = (entId) => `revoked:ent:${encodeURIComponent(String(entId).slice(0, 128))}`;
const revInstallKey = (installId) => `revoked:install:${encodeURIComponent(String(installId).slice(0, 64))}`;

/** Has the operator revoked this entitlement (refund/chargeback) or this install id (lost Mac)? Absent DEVICES or no
 *  marker → not revoked. */
async function isRevoked(env, entId, installId) {
  if (!env.DEVICES) return false;
  if (entId && (await env.DEVICES.get(revEntKey(entId)))) return true;
  if (installId && (await env.DEVICES.get(revInstallKey(installId)))) return true;
  return false;
}

/**
 * GET|HEAD /addons/<id>/<version>/<file>: serve a paid add-on's file from R2 `kingmaker-releases`
 * (key `addons/<id>/<version>/<file>`) to a request carrying a valid entitlement for `addon.<id>`. The entitlement is
 * the only credential (no update key). Anything that fails → 401 with no body. On success it serves exactly like a
 * release file (Range, private, max-age=0). Fails closed when CERT_SIGNING_KEY is absent (nothing can be verified).
 */
async function serveAddon(req, env) {
  const deny = () => new Response(null, { status: 401 });
  try {
    const m = /^\/addons\/([a-z0-9][a-z0-9-]{0,38})\/(\d{1,4}\.\d{1,4}\.\d{1,5})\/([\w.\-/]+)$/.exec(new URL(req.url).pathname);
    if (!m) return deny();
    const [, id, version, file] = m;
    if (file.includes('..') || file.endsWith('/')) return deny();
    const hdr = req.headers.get('x-ronin-entitlement') || '';
    if (!hdr) return deny();
    let envelope; try { envelope = JSON.parse(new TextDecoder().decode(b64ToBytes(hdr))); } catch { return deny(); }
    // 1. ES256 signature against CERT_SIGNING_KEY's public half + schema/issuer/expiry.
    const claims = await verifyEntitlementClaims(env, envelope);
    if (!claims) return deny();
    if (claims.schema !== 'ronin.entitlement/1' || claims.issuer !== 'ronin-update-host') return deny();
    if (claims.expiresAt && !(Date.parse(claims.expiresAt) > Date.now())) return deny();
    // 2. the path's <id> maps to its sku; the entitlement must be for exactly that.
    if (claims.sku !== `addon.${id}`) return deny();
    // 3. not revoked (by entitlement id — the order ref — or by install id).
    const entId = String(claims.order || `${claims.installId || ''}:${claims.sku}`);
    if (await isRevoked(env, entId, claims.installId)) return deny();
    // 4. serve the R2 object exactly like a release file.
    const obj = await env.RELEASES.get(`addons/${id}/${version}/${file}`, { range: req.headers, onlyIf: req.headers });
    if (!obj) return new Response('Not found', { status: 404 });
    const headers = new Headers();
    obj.writeHttpMetadata(headers);
    headers.set('etag', obj.httpEtag);
    headers.set('accept-ranges', 'bytes');
    headers.set('cache-control', 'private, max-age=0');
    if (!('body' in obj)) return new Response(null, { status: 304, headers });
    if (req.headers.has('range') && obj.range && 'offset' in obj.range) {   // only a request that asked for a range gets a 206
      const start = obj.range.offset ?? 0;
      const len = obj.range.length ?? obj.size - start;
      headers.set('content-range', `bytes ${start}-${start + len - 1}/${obj.size}`);
      headers.set('content-length', String(len));
      return new Response(req.method === 'HEAD' ? null : obj.body, { status: 206, headers });
    }
    headers.set('content-length', String(obj.size));
    return new Response(req.method === 'HEAD' ? null : obj.body, { headers });
  } catch { return deny(); }
}

/** Verify a ronin.entitlement/1 envelope ({payload, sig, alg:'ES256'}) against CERT_SIGNING_KEY's PUBLIC half (derived
 *  from the private key the host signs with — the same key pair the install cert uses). Returns the parsed claims, or
 *  null on any failure. Fails closed when the key is absent. */
async function verifyEntitlementClaims(env, ent) {
  try {
    if (!env.CERT_SIGNING_KEY) return null;
    if (!ent || ent.alg !== 'ES256' || typeof ent.payload !== 'string' || typeof ent.sig !== 'string') return null;
    const pub = await certPublicKey(env.CERT_SIGNING_KEY);
    const raw = derToRaw(b64ToBytes(ent.sig));
    const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, raw, enc.encode(ent.payload));
    return ok ? JSON.parse(ent.payload) : null;
  } catch { return null; }
}

/** The P-256 public key for verification, derived from the PKCS#8 private CERT_SIGNING_KEY (export jwk, keep x/y). */
async function certPublicKey(pkcs8Pem) {
  const priv = await crypto.subtle.importKey('pkcs8', pemToDer(pkcs8Pem), { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
  const jwk = await crypto.subtle.exportKey('jwk', priv);
  return crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
}

/** Standard base64 → bytes (inverse of b64). */
function b64ToBytes(s) {
  const bin = atob(String(s).trim());
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** An ASN.1/DER ECDSA signature (SEQUENCE { INTEGER r, INTEGER s }, what issueInstallCert emits) → the raw r‖s (32
 *  bytes each) Web Crypto's verify expects. Inverse of ecdsaRawToDer. Throws on malformed input. */
function derToRaw(der) {
  let i = 0;
  if (der[i++] !== 0x30) throw new Error('bad der');
  if (der[i] & 0x80) i += 1 + (der[i] & 0x7f); else i += 1; // sequence length (skip)
  const readInt = () => {
    if (der[i++] !== 0x02) throw new Error('bad der int');
    let len = der[i++];
    let bytes = der.slice(i, i + len); i += len;
    while (bytes.length > 32 && bytes[0] === 0x00) bytes = bytes.slice(1);
    const out = new Uint8Array(32);
    out.set(bytes, 32 - bytes.length);
    return out;
  };
  const r = readInt();
  const s = readInt();
  const raw = new Uint8Array(64);
  raw.set(r, 0); raw.set(s, 32);
  return raw;
}

/** POST /enroll {device, name, installId?}: a new key for this Mac, returned once (only its sha256 is kept), plus a
 *  signed install certificate (when CERT_SIGNING_KEY is set) the launcher stores and checks.
 *
 *  Limit by design: the enroll token is embedded in every installer (operator's "anyone auto-enrolls" choice), so it
 *  is NOT a secret and anyone can call /enroll and get a signed certificate. What the cert still gives, even so: its
 *  claims are server-set (not caller-chosen — see below), and it is revocable per Mac. It proves "went through a real
 *  enrollment" and enables kill-switching one install; it does NOT prove the running binary is genuine (that is the
 *  signed release manifest + codesign, checked by the launcher) and is NOT Gatekeeper trust. Tying issuance to
 *  server-verifiable proof of an authorized release (so only genuine installs can enroll at all) is a larger change
 *  that trades against frictionless enrollment — an operator decision, tracked separately. */
async function enroll(req, env, token) {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  if (!env.ENROLL_TOKEN || !token || !(await same(env.ENROLL_TOKEN, token))) return new Response('Unauthorized', { status: 401 });
  let body = {};
  try { body = await req.json(); } catch { /* empty */ }
  const device = String(body.device || '').replace(/[^a-f0-9]/gi, '').slice(0, 64);
  if (device.length < 16) return new Response('Bad device', { status: 400 });
  const name = String(body.name || '').replace(/[^\w .'-]/g, '').slice(0, 64);
  const key = hex(crypto.getRandomValues(new Uint8Array(32)));
  const keySha = await sha(key);
  const at = new Date().toISOString();
  await env.DEVICES.put(`key:${keySha}`, JSON.stringify({ device, name, at, revoked: false }));
  await env.DEVICES.put(`device:${device}:${at}`, JSON.stringify({ name, at, keySha }));

  const out = { url: new URL(req.url).origin, key };
  // The install certificate (ronin.install-cert/1): a Ronin-signed, revocable proof this Mac enrolled as a genuine
  // install. Bound to the device, bundle and release; revocation reuses the device record above. The launcher
  // (app/src-tauri/src/cert.rs) verifies it against its pinned ES256 public key. Minted only when CERT_SIGNING_KEY is
  // present, so an enroll without it still works (the cert is additive, never required to install).
  if (env.CERT_SIGNING_KEY) {
    // The certificate's trust-bearing claims are set by the SERVER, not the caller. Anyone can present the enroll
    // token (it ships in every installer), so a caller-supplied bundleId/releaseTag would let a rebuilt installer mint
    // a certificate with claims it chose — the very forgery the cert is meant to prevent. installId is just an opaque
    // identifier (no trust rides on it), so the caller may supply it; bundleId is fixed, and releaseTag comes from the
    // release the host is actually publishing right now (latest.json). This does NOT make the token secret — see the
    // note in the enroll docstring; it removes caller-controlled claims so a forged cert can't misstate what it is.
    const installId = /^[0-9a-f-]{8,64}$/i.test(String(body.installId || '')) ? String(body.installId) : crypto.randomUUID();
    const bundleId = 'com.ronininc.solghost';
    let releaseTag = 'unknown';
    try {
      const latest = await env.RELEASES?.get('latest.json');
      if (latest) releaseTag = String((await latest.json()).tag || 'unknown').replace(/[^\w.-]/g, '').slice(0, 64) || 'unknown';
    } catch { /* if latest.json can't be read, the cert still issues with releaseTag 'unknown' */ }
    try {
      out.cert = await issueInstallCert(env.CERT_SIGNING_KEY, {
        schema: 'ronin.install-cert/1', installId, deviceSha256: device, bundleId, releaseTag,
        issuedAt: at, keySha, issuer: 'ronin-update-host',
      });
    } catch { /* signing is best-effort: an enroll never fails because the cert couldn't be minted */ }
  }
  return Response.json(out);
}

/** Sign the claims as an install certificate the launcher verifies: ES256 (ECDSA P-256 SHA-256) over the exact
 *  payload bytes, signature as ASN.1/DER (what ring's ECDSA_P256_SHA256_ASN1 expects), base64. The payload is
 *  returned byte-for-byte so the verifier signs exactly what it reads. */
async function issueInstallCert(pkcs8Pem, claims) {
  const der = pemToDer(pkcs8Pem);
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const payload = JSON.stringify(claims);
  const raw = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(payload)));
  return { payload, sig: b64(ecdsaRawToDer(raw)), alg: 'ES256' };
}

/** A PEM block ("-----BEGIN …-----\n<base64>\n-----END …-----") → its DER bytes (Uint8Array). */
function pemToDer(pem) {
  const b64str = String(pem).replace(/-----(BEGIN|END)[^-]*-----/g, '').replace(/\s+/g, '');
  const bin = atob(b64str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** base64 (standard) of a byte array. */
function b64(bytes) {
  let s = '';
  for (const byte of bytes) s += String.fromCharCode(byte);
  return btoa(s);
}

/** Convert a P-256 raw ECDSA signature (r‖s, 32 bytes each, as Web Crypto returns) to ASN.1/DER
 *  (SEQUENCE { INTEGER r, INTEGER s }). ring verifies the DER form. */
function ecdsaRawToDer(raw) {
  const r = derInt(raw.slice(0, 32));
  const s = derInt(raw.slice(32, 64));
  const body = [...r, ...s];
  return Uint8Array.from([0x30, ...derLen(body.length), ...body]);
}
/** One DER INTEGER from a big-endian 32-byte value: strip leading zeros, prepend 0x00 if the high bit is set. */
function derInt(bytes) {
  let i = 0;
  while (i < bytes.length - 1 && bytes[i] === 0x00) i++;
  let v = [...bytes.slice(i)];
  if (v[0] & 0x80) v = [0x00, ...v];
  return [0x02, ...derLen(v.length), ...v];
}
/** DER length bytes (short form for <128, else long form). P-256 sigs never exceed a one-byte long-form length. */
function derLen(n) {
  return n < 0x80 ? [n] : [0x81, n];
}
