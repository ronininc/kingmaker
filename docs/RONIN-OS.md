# Ronin OS: the Kingmaker-native phone

> **Status: design only.** Nothing in this file is built, and nothing has been measured on a phone. Every row says
> which. Written 2026-10-15 against Kingmaker `local/kingmaker-bar` @ `c079a0a` and GrapheneOS `2026100600`
> (Android 17), the stable build for the Pixel 10 series that day.
> Notes marked **(upstream)** come from a third-party project's own docs, not from this repo.

Ronin OS is a phone operating system built from GrapheneOS, with Kingmaker as its brain. **Kingmaker-native** means
Kingmaker is not an app installed on the phone. It is part of the signed system image: it starts at boot, it is the
home screen, the assistant, the dialer and the messenger, it decides what may install, and it holds the keys. No
system setting can remove it.

The owner's rule for the Mac carries over unchanged: people add features through skills and extensions, never by
editing Kingmaker (`lib/integrity.mjs`). On the phone the whole OS is sealed the same way, by verified boot with
Ronin's own key.

## 1. What Kingmaker owns on the phone

| OS role | On the Mac today | On Ronin OS | Status |
|---|---|---|---|
| Boot and integrity | The code signature seals Kingmaker.app; `lib/integrity.mjs` checks the seal and Ronin's signer at launch | Verified boot with Ronin's key seals the whole OS; hardware attestation proves it to the collective | not built |
| Home screen | The menu bar app (`app/Kingmaker.swift`) | Kingmaker holds Android's home role: the first thing on screen is Kingmaker | not built |
| Assistant | Wake word plus voice (`lib/voice.mjs`), the bar | Kingmaker holds the assistant role: the wake word, the power-button hold and the lock screen all go to it | not built |
| Brain | Ollama models chosen per Mac (`lib/mac-profiles.mjs`, `lib/fast-route.mjs`, `lib/tool-call.mjs`) | llama.cpp inside Kingmaker's own system service, no separate server | not built |
| Hands | Peekaboo plus Accessibility, Screen Recording and Apple Events, each granted by the owner | System permissions given to Kingmaker by the OS itself: input, screen and app control without accessibility workarounds | not built |
| Calls and texts | `lib/iphone-bridge.mjs` through the owner's iPhone, every send behind `lib/iphone-policy.mjs` | Kingmaker holds the dialer and SMS roles; the same gate runs before every call or text | not built |
| Vault | The login Keychain (`lib/keychain-seal.mjs`, `lib/keys.mjs`) | The Titan M2 security chip through Android's hardware keystore | not built |
| App installs | REA checks every connector and skill (`lib/rea.mjs`) | REA is the system installer: no app or skill installs without its verdict | not built |
| Updates | `lib/update.mjs` from a private R2 bucket behind a Worker | GrapheneOS's Updater pointed at Ronin's own update host on R2 | not built |
| Pairing | `lib/ronin-pairing.mjs`, an 8-letter code approved on the site | The same flow, "Pair a phone", with keys saved to the hardware keystore | not built (needs a CRM change) |

## 2. Target hardware

**Pixel 10 Pro XL** (codename `mustang`), **16 GB RAM, 1 TB**, bought **unlocked** from the Google Store.

| Why | Detail |
|---|---|
| GrapheneOS production support | Recommended device, minimum support until **August 2032** **(upstream**, GrapheneOS FAQ) |
| Your own verified-boot key | Pixels accept a custom boot key and let the bootloader be locked again on top of it. That is the only way a fork boots as a verified, locked OS. Most other phones can only run a fork unlocked |
| Memory | 16 GB, the same as Kingmaker's 16 GB Mac class. The Pixel 10 (12 GB) and 10a would put the phone in the 8 GB class's small models |
| Security hardware | Tensor G5 with ARM memory tagging (MTE), and Titan M2 for the keystore |
| Pro XL over Pro | Same chip and RAM. The XL has the bigger battery, and a local model drains the battery fast. 1 TB holds several sets of model weights |

Buy it **unlocked**: a carrier-sold Pixel can refuse OEM unlocking, and then no custom OS installs at all.

**Not now:**
- **Pixel 11 series.** GrapheneOS has no port: Google appears to have removed MTE from its firmware, and GrapheneOS
  may skip the generation **(upstream)**. Revisit only if GrapheneOS ships it.
- **Motorola.** GrapheneOS announced it will certify selected Motorola devices, expected in 2027 **(upstream)**.
  That would be the first non-Pixel option.

## 3. Build machine

GrapheneOS builds only on **x86_64 Linux** **(upstream**, grapheneos.org/build). A Mac, Apple-silicon or Intel,
can't build it, so the M5 Pro stays the development Mac for Kingmaker itself.

| Need | Minimum **(upstream)** | Recommended |
|---|---|---|
| OS | Ubuntu 24.04 LTS, Ubuntu 24.10, Debian bookworm or Arch | Ubuntu 24.04 LTS |
| CPU | x86_64 | 16+ cores (a full build takes hours) |
| Memory | 32 GiB (needed to link with LTO and CFI) | 64 GiB |
| Disk | 136 GiB for the source with history, plus 100 GiB+ per device build | 1 TB NVMe |
| Shell | bash or zsh | — |

A cloud VM works. The **signing keys never go on it**: builds can run in the cloud, but signing runs on a machine the
owner controls (§4).

## 4. The chain of trust

This is what makes a phone *Ronin's*, and what lets the collective tell an official Ronin OS from a modified copy.

1. **Keys**, generated once per device model, offline **(upstream**, grapheneos.org/build):
   - the Android release keys (`releasekey`, `platform`, `shared`, `media`, `networkstack` and the rest) with
     `development/tools/make_key`;
   - the **verified-boot key**: RSA-4096, with its public half extracted by `avbtool` to `avb_pkmd.bin`;
   - an ed25519 key that signs factory images;
   - all of them encrypted at rest by GrapheneOS's `encrypt-keys` script (scrypt plus AES-256).
2. **Custody.** The keys live only with the owner, like the Solomon Local certificate that signs Kingmaker.app
   today (`RONIN_SIGNERS` in `lib/integrity.mjs`). Keep an offline backup. A lost key means no more updates for
   phones already in the field: they can only be wiped and reflashed with a new key.
3. **Install.** The factory image's flash script loads `avb_pkmd.bin` into the phone's custom-key slot, then
   `fastboot flashing lock` locks the bootloader. That wipes the phone and must be confirmed on the phone itself
   **(upstream**, grapheneos.org/install).
4. **At every boot** the phone shows a yellow notice with the SHA-256 of the boot key. Pixel 6 and later show the
   full hash, so the owner can compare it against the hash Ronin publishes.
5. **Attestation, the phone's `lib/integrity.mjs`.** Android's hardware key attestation reports, signed by the
   security chip, whether the bootloader is locked and which boot key booted the phone. Kingmaker sends that report
   with every collective share and every Brain Library submission:

   | State | Means | Same as the Mac's |
   |---|---|---|
   | official | locked bootloader, Ronin's boot key, a Ronin build | `official` |
   | modified | unlocked, another key, or a build Ronin didn't sign | `modified`: works on its own phone, cut off from the collective |
   | dev | an engineering build on Ronin's own test phone | `dev` |

## 5. The Kingmaker-native layers

### 5.1 The brain on the phone

- **Runtime.** llama.cpp built for Android (arm64), linked into Kingmaker's system service. One process, with no
  Ollama server and no port to guard.
- **Tool calls carry over.** `lib/tool-call.mjs` relies on Ollama's `format` field to hold each reply to a JSON
  schema. llama.cpp does the same with its JSON-schema grammars, so the two-step pick-then-args method ports as it
  is. The 18 cases in `lib/model-bench.mjs` (`TOOL_CASES`) become the phone's acceptance test.
- **Hardware.** Third-party code can't use the Tensor G5's AI processor (the TPU) without Google's own services, and
  Ronin OS ships without them. So the models run on the CPU (ARM NEON and i8mm) or on the GPU through Vulkan.
  The G5's GPU is a new Imagination PowerVR design, and llama.cpp's Vulkan backend on it is **unmeasured**.
- **Which models.** The 16 GB Mac profile keeps the 1.7b router warm beside the 8b writer, about 9.1 GB resident
  (`lib/mac-profiles.mjs`, line 87). Android itself needs several GB, so that pair is plausible on 16 GB but
  **unmeasured**. The phone profile is picked the same way the Mac profiles were: from a bench run on the phone,
  never from claims (§7, Phase 3).

### 5.2 Split brain: the phone and the Mac

- **On the phone:** the rules plus the router (`lib/fast-route.mjs`), quick writing, tool calls, voice, and every gate.
  The phone works alone with no network.
- **On the paired Mac:** the heavy models, the Build Room desks (`lib/brain-desks.mjs`: Claude, Codex and grok-bot
  stay Mac-side), media generation, and long jobs.
- **Between them:** the pairing in `lib/ronin-pairing.mjs` already binds keys to one install. The phone pairs as its
  own install with its own keys; the Mac never hands it a desk it holds. `lib/phone-companion.mjs` today makes the
  iPhone a display for the Mac. On Ronin OS the arrangement flips: the phone thinks for itself and borrows the Mac.
- **Gates never split.** A turn the Mac answers comes back as a proposal, and the phone's own gates decide whether
  anything happens.

### 5.3 The engine

Kingmaker is Node (`lib/*.mjs`) running Solomon's headless server (`lib/runtime.mjs`). Two ways onto Android:

| Option | For | Against |
|---|---|---|
| **A. Node built for Android arm64**, run as a system service | One codebase: the same `lib/` runs on the Mac and the phone, and the tests carry over | Memory and start-up cost unmeasured; Solomon's native modules (LanceDB, DuckDB, sharp) need Android builds |
| B. A Kotlin rewrite of the core | Lean, at home on Android | Two codebases that drift apart, and every gate written twice |

**Start with A.** Move to B only for parts the phone bench shows are too slow or too large.

### 5.4 The hands

Ronin OS signs Kingmaker with its own platform key, so the OS can grant it system permissions no store app can get:
injecting taps and keys, capturing the screen, starting and stopping apps, and changing settings. On the Mac these
need Peekaboo plus three permissions the owner grants in System Settings (`docs/SYSTEM-REQUIREMENTS.md` §2.4); on the
phone they are part of the OS.

Reaching further is not a licence to act further. The same rules hold:
- an action stops on password, code and payment screens and hands the phone back to the owner, as in
  `docs/iphone-bridge.md`;
- anything that sends, pays or changes a record needs the owner's confirmation (§5.5).

### 5.5 Calls, texts and the outbound gate

Kingmaker holds the dialer and SMS roles, so it places calls and texts directly over the phone's own SIM, with no
iPhone Mirroring. Every call and text first passes the gate in `lib/iphone-policy.mjs`, in the same order:

1. well formed;
2. no secrets in the text;
3. known contacts only;
4. the CRM's do-not-call snapshot, failing closed when it is missing, stale or incomplete (`lib/iphone-dnc.mjs`);
5. the owner confirms each action, now with the phone's fingerprint or face prompt in place of Touch ID. A contact
   the owner trusted for that channel is the only exception.

Inbound is not gated, the same as today.

### 5.6 The vault

Kingmaker's keys (desk keys, the do-not-call reader and the voiceprint seal) move from the login Keychain to the
Titan M2 through Android's hardware keystore:
- keys are created inside the chip and never leave it;
- a key can require the owner's fingerprint or face before each use;
- Android stores each app's keys separately, so another app can't read Kingmaker's.

That closes the gap `lib/keychain-seal.mjs` admits today, where any program running as the owner can ask `security`
for the key.

### 5.7 The REA installer

Every app, skill and extension goes through REA (`lib/rea.mjs`) before it installs. GrapheneOS already has per-app
switches for network and sensors **(upstream)**, so REA's verdicts map straight onto the OS:

| REA verdict | On the Mac | On Ronin OS |
|---|---|---|
| `clean` | runs as itself | installs normally |
| `sandboxed` (fix `network`) | the macOS sandbox denies the network | installs with GrapheneOS's network switch off |
| `sandboxed` (fix `files`) | the sandbox denies those paths | installs with storage limited to its own folder (GrapheneOS's storage scopes) |
| `sandboxed` (fix `exec`) | the sandbox denies privilege | no change needed: Android apps can't raise privileges |
| `rejected` | not connected | refused at install, with the file and line REA found |

REA reads source today. An Android app arrives compiled, so REA needs a pass that reads compiled apps
(**not built**). Until it has one, a compiled app it can't read installs with the network switch off.

### 5.8 Voice

The voice stack (`lib/voice.mjs`): whisper.cpp to transcribe, Kokoro to speak, and the owner's voiceprint deciding
who may approve (`lib/owner-voice.mjs`). whisper.cpp has an Android build **(upstream)**, and Kokoro runs through
ONNX Runtime. The voiceprint is sealed with a key in the Titan M2 instead of the Keychain. The rule stays exact:
only the enrolled owner's live voice can approve anything.

### 5.9 Updates

- GrapheneOS's Updater app, with its address changed in `packages/apps/Updater/res/values/config.xml` to Ronin's
  update host **(upstream)**.
- That host sits on R2 like `lib/update.mjs`'s, with the same three channels GrapheneOS uses (testing, beta and stable)
  and delta updates (`script/generate-delta.sh`).
- Updates are A/B: the new system installs while the phone runs, and a failed boot falls back to the old one.
- **Open:** the Updater expects a public static host, but Kingmaker's update host answers only to an update key.
  Either the Updater learns to send that key, or OS images are public. They are signed, so making them public leaks
  nothing secret.

### 5.10 Google apps

Ronin OS ships without Google services, like GrapheneOS. Kingmaker never needs them. GrapheneOS's sandboxed Google
Play stays available for owners whose business apps require it, installed and sandboxed like any other app.

## 6. Licences and the name

- **Name.** GrapheneOS is that project's name. The product is **Ronin OS**; "based on GrapheneOS" may describe it.
  The GrapheneOS logo and branding don't appear.
- **AOSP** is Apache-2.0. Keep its notices.
- **GrapheneOS's own changes** carry their own per-repository licences. Check each repo Ronin OS changes before
  shipping.
- **The Linux kernel** is GPL-2.0. Ronin must publish the kernel source, Ronin's changes included, for every build
  it ships.
- **Pixel firmware and vendor files** are Google's; GrapheneOS extracts them from Google's own images with
  `adevtool` **(upstream)**. Check Google's terms before Ronin distributes images that contain them.
- **Kingmaker** keeps its own licence ([LICENSE](../LICENSE), [COMMERCIAL-LICENSE.md](../COMMERCIAL-LICENSE.md)). It
  ships in the image as a separate program, so the open-source licences of the OS around it don't change its terms.

## 7. Roadmap

Each phase is done only when its check has been seen passing on a real phone. Nothing is marked done on a claim.

| Phase | Work | Done when |
|---|---|---|
| 0. Hardware | An unlocked Pixel 10 Pro XL 16 GB / 1 TB; the Linux build machine (§3) | OEM unlocking can be switched on; the build machine syncs the GrapheneOS source |
| 1. Stock build, Ronin's keys | Build unmodified GrapheneOS for `mustang`; generate the keys (§4); flash and lock | The phone boots locked; the boot screen shows the hash of Ronin's key; attestation reports locked plus Ronin's key |
| 2. Ronin OS name, own updates | Name, boot animation, setup screens; the Updater pointed at Ronin's host | An update from Ronin's host installs on the phone; a delta update installs; switching channels works |
| 3. Brain bench | llama.cpp on the phone; port `kingmaker models bench` (`lib/model-bench.mjs`) | `catalog/bench/pixel-10-pro-xl-16gb.json` exists with the same suites as the Mac runs, and the phone profile is chosen from it |
| 4. Engine | Kingmaker's `lib/` running as a system service (§5.3, option A); fast route plus tool calls | The 18 tool-call cases and the 12 routing cases pass on the phone at the profile's measured rate |
| 5. Native roles | Home, assistant, dialer and SMS roles; the outbound gate; the vault in the Titan M2; voice | Each role's own tests pass on the phone; a text to a stranger is refused, a do-not-call number is refused, and an approval needs the owner's fingerprint, face or voice |
| 6. REA installer | REA as the system installer, the verdict mapping (§5.7), and a pass for compiled apps | A `rejected` app is refused at install; a `sandboxed` app installs with its network switch off |
| 7. Pairing, split brain, collective | "Pair a phone" on the CRM; phone-to-Mac turns; attestation sent with shares | The phone pairs with no terminal; a Mac-answered turn still passes the phone's gates; a modified phone is cut off from the collective |
| 8. Release | A web installer that unlocks, flashes and relocks, like GrapheneOS's own | A new unlocked Pixel goes to locked Ronin OS from a browser, with the boot hash matching the published one |

## 8. Open questions

- **GPU on Tensor G5:** does llama.cpp's Vulkan backend run well on its PowerVR GPU, or is the CPU faster? Phase 3
  answers it.
- **Node's cost on Android:** memory and start-up time for Kingmaker plus Solomon's server (§5.3). Phase 4 answers it.
- **Updater authentication:** a keyed host or public signed images (§5.9).
- **Pixel 10 Pro Fold:** its RAM isn't confirmed in the sources checked here; check it before adding the fold as a
  second target.
- **After the Pixel 10:** depends on GrapheneOS shipping the Pixel 11 (blocked on MTE) or Motorola (2027).

## Sources

- GrapheneOS FAQ, supported devices and support dates: <https://grapheneos.org/faq>
- GrapheneOS build guide, host requirements, keys, Updater: <https://grapheneos.org/build>
- GrapheneOS command-line install, flashing, locking, boot-key hash: <https://grapheneos.org/install/cli>
- GrapheneOS releases, `2026100600` and the device codenames: <https://grapheneos.org/releases>
- Pixel 11 and MTE: <https://www.androidauthority.com/no-grapheneos-google-pixel-11-3704622/>
- GrapheneOS and Motorola: <https://www.phonearena.com/news/pixels-grapheneos-monopoly-is-officially-over_id183574>
- Pixel 10 Pro and Pro XL memory and storage: <https://www.gsmarena.com/google_pixel_10_pro_pixel_10_pro_xl_specs_leak-news-68449.php>
