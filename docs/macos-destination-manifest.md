# Dormant Apple destination policy contract

This is a validator-only capability. The existing build, public feed, installer, Launcher, and updater still use `kingmaker.release/1` and **do not accept `kingmaker.release/2`**. This branch does not create, sign, distribute or authorize a `/2` release. Do not embed the Apple selector in `/1`: existing readers could ignore a new field.

The proposed `/2` signed JSON retains the existing payload pins and provenance and adds exactly:

```json
{
  "destinationSigning": {
    "schema": "kingmaker.macos-destination-policy/1",
    "lane": "developer-id",
    "teamId": "<approved-apple-team-id>",
    "bundleId": "com.ronininc.solghost",
    "version": "<exact-version>"
  }
}
```

`parseSignedAppDestination()` verifies the exact bytes with the existing pinned RSA release key **before** interpreting the selector. The signed fields must match the release's app/version/tag plus the caller's independently selected exact version, App ID and approved Apple Team. No manifest can supply a raw requirement, override the approved Team, enable an alternate signer, or force Apple-to-legacy downgrade by supplying a signed `/1`. The existing valid legacy path is untouched; this parser has an explicitly selected legacy test case.

**Next:** bind the public macOS Apple Team and verified app signing/notarization into a single candidate and wire `/2` handling in the packer/staged gate, shell installer, CRM feed, Rust Launcher, and installed updater together. Accept `/2` only after each consumer interprets the authenticated destination policy and checks the actual app. Test exact downloaded/stapled bytes on a clean Mac and a legacy migration separately; unmodified legacy updaters cannot switch signer silently. No `/2` serializer by design.
