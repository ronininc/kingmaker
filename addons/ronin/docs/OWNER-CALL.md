# Owner calls: the Mac side (FaceTime Audio, free)

Any Ronin agent (claude, codex, grok, muse, kingmaker, or the CRM scheduler itself) can ask the Ronin CRM to phone
Robbie. The CRM queues the request, and Kingmaker on the paired Mac places the call. Every caller uses the same code
path. Only the spoken name and the voice differ, and no agent is refused.

- **Free only.** The Mac places a FaceTime Audio call to one saved handle. There is no Twilio, no Bland and no paid
  API. `lib/phone.mjs` (Twilio) is not used.
- **Off by default.** Nothing polls the CRM until `kingmaker owner-call setup` has stored the handle and token and
  `kingmaker owner-call on` has been run.
- **Ronin only.** Setup, `on` and the loop all refuse unless this Kingmaker is bound to the Ronin CRM
  (`kingmaker office ronin enable` or `kingmaker crm-lock ronininc`).

Code: `lib/owner-call.mjs`. Tests: `test/owner-call.test.mjs`. CLI and daemon wiring: `lib/cli.mjs`.

## What a call does

1. Every 30 s (only while owner calls are on), the loop sends `GET https://www.ronininc.org/api/owner-call/pending`
   with the owner-call-transport token as the bearer. It takes one call at a time.
2. A quick preflight runs before anything reaches the CRM. It checks the devices, sox, whisper and the call-detection
   helper, and confirms FaceTime is not already on a call. If anything fails, the request is left queued and retried
   on a later tick.
3. `POST start {id, session_id}`. From this point the request id is used up for this Kingmaker session: it is never
   started or dialled again, even when the outcome is uncertain. If start answers `nothing_to_send`, nothing is
   dialled.
4. `open facetime-audio://<saved handle>`. The handle is always the one saved in the Keychain, never one taken from
   the request. It must be an E.164 phone number or an email address, and anything else is refused.
5. An AppleScript (System Events) presses the **Call** button in the macOS confirmation prompt.
6. The loop waits up to 45 s from the dial for "connected": the call-detection helper must report FaceTime running
   audio input and output at the same time. If that doesn't happen, the call is ended and `POST missed` is sent.
   Otherwise `POST answered {connected_at}` is sent.
7. The script runs:
   - **message:** "This is <Caller>, for Ronin. <message>", then "Any reply? Speak after the tone.", a tone, and up to
     20 s of recording. The recording is transcribed with whisper and sent as `POST result {outcome:'reply',
     transcript}`, bounded to 4 KB. With no speech the outcome is `silence`. A reply is information only and never
     approves anything.
   - **outbound_batch:** after the opening line, one line per item: "<ord>. <recipient>, by <channel>: <subject>."
     Only those three fields are read, never a body. Then: "Say okay to send these N, or say no." The loop records
     one utterance of up to 8 s, and asks once more if it heard nothing. The grammar is strict. After lower-casing
     and removing punctuation, only `okay`, `ok`, `yes`, `okay send them` or `yes send them` counts as **approve**.
     An utterance starting with no, nope, nah, don't, do not, stop or cancel is **deny**. No speech, or whisper's
     non-speech markers, is **silence**. Anything else, such as "not yet" or "okay but skip three", is
     **ambiguous**. If the call ends at any point, the outcome is **hangup**.
   - An approve is sent as `{outcome:'approve', phrase, transcript, affirmed_at, transport_event_id}`, and only when
     `affirmed_at` is at least 5 s before `approval_deadline`. A later approve is reported as `ambiguous`, and the
     loop says "That came after the approval window closed. Nothing was sent." Afterwards it says "Sending those N."
     only if the CRM answered `{ok:true, approved:true}`. Otherwise it says "Nothing was sent."
8. The call is ended on every path. The script presses End, then quits FaceTime, and runs `killall FaceTime` only if
   FaceTime still has call audio running.

On any error there is no approve and nothing is sent. The loop reports `ambiguous` (or `hangup` if the call dropped)
when it can, and sends only one result per call. If the approve POST itself fails, the outcome is uncertain. It is not
retried and no second result is sent. The loop tells Robbie to check the CRM.

### Voices

| caller | spoken name | Kokoro voice | `say` voice (fallback) |
|---|---|---|---|
| claude | Claude | af_heart | Samantha |
| codex | Codex | am_michael | Daniel |
| grok | Grok | am_adam | Fred |
| muse | Muse | af_nova | Karen |
| kingmaker | Kingmaker | bm_george | Rishi |
| ronin-crm | Ronin CRM | bf_emma | Moira |
| any other | its `caller_name` | af_sky | Tessa |

The spoken name comes from the CRM's `caller_name` when it sends one. You can override names, voices, devices and the
FaceTime button labels (`buttons.call`, `buttons.end`, for a non-English macOS) in
`~/Library/Application Support/sol-ghost/owner-call.json`, for example:

```json
{ "schema": 1, "enabled": true, "engine": "kokoro",
  "devices": { "speak": "BlackHole 2ch", "hear": "BlackHole 16ch", "hearRemix": "1,2" },
  "voices": { "grok": { "say": "Alex" } } }
```

### Audio routing (no custom native sidecar)

```
Kingmaker TTS ──(sox / say -a)──▶ BlackHole 2ch ──▶ FaceTime microphone ──▶ Robbie's phone
Robbie's voice ──▶ FaceTime output = Multi-Output Device ─┬─▶ your speakers (optional)
                                                          └─▶ BlackHole 16ch ──(sox rec, remix 1,2)──▶ whisper
```

Kingmaker records BlackHole 16ch through sox. It does not use a Core Audio process tap, so `app/Info.plist` does not
need (and does not get) `NSAudioCaptureUsageDescription`.

## Owner setup (once, on the paired Mac)

1. **A separate Apple ID for FaceTime on this Mac.** A Mac signed into Robbie's own Apple ID (or relaying his iPhone
   through Continuity) cannot ring Robbie's own iPhone. Create an Apple ID for the Mac, sign FaceTime into it
   (FaceTime → Settings → Apple ID), and turn off "Calls from iPhone" on this Mac. Ringing Robbie's handle from this
   Apple ID should show as an ordinary incoming FaceTime Audio call on his phone. Saving the Mac's Apple ID as a
   contact on his phone makes it recognisable.
2. **Install the free BlackHole drivers:** `brew install blackhole-2ch blackhole-16ch`, then log out and back in, or
   restart Core Audio.
3. **Install sox:** `brew install sox`.
4. **Create the Multi-Output Device.** In Audio MIDI Setup, click + → Create Multi-Output Device and tick your
   speakers (optional, so you can hear calls) and **BlackHole 16ch**. Leave the Mac's system output on your speakers,
   not the Multi-Output Device.
5. **Set FaceTime's devices.** Open FaceTime, then in the menu bar go to **Video → Microphone: BlackHole 2ch** and
   **Video → Output: Multi-Output Device**. FaceTime keeps these settings for later calls.
6. **Grant permissions** to Kingmaker, or to the terminal you run it from:
   - System Settings → Privacy & Security → **Accessibility**, so it can press Call and End.
   - System Settings → Privacy & Security → **Automation → System Events** (and FaceTime), so it can run the scripts.
     macOS asks the first time `kingmaker owner-call doctor` runs.
7. **Mint the token.** Sign in to the Ronin CRM as the owner and mint an **owner-call-transport** token. It has
   scopes `seeker:owner-call.deliver` and `seeker:owner-call.attest` and can only be minted from the owner's cookie
   session. The CRM also needs the owner row (`seeker_tenant_owners`, tenant `ronin`) and `OWNER_CALLS_ENABLED=1`.
8. **On the Mac:**
   ```
   kingmaker owner-call setup     # Robbie's handle (+1… or Apple ID email) and the token → Keychain (ronin-crm-prod)
   kingmaker owner-call doctor    # every ✗ names exactly what is missing and how to fix it
   kingmaker owner-call test      # optional: a real self-test call, only after you type "call me"; nothing goes to the CRM
   kingmaker owner-call on        # refuses until doctor passes
   kingmaker stop && kingmaker start
   ```
   `kingmaker owner-call off` stops the polling at the next tick, without a restart. `kingmaker owner-call status`
   shows the switch, a masked handle, whether a token is saved, the devices and the voices.

The handle is stored under Keychain account `KINGMAKER_OWNER_CALL_HANDLE` and the token under
`KINGMAKER_OWNER_CALL_TOKEN`, both in service `ronin-crm-prod`. Both are written through `security -i` on stdin, so
they never appear on a command line. Neither is ever printed or logged.

## Unverified until a live call

Everything below has stubbed tests only (this repo's CI is Linux). Check each item on the Mac with
`kingmaker owner-call test`, then with one real `message` call and one real `outbound_batch` call.

- **"Connected" detection.** The loop assumes FaceTime, or `avconferenced` (both bundle ids are watched), runs audio
  input and output together only once the call is answered. If FaceTime opens the microphone while it is still
  ringing, the loop would start speaking too early. Robbie would hear the script cut off, and a batch would end as
  silence or ambiguous, so nothing would be sent. If this happens, the detection needs a second signal, such as the
  in-call window.
- **The confirmation prompt.** The prompt's process and button name differ between macOS versions. The script looks
  for a button named or described "Call" in FaceTime, NotificationCenter and UserNotificationCenter windows. Its
  result ("clicked:<process>" or "not_found") is logged as `owner_call_dialled`.
- **Ending the call.** The script presses End, then quits FaceTime. `killall FaceTime` runs only if call audio is
  still running after 3 s.
- **Devices and levels.** sox recording from BlackHole 16ch with `remix 1,2` (FaceTime's output lands on channels
  1–2). Kokoro WAV played through `sox … -t coreaudio "BlackHole 2ch"`. `say -a "BlackHole 2ch"`. The endpointer's
  levels on FaceTime's decoded audio. Whisper accuracy on narrowband call audio for the five approval phrases.
- **Kokoro voice names.** The six Kokoro voices must exist in the bundled server. If one fails, that line falls back
  to `say` with the mapped voice, then to the default `say` voice.
- **The token and routes.** The token's prefix and format: setup accepts 16–512 URL-safe characters and checks it
  with `GET pending`. The `approval_deadline` format: ms, seconds or an ISO string are accepted, and an unreadable
  deadline is treated as passed.
- **Separate Apple ID reachability.** An outgoing FaceTime Audio call from the Mac's Apple ID must ring Robbie's
  iPhone, which is not guaranteed if FaceTime is restricted or the handle isn't registered with FaceTime.
