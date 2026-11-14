# Local task repair — 2026-11-09

Recovered the unfinished local-task and state-conductor modules from the installed
Kingmaker runtime and integrated them into the private source tree. Short requests
such as "Verify the final score" now use the saved task in the same conversation.
They cannot initialize or replay the simulation; replay opens an existing video.
Unrelated questions continue through the normal routing.

The conductor now requires an owner request to practice, honors no-practice and
single-attempt restrictions across the full task documents, and uses model decisions
when autopilot is forbidden. Authorized method tuning is bounded (32 attempts and
120 seconds by default), records its attempts, stops when the goal is met, and saves
its candidate in the task folder rather than promoting it into the global library.
This is method-parameter tuning, not model-weight training or weight synthesis.
Missed goals, invalid controls, exhausted steps and failed verification return failure.

## Proof

`node --test test/state-conductor.test.mjs test/local-task.test.mjs test/bar-events.test.mjs test/artifacts.test.mjs test/job-inbox.test.mjs test/direct-reasoning.test.mjs`

Result: **41 passed, zero failed**. The original installed conductor failed the
single-attempt regression with seven initializations; the repaired conductor makes
exactly one. Tests use synthetic tools, not the original scored race.

Independent review caught terminal-only goal fields and a practice timer that
excluded initialization. Both are now regression-tested; the baseline reuses the
probe and all practice commands share one deadline.

An installed-app job completed a one-step synthetic task through the local model
with no practice. A second job, "Verify the final score", executed only the saved
verification command. The command audit is `init, step, verify, verify`.

Job IDs: `job_jORjqorGkwGR`, `job_m-ANZ0t-pKLs`.

The local app repair preserves unrelated installed changes, rebuilds the payload
manifest and uses the existing Kingmaker Release signing identity. The installed
app passed deep/strict signature verification and all 1,899 payload hashes.

Report and proof logs:
`/Users/robbiebrown/Documents/Codex/2026-11-08/you-re-the-pilot-ai-in/outputs/kingmaker-fix-report.md`
and `kingmaker-fix-evidence.zip` in that same outputs folder.

## Source packaging closure

The four existing payload failures were reproduced on an unchanged export of base
commit `553476d8b2e8ccfeb9bcbc099b9aed917b09a60c`, then fixed by including only the
three native Armor runtime modules and their license. Vaults, keys, sealed bundles,
standalone apps and paid add-ons are excluded. The public signing pin was also
decoded from an accidental base64 representation into its original JSON values.

Adding `test/payload.test.mjs test/release-identity.test.mjs test/update.test.mjs`
to the focused proof command now gives **62 passed, zero failed**. The unpacked
payload starts and its native Armor imports resolve. This is a private source and
local installation repair; public release publication is separate.

Solomon routing: `sbench` is unavailable on this Mac's command path. No successful
sbench run exists to grade or report for this repair. The runtime was not silently
started; Codex completed the implementation and verification.
