# R&D floor

The analysis engine on Kingmaker's R&D floor. An operator points it at a shipped artifact. It reads. It reports evidence. It does not install the toolkit, and it does not deploy Kingmaker.

Order 1b72e5c0 (Robbie via Muse, 17 October). Pin audited 28 October 2026 from the live tree, not from the expired build-order zip.

## What was already here

These stay. The floor does not replace them.

| Surface | What it already did |
|---|---|
| `lib/rea.mjs` | Connector check. Before Kingmaker uses a CLI, MCP server, skill or repo, it reads that code for unprompted access (phone home, credentials, login persistence, admin, hidden or downloaded code). Verdicts: clean, sandboxed, rejected. |
| `core/skills/rea` | The skill for that check. |
| `core/skills/clone` and `clone/references/reverse-engineer-anything` | The method (understand, drive, rebuild) and REA's own skill text, taken at `e2db768` (16 October). The text does not register an MCP server or install an engine. |
| CLI, bar, MCP | Where an operator already works. The floor is a command on the CLI and a read-only MCP tool. |

Nothing in that list ran REA's analysis engines. That is what this floor adds.

## How an operator runs an analysis

The floor's binary is `rea` from the npm package `rea-agents`, version **6.8.0** only. Kingmaker does not run `npx` and does not run `npm install`. The package's runtime graph includes two licences that are not imported (see the audit). Install that exact version yourself if you want the floor to run it, then either leave `rea` on `PATH` or set `KINGMAKER_REA` to the binary.

```bash
kingmaker rd                  # the five modules
kingmaker rd audit            # the licence gate, in full
kingmaker rd doctor           # is 6.8.0 on PATH?
kingmaker rd route /absolute/path/to/App.apk
kingmaker rd run mobile-apps inspect-android-package /absolute/path/to/App.apk
kingmaker rd run binary-low-level analyze --provider ghidra /absolute/path/to/program
kingmaker rd run network-runtime inspect-web-network-capture /absolute/path/to/capture.har
kingmaker rd run rebuild-verify compare /absolute/left.json /absolute/right.json
```

A search or an address comes after the path:

```bash
kingmaker rd run binary-low-level search --provider kuna /absolute/path/to/program main
```

Add `--json` on the `kingmaker` command when you want the plan and the raw record instead of text. The floor always asks `rea` for `--json`. It does not accept other `rea` flags; those stay on a `rea` you run yourself, and only for a command this floor already admits.

From an MCP client, `rd_floor` answers `map`, `audit`, `route`, or `plan`. It does not start `rea`. The owner runs the plan at the console.

From the skill: ask to reverse engineer a binary or a package. The connector check (`lib/rea.mjs`) is a different question ("is this safe to connect"). The floor is "what does this artifact do".

Native analysis needs a free engine the operator already installed:

- **Ghidra** (Apache-2.0), the default (`--provider ghidra`)
- **Kuna** (Apache-2.0), the other admitted native engine

Android packages need a JADX JAR the operator already has (`REA_JADX_MCP_JAR`). WASM needs WABT 1.0.42 (`REA_WABT_BIN_DIRECTORY`). Firmware regions need Binwalk or Unblob. The floor passes those path settings through. It does not pass `REA_ANALYSIS_PROVIDER` (that variable can name Hopper) and it does not pass API keys.

The floor refuses a target under a credential store (`.ssh`, `.aws`, Keychains, and the same class of path). It only accepts absolute paths.

## Module map

| Module | Reads | Does not run |
|---|---|---|
| **Analysis Core** (`analysis-core`) | `doctor`, `capabilities`, `providers`, `inspect-artifact`, `inspect-analysis-view`, `inspect-evidence-bundle`, `inspect-sqlite-database` | — |
| **Mobile & Apps** (`mobile-apps`) | JavaScript/Electron trees, Electron fuses, Android packages and signatures, Flutter/Dart AOT identity, Android/Apple/Harmony graphs, desktop bundles, Mach-O, plists | Apktool decode (writes a tree; Apache-2.0, still admitted). adb (Apache-2.0 source; the floor does not drive a device). |
| **Binary & Low-Level** (`binary-low-level`) | `analyze`, `decompile`, `function`, `search`, `xrefs`, `instructions` via Ghidra or Kuna. Built-in readers: Go, Rust, PE resources/imports/certificates/load-config, managed assemblies, WASM, firmware regions, EVM, CPython pyc, Erlang BEAM | Unicorn/pwntools ELF layout, GDB crash and debug, Rizin, Cutter, objdump, Frida. Firmware *extraction* (MIT engines, but it writes a directory). |
| **Network & Runtime** (`network-runtime`) | Saved HAR, SAZ and qlog (`inspect-web-network-capture`). Lists of browser and JavaScript runtime targets | tshark/capinfos (GPL-2.0) for pcap. sigrok (GPL-3.0). Live browser driving, live session observation, process capture. |
| **Rebuild & Verify** (`rebuild-verify`) | Compare two evidence bundles, compare application versions, compare a source tree to a bundle, compare JavaScript export shapes, build a reconstruction ledger, score coverage, compare managed members | `evidence-export` (it writes). The clone skill still does the edit. |

`kingmaker rd map` prints the same lists from the code.

A file lands like this: `.apk` Android package, `.asar` or `package.json` JavaScript application, `.har` / `.saz` / `.qlog` web capture, `.pcap` the quarantined packet path (named so the refusal is specific), `.exe` / `.so` / `.dylib` / `.elf` native analyze, `.dll` managed assembly, `.wasm` WASM, `.sqlite` SQLite.

## Licence audit

Audited at [morluto/rea](https://github.com/morluto/rea) commit `40b9c03f996270e944ff07cafb63be15ce903708` (28 October 2026), npm `rea-agents@6.8.0`. Submodule commits are the gitlinks in that tree. None of them were checked out into Kingmaker, and none of this was copied in.

Kingmaker's own licence is PolyForm Noncommercial 1.0.0. The import list, the same one `core/pack.json` already ships by, is MIT, Apache-2.0, BSD, MPL-2.0, OFL, and the other permissive grants that showed up in the lockfile (ISC, 0BSD, BlueOak-1.0.0, Zlib, WTFPL, Unlicense, CC0, Python-2.0, public domain). An `OR` keeps the permissive side. An `AND` has to be permissive on every side.

| Decision | Means |
|---|---|
| **allow** | Permissive enough to import. This floor still did not import it. Bring-your-own tools stay on the operator's machine. |
| **quarantine** | GPL, LGPL, or a licence that is not on the list. Not imported. Not dispatched. |
| **refuse** | AGPL, proprietary, commercial, or no licence. Not imported. A request that would use one is an error. |

AGPL is refuse even when the order's other word is quarantine. No AGPL repository is in this pin. The gate still returns refuse for an AGPL expression, so a later pin cannot slip one through by being "only a dependency".

### npm runtime graph

`licenses/npm-dependencies.txt` at this pin: **180** runtime packages (the lockfile has 963 entries; development and website packages are not in the published runtime and were not imported).

- **178 allow.** That count includes dual licences where a permissive side can be chosen (`MIT OR WTFPL`, `Apache-2.0 AND BSD-3-Clause`, `MIT AND Zlib`, and the same shape).
- **2 quarantine:**
  - `openpgp@6.3.2` — LGPL-3.0+. Required. `src/process/DetachedPgpSignature.ts` imports it to check a detached signature.
  - `frida@17.23.2` — LGPL-2.0 WITH WxWindows-exception-3.1. Optional. The exception does not make it MIT, Apache, or BSD.

Those two are why `rea-agents` is not a dependency of this repository and why Kingmaker will not `npm install` it. An operator-installed 6.8.0 binary may still be executed as a separate process. That process is not linked into Kingmaker. Any other version is refused (`rea-unaudited`).

### Repositories REA pulls in

| Name | Pin | Licence | Decision |
|---|---|---|---|
| REA itself | `40b9c03` | MIT | allow, not imported (the npm graph above) |
| jadx-headless-mcp | `5844800` | Apache-2.0 | allow, submodule not checked out |
| JADX | 1.5.6 | Apache-2.0 | allow, bring-your-own JAR |
| Apktool | upstream | Apache-2.0 | allow, not run (it writes) |
| Binwalk | `4fdab3d` v3.1.0 | MIT | allow, submodule not checked out |
| Unblob | `1fcc7a0` 26.6.4 | MIT | allow, submodule not checked out |
| ghidra-nativeaot | `effeb73` | MIT | allow, submodule not checked out |
| Wakaru | `8219bf5` v1.14.0 | Apache-2.0 | allow, submodule not checked out |
| WABT | `ff0ef7e` 1.0.42 | Apache-2.0 | allow, bring-your-own |
| evmole | 0.9.3 | MIT | allow, rides inside the operator's rea process, not copied here |
| Ghidra | 12.1.4 | Apache-2.0 | allow, bring-your-own. Programs under Ghidra's `GPL/` directory are not imported and not dispatched |
| Kuna | 1.833 | Apache-2.0 | allow, bring-your-own. REA does not download it |
| ILSpy | — | MIT | allow, not bundled. Managed reads dispatched here are REA's own |
| mitmproxy | `6c09d56` 12.2.3 | MIT | allow, bring-your-own. The floor does not start a proxy |
| adb | — | Apache-2.0 | allow as source. Not used. An SDK download has its own terms |
| pwntools | 4.15.0 `3ad86ec` | MIT | allow as its own licence. The ELF profile also loads Unicorn, so that profile is not dispatched |
| pyelftools | 0.33 | public domain | allow. Same undispatched ELF profile |
| pwndbg | `55596aa` | MIT | allow as its own licence. It runs on GDB, which is not dispatched |
| Unicorn | 2.1.2 | GPL-2.0 | quarantine |
| GNU GDB | caller | GPL-3.0-or-later | quarantine |
| Rizin | caller | LGPL-3.0 | quarantine |
| Cutter | caller | GPL-3.0 | quarantine |
| GNU objdump | caller | GPL-3.0-or-later | quarantine |
| Wireshark tshark and capinfos | 4.x | GPL-2.0 | quarantine. Packet captures stay off the floor |
| sigrok-cli | 0.7.2 | GPL-3.0 | quarantine |
| OpenJDK | caller | GPL-2.0 with Classpath exception | quarantine as an import. Not shipped. A JDK the operator already has is what Ghidra and JADX run on |
| Hopper | commercial | proprietary | refuse |
| IDA Pro and Hex-Rays | commercial | proprietary | refuse. The MIT `ida-pro-mcp` bridge is not imported either |
| JEB | commercial | proprietary | refuse |

`kingmaker rd audit` prints this from `lib/rd-floor.mjs`, which is what the running app uses. A row whose declared decision disagrees with the classifier does not load.

## Free tier

No paid service and no paid engine. Hopper, IDA and JEB are refused even if they are installed, including via `REA_ANALYSIS_PROVIDER`. There is no trial install and no `--install-hopper`.

Ghidra, Kuna, JADX, Binwalk, Unblob, WABT, mitmproxy and the built-in readers are free. They are still not bundled. Stock-Mac note: Ghidra and JADX need a JDK the operator supplies; Kingmaker does not ship Java.

## What this change does not do

It does not merge, and it does not deploy. Kingmaker's deploy stays held for Robbie's soak.
