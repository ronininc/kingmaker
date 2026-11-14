# Which Kingmaker version is current

Read this before assuming a version. Do not assume 4.4.4.

| Where | Version | How it was checked (2026-11-11) |
|---|---|---|
| Published release (what the site hands out) | **4.4.4** | `Kingmaker-Installer-v4.4.4.dmg` exists on the `v4.4.4` release; no installer asset exists under `v4.4.5`, `v4.4.6` or `v4.4.7` |
| This repository, `main` (the testing copy) | **4.4.5 work, unreleased** | the chat-route fix of 2026-11-09 (`lib/state-conductor.mjs`, `lib/local-task.mjs`; pull requests #125 to #127) is merged here |
| The owner's installed app | **4.4.6** | `/Applications/Kingmaker.app/Contents/Info.plist`, per the owner's inspection of 2026-11-11 |
| Public repository `ronininc/kingmaker` | `package.json` says 4.4.5; `README.md` still says 4.4.4 | read from its `main` |

What this means:

- **Production is 4.4.4.** That is the only version a customer can download.
- **The testing copy is ahead of production.** Work on `main` here has not been released.
- **A 4.4.6 build exists on the owner's Mac.** Which commit it was built from is not recorded in this repository. If you need to know, ask the owner; do not guess.
- The version is not stored in this tree. `app/Info.plist` and `installer/Info.plist` carry `@VERSION@`, filled in at build time, and `package.json` (`0.3.0`) is not the product version.

Two copies of every build (owner's standing rule, 2026-11-11): this repository is where Kingmaker is tested and iterated; production is whatever the site is serving. When production is behind this copy, production is brought up to it.

Update this file whenever a release is published or the installed build changes.
