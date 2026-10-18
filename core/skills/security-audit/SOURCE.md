# Source: security-audit

- Cloudflare's coding-agent security skill, vendored unchanged from
  https://github.com/cloudflare/security-audit-skill (skills/security-audit) at commit
  c1c8a8c1471069fb0e188eeaff69b8e8db6564a8 (2026-09-14). MIT, © 2025-2026 Cloudflare, Inc.: LICENSE kept
  in this folder.
- Added 2026-10-15 at the owner's request: "the cloudflare security skill they just released needs to be a
  core ability".
- Guidance by default; the full six-phase audit only on an explicit audit, pen-test or report request. Its two
  validators (validate-findings.cjs, validate-coverage-ledger.cjs) only read files (no network, no shell).
- It audits code Kingmaker has the right to audit (the owner's, open source, or by permission) and keeps
  Kingmaker's gates: nothing outward, no target code run outside a sandbox.
