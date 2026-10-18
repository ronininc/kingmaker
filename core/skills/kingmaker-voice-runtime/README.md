# Kingmaker voice runtime

A core Kingmaker skill: how Kingmaker carries out spoken commands across the Mac's apps and the tools the owner has
connected. `SKILL.md` is the skill itself.

## What it does

- Picks the tools a spoken command needs, without the owner naming them.
- Reads, searches and drafts at once.
- Proposes every change and waits for the owner's word; RED actions need their challenge words.
- Checks each change after it happens and says the result in a short spoken line.
- Keeps working when one tool fails, and says what is missing.

## What it does not do

- It doesn't add connectors or permissions. It uses only what is connected and allowed.
- It doesn't change what the owner's voice may do: that is `kingmaker voice` (owner, verified or propose).
- It never takes money, credential, legal or irreversible actions by voice.
- It doesn't listen while Kingmaker is asleep: waking it is the owner's act.

## Try it

1. `kingmaker start`, then wake it (click the menu bar logo or `kingmaker wake`).
2. Say a harmless command from `resources/COMMAND_LIBRARY.md`.
3. Run the checks in `resources/VOICE_ACCEPTANCE_TESTS.md`.

## Files

```text
kingmaker-voice-runtime/
├── SKILL.md
├── README.md
├── LICENSE
├── SOURCE.md
└── resources/
    ├── COMMAND_LIBRARY.md
    ├── CONNECTOR_POLICY.md
    ├── VOICE_ACCEPTANCE_TESTS.md
    └── START_PROMPT.txt
```
