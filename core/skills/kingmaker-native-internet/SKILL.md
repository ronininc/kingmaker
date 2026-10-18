---
name: kingmaker-native-internet
description: >-
  Check how Kingmaker uses the internet and report it truthfully, keeping three lanes apart: web research over
  this Mac's own network (private SearXNG and public sources, with only verified source pages opened), thinking on
  the local model, and a cloud brain that sends the prompt to its provider. Use when the owner asks "does web
  research work", "what leaves my Mac", "is it using the internet", "verify the sources it opens", or "is the
  cloud brain on".
---

# Kingmaker native internet

People mix up three different things. This skill checks each one on its own and never lets one pass for another.

| Lane | What it is | What leaves the Mac |
|---|---|---|
| Web research | Kingmaker's engine (inside Kingmaker.app) searching and reading pages over this Mac's own network: the local SearXNG on `127.0.0.1:8890` and public sources (docs/SYSTEM-REQUIREMENTS.md lists them) | the searches and page requests |
| Local reasoning | the brain `local` (`kingmaker brain local`): Ollama on this Mac (`127.0.0.1:11434`) | nothing |
| Cloud brain | `kingmaker brain claude`, `chatgpt` or `grok`: the owner's own signed-in CLI | the prompt and the answer, to that provider |

Web research working does not mean a cloud brain is on, and a cloud brain answering does not mean web research
happened. Report them separately.

## What must hold

- **Only verified sources open.** While Kingmaker explains a research answer, Chrome opens the pages the answer
  stands on: sources the runtime marked verified, `http`/`https` only, no user name or password in the URL, at most
  three (`lib/evidence.mjs`). A link that merely appears in the answer text never opens. `SOL_GHOST_OPEN_EVIDENCE=0`
  turns the opening off.
- **"Open <site>" opens only that site,** and only an `http`/`https` address: never `file:`, `javascript:` or a URL
  with credentials.
- **The cloud lanes don't spend API money behind the owner's back.** They use the owner's signed-in CLI and see only
  Kingmaker's MCP tools; the Grok lane removes `XAI_API_KEY` and `GROK_API_KEY` from its environment. Actions still
  wait for the owner's word.
- **Web research can be turned off.** `SOLOMON_INTERNET_ACCESS=0` in the environment Kingmaker starts with (see
  docs/SYSTEM-REQUIREMENTS.md).

The runtime's own internet rules (which hosts, how it records what it read) live inside Kingmaker.app; their source
and their internal tests are not in this repository. Check them from Kingmaker's side, below.

## Checks

1. **Tests (offline, free):** `node --test test/browse.test.mjs test/lanes.test.mjs test/claude-brain.test.mjs`.
   They cover what may open, and that the cloud lanes use the signed-in CLI and only Kingmaker's tools.
2. **Local services (read only):** `kingmaker doctor` shows "Ollama answering on :11434". For SearXNG:
   `curl -sI http://127.0.0.1:8890/` answers when it is running.
3. **Which brain:** `kingmaker brain` prints the one answering now.
4. **A live research turn (only when the owner asks for it):** ask a research question at the console, e.g. "what
   changed in the latest macOS release, with sources". Watch which pages open in Chrome, and check each is one the
   answer cites. The voice-turn ledger (`voice-turns.jsonl` in the data folder) records, for spoken turns, whether
   the internet was used, never the words.
5. **Fail closed:** ask it to "open" a `file:` path: nothing opens.

## Report

```
Web research (this Mac's network)   browse test PASS; live turn: 3 verified sources opened   PASS
Local reasoning                     Ollama answering; brain = local                          PASS
Cloud brain                         not selected                                             OFF (nothing sent)
```

Then one line, e.g. `WEB RESEARCH: PASS (live, 3 sources); CLOUD BRAIN: OFF`. If the live turn wasn't run, web
research is `UNVERIFIED (not run)` even when its tests pass.

## Common honest outcomes

- Tests pass, no live turn yet: the opening rules are tested; live research is UNVERIFIED.
- Ollama not running: local reasoning `FAIL` on this Mac (`brew services start ollama` is doctor's fix), a setup
  problem, not a code problem.
- A cloud brain selected: say plainly that prompts go to that provider. Never describe it as on-device.
