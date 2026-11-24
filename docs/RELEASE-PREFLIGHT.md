# Kingmaker release preflight

This is a read-only prerequisite check. It never builds, signs, notarizes, uploads, publishes, makes a production change, or enrolls a device. Exit 0 means local conditions permit the owner to start the existing build/check lane, **not** that anything can be promoted. Exit 1 is a blocker; exit 2 is malformed input. Do not treat a Linux check or a draft installer as a release.

On the approved Apple silicon release host, use a separate clean checkout for the exact product source and point to an existing packaged app and staged signed manifest. Do not put private keys or signing credentials in this checkout or a generic CI runner. Existing owner-lane environment supplies the Developer ID identity name, notarization keychain profile, and enrollment configuration; do not pass credentials on the command line.

```sh
node scripts/release-preflight.mjs \
  --source "$PRODUCT_CHECKOUT" --source-commit "$PRODUCT_FULL_SHA" \
  --engine-source "$ENGINE_CHECKOUT" --engine-commit "$ENGINE_FULL_SHA" \
  --app "$PACKAGED_APP" --build-receipt "$BUILD_RECEIPT" \
  --scratch "$BUILD_SCRATCH" --staging "$SIGNED_STAGE" \
  --minimum-free-gib 32 --check-notary
```

The receipt contains public metadata only: the product and engine Git commits, packaged version, the packaged plist's engine build marker, and the SHA-256 of the exact packaged `Contents/MacOS/KingmakerEngine` executable. Keys are `sourceCommit`, `engineCommit`, `appVersion`, `engineBuild`, and `engineSha256`. Obtain it from the actual owner packaging step, not reconstructed guesses. The tool independently reads local Git/plist/codesign data, validates the runtime inventory and hashes all listed payload files. It does not execute the app.

The scratch floor is conservative: at least the requested floor (default 32 GiB) or three times allocated app size plus 2 GiB, whichever is larger. It checks both existing scratch and staging filesystem free space without reserving it. Keep a separate free-space budget for the target Mac's customer installation. `--check-notary` uses the existing Apple profile for a read-only history query and suppresses the command's output; no Apple submission occurs. The owner host's current pinned Kingmaker app identity, the outer Developer ID installer identity, the offline manifest signing key, and Apple notary credentials are separate controls. A Developer ID used by another product is not permission to re-sign the Kingmaker payload, which would change its pinned leaf and local permission identity.

Staging must already contain `kingmaker-manifest.json`, its detached `.sig`, the exact macOS parts and Launcher archive. This tool uses the checked-in public key; it never requests the private signing key. For enrollment, URL shape and variable presence are checked; code value is not read, no device is enrolled, and the remote system's permissions/reachability are not certified.

If all checks pass, the operator still runs the existing app/tree gate, builds and notarizes the exact approved installer, exercises the customer path on a clean Mac, verifies remote staged object hashes and enrollment, and only then approves promotion. If the pinned inner application is not Developer ID signed, outer installer notarization alone does not establish a one-click clean Mac result. Do not rotate or bypass the existing pin; resolve any approved migration separately.
