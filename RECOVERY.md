# Kingmaker recovered runtime baseline

This repository is a recovery from the published Kingmaker v4.4.1 runtime
artifact. It is **not** a reconstruction of the lost v4.4.1 Git history.

Baseline evidence:

- release: `v4.4.1`
- published payload: `kingmaker-payload.tar.part-aa`
- bytes: `26163200`
- SHA-256: `c553e9a41e6940e18d6adf934b4745891b0f489b38a8f470a220818dccbe7e2a`
- internal payload version: `4.4.0` (v4.4.1 changed executable tar modes only)
- indexed runtime files: `377`
- verification: every indexed file was present and matched its recorded SHA-256;
  all 44 shebang files carried an executable owner bit.

`recovery-evidence/` preserves the published manifest and checksum lists. The
original payload remains unchanged outside this tree. The public v4.4.1 tag does
not match this artifact, and the private build commits named by the manifest were
not available from authorized local repositories or the private origin.

Files absent from the payload—native app/installer sources, release scripts,
primary tests, add-ons, OS tests, TypeScript configuration, and dependency lock
data—must be added in separately identified commits. Snapshot-derived files are
unverified until reviewed; they must never overwrite verified runtime files.

All work after this baseline belongs to a new release line. Do not move or rewrite
the v4.4.1 tag.
