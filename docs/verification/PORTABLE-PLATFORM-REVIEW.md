# Portable Linux / Windows CLI: local review

The missing portable entrypoint/installer sources are implemented. This removes the previous missing-file failure without pretending the macOS native application is portable.

- Linux shell entrypoint resolves its own location (including an installed command symlink), requires existing Node 24+, verifies the complete unit/payload and forwards arguments to the real CLI.
- Windows CMD entrypoint uses the relative engine path and propagates the result. PowerShell installation stages, verifies, renames atomically with rollback, and never changes execution policy, PATH or security settings.
- Shared verifier rejects malformed/mismatched version metadata, altered/unlisted files, links, traversal, unsafe targets, unrelated existing installs/commands and concurrent install locks. Failed installation removes only staging it created; pre-existing staging is preserved.
- No automatic runtime/model/corpus installation or network retrieval.
- Archive hash must be verified against an independently trusted signed release manifest before unpacking. Self-contained payload hashes alone do not authenticate the publisher. These archives are local installer candidates, not published signed platform releases.

Proof: `node --test test/portable-entrypoints.test.mjs test/portable-installers.test.mjs`.
The archive test builds both actual tar.gz/ZIP units, runs Linux shell installation/version on macOS, validates rollback preservation and Windows installer structure. PowerShell is unavailable locally; no Windows execution claimed.

Additional actual Linux proof used the already cached Linux arm64 Node 24.22.2 image with its Node binary as entrypoint, network disabled, no image pulls, dropped capabilities, no-new-privileges, one CPU and 512MiB limit. No application from that image was launched. A copied unit was installed into isolated temporary storage, its real CLI reported 4.5.3, a reviewed native-create request produced PBR PNG artifacts with hashes, and subsequent payload tampering was rejected. Temporary test containers were removed; existing lab containers were untouched. This confirms portable JavaScript execution on Linux arm64, not x64 native-binary validation.

Evidence outside source: `portable-real-linux-proof.json`, `portable-platform-focused-tests.txt`, `portable-runtime-proof/`. The original seven macOS native demonstrations remain separate evidence.

## Not yet proved

Full Windows execution, platform-native GUI/voice/desktop automation, private engine packaging, Launcher and paid Armor integration on Linux/Windows, secure native credential stores, signing/notarization equivalents and real three-OS onboarding remain work. The existing Windows secret-reader failclosed boundary must not be restored with plaintext shortcuts. A successful CLI version or one generated asset is not proof of those features. No deployment was performed.

Actual Linux testing caught a Node24 versus Node26 `fs.cpSync` behavior difference: copying a directory onto an already-created exclusive stage with `errorOnExist` failed on Node24. The installer now copies each source entry into the exclusively created stage, preserving the no-overwrite property. Both local tests and the actual Linux proof were rerun after correction. This is why source inspection/static Windows checks are not substituted for native execution.

A manual-only GitHub Actions matrix is staged for Ubuntu, Windows and macOS: `.github/workflows/portable-platform-proof.yml`. It uses Node24 and runs `test/portable-native-platform.proof.mjs`, invoking the real platform installer/entrypoint and tamper check. It has read-only repository permissions, no project secrets, model downloads or deployment steps. It has not been pushed or run remotely. Windows execution-policy restrictions are reported rather than bypassed. Local macOS execution of the same proof passed; a green local result is not a substitute for the unrun Windows job.
