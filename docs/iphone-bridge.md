# iPhone bridge

Robbie's one iPhone, driven from his Mac by his agents, through Kingmaker. Local only, $0, no jailbreak, no paid Apple account.

Built from the 2026-10-13 build order *iPhone Control Bridge (Capability Augmentation)*.

## The approach, and why

| Path | What it needs | Verdict |
|---|---|---|
| **iPhone Mirroring** (macOS 15+) to see the screen and take input; **Messages.app** for iMessage/SMS; **Calls from iPhone** for SIM calls | Nothing on the phone. Mac and iPhone on the same Apple Account, Wi-Fi and Bluetooth. Three macOS permissions. | **Chosen.** Built in, no developer signing, nothing to install on the phone. |
| WebDriverAgent + Appium over Xcode (what [kevinbadi/Kevs-iOS-Agents](https://github.com/kevinbadi/Kevs-iOS-Agents) uses, Apache-2.0) | Developer Mode on the phone, a WDA build signed with an Apple ID (a free ID's profile expires every 7 days and must be re-signed), Appium, Postgres | Rejected for one phone: heavy and fragile. It gives an accessibility tree, which is nicer than OCR, but the weekly re-sign defeats "always there". |

From Kevs-iOS-Agents and [jfarcand/mirroir-mcp](https://github.com/jfarcand/mirroir-mcp) (both Apache-2.0) only the **pattern** was borrowed: see the screen, find the target by its text, act, see again. No code was copied, so no attribution file is needed. mirroir-mcp also shows that iPhone Mirroring accepts CGEvent input with Accessibility alone.

**Paid capability: none needed.** Nothing here asks for an Apple Developer Program membership.

## How it works

```
agent ──MCP──▶ kingmaker mcp ──▶ lib/iphone-bridge.mjs ──▶ dist/kingmaker-iphone-helper (Swift, Apple frameworks)
                                   │  see:  screencapture -l <iPhone Mirroring window> → Vision OCR → text + tap points
                                   │  act:  CGEvent click / drag / keys into that window
                                   │  call: open tel:+1…  (Calls from iPhone, the phone's SIM)
                                   │  text: osascript → Messages.app (iMessage, or SMS via Text Message Forwarding)
                                   └─ lib/iphone-policy.mjs gate + lib/iphone-dnc.mjs (local do-not-call snapshot)
```

Every action reads the screen again afterwards and returns it, so the calling agent closes the **see → decide → act** loop. `kingmaker iphone do "<goal>"` runs the same loop with a local Ollama model as the decider (127.0.0.1 only). Small models are weak at this, so the usual decider is the agent itself.

### Methods in the Kingmaker registry (`kingmaker mcp`)

| Tool | Does | Gate |
|---|---|---|
| `see-phone-screen` | text elements with tap points, screen class, a picture | read-only |
| `tap-phone` | tap by on-screen text (preferred) or x/y | stops on password/code/payment screens; Send-like buttons and compose screens need Touch ID |
| `type-on-phone` | type into the focused field | never secrets; typing into a message box needs Touch ID |
| `press-phone-button` | home, app-switcher, spotlight, return, delete, escape… | Return in a compose box needs Touch ID |
| `swipe-phone` | up/down/left/right | — |
| `open-phone-app` | open an app through Spotlight | Wallet and Passwords refused |
| `call-from-phone` | call a contact from the SIM | outbound gate |
| `send-imessage-to-contact` | iMessage or SMS a contact | outbound gate |
| `phone-bridge-status` | permissions, Mirroring, DNC snapshot | read-only |

No tool approves anything, trusts a contact, syncs the DNC list or changes policy. Those are Robbie's acts at the CLI.

## The outbound gate (`lib/iphone-policy.mjs`)

Every call and message passes these checks in order. Any failure refuses, with a plain reason:

1. **Well formed:** an action, a recipient, and a non-empty message of 2000 characters or fewer.
2. **No secrets:** a password, a one-time code, a card number (Luhn check), CVV or SSN in the text is refused. Those are Robbie's to type.
3. **Known contact only:** the recipient must be one card in the Mac's Contacts, and the number or email asked for must really be on that card. Strangers are refused: *"Refused: +1 480… is not in your Contacts. I only message people you know."* A name matching several cards, or a card with several numbers, is refused as ambiguous rather than guessed. Follow lists aren't checked: no iPhone app exposes one locally without a paid or cloud API, so Contacts is the proof of relationship.
4. **CRM do-not-call, fail closed:** the target number and every other number on that card are checked against a local snapshot of the CRM's `do_not_call` table (`worker/dnc.ts`, `GET /api/dnc/snapshot`: phone numbers only, no row cap). Everything is refused when the snapshot is missing, older than 24 h, or marked incomplete.
5. **Robbie confirms each action:** a macOS Touch ID / login-password dialog reads back exactly what will happen (*"iMessage Mom (+16025550100): "Running late""*). The only way around it is a contact Robbie trusted himself for that channel (`kingmaker iphone trust`, itself behind Touch ID, stored in the login Keychain by the helper).

**Raw input is screen-guarded too.** A password, passcode, verification-code or payment screen stops tap/type and hands back to Robbie. Typing into, or sending from, what looks like a message box needs his Touch ID. Typing or pressing Return inside a messaging app (Messages, WhatsApp, Instagram, Mail…) also needs his Touch ID, as does typing into an app the bridge didn't open itself (right after connecting, after the App Switcher). The bridge tracks which app it last put on screen, because OCR often can't see a thread's input box. That stops a route around step 3 via the Messages app on the phone. The guard is an OCR heuristic. The guaranteed path is the gate above.

Inbound is not gated: an agent can open Messages on the phone and read what arrived.

## Robbie's setup (once)

1. **Build the helper:** `kingmaker iphone build` (Xcode command-line tools, already on this Mac).
2. **iPhone Mirroring:** open *iPhone Mirroring* on the Mac and follow its first-run steps. Your iPhone must be nearby, locked, on the same Apple Account, with Wi-Fi and Bluetooth on. Mirroring only works while the phone is locked: using the phone ends the session.
3. **macOS permissions** in *System Settings → Privacy & Security*, for the app that runs `kingmaker` (Terminal, Claude, or Kingmaker.app):
   - **Screen & System Audio Recording:** on (to see the phone).
   - **Accessibility:** on (to tap and type).
   - **Contacts:** macOS asks the first time a call or message is checked. Allow. A host app that cannot show that prompt (a CLI agent) is denied silently; the bridge then reads Contacts through Contacts.app, so allow **Automation → Contacts** instead.
   - **Automation → Messages** and **→ System Events:** macOS asks on the first message and the first call. Allow.
4. **Calls through the SIM:** on the iPhone, *Settings → Apps → Phone → Calls on Other Devices* → allow this Mac. On the Mac, *FaceTime → Settings → Calls from iPhone* → on.
5. **SMS through the SIM:** on the iPhone, *Settings → Apps → Messages → Text Message Forwarding* → this Mac on.
6. **Do-not-call list:** pair this Mac on the site (*Connections → Pair a Mac*, tick **Do-not-call reader**, tap Approve): Kingmaker saves the reader key in this Keychain item by itself (see `docs/ronin-pairing.md`). By hand instead: in the CRM, *Admin → Connections → Issue do-not-call reader token* (prefix `ronin_dnc_`: it can read the do-not-call phone numbers and nothing else). Store it, pasting it at the hidden prompt:
   ```bash
   security add-generic-password -s "Kingmaker iPhone Bridge" -a crm-dnc-token -w
   ```
   Then sync, and re-sync at least daily (outbound is blocked when the snapshot is more than 24 h old):
   ```bash
   kingmaker iphone dnc sync
   ```
   Sync sends only a `ronin_dnc_` token. A stronger token in that Keychain item is refused before anything is sent.
7. **Check:** `kingmaker iphone status`.

To let agents message one person without asking each time: `kingmaker iphone trust "Mom" --channels imessage,sms`. Take it back with `kingmaker iphone untrust "Mom"`.

## Network

The bridge's own processes make **no non-local network calls** while operating. Run `kingmaker iphone status` and `see`, or the tests, under a sandbox that denies everything but localhost:

```bash
sandbox-exec -p '(version 1)(allow default)(deny network-outbound)(allow network-outbound (remote ip "localhost:*"))(allow network-outbound (remote unix-socket))' node lib/cli.mjs iphone see
```

There are only two `fetchImpl(` calls in bridge code: the owner-run `dnc sync` (one GET to his own CRM with a read-only token, not during operation) and the optional Ollama decider (refuses any host but 127.0.0.1).

Apple's own transports are outside the bridge, and the owner should know about them. iPhone Mirroring and Text Message Forwarding are Mac↔iPhone over Wi-Fi/Bluetooth. An **iMessage** is carried by Apple's iMessage service, as any iMessage is. A call goes over the phone's cellular line.

## Limits and follow-ups

- **Agents with a raw shell** can drive Messages.app or `tel:` themselves and bypass any local gate. The gate governs the agent-callable registry. Shell-level agents are governed by the CRM doctrine (no outreach without an owner tap).
- **The DNC snapshot endpoint is a CRM change** (`GET /api/dnc/snapshot`, the `dnc-reader` token). Sync works only once that CRM PR is deployed. Until then, `dnc import` takes a saved copy of `/api/admin/dnc/list` (capped at 500 rows: past that, outbound stays blocked).
- **Pressing Call** after the `tel:` link is best effort (System Events looks for a "Call" button). When it isn't found, the result says the prompt is showing.
- **One pointer:** iPhone Mirroring has no multi-touch, so no pinch.
- **Typing uses US-keyboard keystrokes.** iPhone Mirroring reads key codes, not attached characters, so a character with no US key (emoji, accents) is refused before anything is typed. Use send-imessage-to-contact for those.
- **OCR sees text, not icons.** Tap icon-only buttons by x/y from the picture.
- The Kingmaker phone module (`lib/phone.mjs`) still never calls anyone but Robbie through Twilio. SIM calls to other people go only through this gate.
