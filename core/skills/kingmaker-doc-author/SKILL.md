---
name: kingmaker-doc-author
description: >-
  Write or extend Kingmaker's own documentation in its house voice: README.md sections, docs/*.md pages, the
  command list at the top of lib/cli.mjs, and the SKILL.md of a core skill. Short plain sentences, honest limits,
  and no claim the code or a test can't back. Use when the owner asks to "write the docs for X", "add a README
  section", "document this command", "write a skill for Kingmaker" or "make this read like the rest of the README".
  Prose only: status lines driven by test results belong to kingmaker-readme-sync.
---

# Kingmaker doc author

Kingmaker's docs read like a careful person explaining a machine they built: what it does, how to run it, and
where it stops. No marketing. A new page or section should be impossible to tell apart from README.md and the
pages in docs/.

## When to use it

- A new docs/<TOPIC>.md page, a README section, a row in the README's command table, or a usage line in the
  comment block at the top of `lib/cli.mjs` (that block is what `kingmaker` prints with no arguments).
- A new core skill under `core/skills/<name>/` (SKILL.md, plus LICENSE and SOURCE.md like its neighbours).
- Rewording a page so it says what is true today.

Status lines (does X work, is Y proven) come from `kingmaker-readme-sync`, after a real run.

## The voice

- **Short, plain sentences.** One fact per sentence. Read README.md's "Voice" and "Known gaps" sections first and
  match them.
- **Say what it does, then what it doesn't.** "It never trades", "Nothing stays resident", "Chrome doesn't let a
  program add an unpacked extension". Fencing the scope is the house move.
- **Name the real thing.** A command that exists (`kingmaker doctor`), a file that exists (`lib/voice.mjs`), an
  environment variable the code reads. Grep for it before you write it.
- **Numbers carry their source and date.** The README's "Measured on an 8 GB M3 (2026-10-07)" table is the model.
- **Limits are written down, not hidden.** The README's "Known gaps (v0.1, honest)" section is a feature.
- **Plain words over jargon.** "Your word", "waits for your yes", "the Mac's own apps".

## Claims you never write

Never write that Kingmaker:

- did something it only proposed, or proposed something it only drafted;
- works offline when a step needs the network, or keeps data on the Mac when it leaves it (a cloud brain sends the
  prompt to its provider: say so);
- is tested or proven when no test covers it, or when the test skips on this machine;
- is signed, notarized or released when it isn't;
- acts on its own where it waits for the owner's word.

The engine ships compiled inside Kingmaker.app; its source is not in this repository. Describe what it does
from Kingmaker's side (what Kingmaker sends, what comes back, what the owner sees). Don't cite engine source paths a
reader can't open.

## Shapes to reuse

A docs page:

```markdown
# <Topic>

<One sentence: what it is.>

## What it does
<Plain sentences or a short list. Each command named exists in lib/cli.mjs.>

## What it doesn't do
<The fence: what stays off, what needs the owner's word, what never leaves the Mac.>

## How to check it
<The test file under test/ and the live check (kingmaker doctor, kingmaker status, a spoken turn).>

## Known gaps
<What isn't proven or built yet, honestly.>
```

A core skill's SKILL.md: frontmatter `name:` (exactly the folder name) and `description:` (what it does and when to
use it, in the owner's words), then "When to use it", "How Kingmaker runs it" and "Boundary". See
`core/skills/rea/SKILL.md` and `core/skills/trading-agents/SKILL.md`.

## Public text

This repository is public. Keep personal data out of every doc: no people's names, no clients, no home-folder paths
with a user name in them, no email addresses (the licensing contact in README.md is the one exception), no keys or
tokens, not even shortened ones.

## Before you finish

Read the draft next to README.md. For every command, file and variable it names, confirm it exists (`grep -n` in
`lib/`, `ls`). If a sentence sounds like a brochure, or claims something no test or live check showed, cut it down to
what is true. A page that marks its own limits is correct; one that reads well but overclaims is wrong.
