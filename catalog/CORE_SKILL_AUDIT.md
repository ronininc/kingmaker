# Core skill inventory and learning audit

Verified 2026-11-15 against extracted Kingmaker 4.5.1 repair candidate 23d5414. This is not an installed-app upgrade or a claim that descriptions have become implemented abilities.

## Exact local inventory

- 169 SKILL.md files: 106 top-level core skills, plus 63 nested skill documents. core-pack.mjs registers only top-level folders individually. Nested documents are bundled references, not 63 additional registered executors.
- Existing REA core-pack inspection reports 106 enabled / 0 disabled. License labels reported by the existing scanner: MIT 40, Ronin 39, Apache-2.0 26, Unlicense 1. These are scanner results, not a fresh legal audit or execution benchmark.
- Six original native creation candidates: PBR synthesis, lathe mesh, textured lathe, USD lathe, camera orbit, edit timeline. They have implementations and constrained receipts, but existing explicit method admission and local execution approval still apply. Their quality remains draft, not AAA-certified.
- 35 provider workflow descriptions are reference-only, not native implementations.
- Generated core-skill-registry.json binds local descriptors, source/license documentation, relevant implementation files and catalog indexes to SHA-256. This registers a discoverable inventory, not new execution authority. Existing runtime registration is unchanged.

## Connected repository

Authenticated GitHub connector retrieved ronininc/kingmaker-tools skills/index.json: 440 entries, all draft, score 0, basis unreviewed CRM seed import. remote-skill-inventory.json preserves the exact index blob SHA, claimed payload hashes/sizes and provenance strings. Payloads were NOT fetched or verified. These entries cannot honestly be called 440 native or tested skills. Do not sum these with local entries as unique capabilities: overlap has not been resolved. No remote files modified.

## Existing learning is not autonomous reconstruction

learning.mjs records user preferences. skill-create.mjs writes instruction folders. absorb.mjs turns connector tool descriptions into candidate instructions which still invoke that connector. It graduates them after at least three runs and an 80% recent success rate; that does not establish independent implementation, source rights, or general task quality. core-pack.mjs performs REA/license screening on prose skills, not acceptance tests proving the described capability. None of those mechanisms alone establishes link -> source evaluation -> independent reconstruction -> isolated tests -> governed native admission. That separate learning orchestrator is being implemented by the integration worker, not duplicated here.

## Reproduce

node scripts/core-skill-registry.mjs > catalog/core-skill-registry.json
node scripts/core-skill-registry.mjs --verify catalog/core-skill-registry.json
node --test test/core-skill-registry.test.mjs

Regenerate manifest after an implementation or catalog merge, otherwise verification must fail. Manifest verification is integrity checking, not execution admission. No installer, network fetch, source execution, rights acceptance or arbitrary-code adapter is part of this module.
