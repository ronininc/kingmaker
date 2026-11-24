# K4 — Model catalog refresh: PARTIAL. Three models measured; the rest blocked by disk.

Claude seat, 2026-11-24.

## Status update (after the owner ran the bench on the 8 GB Mac)

**Three installed small models were measured on the 8 GB Mac and recorded in `catalog/HARDWARE_OUTCOMES.md`. Everything else is still unmeasured: the Mac has 1.7 GB of disk free, which rules out pulling any model and makes the two installed 8B/7B models unsafe to bench.** No Qwen 3.5 or Gemma 4 entry was added, `qwen3:4b` and `granite-code:3b` were not re-run, and no label in `lib/models.mjs` was changed (that file is the backend seat's).

To finish K4, free about 10 GB on the Mac, then run step 3 of the runbook below.

The text under this line is the original entry, written before any measurement.

---

# K4 — Model catalog refresh: NOT DONE. No number was measured.

Claude seat, 2026-11-24.

## Headline

**K4 is blocked. This seat ran in a cloud Linux container with no access to the 8 GB Mac, so nothing was measured and no catalog number or label was changed.** The rule was "a number you did not measure does not go in", so nothing went in. What follows is the runbook that produces the measurements on the Mac, and the exact places the results land.

## What is stale, and where it lives

| Problem | Where | Whose file |
|---|---|---|
| Every 8B model labelled for 8 GB (`minGb` 8 on `qwen3:8b`, `llama3.1:8b`, `mistral:7b`, `dolphin3:8b`, `deepseek-r1:8b` and their abliterated twins; the listing prints it as "8GB+") | `lib/models.mjs` lines 17–31, printed by line 61 | **Codex** (`lib/`) |
| `qwen3:4b` called "Best all-rounder at 8 GB" | `lib/models.mjs` line 17 | **Codex** |
| No Qwen 3.5 or Gemma 4 entries | `lib/models.mjs` `MODEL_CATALOG` | **Codex** |
| `granite-code:3b` fails to load (HTTP 500) | recorded in `catalog/HARDWARE_OUTCOMES.md` line 35; it is not in `MODEL_CATALOG` | Claude (text) |
| The measurements themselves are from 2026-10-09 | `catalog/HARDWARE_OUTCOMES.md`, raw rows in `catalog/bench/bench_host.jsonl` | Claude (text) |

So the split for K4 is: this seat owns the measured record (`catalog/HARDWARE_OUTCOMES.md` and the raw `.jsonl`), and the label and entry changes in `lib/models.mjs` are the backend seat's, made from that record.

The existing record already holds 8 GB measurements from 2026-10-09 (qwen3:4b at 8–10 tok/s with +1.1 GB swap; granite-code 3b failing; stock `qwen3.5:2b` Q8 swapping 1.3 GB). They were not carried into `lib/models.mjs`. They are six weeks old and were not re-run here.

## Runbook (run on the 8 GB Mac, quiet window, nothing else loaded)

The harness already exists: `catalog/bench/bench_models.py` (cold load, three fixed turns; records load seconds, tokens per second, resident size and swap growth) and `catalog/bench/eval_models.py` (the 8-task score).

1. Confirm the machine and free disk. The Mac was at 99% disk on 2026-10-09; an 8B pull is about 5 GB.

```bash
sysctl -n hw.memsize hw.model; sw_vers -productVersion; ollama --version; df -h / | tail -1; ollama ps; ollama list
```

2. Confirm the new families' tags exist before pulling. The tags below are the registry names recorded in `HARDWARE_OUTCOMES.md`; this seat could not reach the registry to confirm them.

```bash
for M in qwen3.5:0.8b qwen3.5:2b qwen3.5:4b gemma4:e2b gemma4:e4b; do ollama show "$M" >/dev/null 2>&1 && echo "local  $M" || echo "absent $M"; done
```

3. Measure. One model at a time: pull, bench, score, and remove it again only if it was not installed before. A pull or load failure is written to the file as a row, never skipped.

```bash
cd ~/Documents/kingmaker && OUT=catalog/bench/k4-8gb-$(date +%Y%m%d).jsonl && for M in huihui_ai/qwen3-abliterated:0.6b huihui_ai/qwen3-abliterated:1.7b qwen3:4b gemma3:4b llama3.2:3b phi4-mini:3.8b granite-code:3b qwen3:8b llama3.1:8b mistral:7b qwen3.5:0.8b qwen3.5:2b qwen3.5:4b gemma4:e2b gemma4:e4b; do had=$(ollama list | awk '{print $1}' | grep -Fxc "$M"); if ! ollama pull "$M"; then echo "{\"model\":\"$M\",\"error\":\"pull failed\"}" >> "$OUT"; continue; fi; python3 -I catalog/bench/bench_models.py "$OUT" http://127.0.0.1:11434 "$M"; python3 -I catalog/bench/eval_models.py "${OUT%.jsonl}-eval.jsonl" "$M"; [ "$had" = 0 ] && ollama rm "$M"; done
```

Change `~/Documents/kingmaker` to the real checkout path. Drop any tag step 2 reported absent from the registry, and say so in the record.

4. Hand the two files back (`catalog/bench/k4-8gb-<date>.jsonl` and `-eval.jsonl`). From them this seat rewrites the measured table in `catalog/HARDWARE_OUTCOMES.md`, and the backend seat sets `minGb` and adds or removes entries in `lib/models.mjs`.

## The label rule proposed (applied only to measured rows)

- **8 GB**: loads, and swap growth over the three turns is 0.
- **8 GB, slow**: loads, but swap grows or speed falls under 12 tokens per second.
- **16 GB+**: fails to load on 8 GB, or swaps more than 1 GB.
- **Removed**: fails to load on every attempt (the row carries the error text).

A model with no row in the new file keeps no 8 GB label at all.
