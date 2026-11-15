# Asset admission and adapter contract

`lib/film-assets.mjs` introduces a local-only boundary, not a live MPFB integration.
No software is installed, no assets downloaded or uploaded, and no settings changed.

1. Construct `kingmaker.asset-manifest/1` with an `assets` array. Each entry needs id, kind (mesh/texture/hdri/motion), relative path, exact bytes, SHA256, title, author, HTTPS source, license, changes, and dependencies (asset IDs). Supported automatic license policy is CC0-1.0 or CC-BY-4.0 only. A source/license claim must still be reviewed against the real asset page; declaring CC0 in JSON does not establish rights. Other licenses are rejected for separate review, not presumed forbidden universally.
2. `prepareAssetJob({request,manifest,assetRoot,maxBytes})` validates references, dependency graph, local containment, exact file sizes and streamed hashes. Default aggregate input budget64MiB, maximum1GiB. Preparation returns `prepared-not-executed` and explicitly does not certify content, licensing or quality.
3. Character request: `{kind:'mpfb-rigify',preset:'neutral-adult',rig:'rigify'}`. This is the sole admitted preset for the initial adapter. It does not yet create a person. An actual version-pinned MPFB/Rigify implementation must map this data to trusted local scripts, verify installed versions and bundled asset provenance, then create/bake/export a validated rig.
4. Material request: `{kind:'pbr-material',maps:{baseColor:'asset-id',normal:'asset-id',roughness:'asset-id'},normalConvention:'OpenGL'}`. Maps reference admitted texture IDs only. Base color is sRGB; data maps Non-Color. An actual adapter must inspect formats/dimensions, handle DirectX normal conversion when selected, wire nodes and validate material output. This module does not parse or create textures.
5. `runAssetAdapter({prepared,adapter,outputRoot,maxOutputBytes})` requires an explicitly injected authorized function. It rechecks inputs, reserves requested output budget plus256MiB free space, and creates a unique output directory. Adapter receives `{job,inputs,outputDir,maxOutputBytes}` and returns `{manifest}` describing generated files inside that directory. Output bytes are verified, original and output attribution are saved together, and receipt says `adapter-artifacts-verified`, never production/render/quality complete.

## Obligations of the live adapter

- No arbitrary model-authored Python, autoexecuted imported scripts, network dependency fetches, global add-on activation or implicit PATH tool discovery.
- Recheck input hashes at import; admission alone cannot prevent later concurrent file edits.
- Enforce subprocess timeout/cancellation and disk budgets while producing output. The in-process adapter interface is a trusted implementation boundary, NOT an OS sandbox; it cannot stop a malicious injected function from ignoring limits.
- Output manifests must include all relevant texture/mesh dependencies and preserve sources and licenses. Emitting CC0 cannot wash away a restricted input license. Input attribution is retained irrespective of output declarations.
- Rigify control rigs can include drivers: assess supported import/export data and bake as needed, rather than enabling arbitrary embedded execution.
- Add a validated import/material/rig path to scene production before claiming end-to-end integration. Current primitive producer still rejects external mesh kinds.

## Evidence

Fixtures test traversal/symlink escapes, digest/size tampering, dependency cycles/missing references, attribution, license restrictions, PBR color-space mapping, narrow character preset, absent adapter refusal and output artifact receipts. Fixture bytes intentionally are not real decoded textures; no actual MPFB, character generation, rig deformation, material rendering or cinematic quality has been validated.
