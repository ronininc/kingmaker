# Kingmaker terms: the fine print

## The deal

Kingmaker learns on your Mac, and by default it shares what it learned, never your data, so every copy of Kingmaker gets better. You choose: the first time Kingmaker has something to share, it shows a permissions box. **Share and get improvements** is the default. **Keep it on this Mac** turns sharing off. Nothing leaves your Mac until you have seen that box. You can change your mind any time: say or type "sharing on" or "sharing off", or use the row in Connectors & keys, under Access on this Mac. With sharing off, Kingmaker keeps working and keeps learning on your Mac; it just receives no improvements from the collective.

*(Changed 2026-10-15. Earlier terms made collective learning a condition of the licence; it is now on by default and your choice.)*

**Not running yet.** The collective's service is not live. Until it is, nothing is sent: each packet Kingmaker would share is written to your local log and marked not sent.

## Your data and ours: the line

| | Your data | Ours (Ronin Inc. and the collective) |
|---|---|---|
| **What it is** | Everything you say, type, see, store or connect: recordings and transcripts, files, screens, messages, contacts, accounts and credentials, names, addresses and numbers, your business records, the names of your local models. | The sanitized learning Kingmaker produces about how it works: skill procedures and their scorecards, per-device evaluation and model-trial results, counts of public task words per route, and counts of the kinds of preferences you set (never the preferences themselves). Closed values only, built from a public vocabulary. |
| **Where it lives** | On your device, only. | Sent to the collective; a copy of every packet stays in your local log. |
| **Who owns it** | You. Ronin Inc. claims no right to it and never receives it. | You grant Ronin Inc. a perpetual, worldwide, irrevocable, royalty-free licence to use, combine, improve and redistribute it, including commercially. The collective's improvements built from it belong to Ronin Inc. |

Nothing crosses from the left column to the right. A field that could carry your data does not build.

## Contributing to the collective

With sharing on, Kingmaker contributes sanitized learning to the collective: skill procedures and their scorecards, per-device evaluation and model-trial results, counts of public task words per route, and counts of the kinds of preferences you set (never the preferences themselves). These are closed values only. No transcript, file, screen, contact, credential, name, address or other identifier is ever sent; your data never leaves this device. Each instance keeps a log of exactly what it sent (`fleet/contributed.jsonl`). The collective's signed improvements are offered only to instances that contribute, and each instance trials an improvement on its own device before adopting it.

What that means in practice:

- **What is sent.** Only fields from a closed schema: enums, bounded numbers, a random install id, the day, the release version, a coarse device class (for example `darwin-arm64-8gb`), and words from a public vocabulary that ships with the code. A field that could carry free text does not build.
- **What is never sent.** What you said, typed, saw or stored: no transcripts, files, screen contents, contacts, credentials, names, addresses, account numbers, host names, serial numbers, or the names of your local models. From your requests, only counts of common task words on the public vocabulary leave, and only words used in at least two of your requests.
- **How you can check.** Every packet is written, exactly as sent, to `fleet/contributed.jsonl` in Kingmaker's data folder, with what was stripped (kinds and counts only) and the collective's signed receipt.
- **Reciprocity.** The collective sends its improvements only to installs that share. A copy of Kingmaker with sharing off keeps working on its own and receives no collective updates.
- **Your switch.** "sharing off" stops sharing at once. "what have you shared" shows the log. "forget what I shared" asks the collective to erase this install's contributions.
- **Nothing is adopted blindly.** An improvement must be signed by the collective's key, addressed to your install, and pass a trial on your own device's records before it is used. Nothing from the collective can change Kingmaker's governance, approvals, keys or code.
- **Erasure.** On request, the collective deletes your install's contributions and standing. It then receives no collective updates until it contributes again.

## Knowing your copy is genuine

Kingmaker's source is public, so anyone can build a copy and put the Kingmaker name on it. Here is how to tell Ronin Inc.'s own copy from someone else's:

- **The release is signed.** Every genuine release is signed with Ronin Inc.'s offline release key. The installer verifies that signature against the key it carries before it trusts or downloads anything, and it refuses a release whose signature does not match. A fake cannot forge this signature without the private key, which never leaves Ronin Inc.'s hands.
- **You can check the key yourself.** The key's fingerprint is published at the official site. A careful user can confirm the installer carries that same key before running it.
- **When notarization is available**, the app and installer are also signed with Ronin Inc.'s Apple Developer ID and notarized by Apple, so macOS Gatekeeper vouches for them. A copy that is not notarized under that identity is not Ronin Inc.'s.
- **Get it from the official site only.** Updates and installers from anywhere else are not covered by any of the above, whatever they are called.

## Licence, and the absence of a warranty

*(This section states the licensing and liability position in plain terms. It is not itself legal advice.)*

- **Licence.** Kingmaker's source code is made available under **PolyForm Noncommercial 1.0.0** (see `LICENSE`); commercial use is offered separately (see `COMMERCIAL-LICENSE.md`). The licence covers not only the source but the **compiled application, the installer, and everything Ronin Inc. distributes as part of Kingmaker**.
- **No warranty.** Kingmaker — the source, the app, and the installer alike — is provided **"as is" and "as available," without warranty of any kind**, express or implied, including merchantability, fitness for a particular purpose, title, and non-infringement. Ronin Inc. does not warrant that Kingmaker will be uninterrupted, error-free, or secure, or that it will meet your needs. This restates, for the app and the installer, the same disclaimer the source licence already makes.
- **You run it; you are responsible for how.** Kingmaker acts on your Mac under your direction, with the models and connectors you choose. You are responsible for what you ask it to do and for complying with the law and with the terms of any model, service, or account you use through it.
- **Limitation of liability.** To the fullest extent the law allows, Ronin Inc. is **not liable for any indirect, incidental, special, consequential, or punitive damages, or for lost data, profits, or goodwill**, arising from Kingmaker; and Ronin Inc.'s total liability for any claim is limited to **the amount you paid Ronin Inc. for Kingmaker in the twelve months before the claim, which for a free install is nothing**.
- **You indemnify Ronin Inc.** You agree to defend and hold Ronin Inc. harmless from claims arising out of your use of Kingmaker in breach of these terms or of the law.
- **Acceptable use.** Do not use Kingmaker to break the law, to harm others, or in breach of the terms of the models, services, or accounts you connect to it. Kingmaker runs the models you choose, including uncensored ones; choosing and using them is yours to answer for, not Ronin Inc.'s.
- **Who may use it.** Kingmaker is for adults: you must be at least **18**.
- **If a part fails.** If any part of this section is unenforceable, the rest still stands.
