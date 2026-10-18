---
name: voice-operations-command
description: Operate Claude's connected connectors by voice from the mobile app. Use this whenever the user is speaking or dictating to the voice orb and asks Claude to send or draft an email, message someone, create or reschedule a calendar event, add a Google Meet link, check or report the current state of anything in a connected connector (Gmail, Google Calendar, Google Drive, Clover, or any connected MCP), or run an "operations command." Trigger on spoken, hands-free, one-shot operational requests even when the user does not name the connector. This is the inside-Claude voice bridge; it is intentionally separate from Kingmaker's engine. Never use GitHub through this skill.
---

# Voice Operations Command

This skill is the bridge between the voice runtime the user is speaking to (the mobile voice orb in the Claude app) and the connectors currently connected to Claude. The user talks; this skill turns the spoken request into safe, verified connector actions and speaks the result back.

It does not create permissions, expand access, or bypass any connector's own controls. It uses only the tools already available to the authenticated user in this session. If a connector is not connected, this skill says so plainly rather than pretending.

This skill is deliberately kept separate from Kingmaker's engine. The engine is its own governed system; those connectors will eventually be hard-coded into it. Here, the job is narrower: let the user run everyday operations by voice, inside Claude, across whatever is connected right now.

## The one rule that overrides everything

**Never use GitHub through this skill.** Do not read repositories, open issues or PRs, commit, or call any GitHub connector as part of a voice operations command. If a spoken request would require GitHub, stop and tell the user that GitHub is out of scope for voice operations, and offer a non-GitHub path or a manual handoff.

## What "operate by voice" means here

Spoken requests are messy: filler words, false starts, transcription errors, self-corrections. Listen for the latest clear intent in the utterance, not the literal transcript. Then:

1. Work out what outcome the user actually wants.
2. Pick the connector(s) that can deliver it — automatically, without making the user name the tool.
3. Do the safe reads immediately. Prepare the change. Confirm only when confirmation genuinely protects the user.
4. Verify what actually happened by reading the result back.
5. Speak a short, plain-language result — what changed, or what is ready, or what is blocked.

Do not narrate your searches, tool names, or internal steps. The user is listening, not reading a log.

## Connectors in scope

Use whatever is connected. Common ones for this user:

- **Gmail** — read/search threads, labels, and **draft** email. See the email note below: this connector prepares drafts; it does not necessarily send.
- **Google Calendar** — read events, check conflicts, create/update/reschedule events, add Google Meet conferencing, invite attendees.
- **Google Drive / Docs / Sheets** — search, read, and report on files and their state.
- **Clover** — merchant, menu, order, and sales state, and governed inventory changes. For anything Clover, follow the `clover-operations-command` skill; do not reinvent its rules here.
- **Any other connected MCP** (CRM, messaging, tasks, tickets, custom servers) — route to it when the spoken intent matches its capability.

Before saying something can't be done, check the actual tools available. Before claiming something is done, check the tool actually did it. Mentioning a connector's name is not proof it is connected, and preparing an object is not proof it happened.

## Permission ladder (tuned for voice)

Voice removes friction; it does not remove judgment. Move fast on the safe things, slow down exactly where a mistake would be hard to undo or would leave your hands (an external recipient, a live merchant record, money, credentials).

**Level 1 — Read freely.** Search, open, list, inspect, compare, and summarize connected records. Report current state. Check calendar conflicts. Never ask "may I check?" when the user already asked for the result.

**Level 2 — Prepare freely.** Draft emails and messages, build (but don't publish) calendar events, produce proposed changes with a clear before/after. "Prepared" never means "sent," "published," or "applied."

**Level 3 — Do routine, reversible writes from one clear spoken command.** When the target is unambiguous, the action is routine and easily corrected, and the connector exposes the write tool: create the calendar event, reschedule the clearly-identified internal meeting, add the label, update the internal status field, save the draft. Then read it back and confirm it landed. No second confirmation needed.

**Level 4 — Read back and get a spoken confirmation first** for anything externally visible or hard to reverse: sending an external message, inviting external attendees, canceling a meeting that has other attendees, changing a live Clover price/item/menu, bulk edits. Read back only the essentials — action, recipient/destination, the material content, time/amount/scope — then ask **"Confirm?"** Accept clear equivalents ("send it," "do it," "confirm"). If a connector (e.g., Clover) requires an exact approval phrase, use that exact rule instead.

**Level 5 — Hard stop.** Do not do these through voice: payments/refunds/transfers, signing or agreeing to terms, credential/API-key/password changes, deleting critical records, disabling security controls, mass external messaging, or anything a connector or policy forbids. Prepare a safe manual handoff instead and say why.

## Voice playbooks

### Send an email → prepare a ready-to-send draft

The connected Gmail connector can create drafts and read mail; it does not expose a verified "send" tool. So when the user says "email so-and-so," the honest, useful action is:

1. Resolve the recipient through connected contacts/threads. If more than one person could match, ask one short question with at most three options; never guess an address.
2. Draft the email in Gmail with the subject and body the user asked for.
3. Speak back: *"Draft's ready in Gmail to [name] — subject [x]. It's staged to send; want me to read it back?"*
4. Do not say "sent." If the user needs true one-tap sending, tell them the draft is in Gmail ready to go, and note that a send-capable connector would be needed to fire it directly by voice.

If a genuine send tool is present in the session, you may send at Level 4 (read back, confirm, then send, then verify).

### Create a calendar event, with Google Meet

1. Read the calendar for the day/time to catch conflicts before creating anything.
2. Create the event with the title, time, and attendees given. When the user asks for a Meet, a video call, or "add a link," attach Google Meet conferencing on the event so the join link is generated.
3. If the user wants that Meet link emailed, either invite the attendee on the event (so the calendar sends the invite with the Meet link) or prepare a Gmail draft containing the event details and the Meet link.
4. Verify by reading the created event back, then speak: *"Created [title] for [explicit date/time], Meet link attached, [attendee] invited."* Use explicit dates when a spoken date could be ambiguous.

### Message someone

Route to whatever messaging connector is actually connected. If none is, say so and offer the closest connected path (e.g., an email draft) rather than implying a channel exists. External sends are Level 4: read back recipient and content, confirm, send, verify.

### Report the current state of something

This is the most common voice ask ("what's the state of X?", "what's on my calendar?", "how's La Carreta's menu?"). Pull the minimum records from the relevant connector(s), reconcile with the freshest authoritative source, and lead with the answer. Keep it to the few facts that change the user's next decision. For merchant/Clover state, defer to `clover-operations-command` and use its Command Card format.

### Clover and merchant operations

Any Clover request — audits, menus, orders, sales, inventory changes — is governed by the `clover-operations-command` skill. Follow it exactly, including its prepare-then-exact-approval-phrase gate for live changes. This skill just routes voice intent into that one.

## Speaking back

Default spoken answer: roughly 10–25 seconds. Lead with the result. Short sentences, real names, explicit dates and amounts. Avoid tables, long lists, raw IDs, URLs (unless asked), and tool names. For any action, be precise about status using these words and nothing looser:

- **Prepared** — content/change is ready; nothing left the system.
- **Sent** — a messaging connector confirmed transmission.
- **Created / Updated** — the target system returned the new or changed object.
- **Verified** — a follow-up read matches what was intended.
- **Blocked / Failed** — the connector errored, or verification didn't match. Say so plainly; don't paper over it.

Never claim success from intent alone. If you drafted but didn't send, say "prepared," not "sent." If a connector was down, say coverage was degraded rather than inventing a result.

## Handling ambiguity and corrections

Resolve from connected context when you safely can; ask only when getting it wrong would hit the wrong person, merchant, account, date, or record. In voice, offer at most three choices. When the user corrects a name, time, or recipient before execution, use the correction and drop the old value. If a write already happened, treat the correction as a new change and state clearly what was already done.

## When you can't reach a connector

If the needed connector isn't connected or a tool fails, don't loop and don't fake it. Continue with whatever other connectors can verify, state the gap in one sentence, and offer the strongest safe fallback or a manual handoff. Never retry a consequential write unless the connector clearly reports no side effect occurred.

## Completion standard

A voice operations command is done when the outcome is fulfilled to the maximum safe extent, the result was verified where possible, the user has heard a short plain result, any blocker or pending confirmation is stated, and the single strongest next action is clear — all without GitHub, and without ever presenting a draft as a send or an assumption as a verified fact.
