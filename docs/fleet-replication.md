# Fleet Replication (kingmaker.fleet/1)

`lib/brain-library-fleet.mjs` — peer serving and verified fetching for the
Brain Library, on the seams of `lib/brain-library-access.mjs`. Doctrine:
fleet-based streaming, no server — every install carries its own copy of the
library; docked installs stream portions to each other; the door
(GitHub/Forgejo) is bootstrap/discovery only.

## The one rule

A portion is accepted from **any** source — local disk, a fleet peer, the
door — by exactly one test: its SHA-256 equals the descriptor's portion pin
(`portionSha256[i]`). A completed download is additionally accepted only when
the assembled bytes match the whole-item pin, enforced by the access layer as
before. Serving peers are untrusted by construction; a mesh admission token
(`x-kingmaker-mesh-token`, carried over the Headscale mesh in production)
controls who may ask, never what is believed.

## Pieces

- `buildPortionManifest(source, {portionBytes})` — a catalog descriptor with
  per-portion pins, built from any access-layer source. Portion size defaults
  to the access layer's 256 KiB pull segment and may not exceed its 1 MiB
  portion bound. A descriptor without a complete manifest is refused
  (`FLEET_PIN_MANIFEST_MISSING`).
- `createFleetNode({nodeId, sources, portionBytes, meshToken, profile, budgets, onServed})`
  — serves held items: `GET /health`, `GET /v1/advertise` (availability hints
  only), `GET /v1/items/<id>/portions/<i>` (bytes + `x-kingmaker-sha256`).
- `createFleetSource({descriptor, peers, doorSource, localSource})` — an
  access-layer source. Per portion: local copy → advertising peers in order →
  door, pin-verified identically at every step. A pin mismatch is refused and
  quarantines the peer for that item; a dead peer fails over mid-range — the
  portions already accepted are kept and only the missing ones move.
  Attempt receipts: `source.stats()`.
- `chooseEvictions(holdings, {budgetBytes})` — pure LRU eviction planner;
  catalogs, methods, knowledge indexes, and pinned rows are never evicted.

## Wiring sketch

```js
import { createBrainLibraryAccess, fileSource } from './brain-library-access.mjs';
import { buildPortionManifest, createFleetNode, createFleetSource } from './brain-library-fleet.mjs';

// A holder serves what it holds:
const held = await fileSource({ id: 'method:example', kind: 'method', path });
const node = createFleetNode({ nodeId, sources: new Map([[held.id, held]]) });
await node.listen(port, meshAddress);

// A fetcher pulls the same item fleet-first:
const descriptor = await buildPortionManifest(held); // in production: from the signed door catalog
const source = createFleetSource({ descriptor, peers: [peerUrl], doorSource });
const access = createBrainLibraryAccess({ sources: new Map([[held.id, source]]), storeDir, cacheDir, stateDir });
await access.download(held.id); // portions fleet-served, whole item pin-verified
```

Standalone is structural: with every peer down, the access layer still serves
the install's verified residents locally, and the catalog/pins/manifests are
part of the protected floor on disk.
