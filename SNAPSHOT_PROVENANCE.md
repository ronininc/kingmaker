# Unverified native-build input provenance

The native `app/`, `installer/`, and `scripts/` trees and the top-level build and
documentation files added after the recovered runtime baseline came from:

`/Users/robbiebrown/Projects/kingmaker-4.4-mac`

That directory was a non-Git local snapshot. These files are preserved in a
separate commit because their original commit identities cannot be verified. They
did not overwrite any of the 377 runtime files recovered from the published
v4.4.1 payload.

Known limitations:

- The snapshot has no primary `test/`, `addons/`, or `test-os/` trees and no
  dependency lockfile.
- Its build scripts target the older app-archive installer manifest, while the
  published v4.4.1 release uses a payload `units.macos` manifest.
- The app builder deliberately requires private signing tooling absent from the
  public/recovered tree. No signing identity or key was accessed.
- These files require review and payload-aware adaptation before they can produce
  a release artifact.
