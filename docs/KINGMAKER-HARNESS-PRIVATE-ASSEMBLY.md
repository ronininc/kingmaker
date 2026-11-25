# Fresh private Kingmaker 4.5.1 assembly

This is private candidate assembly, not a customer release. It checks out Kingmaker `8af0839ddd06ae16f441ed51fe763d5d50235ba8` (harness-only release plus streaming disk fix) and TSS `4d514a623d51f78b0faed0d0edabd41b5e279cfd`. It does not enroll, deploy, publish, read private release keys, move update pointers, sign for customers, or notarize. The only signing is ad hoc. Candidate files stay in the private repository for two days.

## Prepare the runner

Use a dedicated, disposable arm64 macOS Actions runner labeled `kingmaker-assembly-arm64`. Restrict it to this private repository. It needs Xcode CLI tools, Python 3.13, CMake, Ollama, GitHub CLI, and no running Docker daemon. Workspace and runner temp must both be writable APFS with 32 GiB free before any checkout or download. Standard and XL GitHub-hosted [macOS runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners#standard-github-hosted-runners-for-private-repositories) provide 14 GB; use neither in this lane.

If the runner already has approved TSS source, set path-only repository variable `KINGMAKER_APPROVED_TSS_SOURCE_ROOT`: the job creates a separate checkout and verifies the exact commit. No new credential is needed. Otherwise use a short-lived credential scoped only to `ronininc/TSS` repository **Contents: read** in `KINGMAKER_TSS_CONTENTS_READ`. No broad token, signing credential or Keychain material belongs here.

## Rebuild and calculate new hashes

1. Check out both exact revisions. Verify the known four-tool arm64 acquisition archive from the existing private Kingmaker release and the NeMo wheel pin from the exact TSS source. These establish trusted inputs; they are not expectations for new output bytes.
2. Run exact TSS package preparation, provision the pinned Voice/NeMo dependencies into fresh scratch, build Guardrails from the exact TSS sidecar sources, stage the locked Playwright browser, and run the exact Northstar bootstrap. A disposable, loopback-only Ollama uses only its own empty per-run model store. Never use previous compiled runtimes, a live service, or the old kit.
3. Assemble the new app with `package:ghost`. Require all ten runtime kinds, exact TSS source and native plist build stamps, fresh Northstar metadata, and actual Installer-engine fixture tests.
4. Recompute each runtime tree digest, native engine byte hash, and final private zip digest from materialized output. Record the freshly built Guardrails pre-sign digest separately from the packaged binary digest: native code signing can rewrite Mach-O bytes. Derive a fresh **private unsigned** multipart hash preview by streaming the actual app rather than writing a duplicate compressed archive. The prior app and its hashes are rollback evidence only.

The ad-hoc zip and preview are not customer bytes. The owner-managed lane must re-sign the complete current app and calculate new hashes from those signed output bytes, independently extract and verify the pinned signature, sign the detached production manifest, then sign, notarize and staple its installer. The public checksum must be calculated after the last signing or stapling mutation. Do not change historical rollback pins to match the new work.

## Explicit dispatch only

An ordinary branch push never starts this workflow. When the dedicated runner and action are authorized, dispatch `Kingmaker private harness assembly` from the reviewed workflow ref if enabled. If unavailable from a non-default branch, the reviewed internal tag `ci-proof-kingmaker-harness-8af0839` is the explicit branch-only trigger; it is not a production release tag. Do not push it or edit repository settings during review.
