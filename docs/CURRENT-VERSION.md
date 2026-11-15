# Which Kingmaker version is current

Verified 2026-11-15. Do not infer production from historical notes or a candidate's package version.

| Location | Version | Evidence |
|---|---|---|
| Published GitHub release | **4.5.1** | `gh release view v4.5.1 --repo ronininc/kingmaker`: published, not draft/prerelease; installer DMG, two app archive parts, signed manifest and Launcher 0.3.17 ZIP present |
| Installed owner application | **4.5.1** | `/Applications/Kingmaker.app/Contents/Info.plist` `CFBundleShortVersionString` |
| This isolated integrated source candidate | **4.5.2, unpublished** | `package.json` and lockfile; new version avoids replacing immutable existing 4.5.1 release assets |
| Last fully built isolated candidate | **4.5.1, not deployed** | Prior full-runtime signed build, isolated health/CLI proofs; requires rebuilding from the final 4.5.2 source |

Before choosing 4.5.2, both `gh release view v4.5.2` and `git ls-remote` for tags `v4.5.2` / `4.5.2` found no existing release/tag. Recheck immediately before publication to avoid a concurrent collision.

App and installer plist templates obtain the product version from this checkout's `package.json` during their builds. The engine repository's own package version is separate and must not be mistaken for the product version.

4.5.2 is not a completed release: final artifact refresh, signed manifest, full staged extraction and installation verification, and published download verification remain required. Preserve the existing usable public release until its replacement passes the gates. The source for candidate changes must be preserved in the repository; do not publish generated private engine imports or signing secrets.

Historical 2026-11-11 notes claiming 4.4.4 was the only published installer are superseded by the direct checks above. No assertion of Linux/Windows 4.5.2 readiness is made; their current portable installer sources remain incomplete.
