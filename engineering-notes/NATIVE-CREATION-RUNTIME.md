# Governed colloquial creation runtime

`createNativeCreationRuntime` in `lib/native-creation-runtime.mjs` implements an explicit proposal/approval/execution API. It is not automatically connected to the installed Kingmaker voice/CLI loop.

Caller supplies a conductor bound to a reviewed catalog, an explicit list of admitted method IDs, a governed planner callback (the model/runtime selected under existing policy), an approval callback, and optional governed reasoner/film producer. `filmQualityTarget` is supplied outside model output.

1. `await runtime.propose(colloquialRequest)` sends the request and only admitted method descriptors to the planner. The planner returns JSON with1..8 sequential `{id,methodId,inputs}` steps. Inputs may use `{$from:{step:'earlier-step',output:'store-name'}}` to compose prior outputs. Unknown IDs/inputs, forward references, unsafe keys and oversized plans are rejected.
2. Proposal binds request, selected method version/hash, inputs and quality target to SHA256. It is frozen and recognized by the issuing runtime. It is not execution authority.
3. `await runtime.execute(proposal,{workDir})` asks caller's approval callback for `{approved:true,proposalSha256}`. Missing/mismatched approval returns approval-required without creating files. Caller must connect this callback to its actual owner approval mechanism, not a model decision or auto-true function.
4. Methods execute in order in unique subdirectories. Outputs are composed as bounded JSON values. The first failed/incomplete/declared result stops the pipeline. Unconsumed original proposals only; no automatic rerun after failure. Receipts retain exact method result and output directories.

## Evidence and limits
Six fixtures cover colloquial request preservation, selection boundary, approval binding, real composed file creation, missing-native-adapter incomplete result, anti-forgery and external fidelity target. Planner/reasoner are fixtures, NOT evidence a live model understood unseen colloquial prompts. Real local file creation is proven; character/material generation is not.

The35 capability methods in catalog/native-asset-methods are staged supply, not automatically admitted. Their read-json jobFile input requires a caller-prepared reviewed job.json in the run workspace; this runtime does not invent or import that file. They currently expose native adapter requirements, not completed creation. Their preparation helper covers only the supported admission contracts.

Remaining production integration: connect admitted-method registry, actual selected model, owner proposal UI/receipt, asset-job preparation, existing job/progress/cancellation surfaces, native adapters, and acceptance checks in the live engine. No universal CLI interception or bypass of existing money/messages/connector/security gates was introduced. This API is callable source, not a claim that installed Kingmaker now creates arbitrary assets from speech.

## Candidate CLI integration

The actual Kingmaker entry now exposes isolated commands before add-on activation or live state resolution:

```
node lib/kingmaker.mjs native-create --request 'make a stone vase at 32 pixels' --work-dir /existing/output
```

First invocation prints a proposal and review hash without writing output. After review, repeat with `--approve HASH`. The review binds request, method digests, quality target and resolved output directory. This explicitly selects the four original native skills; it does not auto-admit provider workflows. No model, daemon, microphone or plugin activation is needed.

```
node lib/kingmaker.mjs asset-download --manifest /reviewed/asset.json --work-dir /existing/output --max-bytes 1000000
```

This likewise previews without network; `--approve HASH` binds exact asset metadata, origin, destination, byte budget and download-specific rights statement. The operator must actually review asset-specific rights. Approval is not proof that metadata is true, nor permission to republish. No generic `--yes` or downloaded approval flag is accepted.

These commands are candidate source integration, not installed app updates. Voice currently enters the existing session/brain turn paths; UI belongs to the separate engine source. A proper voice/UI proposal display, owner-authenticated approval and delivery binding are still required before connecting these operations there. The candidate deliberately does not interpret a casual spoken yes, a model output or imported metadata as authority to execute/download.

## Candidate voice/menu-bar session binding

`native-creation-session.mjs` is now bound into the existing voice route, local typed-command, typed-turn and terminal paths in `cli.mjs`. Explicit `native create make a stone vase` produces a read-back proposal, destination and exact digest. It does not execute. Type `native approve HASH` in the local window/terminal within five minutes to execute; speech and remote/phone turns cannot approve this new lane. Cancel, expiration, changed method/destination hash and duplicate use are rejected. Requested production-fidelity language is refused rather than silently substituted with procedural proof. Ordinary conversation routing remains untouched.

Native events use the existing `session.say` output and an additional structured stdout event. No new Swift card is claimed. Session tests exercise real original asset output and all approval boundaries. A complete running microphone/menu-bar UX test has not been performed: starting/rebuilding the signed app would affect the user's active session. Engine HTTP conversations and remote phones are not independently granted execution authority by this integration. Asset downloads remain separately reviewed CLI operations, not casually voice-approved downloads.
