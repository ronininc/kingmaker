# Independent products: clean-Mac acceptance

This is a test plan, not a release receipt. Run on a clean Apple Silicon Mac with an entitled staging identity and an unrelated negative-control identity. Record exact installer bytes, digests, signed manifests and source commits. Use only synthetic documents and approved test payment mode. Never record passwords, enrollment codes, keys or card details.

## Entry points and gates

| Customer chooses | Must be obtainable and usable with neither other product installed | Before integration |
| --- | --- | --- |
| Kingmaker | Direct signed Kingmaker installer, local app and an explicitly configured, compatible local inference model; normal UI defaults to Kingmaker alone. Verify a synthetic artifact export. | No Ronin account, payment, Launcher, or standalone Armor required for the free harness. Local signed media is not the same as an offline customer installer: all prerequisites/model must also be available locally. |
| Scripture Armor | Direct approved purchase and signed standalone Armor artifact, paid activation through site's verified account, then demonstrate standalone protection with test data. | No Launcher or Kingmaker required. Billing and entitlement remain server-owned. |
| Ronin Launcher | Direct signed Launcher artifact; opens and shows free install options by itself. | No account for its local UI or free Kingmaker install. Verified sign-in is optional unless accessing account-backed products. |

Check default Kingmaker install does not request, place, launch or replace Launcher. Explicit separate optional opt-in must use the existing verified Launcher artifact/pin; a corrupt opt-in Launcher must still fail the bundled transaction, not silently fall back. Keep the existing mandatory bundled manifest field and do not substitute an old Launcher archive under it.

The public payload feed serves version-tagged signed metadata and app parts independently of the device-enrollment update endpoint. Check the Kingmaker installer can reach exact public parts from a clean browser and Mac, not just from an authenticated GitHub client. The preproduction installer UI change does not itself switch the standalone installer download transport or expose local-media selection. Until the exact standalone installer can reach its parts in a clean accountless test, that route is not done.

## Six install orders

On fresh isolated homes/devices, individually obtain/install products in all orders: K→A→L, K→L→A, A→K→L, A→L→K, L→K→A, and L→A→K. After each step, launch the installed product and verify existing products, update records and local vault/data were not replaced. Before sign-in, distinguish local presence and local provenance from account ownership.

After a verified sign-in wherever supported, reconcile prior grants and verified local installations on the same stable account ID; do not require re-purchase or reinstall. A locally present app or a matching email string is not proof of a paid grant. Confirm no obsolete port/daemon/keychain assumption and no duplicate grants. An unrelated signed-in account must never inherit the previous customer's paid entitlement, even on the same Mac; sign-out/revoked controls must not erase unrelated local product state. Keep all existing device-proof, attestation and revocation requirements.

Record separate outcomes for source tests, installed app, ordinary customer download, account-link/docking, purchase and activation. The in-repo installer regressions cover the harness-only checkbox and isolated engine behavior, not these six live scenarios.
