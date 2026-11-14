# Method — OpenCode code task (streamed harness, headless run)

A method file: read by the conductor (`lib/method-conductor.mjs`) and executed step by step.
For a code-class request: record the task as a job record in the working folder, then run the
coding harness on it headless — OpenCode (MIT, `anomalyco/opencode`), the fleet's local coder
seat — and leave the run's exit code and output in the trace.

OpenCode is a Brain Library TOOL (catalog/tools/index.json, `provides: ["opencode"]`). Step 1
checks for it on PATH; on a miss the tool-streaming provider pulls the staged payload for this
platform, materializes it and registers it, and step 4 — declared only because the node lacked
the tool — then EXECUTES for real against the materialized binary (argv as written, no shell,
cwd = the working folder). On a node where the catalog carries no staged payload for the
platform, step 4 stays declared with its reason: never faked.

The run is headless by construction: `opencode run` is OpenCode's non-interactive mode, and
`--auto` approves its tool permissions without a terminal. That makes the WORKING FOLDER the
sandbox boundary — conduct this method only in a folder that is the task's own scratch or
checkout, never a home directory. The model is an input dial: the default is the vendor's
built-in free model; a caller conducting against a local streamed weight passes its own
`provider/model` (e.g. an Ollama-served Brain Library model) and this file does not change.

## Executable block

```kingmaker-method
{
  "id": "opencode-code-task",
  "version": "1.1",
  "title": "OpenCode code task (streamed harness, headless run)",
  "domain": "code",
  "inputs": {
    "task": "Fix the bug in math.js so that add returns the sum of its two arguments. Change nothing else.",
    "model": "opencode/big-pickle",
    "toolPath": "opencode"
  },
  "steps": [
    {
      "n": 1,
      "id": "check-opencode",
      "type": "check-tool",
      "command": "opencode",
      "into": "toolCheck"
    },
    {
      "n": 2,
      "id": "inspect-workdir",
      "type": "inspect",
      "path": ".",
      "into": "workdirInfo"
    },
    {
      "n": 3,
      "id": "write-job",
      "type": "write-json",
      "path": "opencode-job.json",
      "value": {
        "schema": "kingmaker.code-job/1",
        "method": "{{method.id}}",
        "methodVersion": "{{method.version}}",
        "task": "{{inputs.task}}",
        "model": "{{inputs.model}}",
        "tool": "{{inputs.toolPath}}",
        "action": "opencode run --auto --model {{inputs.model}} {{inputs.task}}",
        "stepTimeoutSeconds": 300,
        "state": "task-written-run-declared"
      }
    },
    {
      "n": 4,
      "id": "run-opencode",
      "type": "declare",
      "into": "runResult",
      "action": "opencode run --auto --model {{inputs.model}} {{inputs.task}}",
      "reason": "OpenCode is not on this node and no staged payload was pulled, so the run cannot execute here. The job record above carries the exact task and model; install OpenCode, or let the Brain Library stream it (catalog tool opencode, staged per platform), and this step executes for real."
    },
    {
      "n": 5,
      "id": "verify-artifacts",
      "type": "verify",
      "assertions": [
        {
          "file": "opencode-job.json",
          "field": "schema",
          "equals": "kingmaker.code-job/1"
        },
        {
          "file": "opencode-job.json",
          "field": "state",
          "equals": "task-written-run-declared"
        }
      ]
    },
    {
      "n": 6,
      "id": "note-outcome",
      "type": "note",
      "text": "OpenCode code task conducted: the job record is written; the run step's trace entry carries the verdict — 'executed' with the run's exit code and output when the harness was on PATH or streamed from the Brain Library, 'declared' with its reason when it was not. Whether the code change itself is correct is the conducting loop's evaluation, not this file's claim."
    }
  ]
}
```

## Steps (prose mirror)

1. **check-opencode** — Is `opencode` on PATH? On a miss, the Brain Library is asked: the staged OpenCode payload for this platform is pulled, hash-verified, materialized and registered, and the check re-runs against the materialized binary.
2. **inspect-workdir** — Record the working folder's state before the harness writes into it.
3. **write-job** — Write `opencode-job.json`: the order as a record — task, model, tool, and the state `task-written-run-declared`.
4. **run-opencode** — `opencode run --auto --model <model> <task words>`, executed for real when the harness is present or was streamed in step 1 (exit code and stdout land in the trace and in the `runResult` store); otherwise DECLARED with the reason.
5. **verify-artifacts** — Re-read the job record and confirm it landed as written.
6. **note-outcome** — State plainly where the run's verdict lives (the trace), and that code correctness is the loop's evaluation.

## Failure modes

- **OpenCode absent and unstaged for this platform** → step 1 reports `found: false` with the library's reason; the job record is still written and verified; step 4 stays declared. Nothing is claimed to have run.
- **The task contains quotes, backslashes or line breaks** → the declared action is split into argv on whitespace and the harness receives the task as joined plain words; punctuation that would need quoting does not survive. Callers pass tasks in plain words (the same discipline as the render methods' subject rule).
- **The run exceeds the conductor's step timeout (300 s)** → the step records as failed with the timeout; shrink the task or pass a faster model — the file's dials do not change.
- **The model is unreachable** (no provider configured, local server down) → the harness exits non-zero and the step records as failed with its stderr; the job record remains as the receipt of what was asked.
- **The model backend never answers** (observed 2026-11-14, the v1.0 proof conduction): the harness's own log shows instance init completing, then zero tokens and zero errors until the conductor's cap kills the run — the target file untouched, the step failed at 300 s. This was the vendor's built-in free tier reached from a sandboxed VM egress. The defect is the backend's reachability from that node, not this file's steps: conduct with the `model` dial pointed at a backend the node can actually reach (a local Ollama-served streamed weight is the production shape). Since v1.1 the job record carries the exact attempted `action` and the step cap, so an attempted-and-failed run is distinguishable from a never-attempted one in the folder's own receipt.
