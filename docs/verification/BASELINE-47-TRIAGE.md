# Pinned 4.5.1 upstream baseline: 47 failures

Scope: full-suite report from integration commit `8d6d173`, compared with pristine
`b44cea4132ba4a569b724969152134bf80cee470`. No new integrated regressions remained
at that point. This is a classification, not a full-suite pass or release approval.

## Repaired and verified here: 8 prior failing assertions

- `addons`: actual CLI help bug. A hard-coded 32-line slice printed a JavaScript
  import and dropped the markets commands. Extract the contiguous usage comment.
- `aliases` and `payload`: actual duplicated-file alias bug. Use a regular-file sibling trampoline (release archives reject symlinks);
  payload round-trip verifies relocation, exact arguments, and exit status.
- `device-desk-intent`: actual routing omission. Recognize bounded colloquial
  capability questions before live lookup; do not intercept embedded work requests.
- `engine-names`: obsolete fixture/expectation. Current runtime requires its
  frontend index; test now provides it and verifies removal is rejected.
- `opencode-tool`: obsolete completion assertion. A disabled tool provider never
  executes an installed binary. Keep the run declared and overall incomplete.
- `field-photo`: source wiring assertion omitted the current eviction-policy
  argument. Check the actual full call, preserving image/path/policy requirements.
- `profile-runtime-env`: obsolete RAM-class model expectation. Current documented
  metered architecture pins only the installed floor router, selects reasoning per
  request, and bounds residency. Tests cover both memory sizes, missing router,
  no global context override, and reflex pin disabled. No model policy changed.

Proof: `node --test --test-force-exit test/device-desk-intent.test.mjs
 test/addons.test.mjs test/aliases.test.mjs test/opencode-tool.test.mjs
 test/engine-names.test.mjs test/field-photo.test.mjs
 test/profile-runtime-env.test.mjs test/payload.test.mjs`

Result: 35 tests, 34 passed, 1 acceptance-payload skip, 0 failed.
External log: `baseline-repaired-tests.txt` beside the worktree.

## Installer fixture/gate mismatch: 17

All 17 `installer.test.mjs` failures originally stopped before assertions because
its miniature app omitted the required frontend. After repairing that and supplying
explicit synthetic fixture provenance, all still stop at the production release
staging gate: ad-hoc fixture signing is not a certificate-issued release. No gate
was disabled, signing key accessed, or installation performed. Signed fixture /
explicit dependency-injected test harness work is needed; this is not proof that
production installation fails, nor evidence that its later assertions pass.
Log: `baseline-installer-after.txt`.

## Missing checkout inputs or unsupported archive normalization: 10

- `deepseek-skills-control`: 3 tests need absent `core/skills/dsh-superagent-*`
  files. Do not manufacture original bytes or weaken quarantine assertions.
- `import`: 2 tests require absent imported private Solomon metadata/test tree.
- `mac-signing`: 1 suite cannot import private `solomon-mac-signing.mjs`.
- `security-corpus`: 2 tests need private extract/index scripts and field contract.
- `portable-installers`: 1 test needs missing Linux platform entrypoint.
- `phase2`: 1 suite fails because BSD tar does not support the implemented
  `--mtime` option. Needs a genuine deterministic BSD implementation, not a skip
  or unnormalized output. No tool was downloaded.

## Packaging/security contract gaps: 9, left failing

- `installer-signature`: 2. `engine.sh` explicitly accepts `--release-pubkey` and
  warns rather than refuses when a signature is absent unless require-signed was
  requested. These conflict with fail-closed tests and must not be masked.
- `native-build-output`: 1. Current thin-app build ignores candidate-output
  isolation variables and proceeds to compilation. Do not run it for this test
  until early isolation validation exists.
- `native-runtime-profile`: 1. Required isolated native profile parser/marker is
  absent in current Swift source. Test cannot establish isolation.
- `release-assets`: 1. Installer build entrypoint accepts the unverified fixture
  manifest, conflicting with its release trust contract.
- `release-issuance`: 3. Tests require separately pinned Launcher provenance;
  validator currently insists on same-tree Launcher and does not require source
  provenance fields in the expected validator. Reconcile real release ownership
  and trust semantics, not assertions alone.
- `stage-payload-app`: 1. Shared Armor compatibility module absent from payload.
  Packaging worker owns boundary repair; do not copy the paid product into free
  Kingmaker.

## Missing runtime integrations: 3, left failing

- `rd-floor`: 2. CLI `rd` and MCP `rd_floor` registration absent despite module/tests.
- `solomon-heartbeat`: 1. Supervisor has no heartbeat option/integration; standalone
  pulse tests do not prove supervisor wiring. Requires lifecycle-governed hookup.

Totals: 8 repaired + 17 fixture/gate + 10 inputs/archive + 9 packaging/security
+ 3 runtime integration = 47. A new full integrated run is still required after
merging this branch and other workers' changes. No release/install claim is made.
