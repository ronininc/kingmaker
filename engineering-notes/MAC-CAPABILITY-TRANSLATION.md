# Capability preservation, not container renaming

## Existing translator and actual gap
`code-translate.mjs` previously selected a target language, invoked one coder generation and conducted a method. Verification grades PARSE/STRUCT/NONE describe syntax/structure, not behavioral equivalence. They remain unchanged; none is renamed 'fully working'.

New `platform-compatibility.mjs` provides an explicit capability lane, exported through the translator and exposed by the actual Kingmaker entry:

```
node lib/kingmaker.mjs translate --inspect-compatibility /path/to/artifact
node lib/kingmaker.mjs translate SOURCE --mac-compatible --dir EXISTING_DIR
```

Inspection reads a bounded header only. GGUF is recognized as a model container, not Linux executable; model architecture, quantization, inference backend and full resource needs still require validation. ELF requires an appropriate runtime/source port/capability reconstruction on macOS. Mach-O likewise needs architecture/dependency/signature checks. No container/extension change is called a successful port.

## Real scoped reconstruction proof
Implemented original portable Node equivalent for one exact reviewed Linux/GNU shell utility: report file metadata byte size plus streamed SHA256, TAB-delimited. This is a complete bounded capability example, not arbitrary source conversion. Unknown source fails closed and is not executed. Original user source remains unchanged; unique output directory preserves source+artifact digests.

Mac proof in sibling mac-compatibility-proof: original GNU `/usr/bin/stat -c` script actually fails on macOS (exit1); reconstructed program runs successfully through the Kingmaker CLI and validates independent published SHA256 empty/abc vectors. Additional Python hashlib/byte-count oracle independently verified actual binary-file result. Regression cases cover empty/binary/Unicode/space filenames and file symlinks. This demonstrates a functioning equivalent on Mac without installing Linux or rewriting model weights. Source execution happens only in the explicitly authored test fixture; the translator never runs unrecognized input code.

Receipt tier BEHAVIOR-SCOPED names runtime/platform and exact tests. No universal program-equivalence claim: devices, syscalls, drivers, GUIs, network behavior, proprietary APIs, source licensing, performance and untested filename encodings require separate requirements/reconstruction/verification. Target runtime is existing Node22+. No installed app changes, keys, network credentials or paid Armor boundaries touched.

## Next meaningful generalization
For a real incompatible application, inventory user-visible capabilities, source/license/dependencies and target platform APIs; create acceptance tests first; select port/reimplementation/runtime only after feasibility. Independently reconstruct implementations under explicit governance, run security+functional tests in an isolated environment, validate target hardware and UI, and report missing features. This new lane is a tested foothold, not completion of that general workflow or proof that huge models fit small hardware.
