# Which Kingmaker version is current

Use the published tag and its signed manifest, not historical notes or a working branch's version.

| Location | Version | Evidence |
|---|---|---|
| Published GitHub release | **4.5.2** | [Release](https://github.com/ronininc/kingmaker/releases/tag/v4.5.2), published/latest, seven verified assets |
| Released source | **4.5.2** | tag `v4.5.2` points to `4a453cc8d798a5adfcd50bcfbbbe2b40ddfe6429`; installer provenance matches |
| Included Ronin Launcher | **0.3.18** | independent source `ronininc/ronin-launcher@f6aeb090b90e9a8cb9cfdff53a89dff627813b1d`, signed archive and bundle identities in the issued ledger |
| Owner's installed application at verification | **4.5.1** | inspected plist; the release workflow did not replace the owner's installed app |

**Known Launcher-first blocker:** Launcher 0.3.18 rejects the complete Kingmaker product through its generic connector scanner. Use the tested standalone installer while the authenticated-product placement correction is pending. The isolated installation proof below is for that standalone installer, not Launcher-first installation.

4.5.2 targets Apple Silicon macOS 14.0 or newer. App and installer plist templates obtain the product version from `package.json`; the engine repository has its own versioning.

The signed archive passed full staged extraction, tree comparison and certificate verification, followed by an isolated installation and engine health check. Public installer, Launcher, manifest, signature and checksum downloads were verified against their expected bytes; both large parts are publicly accessible and GitHub's stored digests match the signed manifest. See [release verification](releases/4.5.2-verification.md).

Model weights and knowledge corpora are **not automatically downloaded** by the installer. Existing data is inventoried; unavailable inference/data is stated explicitly. Clean machines need explicitly configured inference for model-dependent work. This is not a claim that arbitrary-model streaming has been proven.

The installer and Launcher are Developer ID signed; Kingmaker retains its established pinned release certificate. None is notarized, and fresh Macs may present Gatekeeper restrictions. First-run ownership and permission setup remain required.

Existing 4.5.1 release assets were preserved. Linux/Windows artifacts were not relabeled as 4.5.2; current portable installer source remains incomplete. Generated private engine imports and signing secrets must never be committed to this public repository.
