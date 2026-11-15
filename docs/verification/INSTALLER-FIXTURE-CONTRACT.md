# Installer fixture trust contract

The installer integration suite uses a miniature ad-hoc-signed app and localhost
HTTP endpoints. It does not possess a production certificate or release key.

- `release-parts.main` defaults to the real `verifyStagedRelease`. Its dependency
  parameter is injectable only by a programmatic caller, not an environment flag
  or command-line option. The fixture calls the real verifier with a synthetic
  certificate probe; part hashes, extracted/source tree equality and issuance
  checks still run. Separate release-gate tests cover rejection of missing,
  ad-hoc, incorrect and invalid signatures.
- The fixture generates an ephemeral release key, copies the exact installer
  shell engine to its own temporary directory and places only that fixture's
  public key beside it. The engine verifies actual signatures normally. The
  production build rejects this fixture signature against its production pin.
- A test that deliberately changes a manifest must explicitly sign the new
  fixture. The runner never silently signs its inputs. Negative tests prove the
  fixture engine rejects absent and tampered signatures before download.
- The test-world curl wrapper permits only loopback URLs. Corruption retries
  therefore cannot reach the production GitHub fallback. No real models/tools
  are installed: fake tools and a fake local model server implement the contract.
- App placement happens only under test-owned temporary prefixes. Fixture engine,
  release trees and world prefixes are removed by their owning suite's after hook.

BSD deterministic archives use a sorted libarchive mtree input rather than the
unsupported BSD `tar --mtime` switch. Metadata is normalized without changing or
copying source file bodies; test coverage includes differing creation order and
mtime, Unicode/special filenames, permissions, and relative symbolic links.
