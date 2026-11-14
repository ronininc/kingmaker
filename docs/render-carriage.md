# Multi-node render carriage

`lib/render-carriage.mjs` carries a render job across fleet nodes under the
owner's created-vs-consumed doctrine (2026-11-14, final form): **pins vet
what the system consumes; issued hashes seal and credit what the system
creates.**

**Consumed — materials.** The conductor splits the job into frame **chunks**
(`planChunks`) and publishes the scene assets on a fleet node with
`buildPortionManifest` pins. A render node (`scripts/render-node.mjs`)
claims a chunk and pulls the assets through `createFleetSource` — accepted
only by portion pin, byte-exact, refused by pin on any mismatch. Anything
that executes or drives execution stays in this class.

**Created — frames.** A rendered frame is a creation, not a material, and
is never matched against anything: no pre-existing pin, no other rendering,
no pixel hash. The node renders locally with Blender
(`blender --background --python <scene>`, run in the node's work dir with
`PWD` in agreement, frame range + output dir passed via
`CARRIAGE_FRAME_START` / `CARRIAGE_FRAME_END` / `CARRIAGE_OUT_DIR`), then
**issues** the frame:

- the frame's PNG metadata is stripped (`stripPngMetadata` — renders carry
  no metadata; only the pixel chunks and the colour chunks needed for
  identical decode are kept);
- the stripped bytes are hashed — that hash is the frame's **issued hash**,
  carried as a portion manifest so the frame travels as fleet portions;
- a **provenance record** is attached: `{ frame, jobId, chunkId, nodeId,
  sourceAssets: [{ id, sha256 }], issuedAt }` — the frame's credit to the
  vetted inputs it was created from.

The conductor (`scripts/render-conductor.mjs`) records the issued hash +
provenance and accepts the frame on issuance. The only post-issuance check
is **tamper-evidence**: pulled bytes, and later the stored bytes at
assembly, must still match the frame's OWN issued hash. A mismatch means
the artifact was manipulated after the system built it — the attempt is
refused, the node is named in the receipts and excluded from the chunk, and
the chunk is re-issued. The re-render is a **new creation** with its own
newly issued hash + provenance; it is accepted on its own issuance, and no
comparison against the first rendering is performed or needed. No re-render
is ever triggered by byte disagreement between creations — only by a
creation failing its own issued hash.

Render *quality* is not a carriage judgement: a creation is sealed and
credited as issued, and quality review stays downstream (director/QC), as
it is in the escapement method.

The conductor is the job's rendezvous (claim/submit over HTTP, mesh-token
admission when configured). On a live mesh, node discovery rides the fleet
directory / Headscale; loopback proofs do not prove live-mesh carriage.
