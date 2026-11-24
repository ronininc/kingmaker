# macOS app signer proof (candidate only)

Use this read-only check on the **exact finalized inner Kingmaker.app** on a clean Mac:

```sh
node scripts/macos-app-signing-policy-proof.mjs developer-id <exact-version> <approved-apple-team-id> /path/to/Kingmaker.app
```

Use the separate `legacy <exact-version> <legacy-leaf-sha1>` lane only to inspect an existing old identity. Neither lane can fall back to the other, alter user permissions, sign anything, or declare a release published. A legacy pass does not say Gatekeeper accepts it. Simulated tests: `node --test test/macos-app-signing-policy.test.mjs`.

## Why this check is not yet a release switch

- In this base the same legacy leaf still binds the signed app in `scripts/kingmaker-mac-signing.mjs`, `scripts/release-gate.mjs`, `installer/engine.sh`, and `lib/update.mjs`. Separately, it authenticates the detached update engine. Replacing the one leaf everywhere would invalidate older installation receipts/signature requirements. A notarized DMG does not notarize a separately extracted legacy-signed inner app.
- The shipping integration must select the Apple policy through a verified signed manifest of the exact destination version. Bind the known Team ID and bundle, keep a separate legacy *source* trust contract, and require the normal detached release manifest signature and every pinned digest. Make installer, Launcher, release gate, and updater agree before any promotion. A missing/invalid selector or requirement must fail closed; never treat the legacy signer as an alternate destination signer for an Apple-policy release.
- Build/finalize/notarize/staple the inner app before generating archive parts or signing the manifest; then verify exact delivery from a clean account with the quarantine/Gatekeeper path intact. This command is inspection, not a full installer or first-task proof.
- Existing releases cannot transparently switch signers with their current updater. Prefer an explicit signed reinstall with verified old ownership/receipt and preserved app data unless a separately tested, version-and-destination-bound bridge is ready. macOS permission grants may need user approval again; do not claim inherited TCC access.

Apple requirement guidance: https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements/
