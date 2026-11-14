# Security-diagnostics corpus

Kingmaker's knowledge library can carry a security reference corpus built from the defensive folders of the
Hugging Face dataset `Vyber07/cyber-security`. It lands as its own knowledge field, `security-diagnostics`, and
is indexed into its own SQLite shard, `security-diagnostics.db`, next to the other fields.

## What is taken

The list is `catalog/corpora/security-diagnostics.json`.

- 13 folders: blue-team, defensive-security, digital-forensics, compliance, devsecops,
  identity-access-management, cloud-security, container-security, cryptography, network-security,
  supply-chain-security, api-security and vulnerability-intelligence.
- Only `.json` and `.jsonl` files, each 64 MB or smaller, each distinct content once.
- At the pinned revision that is 65 files, 2.4 MB (measured 2026-11-11 with `--list`).
- Everything else is left out: the attack-side folders, the loose files at the top of the dataset, and five
  files over the size limit (the 2.7 GB master dump and its copies, and one 660 MB cloud-security file).

To take more, add a folder name to `include` or raise `maxFileMB`.

## Rights

The dataset card is tagged `apache-2.0`, but its LICENSE file says the material was collected from many
platforms and scraped documents under a fair-use claim. The upstream rights are **not confirmed**, and the list
records that (`license.confirmed: false`). The corpus is for internal reference on the owner's own machine. Do
not bundle it in an installer, publish it, or serve it from the site until the rights are confirmed.

## Fetching it

The dataset is gated. Its files need a Hugging Face token from an account that has accepted the dataset's terms
on its page. The token is read from `HF_TOKEN` and is sent only to huggingface.co. It is not written to disk.

    cd <the Kingmaker checkout>
    node scripts/fetch-security-corpus.mjs --list
    HF_TOKEN=<token> node scripts/fetch-security-corpus.mjs

`--list` needs no token: it shows every file that would be taken or skipped, and why.

Each file is downloaded to a holding folder and checked against the listed size (and SHA-256 where the listing
gives one). It is then rewritten as Markdown in a staging folder and moved under
`<knowledge sources>/security-diagnostics/vyber07-cyber-security/` only when the whole file has converted, so a
cut-off download leaves nothing behind for the index. The download is removed. A receipt is written to
`<knowledge sources>/.receipts/vyber07-cyber-security.json`.

The same command then builds the shard straight away: it runs the engine's extract and index scripts for this
one field. It does not wait for Kingmaker's background knowledge build, because that build does nothing once
the library already reports complete, and this field is optional. To rebuild the shard without fetching again:

    node scripts/fetch-security-corpus.mjs --build-only

## How turns reach it

The engine searches only the fields a question's keywords nominate. The corpus list carries a `route` (trigger
words such as security, vulnerability, CVE, hardening, incident response, authentication), and that route is
written into the engine's field contract, `solomon/contracts/knowledge-fields.json`, as an **optional** field.
Optional means a library without the corpus still counts as complete.

The engine folder is replaced on every engine import, so the entry is not a hand edit: `applyFieldRoute` in
`lib/security-corpus.mjs` writes it, and `scripts/import-solomon.mjs` calls it after each import. A test fails
if the entry goes missing.

One effect on a Mac that has **not** fetched the corpus: a question whose only keyword match is a security word
is routed to a shard that is not there, so it gets no library passages and falls back to the engine's other
lanes, the same way the optional law and economics fields already behave. The trigger list is kept to plainly
security words for that reason.

## What has and has not been checked

- Checked: the selection against the real dataset listing; the fetch, verification and conversion against a
  local stand-in for the hub; the build step through the real extract and index scripts into a searchable
  `security-diagnostics.db`; the route entry and its trigger words (all in `test/security-corpus.test.mjs`).
- Checked: the engine's own suites with the route in place: `knowledge-field-routing` (14 of 14),
  `corpus-manifest-covers-contract` (16 of 16 required fields; this one is optional), and the three
  `knowledge-provision-*` suites.
- Not checked: a download of the real files. They are gated, and this was built without a token. The converter
  accepts any JSON or JSONL shape, so the first real fetch is the check that the entries read well.
