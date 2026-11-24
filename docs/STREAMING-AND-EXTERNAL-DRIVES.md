# Streaming, memory and external drives

Kingmaker uses multipart downloads for model weights and bounded range reads for library content. The measurements below cover the bounded reads in `lib/brain-library-access.mjs`.

## Model weights on 8 GB

When an Auto turn reaches local text work on an 8 GB Mac, Kingmaker uses the measured median `huihui_ai/qwen3-abliterated:1.7b`. It checks the Brain Library catalog pins and can reuse an Ollama weight blob on the card once its SHA-256 matches. An explicit model pin keeps its existing path.

When the card needs the median, Kingmaker downloads the selected release's parts to staging on the card. It checks each part's byte count and SHA-256, assembles the GGUF, and checks its complete SHA-256 before registering it with the card's Ollama. Registration uses the verified file and the release's Modelfile. Ollama loads the complete model file when the turn needs it. This is download, assemble, then load.

The assembled file lives in `<card>/models/library/<slug>/<sha256>/`. Manual `kingmaker models library pull <tag>` uses the same card destination for republished task weights. A missing card or missing model pins are reported before any release part is written. Above 8 GB, the library still assembles into `<state>/models/library/<slug>/`. The Open-JEV path stays internal.

The on-demand checks use a disposable card directory and a local HTTP server. They cover the delivery and registration request. Physical card and real-model load measurements are in [8 GB class layout](8GB-CLASS-LAYOUT.md).

## The controls, kept separate

| Control | What it bounds | Default |
|---|---|---|
| `maxPortionBytes` | how much ONE read may ask for | 1 MiB |
| `reuseCacheBytes` | how many bytes of already-read blocks are kept in memory, across all items | 0 (off) |
| the rolling `.stream-cache` file | one portion per item on disk | unchanged |

Raising one never changes another.

## What changed

- **Reads are bounded by the portion, not the item.** A resident item is read by range and hashed by stream; a download writes each segment to disk as it arrives. Before, each of these held the whole item in memory.
- **A resident is verified once per change**, not on every portion read. The answer is remembered until the file's size or modification time changes.
- **The catalog no longer holds every training part in memory.** Parts and methods are file sources.
- **File sources** (`fileSource`): any file on the internal disk or an external drive. A read opens the file, reads the range and closes it, so a drive can be removed between reads. If the file cannot be read, the error has code `SOURCE_UNAVAILABLE` and names the path.
- **Reusable block cache** (`reuseCacheBytes`): off by default. When on, a repeat of the same range is served from memory without going back to the source; the budget is a hard ceiling and the least recently used block leaves first.

## Measured (64 MB synthetic file, Linux x64 container — NOT the Mac)

| Case | Time | Source reads | Peak memory growth |
|---|---|---|---|
| Sequential, 64 KiB portions | 713 ms | 1024 | 12.5 MB |
| Sequential, 256 KiB portions | 246 ms | 256 | 14.7 MB |
| Sequential, 1 MiB portions | 134 ms | 64 | 63.9 MB |
| 200 reads of the same 8 blocks, cache off | 182 ms | 200 | 4 MB |
| 200 reads of the same 8 blocks, cache 8 MiB | 8 ms | 8 | 0.1 MB |
| 200 sparse random reads, cache off | 128 ms | 200 | 4 MB |
| 200 sparse random reads, cache 8 MiB | 160 ms | 200 | 12.3 MB |
| Download and verify | 196 ms | 256 | 34.1 MB |

What the numbers say, for this machine only:

- **Bigger portions are faster for sequential reads and cost memory.** 256 KiB took about a third of the time of 64 KiB for 2 MB more memory; 1 MiB halved the time again for about 50 MB more.
- **The reuse cache pays only when reads repeat.** Repeated ranges: about 20 times faster and 25 times fewer source reads. Sparse random reads: no hits, slightly slower, more memory.
- These are one run on a fast local disk. They are not a recommendation for the Mac or for a USB drive.

Run it on the machine and drive that matter:

```bash
cd ~/Projects/kingmaker-private && node --expose-gc scripts/streaming-bench.mjs --size-mb 256 --json ~/Downloads/streaming-bench-internal-disk.json
```

```bash
cd ~/Projects/kingmaker-private && node --expose-gc scripts/streaming-bench.mjs --size-mb 256 --dir /Volumes/YOUR-DRIVE-NAME --json ~/Downloads/streaming-bench-usb-drive.json
```

(Replace `YOUR-DRIVE-NAME` with the drive's name as Finder shows it.) The harness writes one temporary file, reads it, and deletes it. It touches no app data and starts no model.

## External drives

- **Knowledge on a drive:** point a `fileSource` at files on the drive. Reads are by range; memory stays at one portion.
- **Models on a drive:** the model server needs the complete model file and loads it into memory. A drive holds the files; it does not let a model larger than RAM run fast. The reference the owner supplied (`techjarves/USB-Uncensored-LLM`, marked deprecated by its author) does this by pointing `OLLAMA_MODELS`, `OLLAMA_HOME` and `OLLAMA_TMPDIR` at the drive. It does not stream weights.
- **Not built:** recognising a specific drive by identity, a user-facing setting for either control, and the macOS removable-volume permission prompt.
