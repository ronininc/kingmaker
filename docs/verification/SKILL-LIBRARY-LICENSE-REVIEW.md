# Skill-library distribution review

Read-only local audit, 2026-11-16. No licenses or third-party files changed.

The available `Projects/skill-library-motion-wt` snapshot identifies itself as Ronin Skill Library but its worktree metadata points to a missing Git directory. It cannot establish the current public repository revision. Its README says “Private; do not publish.” That conflicts with broad distribution assumptions and is not waived by a generic policy for newly produced components.

No root license was present. One per-item license was found within three directory levels: `universal-modder/LICENSE`, MIT, copyright Rehan and universal-modder contributors. Preserve that attribution and license; do not rewrite it as original Ronin Apache-2.0 content.

Thirteen root symlinks resolve outside the library into the user's `.agents/skills`: agents-sdk, cloudflare, cloudflare-email-service, cloudflare-one, cloudflare-one-migrations, durable-objects, sandbox-migrate-to-next, sandbox-next, sandbox-stable, turnstile-spin, web-perf, workers-best-practices, wrangler. Their targets exist, but none has a direct LICENSE/LICENSE.md/LICENSE.txt/COPYING file. This is missing local provenance, not proof of absence of upstream licensing. Do not dereference these into a distribution or infer ownership from their presence.

The shipped Kingmaker registry's prose/reference declarations are not blanket fleet licensing approval. Newly authored, independently reviewed generic components may be Apache-2.0; project outputs and private source remain separate. Existing items require per-item source revision, authorship, applicable license and notices, compatible redistribution rights, content/privacy review, and dependency/symlink containment before fleet admission. Unknown rights remain local/unadmitted. No root license was added and no public snapshot was silently relicensed.
