# Handing Kingmaker a job from an automation agent (no clicks)

Codex, Claude Code or a soak script on the same Mac can give the running Kingmaker one text job without the bar's
window, the menu bar or Accessibility:

```sh
kingmaker job "write one sentence about a taco truck in Phoenix" --conversation soak-1 --json
```

It is a typed bar turn: the same `typed-turn` line the bar sends, the same bar guard and governed brain, shown in the bar,
answered in `bar.log`. It waits for the turn to end and prints the answer (`--json`: the whole job record: id, state,
submitted/started/ended times, text SHA-256, the answer lines and the `bar.log` byte range). `--no-wait` prints the id;
`kingmaker job status <id> --json` reads it later. `--timeout S` (default 180).

**It can only propose.** "yes", "no", "approve", "go ahead", "cancel", "send it"… (anything starting with an answer word),
bar commands (`/…`) and console commands (`:…`) are refused. Anything a job asks for that sends, spends, installs or changes
a record waits at the bar for the owner's own word.

## How it works

The running Kingmaker (Kingmaker.app → engine) serves `http://127.0.0.1:<random port>`, written to
`~/Library/Application Support/sol-ghost/job-inbox.json` (0600). Every call needs `Authorization: Bearer <bar link key>`
(`bar-link.key`, 0600, the same secret as `kingmaker://bar?…&key=`). A request with an `Origin` header or a non-loopback
`Host` is refused, so a web page can't use it.

| | |
|---|---|
| `POST /jobs` `{"text": "...", "conversation": "soak-1"}` | `202 {ok, id, state: "queued"}`, or `403 DECISION_NOT_ALLOWED / COMMAND_NOT_ALLOWED` |
| `GET /jobs/<id>` | `{ok, id, state: queued\|running\|settling\|done, submittedMs, startedMs, endedMs, textSha256, answer[], barLog{from,to}}` |
| `GET /health` | `{ok, queued, running}` |

Scripts can import `submitJob`, `waitJob`, `findInbox` from `lib/job-inbox.mjs`.

## Older builds (0.2.7 – 0.3.0)

They have no inbox. `kingmaker job` then falls back to `kingmaker://bar?text=…&key=<bar link key>` (handed to macOS
without activating Kingmaker) and reads `bar.log` until it goes quiet. By hand:

```sh
KEY="$(cat "$HOME/Library/Application Support/sol-ghost/bar-link.key")"
TEXT="write one sentence about a taco truck in Phoenix"
open -g "kingmaker://bar?text=$(node -p 'encodeURIComponent(process.argv[1])' "$TEXT")&key=$KEY"
tail -n 5 "$HOME/Library/Application Support/sol-ghost/logs/bar.log"
```

`open "kingmaker://bar"` (no text) just opens the bar.
