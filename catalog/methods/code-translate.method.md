# Method — Code Translator (any language → the language the intent calls for)

A method file (owner item 15 shape): read by the conductor (`lib/method-conductor.mjs`) and
executed step by step. For a code-translation task: take one source artifact in the workDir,
translate it into the target language the run's intent resolved to, write the translated
artifact plus a provenance record, and check exactly as much as this node can check —
recording what ran and what did not, never upgrading a grade silently.

Filed 2026-11-14 from the approved design (`~/workspace/code-translator-design-2026-11-14/DESIGN.md`);
the conducting caller is `lib/code-translate.mjs`.

**Who resolves the languages (not this file):** the conducting caller resolves
`targetLanguage` and `targetChosenBy` BEFORE conduction, by the precedence in the design
(explicit run input → producing method's declaration → recipient-surface table in this
file's inputs → intent keywords in the request → no translation). This file receives them
as inputs and records them in the provenance record verbatim. `sourceLanguage` may arrive
as `auto-detect`, in which case the translating pass states what it detected in the
output's provenance line.

**The translating pass** is the conductor's `reason` step: ONE local model pass by the
caller-supplied reasoner, on the model the smallest-sufficient selector picked for this
method's declared `weights` requirement (`role: coder`). No reasoner → the step is
declared, not executed, and this method produces no translation (see Failure modes).

**The parse check** is a `declare` step on purpose: the conductor executes a declared
step only when its command was pulled from the Brain Library by `check-tool` in the same
conduction. `langcheck` is the tools-catalog checker bundle staged for exactly this.
Where `langcheck` was not pulled (absent, or declared-not-staged in the catalog),
the step stays declared and the translation record says the parse check did not run —
the delivery grade is then structural-only, stated by the caller from the trace.

## Executable block

```kingmaker-method
{
  "id": "code-translate",
  "version": "0.1",
  "title": "Translate Code — universal translator for functions and code in any language",
  "domain": "code",
  "kind": "code-translate",
  "weights": { "role": "coder" },
  "inputs": {
    "sourceFile": "source.txt",
    "sourceLanguage": "auto-detect",
    "targetLanguage": "",
    "targetChosenBy": "unspecified",
    "targetFile": "translated.out",
    "surfaceLanguages": {
      "blender-script": "python",
      "openscad": "openscad",
      "installer-ui": "swift",
      "engine-shell": "bash",
      "site-or-crm": "javascript",
      "kingmaker-engine": "javascript"
    },
    "model": null
  },
  "steps": [
    { "n": 1, "id": "inspect-source", "type": "inspect", "path": "{{inputs.sourceFile}}", "into": "sourceInfo" },
    { "n": 2, "id": "read-source", "type": "read-text", "path": "{{inputs.sourceFile}}", "into": "sourceCode" },
    { "n": 3, "id": "check-langcheck", "type": "check-tool", "command": "langcheck", "into": "checker" },
    { "n": 4, "id": "translate", "type": "reason", "into": "translation",
      "preamble": "You are the code translator inside a conducted Kingmaker method. Translate the given source code into the target language named in the prompt. Preserve behavior: same inputs, same outputs, same edge cases. Use the target language's ordinary idioms where they do not change behavior. Output ONLY the translated code — no explanation, no markdown fences. The first line of the output must be a comment in the target language's own comment syntax containing the marker kingmaker-translate and stating: translated from <source language> to <target language>. If the source language is given as auto-detect, name the language you detected in that line.",
      "prompt": "Source language: {{inputs.sourceLanguage}}\nTarget language: {{inputs.targetLanguage}}\n\nSource code:\n{{sourceCode}}" },
    { "n": 5, "id": "write-translation", "type": "render", "path": "{{inputs.targetFile}}", "template": "{{translation}}" },
    { "n": 6, "id": "verify-translation", "type": "verify",
      "assertions": [
        { "file": "{{inputs.targetFile}}", "contains": "kingmaker-translate" }
      ] },
    { "n": 7, "id": "parse-check", "type": "declare", "into": "parseCheck",
      "action": "langcheck {{inputs.targetFile}}",
      "reason": "Runs only when step 3 pulled the langcheck tool from the Brain Library in this conduction (the conductor executes declared steps solely for library-pulled tools). On a node where langcheck was not pulled, this stays declared: no parse check ran, and the translation record and the caller's grade say so." },
    { "n": 8, "id": "write-record", "type": "write-json", "path": "{{inputs.targetFile}}.translation.json",
      "value": {
        "schema": "kingmaker.code-translation/1",
        "method": "{{method.id}}",
        "methodVersion": "{{method.version}}",
        "sourceFile": "{{inputs.sourceFile}}",
        "sourceLanguage": "{{inputs.sourceLanguage}}",
        "targetFile": "{{inputs.targetFile}}",
        "targetLanguage": "{{inputs.targetLanguage}}",
        "targetChosenBy": "{{inputs.targetChosenBy}}",
        "model": "{{inputs.model}}",
        "checkerFound": "{{checker.found}}",
        "parseCheck": "exit={{parseCheck.exitCode}}"
      } },
    { "n": 9, "id": "verify-record", "type": "verify",
      "assertions": [
        { "file": "{{inputs.targetFile}}.translation.json", "field": "schema", "equals": "kingmaker.code-translation/1" },
        { "file": "{{inputs.targetFile}}.translation.json", "field": "targetLanguage", "equals": "{{inputs.targetLanguage}}" },
        { "file": "{{inputs.targetFile}}.translation.json", "field": "targetChosenBy", "exists": true }
      ] }
  ]
}
```

## Steps (prose mirror)

1. **inspect-source** — Record whether the source artifact exists in the workDir, its kind and size.
2. **read-source** — Read the source artifact's text into the `sourceCode` store.
3. **check-langcheck** — Is the `langcheck` checker on PATH or at a candidate — and if not, can the Brain Library stream it here? The outcome (found via PATH / via library / not found, staged or not) is recorded in the `checker` store and lands in the provenance record.
4. **translate** — ONE local model pass: translate `sourceCode` from `sourceLanguage` (or the language the pass detects) into `targetLanguage`, code only, provenance marker line first.
5. **write-translation** — Write the pass's output, byte for byte, to `targetFile` (the render template is exactly the translation store, so nothing is added or wrapped).
6. **verify-translation** — Re-read the written file and confirm the provenance marker actually landed in it.
7. **parse-check** — DECLARED unless `langcheck` was library-pulled in step 3: parse/compile-check the translated file in its target language. An executed check that exits non-zero FAILS the conduction — an unparseable translation is never delivered as a success.
8. **write-record** — Write `<targetFile>.translation.json`: the provenance record — source/target languages, who chose the target and by which rule (`targetChosenBy`), the model that translated, whether the checker was found, and the parse check's exit code (`exit=` with nothing after it means the check did not run).
9. **verify-record** — Re-read the record and confirm its schema, target language and chooser fields landed as conducted.

## Failure modes

- **No reasoner supplied** → step 4 is declared, not executed; the conduction carries no translation and the caller must report exactly that. This method never falls back to a template or a guess.
- **Empty `targetLanguage`** → the caller broke the contract (targets are resolved before conduction); the translation pass receives no target and its output is meaningless. The record still states what it was given — the caller's precondition failure stays visible in the receipt.
- **Source file missing** → step 2 fails the conduction with the step named; nothing is fabricated.
- **`langcheck` not pulled** → step 7 stays declared; the record's `parseCheck` reads `exit=` (no code). The caller's delivery grade for this run is structural-only (marker verified) or unverified — never "parse-verified."
- **Parse check executed and failed** → the conduction status is `failed` at step 7. The translated file remains in the workDir as evidence; it is not a deliverable.
- **Model writes prose or fences anyway** → step 6's marker check may still pass if the marker line is present; the parse check (when it runs) is the backstop. Where no parse check ran, this risk is exactly why the grade stays low — stated, not hidden.
