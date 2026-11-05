# Local key management and coordinated rotation

Status: implementation in progress. No real identity has been rotated. Native authorization, public trust transitions and encrypted decryption-only recovery have passing fixture tests. Protected storage migration, atomic commit/recovery, runtime wiring and live peer distribution are not complete. The new modules are not a live key-rotation feature and are not exposed through a runtime button.

The rotation trigger belongs to the native runtime and requires fresh device-owner authentication. There must be no HTTP, URL, CRM, job-board, bot, MCP or WebView command that triggers rotation or returns an authorization ticket. A paying or owner-comped account retains its ordinary customer scope; admin credentials are never copied into the client.

`mac/LocalKeyAuthorization.swift` issues an opaque, in-process, single-use authorization bound to the specific operation and identity revision, with a 15-second monotonic deadline. Rejected or unavailable OS authentication issues no grant. A newer request invalidates an older pending request. This primitive alone does not encrypt existing identity files or implement rotation.

Verified components:

- `test/native-key-authorization.swift` compiles the real Swift authorization implementation with a test-only authentication context. It verifies denial, unavailable authentication, one-shot consumption, action/revision binding, expiry, repeated and superseded callbacks, lifecycle invalidation and invalid-clock refusal. Production compilation has no injected authentication constructor. This is not a successful physical Touch ID test.
- `key-transition.mjs` accepts a transition only against an independently pinned P-256 rotation authority, an exact previous public revision, the next epoch, a device binding and a bounded validity window. Replacement Ed25519 and ML-DSA-65 keys must prove possession. Old signing keys alone cannot authorize replacement. Signed acknowledgements are accepted only from explicitly enrolled peers; offline peers stay pending. The caller still must provide protected, rollback-resistant persistence and peer enforcement. No enrollment or network sender is included.
- `retired-key-recovery.mjs` encrypts the old X25519/ML-KEM private keys in an ordinary v4 Armor package to the new identity. The old Ed25519 and ML-DSA private signing keys are omitted. The test opens real pre-rotation v4 ciphertext using the recovered decryption-only capability and verifies the new key alone cannot open it. No live store is opened by this module.
- `mac/ProtectedIdentityVault.swift` provides signed, encrypted generation envelopes. Production provisioning requires a fresh `.protectKeys` grant and creates permanent, this-device-only, user-presence-protected Secure Enclave keys. Existing-key loading never silently creates replacement authority or falls back to software. Encryption uses a fresh AES-GCM key wrapped to the hardware public key; a separate hardware authority signs the envelope. Opening requires `.unlockKeys`, the expected epoch/revision, a valid pinned authority signature, and hardware decryption. Authorization bindings include the exact input digest, epoch and revision, preventing candidate substitution after authentication. The caller must supply protected epoch persistence; this primitive does not itself prevent whole-store rollback.
- `test/native-protected-identity.swift` verifies encryption/decryption, signatures, exact-input authorization, one-shot grants, wrong epoch, tampering, wrong authority and wrong device with disposable in-memory software fixtures. Its alternate constructor exists only under `ARMOR_AUTH_TESTS`. It never writes Keychain items or opens owner data. Production compilation without that flag passes type checking. Actual Secure Enclave provisioning, physical owner authentication, lifecycle integration and crash recovery remain unverified.

Run the fixture proofs serially:

```sh
node --test --test-concurrency=1 scripture-armor/test/key-transition.test.mjs scripture-armor/test/retired-key-recovery.test.mjs
swiftc -D ARMOR_AUTH_TESTS scripture-armor/mac/LocalKeyAuthorization.swift scripture-armor/test/native-key-authorization.swift -framework LocalAuthentication -o /tmp/armor-native-authorization-proof
/tmp/armor-native-authorization-proof
swiftc -D ARMOR_AUTH_TESTS scripture-armor/mac/LocalKeyAuthorization.swift scripture-armor/mac/ProtectedIdentityVault.swift scripture-armor/test/native-protected-identity.swift -framework LocalAuthentication -framework Security -framework CryptoKit -o /tmp/armor-native-protected-identity-proof
/tmp/armor-native-protected-identity-proof
```

Before enabling the Rotate key button:

1. Move private material behind the protected native storage/crypto boundary. Never render private keys in HTML, JavaScript, logs or a clipboard, including after authentication. Public algorithm names are not secret keys.
2. Generate replacement key material locally. Rewrap existing vault data and authenticated stores into a staged generation; verify all reads before an atomic commit. Preserve an encrypted, authenticated recovery path. Never leave a plaintext rollback copy.
3. Use a separately protected, presence-authorized rotation authority. Possession of the compromised old signing key alone must not authorize its replacement. Bind the signed transition to the device, old/new public identities, a monotonic epoch, expiry and a fresh nonce.
4. Revoke old authority and distribute only the new public trust/version information to authenticated enrolled peers. Private keys stay local. Reject stale/replayed transitions. Track acknowledgements; offline devices remain pending or blocked until updated. Do not claim instantaneous completion everywhere.
5. Keep old encrypted-data recovery separate from permission to issue new signatures. Rotation cannot undo exposure of already stolen plaintext or old ciphertext/key copies.
6. Verify denied/replayed authentication, interrupted migration, stale epochs, compromised-old-key impersonation, offline peers, successful recovery and revocation before declaring rotation complete. Fixtures must use generated test identities, never the owner's real store.
