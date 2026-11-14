# Pairing a Mac with Ronin CRM (no terminal)

Kingmaker collects its Ronin keys from the site. Nobody pastes a key into a terminal, `security` or a dotfile.

Code: `lib/ronin-pairing.mjs` (Mac side), `worker/kingmaker-pairing.ts` in ronininc-crm (CRM side, migration 0315).
Tests: `test/ronin-pairing.test.mjs`, and `npm run proof:kingmaker-pairing` in ronininc-crm.

## What the owner does

1. Install Kingmaker (Kingmaker Installer) and start it.
2. A Kingmaker dialog shows an 8-letter code like `BCDF-GHJK`, and the browser opens Connections on the site.
3. On the site, under **Connections → Pair a Mac**, type the code. The card shows which Mac asked: its name, its
   network and country, and whether it was paired before. Tick the keys it may hold, then tap **Approve**.
4. Within a few seconds the Mac saves its keys in its login Keychain, turns the Ronin office on and docks. The
   Kingmaker desk shows as live on the floor.

If the Mac is already running Kingmaker, open the site on that Mac and click **Pair this Mac**. That opens
`kingmaker://pair`, which shows a new code. The link carries no code and no key.

## When a Mac asks to pair

A Mac asks only when it is a Ronin install:

- the owner asked: **Pair this Mac** (`kingmaker://pair`), or `kingmaker pair`;
- the installer carried `pair.json` (`KINGMAKER_PAIR_CRM=ronininc scripts/build-installer.sh`, an operator build
  choice). The file holds `{"crm":"ronininc"}` only;
- the Ronin office was already on (`ronin-desk.json`), or the install is locked to Ronin (`crm-lock.json`).

On such a Mac it asks:

- when it has no Ronin key yet;
- when a key the pairing gave it is missing from the Keychain;
- when the CRM refuses a desk key (HTTP 401). That happens after a revoke on the site, after **Re-pair**, after a
  lost-Mac revoke, or when the key expires after 90 days. The dock stops retrying and the Mac asks again.

A plain install (no office, no lock, nobody asked) never contacts the pairing endpoint. A Ronin install from before
pairing existed, whose desk key was saved by hand, is left alone.

If the owner taps **Deny**, the Mac stays quiet until someone asks again. If a code expires unapproved, the Mac asks
again at its next start.

## What the Mac can be given

| Key on the site | Keychain service / account | Used by |
|---|---|---|
| Kingmaker desk | `ronin-crm-prod` / `KINGMAKER_DESK_TOKEN` | the desk dock (heartbeat = readiness, commands, inbox) |
| Muse, Claude, Codex, grok-bot desks | `ronin-crm-prod` / `MUSE_DESK_TOKEN`, `CLAUDE_DESK_TOKEN`, `CODEX_DESK_TOKEN`, `GROK_DESK_TOKEN` | the Build Room desks hosted here |
| Do-not-call reader | `Kingmaker iPhone Bridge` / `crm-dnc-token` | the iPhone bridge's DNC snapshot |
| Owner call transport | `ronin-crm-prod` / `KINGMAKER_OWNER_CALL_TOKEN` | owner calls (`kingmaker owner-call`) |

These are the slots Kingmaker already read. The pairing only fills them. A pairing can never hand out the master
key, an approver, a Solomon operator key, or any money key. The CRM refuses those, and the Mac has no slot for them.

A desk lives on one Mac. Giving the Kingmaker desk to a second Mac stops the first Mac's key, and the approval card
says which Mac holds it now. The owner call transport also lives on one Mac. The do-not-call reader can be on several.

## Security properties

- **Only the owner approves.** The approve, deny and revoke routes accept only the reviewed Ronin owner's signed-in
  session. Any `Authorization` header is refused before the master-token audit runs, so the master bearer cannot
  approve its own pairing, and neither can a desk key. There is no auto-approve.
- **One use, short-lived.** A code lasts 10 minutes. The keys are minted when the Mac collects them, not when the owner
  approves. They are returned once, in the response body. A second poll, even one racing the first, gets nothing,
  because the claim is one D1 batch guarded on `status='approved'`.
- **Never in a URL, log, file or audit row.** The device code (`ronin_pairdev_…`) is sent only in POST bodies. The
  code dialog script reaches `osascript` on stdin, and keys reach `security` on stdin, never on argv. The state file
  `ronin-pairing.json` (0600) holds the install id, the pairing id and grant names only. The CRM stores only hashes of
  the device code, the user code and each key. Audit rows record key ids, never a key or a prefix.
- **Bound to this Mac.** Each desk is bound to the pairing id and to this install's random id. The same key presented
  by another installation fails the desk heartbeat.
- **A stolen-Mac tripwire.** Every collection notifies the owner ("Kingmaker paired: <Mac>"). Revoke stops every key
  that Mac holds on its next request and frees its desks.

## Re-pair, rotate, revoke, lost Mac, several Macs

- **Rotate:** tap **Re-pair** on the Mac's row. Its keys stop, it asks again, and the owner approves the new code.
  Pairing the same Mac again retires its earlier pairing and every key that pairing held.
- **Lost or stolen Mac:** tap **Revoke**. Every key stops at once and its desks become free. If that Mac asks again,
  it only waits for a tap the owner never gives.
- **Several Macs:** pair each one and give each only its own desks. Each has its own pairing, install id and keys.

## Still manual, and why

- **The FaceTime handle for owner calls**, and turning owner calls on: `kingmaker owner-call setup` (now asks only for
  the handle when the Mac was paired) and `kingmaker owner-call on`. Choosing which number the Mac may ring is a
  deliberate owner act, kept local.
- **Voice enrollment** (`kingmaker enroll`). It is typed at a terminal on purpose: the voiceprint gate is only as
  strong as who is at the keyboard.
- **Solomon's own CRM connector key and the approver key** go through Solomon's protected key handoff (`:key`, or "connect my
  CRM"), which is not a shell command. They are not part of pairing, because they act far beyond a desk.
- **macOS permissions** (Microphone, Accessibility, Screen Recording, Automation) are granted by the owner in System
  Settings. Apple allows no other way.
- **A desk wake receiver** needs a public HTTPS URL, and a Mac has none. Kingmaker polls through its desk heartbeat
  instead. The owner-registered agent readiness registry (`/api/admin/agent-readiness/register`) still requires that
  receiver, so it is not set by pairing.
