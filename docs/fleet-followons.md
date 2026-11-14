# Fleet Replication — follow-ons (catalog publication, directory discovery, churn)

Three follow-ons to Fleet Replication v1 (`docs/fleet-replication.md`), each
in its own module; no v1 file changes.

## 1. The catalog carries the portion manifests — `lib/brain-library-fleet-catalog.mjs`

`catalog/fleet.json` (schema `kingmaker.fleet-catalog/1`) is the shipped
Brain Library catalog extended with the fleet descriptor of every item:
`{id, kind, name, size, sha256, portionBytes, portionSha256[]}` — the
§3.1 descriptor of the v1 design, published. Regenerate it with:

```
node scripts/build-fleet-catalog.mjs [--out <path>] [--portion-bytes <n>]
```

The builder walks `buildCatalogSources()` — the same production source
construction the access layer serves from — and computes every pin in one
pass over the real bytes. A source whose carried whole pin contradicts its
bytes is refused (`FLEET_CATALOG_PIN_CONFLICT`); a virtual source with no
whole pin (training modules, the knowledge library) gets one computed from
its bytes, which v1's `buildPortionManifest` cannot do (it requires a pin
to start from). Training *parts* are not items (they are members of their
module item) and are named in the document's `skipped` list. Model weights
join the same file when the publish build wires a range fetcher
(`buildCatalogSources({fetchModelRange, models})`): the builder is
source-agnostic, so a model's descriptor is computed from the door's own
range reads at publish time.

Clients load the file with `loadFleetCatalog()`, which validates every
entry: an entry with a missing or short `portionSha256` is returned in
`rejected` with its problems and is never handed to a fetcher. There is no
fallback to unpinned portions — a descriptor without a complete manifest
is refused, by the loader here and by `createFleetSource` itself
(`FLEET_PIN_MANIFEST_MISSING`).

## 2. Nodes find each other — `lib/brain-library-fleet-directory.mjs`

A directory is a rendezvous, never a store:

- `POST /v1/register` — `{nodeId, url, profile}`; the registration expires
  after the directory's TTL unless renewed.
- `GET /v1/directory` — the live registrations.
- `startDirectoryHeartbeat()` renews a registration until stopped.
- `createDiscoveredFleetSource({descriptor, directoryUrl})` builds a v1
  fleet source whose peers were resolved from the directory. The caller's
  only network configuration is the directory's address; the resolved
  peers ride on the source as `peerReceipts` so a run can prove where
  every address came from.

The directory hands out availability only. A lying or stale directory can
waste requests or hide peers; it cannot make bad bytes acceptable, because
acceptance is still the portion pin and, on download completion, the
whole-item pin. Mesh admission (`x-kingmaker-mesh-token`) gates
registration and lookup when a token is set, as it gates serving in v1.

Production note (stated in v1's design §9, still true): in the Headscale
mesh this role is played by MagicDNS enumeration. This module implements
the same register/lookup contract for substrates with no mesh directory —
and the fetcher cannot tell the difference, because it only ever consumes
peer URLs + advertisements.

## 3. The churn cycle applies the planner — `lib/brain-library-fleet-churn.mjs`

`createFleetChurn({stateDir, logDir}).runCycle({access, catalog, budgetBytes, staleAfterMs, now})`
runs one cycle over a live access instance, to the standing churn rules:

1. **Verify** — every resident is re-hashed against its receipt pin
   (`access.verifyResident`). A failure is a `TAMPERED` verdict in the
   cycle record with expected and actual hashes; the holding is
   quarantined in the ledger and its bytes are **never touched** — a
   failed verification is a user-visible verdict, never silently repaired.
   (The access layer already refuses to serve an unverified resident;
   churn adds the verdict and the record.)
2. **Refresh** — a resident whose receipt pin differs from the current
   catalog descriptor is superseded and re-pulled through
   `access.download()`, which accepts the new bytes only against the
   serving source's pin. A refusal is a `REFRESH-REFUSED` verdict; the old
   resident stays.
3. **Evict** — with the reason recorded per item: `orphaned` (the catalog
   no longer publishes it), `stale` (unused longer than `staleAfterMs`,
   30 days by default), `budget` (the v1 planner's LRU set under
   `budgetBytes`). Protected kinds (`catalog`, `method`,
   `knowledge-index`), pinned holdings, and quarantined holdings are
   never evicted by any reason; if the untouchable floor alone busts the
   budget, the record says `reachable: false`.

Holdings are tracked in `holdings.json` (the churn state dir): callers
record use with `noteHolding({id, lastUsedAt, pinned})`. Every cycle
writes its full record — verdicts, refreshes, evictions, and footprint
before/after measured from the access layer's own `diskState()` — to the
log dir and returns it. Stream-cache artifacts carry no at-rest pin in the
access layer, so churn verifies residents and evicts cache bytes by
age/budget only.

## What is still not claimed

- **Live Headscale carriage.** All proofs run the production handlers on
  loopback, like v1. Nothing here was run on a second machine or over the
  mesh; the unblocking act is a second docked install (or the owner's Mac)
  on the mesh, running the directory + node there and repeating the
  discovery leg against it.
- **Model portion manifests in the published file.** The builder supports
  them; this build's `catalog/fleet.json` contains none because no range
  fetcher was wired (the builder prints that absence). Wiring the door
  fetcher at publish time is a catalog-lane act.
- **A scheduler.** `runCycle` is one cycle; the daily cadence is whatever
  supervisor invokes it — wiring it into a daemon is a separate commission.
