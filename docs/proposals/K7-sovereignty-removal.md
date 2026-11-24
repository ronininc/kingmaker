# K7-prep — Sovereignty removal branch (PREPARED ONLY — DO NOT MERGE)

Claude seat, 2026-11-24.

## Headline

**The branch exists and removes the subtree, but Kingmaker does not start on it.** Eight Kingmaker modules import code from `scripture-armor/`, including `lib/cli.mjs` through its imports. The files overlap today; deleting the folder alone does not make the two products sovereign. The rewiring is in the backend seat's files.

## The branch

- Name: `k7-prep/remove-scripture-armor`, cut from `main` at b44cea4, one commit: 8806b3e.
- Content: `git rm -r scripture-armor`. 236 files deleted, 56,319 lines. Nothing else touched (`git diff --name-status main k7-prep/remove-scripture-armor | grep -vc '^D.scripture-armor/'` prints 0).
- Not merged, not pushed.

## What breaks (tested by importing each module on the branch; all eight load on `main`)

| Module | Imports from the subtree |
|---|---|
| `lib/cli.mjs` | fails through its own imports: `ERR_MODULE_NOT_FOUND scripture-armor/armor.mjs` |
| `lib/install-docking-runtime.mjs:4` | `armor.mjs` (fingerprint, identity, sign, verify, revocation) |
| `lib/launcher-crm-identity-client.mjs:8` | `armor.mjs` (`loadIdentity`) |
| `lib/armor-native.mjs:32-33,38` | `armor.mjs`, `refit-net.mjs` |
| `lib/armor-egress.mjs:196` | `refit-net.mjs` (dynamic import) |
| `surface/kernel/armor-bridge.mjs:34` | `armor.mjs` |
| `light-runtime/artifact.mjs:34` | `armor.mjs` (`sealPlaintext`) |
| `light-runtime/voice-artifact.mjs:46` | `armor.mjs` |

Also pointing at the folder:

- `lib/payload.mjs:19` ships four of its files inside every Kingmaker payload: `armor.mjs`, `refit-net.mjs`, `scan.mjs`, `LICENSE`. `lib/armor-bundle.mjs` and `lib/armor-bundle-build.mjs` seal those into the shipped bundle.
- Tests that import or assert on it: `test/payload.test.mjs`, `test/stage-payload-app.test.mjs`, `test/install-docking-runtime.test.mjs`, `test/launcher-crm-identity-client.test.mjs`.
- `.github/scripture-armor-allow.json` is the Armor scan daemon's allowlist for this repo. It is configuration about Kingmaker, outside the subtree, and the branch leaves it.
- The README says "scanning ships inside Kingmaker, free" and describes the Creation Seal. If the subtree goes, that sentence needs the owner's ruling too.

So Kingmaker uses 3 of the 236 files at run time (`armor.mjs`, `refit-net.mjs`, `scan.mjs`) plus the licence. The other 232 (73 tests, 60 harness files, the mac/linux/windows/ui/dns-profile folders, the vault and review modules) have no importer in Kingmaker.

## What the owner rules on

1. **Remove all 236** and have Kingmaker take the three modules from Armor as a separate, versioned dependency. Needs backend work in the eight modules, the payload list and four tests before the branch can merge.
2. **Remove the 232 unused files only** and keep the three shared modules and the licence in place for now. Smaller, mergeable sooner, but the files still overlap.
3. **Leave it.**

Until the ruling, the branch waits.

## Reproduce

```bash
git checkout k7-prep/remove-scripture-armor && node -e "import('./lib/cli.mjs').then(()=>console.log('LOADS'),e=>console.log('BREAKS',e.code))"
```
