# Streaming, memory and external drives

What `lib/brain-library-access.mjs` does after the 2026-11-11 change, what was measured, and what is still open. It answers the owner's review of the installed 4.4.6 build (`kingmaker_streaming_review.md`).

## Is the streaming layer live?

**Not in this repository.** Nothing in the running app's code calls `createBrainLibraryAccess`, `streamingReadText` or `readKnowledgeStreamed`: the only callers are `test/brain-library-access.test.mjs`, and `lib/brain-library-fetch.mjs` imports one constant. The library is built and tested but not wired into a live path. Wiring it in is a separate change and has not been made.

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
- **Built 2026-11-16:** recognising an approved drive by identity — see *Approved external storage* below. **Still not built:** a user-facing setting for the streaming controls, and handling of the macOS removable-volume permission prompt (TCC "Removable Volumes"; untested in the signed app).

## Approved external storage (lib/external-storage.mjs, `kingmaker storage …`)

A USB stick, external SSD/HDD or SD card can hold the same stores as the internal disk, with the same layout and indexes:

```
<drive>/Kingmaker/<install id>/owner.json                       pins the folder to this install and drive
<drive>/Kingmaker/<install id>/abilities/methods/index.json     your own methods        (role user-methods)
<drive>/Kingmaker/<install id>/fleet/abilities/methods/…        fleet abilities         (role fleet-abilities)
<drive>/Kingmaker/<install id>/brain-library/methods/…          curated library cache   (role library-cache)
<drive>/Kingmaker/<install id>/models/                          model files             (role models, documented config only)
<drive>/Kingmaker/<install id>/memory/sqlite/solomon.db          the engine's memory     (role memory: SOLOMON_DATA_DIR)
<drive>/Kingmaker/<install id>/files/                           your Files folder       (role files: kingmakerHome)
```

### What each role routes (2026-11-16 follow-up)

| Role | Writes that go to the drive | When the drive is missing / read-only |
|---|---|---|
| `user-methods` | `writeMethod`, `promoteDraft`, `kingmaker method new` | refused (`STORAGE_UNAVAILABLE`) |
| `fleet-abilities` | `acceptAbilityRelease` (method, `.prev` copy, index), `applyRevocations` (index; quarantine on the same drive) | accept refused; each revocation comes back `quarantined: false` for the caller to apply again. The acceptance receipt (`<state>/fleet/accepted.jsonl`) stays on this Mac |
| `library-cache` | the curated hunt (staging, then a verified copy) | the hunt does not run |
| any method store | iteration (`createLocalBrain({ iterate: true })`): the next version goes to the store the method came from; a built-in method goes to the library cache's target | refused for a read-only drive store (recorded in the run's trace); a missing drive's methods are not offered |
| `memory` | the engine's whole data folder (`SOLOMON_DATA_DIR`), whose `sqlite/solomon.db` holds the governed memory MemPalace reads and writes, plus the engine's logs, exports and generated media | **the engine does not start** (`kingmaker start` lists "Unavailable: memory — …"). Also refused while the drive has no memory database but this Mac still has one: run `kingmaker storage copy memory` with Kingmaker stopped (verified; this Mac's copy is kept) |
| `files` | `kingmakerHome` / `homeFolder` / `saveHomeFile` (verified saves), Artifacts listing, the engine's Reports and Field folders | `kingmakerHome`/`homeFolder` throw `STORAGE_UNAVAILABLE`; the engine is still given the drive's path, so its writes fail instead of landing on this Mac; the Desktop tidy-up is skipped. `kingmaker storage copy files` copies this Mac's Files folder (verified; originals kept) |

- **An approved drive wins** over `KINGMAKER_HOME` (files) and over `SOLOMON_DATA_DIR` (memory): the approval is the newer, explicit choice.
- **What stays on this Mac with the memory role:** the knowledge library (`SOLOMON_INDEX_DIR` / `CORPUS` / `EXTRACTED` are set explicitly), the launcher's keys (`<runtime home>/data/keys`), the worker node state, `~/.solomon-secure` and the vault key.
- **Durability:** Node's fsync on macOS already issues `fcntl(F_FULLFSYNC)` (libuv), falling back to `F_BARRIERFSYNC` and then `fsync` when a filesystem refuses it. Measured on this Mac: Node `fsyncSync` ≈ 3.4 ms per call, Python `os.fsync` 0.1 ms, `fcntl(F_FULLFSYNC)` 4.4 ms. No native code is added. Whether a given USB or SD bridge honours the flush is not tested.
- **Not tested:** the real engine (a stand-in opened the same `sqlite/solomon.db` with SQLite in WAL mode, including on the exFAT and FAT32 images); SQLite on a real USB/SD drive under unplug; NTFS, HFS+, encrypted volumes; Linux and Windows.

- **Discovery is read-only.** macOS: `mount`, `df -k`, `diskutil info -plist <mount>`. Linux: `/proc/mounts` + `lsblk -J -b -o NAME,PATH,TYPE,FSTYPE,UUID,LABEL,RM,RO,HOTPLUG,TRAN,SIZE,FSAVAIL,FSSIZE,MOUNTPOINTS`. Windows: parsers for `Get-Volume | ConvertTo-Json` and `Get-CimInstance Win32_Volume | ConvertTo-Json` (fixture-tested only; nothing runs PowerShell). Every command passes an allowlist; erase/partition/mount/unmount/chmod are refused by code.
- **Approval** (`kingmaker storage approve <mount> --roles user-methods,library-cache`) is the user's own answer. It is recorded in `<state>/storage/drives.json` with the stable id (macOS VolumeUUID, else DiskUUID; Linux filesystem UUID; Windows volume GUID, else serial). A volume without a stable id is refused. One role lives on at most one drive.
- **Reconnect:** matched by stable id only; a changed mount path is followed and recorded; a same-named volume with a different or missing id is reported and not used.
- **Layers:** a connected drive's stores join the conductor in the same order (user > fleet > library > built-in), the drive store first within its layer. Missing / read-only / foreign drives are reported per resource in every `kingmaker ask` report; local abilities keep working; the curated hunt does not run for a cache whose drive is missing, and nothing is fetched or duplicated instead.
- **Saves to a drive:** capacity and filesystem-limit checks (FAT32 < 4 GiB per file), journal, temp file, fsync, read-back sha256, rename, read-back sha256. `kingmaker storage status` (and every start) rolls back interrupted saves. `kingmaker storage copy <role>` copies an internal store to the drive with verification and keeps the originals (roles `user-methods`, `fleet-abilities`, `library-cache`, `memory`, `files`).
- **Models:** `kingmaker storage models` prints the `OLLAMA_MODELS=…` line to use; Kingmaker never edits the live Ollama configuration.
- **Eject:** `kingmaker storage eject-check <label>` lists open files (lsof), writes in progress and unfinished saves. Kingmaker never unmounts.

