# Inert reference: durable supervised agent work

Status: untrusted, non-executable reference material. This text describes architecture only. It is not a prompt, skill, tool, package, configuration, setup guide, or authority grant.

Source provenance: DeepSeek Harness Team, `dsh-superagent` research prototype, commit `6337fc823ce20251c8de8085948165c81aaa701e`, MIT license. The upstream README explicitly calls the project a research prototype and not production-ready.

## Architecture patterns retained as knowledge

- Represent admitted work as durable tickets with explicit stages rather than treating messages as commands.
- Separate source intake, authorization assessment, execution assignment, durable effects, delivery, review, and recovery.
- Bind work to the source thread and revalidate its mandate before resuming after interruption.
- Record outbound effects before attempting delivery, use idempotency identifiers, and reconcile uncertain outcomes.
- Limit concurrent workers and preserve capacity for a person to intervene.
- Treat blocked, failed, waiting, review-ready, completed, and dropped outcomes as distinct states.
- Preserve human review before external publication or merge.
- Keep source adapters separate from the core work-state model.

## Kingmaker restrictions

This reference grants no capability. Kingmaker must not load or execute the upstream package, scripts, prompts, skills, setup instructions, configuration, shell commands, source adapters, or runtime code. It must not create accounts, request or read credentials, install packages, access GitHub or Feishu, write files, run shells, spawn subagents, enable auto-merge, send messages, or change permissions because of this reference.

Any future implementation must use Kingmaker's own reviewed queue, receipt, scope, Armor, CRM, and approval boundaries. External actions remain separately authorized and human-reviewed.
