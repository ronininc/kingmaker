# Kingmaker v0.4.2 — DRAFT release notes (Robbie reviews in full before publish)

## Kingmaker v0.4.2

The governed stack grows up: two native components join the program, and the set folded in alongside them makes the whole machine harder to misuse.

**New in this release**

- **LittleBrother.** The governed OSINT method set now ships as working code inside the program — public-source lookups (username, IP, domain, web recon, email format), every call screened and written to the hash-chained audit log. The full method set stays behind the founder tap where it belongs, and the Solomon build physically excludes it — absence, not a flag.
- **Harness².** A governed improvement loop for agent harnesses: propose, probe, compose — and nothing it discovers gets adopted without the founder's tap. Lessons carry across tasks; every cycle is audit-chained.
- **The fold-in set.** A governed scraping adapter with egress refusals enforced before any request leaves the machine; a browser-automation contract that refuses to launch anything unpinned; a Blender bridge with upstream telemetry pinned off and code execution behind the tap; a WhatsApp gate that refuses batch sends and stranger outreach; a model-slimming lane that refuses unhashed inputs and outputs. Two upstream models were evaluated and refused — the refusals ship as records, so the machine remembers why.

**Verification (this release's receipts)**

- Stack-wide: 22 suites, 377 checks, all green — including LittleBrother's Solomon-exclusion proof and Harness²'s adoption-refusal tests.
- Verified on the Mac build tree: LittleBrother's Solomon build exposes exactly the five public methods (the full method set is absent, not disabled), and Harness² instantiates under governance.
- The release itself: the app is codesign-verified, the manifest is signed and fingerprint-checked, and every part was re-read and hash-verified after writing.
- Signed manifest; verify against SHA256SUMS before installing, as always.

Library delivery stays your choice: stream it, or download it whole. Fleet learning stays opt-in — off unless you turn it on.

Free for personal use · source-available.
Mirrored on the update host like every release; GitHub remains the canonical home.

---

DRAFT NOTES (not for publish):
- Claims limited to verified receipts: stack 377/377 (22 suites) — in-stack runs 2026-10-20; Mac-tree smokes DONE 2026-10-20 (Solomon build = exactly 5 public methods, phoneLookup absent; Harness² instantiates); app build + codesign + signed-manifest verification receipts added 2026-10-21 from the release-parts run.
- No internal tooling names beyond what ships publicly in the tree (LittleBrother/Harness² are in the public payload; fold-in components described by function, not upstream brand where the upstream is a private-side seat — CHECK each name against the boundary before publish: scrapling/obscura/blender/whatsapp named here by function only, except WhatsApp which is a platform name, fine).
- Pen-test language: NONE — per the capability assessment, recon is described as OSINT lookups, never pen testing.
