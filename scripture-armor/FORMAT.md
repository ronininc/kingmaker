# Scripture Armor — package format (v1–v4)

The format is public and frozen per version. `open-standalone.mjs` in this
repository is a complete, dependency-free implementation of everything
below; this document is the same information in prose, so anyone can
write a third opener in any language.

## File layout

```
SCRIPTURE-ARMOR v<N>\n
<one line of JSON: the frame>\n
<glyph body: lines of 48 glyphs>\n
```

## The glyph body (Layer 2 — skin, never the lock)

Alphabet of 256 code points: U+E000–U+E07F (128), U+10600–U+1063F (64),
U+12000–U+1203F (64). The alphabet is permuted per package: seed =
`frame.armor_seed` (16 random bytes, base64). Permutation = Fisher–Yates
driven by an HKDF-SHA256 stream: `HKDF(ikm=seed, salt="scripture-armor",
info="glyph-perm/v1", 4096 bytes)`, read as big-endian uint16s with
rejection sampling (`limit = 65536 - (65536 % n)`). Each payload byte maps
to exactly one glyph through the permuted alphabet. Whitespace in the
body is ignored on decode.

The payload being encoded is `ciphertext || 16-byte AEAD tag` of the
content encryption below.

## Content encryption (Layer 1 — the lock)

ChaCha20-Poly1305, random 32-byte file key per package, random 12-byte
nonce (`frame.file_nonce`, base64). Tag appended to the ciphertext.

## The key seal

**v1–v3 (classical):** ephemeral X25519 keypair per package.
`shared = X25519(ephemeral_priv, recipient seal_pub)`.
`wrapKey = HKDF-SHA256(ikm=shared, salt=ephemeral_pub_raw,
info="scripture-wrap/file-key/v1", 32)`. The file key is AEAD-sealed
under wrapKey with nonce `frame.key_nonce`; `frame.key_ct` =
base64(`ct || tag`); `frame.eph_pub` = base64url of the ephemeral
public key's raw 32 bytes.

**v4 (hybrid, current):** as above, PLUS ML-KEM-768 encapsulation to the
recipient's KEM public key, producing `kemShared` and a 1088-byte
ciphertext (`frame.kem_ct`, base64; `frame.kem_alg = "ML-KEM-768"`).
`wrapKey = HKDF-SHA256(ikm = xShared || kemShared,
salt = ephPubRaw || kemCt, info="scripture-wrap/file-key/v2", 32)`.
Both secrets are required: breaking either scheme alone yields nothing.

## The frame and its signatures

The frame is signed data, not a header you trust. Signature input =
`canonicalFrame + "\n" + sha256_hex(body_text_utf8)`, where
canonicalFrame is JSON.stringify of the frame restricted to the
version's field list, in the list's order, missing fields as null
(`sig`/`sig_pq` are never in the list).

Field lists:
- **v1:** v, canary, created, expiry, sha256, sender_sign_fp,
  sender_sign_pub, recipient_seal_fp, armor_seed, eph_pub, key_nonce,
  key_ct, file_nonce
- **v2:** v1 list + scan_verdict, scan_digest, scan_report,
  scan_override, armor_tier (sha256 retained)
- **v3:** sha256 replaced by commit (below) + the v2 scan fields
- **v4:** v3 + sender_mldsa_fp, sender_mldsa_pub (after sender_sign_pub),
  recipient_kem_fp (after recipient_seal_fp), kem_alg, kem_ct
  (after eph_pub)

`frame.sig` (all versions): Ed25519 over the signature input, key =
`frame.sender_sign_pub` (JWK `x`, base64url).
`frame.sig_pq` (v4 only): ML-DSA-65 over the same input, key =
`frame.sender_mldsa_pub` (DER SPKI, base64). A v4 frame verifies only
if BOTH signatures verify.

Fingerprints (`*_fp`) are SHA-256 hex of the raw public key bytes
(for PQ keys: of the DER SPKI bytes).

## Content integrity

- **v1/v2:** `frame.sha256` = SHA-256 hex of the plaintext. (Known
  weakness — an offline guessing oracle; the reason v3 exists. Old
  packages keep it because that is honestly what they are.)
- **v3/v4:** `frame.commit` =
  `HMAC-SHA256(key = HKDF-SHA256(ikm=fileKey, salt="", info="scripture-armor/commit/v1", 32), plaintext)`
  hex. Computable only by a party who can unseal the file key.

## Identity store

`identity.json` (mode 0600): `seal_pub`/`seal_priv` (X25519 JWK x/d,
base64url), `sign_pub`/`sign_priv` (Ed25519 JWK x/d, base64url), and
(v4) `kem_pub`/`kem_priv`, `mldsa_pub`/`mldsa_priv` (DER SPKI/PKCS8,
base64). A public identity block is base64 of JSON
`{v, label, seal_pub, sign_pub, kem_pub?, mldsa_pub?}`.

## The vault log chain

`vaultd.log` lines are JSON records `{ts, ...event, prev, mac}`:
`mac = HMAC-SHA256(logKey, JSON.stringify(record without mac))`,
`prev` = SHA-256 hex of the previous line's full text (or `GENESIS`, or
the SHA-256 of the rotated segment's raw bytes), and
`logKey = HKDF-SHA256(ikm = seal_priv raw, salt="scripture-armor/log",
info="scripture-armor/log/v1", 32)`. Closed segments are rotated into
`log-segments/` sealed as ordinary v4 packages to the same identity.

## Version policy

New packages are always written at the highest version (v4). Every
version remains readable forever — by the main tool and by
`open-standalone.mjs`. A reader must refuse a frame whose version it
does not know, and must refuse a v4 frame whose KEM block or ML-DSA
signature is absent: absence is a downgrade, and a downgrade is a
refusal, never a fallback.
