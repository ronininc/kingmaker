# Scripture Armor — Enterprise Seat-Scoping Addendum

**Status:** Design specification only. No code in this pass.  
**Date:** 16 November 2026 (America/Phoenix)  
**Source tree:** `~/armor-122-build`  
**This document lives at:** `docs/ENTERPRISE-SEAT-SCOPING-ADDENDUM.md`  
**Out of scope for this file:** the token-in-HTML dashboard auth fix, the adversarial pen-test re-run, notarization, push, Apple submission, sol-ghost, and the live vault.

This addendum specifies how Scripture Armor should distinguish a paid *individual* membership from an *enterprise* contract, how the individual device ceiling hands off to enterprise, and the deal and support rules that sit around that handoff. It is written so the behavior can be implemented later from this document alone.

Where this document describes intended policy, it says so. Where current code already does something related, it cites the path and states what the code actually does — including when that differs from the intended policy.

---

## 1. Purpose

Hoid sells two commercial shapes for Scripture Armor:

1. **Individual (paid membership) install.** One person, one email-bound membership, a hard ceiling of **10 devices**. No individual membership covers more than 10 devices.
2. **Enterprise contract.** A flat-price deal (quarterly or yearly, at the customer's choice of payment term) covering a **blanket seat pool**. This path is required for any deployment that needs more than 10 devices.

This addendum defines identity, seat-pool enforcement, billing-term recording, CRM entry, the auth / rate-limit contrast, the 10-device ceiling and 11th-device booking redirect, a required pre-deal meeting gate, and individual-member support isolation.

---

## 2. Code grounding — what exists today

Read this section before implementing. Several pieces of the intended design are **not** in the tree yet; a few nearby mechanisms **are**.

### 2.1 Individual identity (exists)

The paid individual version docks with Hoid's site using the install's **email**. After password entry and an eight-digit email OTP, the verified address is the account identity (`authenticatedEmail` in `scripture-armor/account-session.mjs`). Entitlement is looked up by that email:

- Client verifier: `scripture-armor/entitlement-client.mjs` → `POST https://www.ronininc.org/api/armor/entitlement` (schema `ronin.armor-entitlement/v1`).
- Server: `ronininc-crm-deploy/worker/armor-auth.ts` (`armorEntitlement`) reads `armor_entitlements` **where email = the session (or legacy application) email**.
- A current paid term is `starts_at` / `ends_at` on that row (`entitlementState` in `worker/armor-funnel.ts`). Individual membership in that funnel is **monthly** (`ARMOR_FUNNEL.termMonths = 1`, `$99` / month). There is no quarterly / yearly field on this row today.

That email-to-install binding **is** the individual identity, and it is the identity the in-flight dashboard auth work should carry so rate limiting can key off the known install rather than a bare HTML token.

Locally, each install also has a billing reservation id: a 256-bit `installationId` in a sibling `.installation/installation.json` (`scripture-armor/installation-metadata.mjs`). The code is explicit that this is **billing metadata, not a device certificate or physical-device attestation**. Capacity is reserved at `POST https://www.ronininc.org/api/armor/license/installations/reserve` *before* identity, terms, or vault creation (`dashboard.mjs` `/api/activate` → `account.reserveInstallation()`). A quota refusal leaves the vault uncreated.

### 2.2 Dashboard local auth and rate limits (current vs in-flight)

**Current shipped source in this tree** still serves the dashboard as a loopback HTTP server and embeds a process-local API token in the page (`const TOKEN=…` in `scripture-armor/dashboard-view.mjs`, minted in `scripture-armor/dashboard.mjs`). API calls send `x-scripture-armor-token`. Host and origin checks apply; there is **no** per-install or per-IP rate limiter on the dashboard API itself (only a single-flight `mutationBusy` lock).

A separate, in-flight hardening job is replacing that token-in-HTML TCP approach with a Unix socket and an OS-level UID check, and is intended to carry the install identity (the email binding, or an enterprise token — see §8) so throttles can key off it. **This addendum does not specify or alter that patch.** It only requires that whichever auth path ships can present the install identity described here.

**Existing remote throttles** (customer auth at ronininc.org, not the local dashboard) live in `ronininc-crm-deploy/worker/armor-auth.ts`:

- Login: 8 failures / 15 minutes per email, and 20 failures / 15 minutes per IP, returning 429 `"Too many sign-in attempts. Please wait."`
- Code issuance and verification have separate per-member windows.

Those counters are for sign-in abuse, not a general per-install per-IP API throttle.

### 2.3 Installation quota (exists — but it is 3, not 10)

A numeric installation cap **does** exist, on the **site/CRM worker**, not in the Armor client:

- Constant: `MAX_INSTALLATIONS = 3` in `ronininc-crm-deploy/worker/armor-auth.ts` (line 67).
- Enforcement: on `reserve` or `resume`, if there is no active row for this `installationId` (new install, or a revoked row being resumed), the worker counts `armor_installations` where `member_id = <this account>` and `status = 'active'`. If `n >= 3`, it returns **HTTP 409** with body `{ ok: false, error: "Installation limit reached." }` (line 475). Revoking an install frees a slot. The cap is per **member account** (the email-bound member), counting **active installation reservations**, not hardware serials.
- Tests in `ronininc-crm-deploy/test/armor-auth.test.mjs` assert that the **fourth** distinct reservation is 409.

**There is no `10` device or installation ceiling in Armor or CRM code today.** `docs/UNDEPLOYED-WORK-2026-11-04.md` lists “the >10-device enterprise-appointment boundary” as work still to verify — it is not implemented as a 10-cap in this tree. The **10-device individual ceiling in this addendum is policy to implement**, which includes raising or replacing the current `MAX_INSTALLATIONS = 3` cap. Do not ship documentation or UI that claims a 10-device limit is already enforced.

### 2.4 “Book an enterprise appointment” copy (partial — no redirect)

The Armor client already remaps **any** 409 from `reserve-installation` to the message:

> Installation limit reached. Book an enterprise appointment for additional capacity.

Citation: `scripture-armor/account-session.mjs` lines 89 and 95. `dashboard.mjs` `/api/activate` returns that 409 and message to the page and **does not** create identity or a paid-activation marker (`scripture-armor/test/installation-quota.test.mjs`, test `quota409 stops dashboard activation…`).

What is **not** implemented:

- The dashboard UI only surfaces the error string (`feedback(e.message)` in `dashboard-view.mjs`). It does **not** redirect, open a booking URL, or offer a “Book an appointment” action.
- The server 409 body is only `"Installation limit reached."` — no booking URL, flow id, or redirect target.
- `account-session.mjs` **refuses HTTP redirects** from the account API (`"Account redirects are refused. Access remains locked."`). A 3xx from ronininc.org is not a viable booking redirect.
- Checkout links already in the dashboard (`https://www.ronininc.org/armor/checkout?purpose=download` and `…?purpose=discord-membership`) are not an enterprise booking flow.
- A general Ronin site scheduler exists (calendar pop-up and `/build/` form; setup notes in `Projects/Ronininc.org/BOOKING-SETUP.md`). It is **not** wired as the Armor 11th-device or enterprise-appointment path. The concrete enterprise booking URL / endpoint is **TBD**.

### 2.5 What does not exist yet

- An **enterprise token** type, distinct from the individual email binding.
- A **seat pool** tied to an enterprise token.
- A **quarterly vs yearly** billing-term field on an enterprise record (individual terms are monthly `starts_at` / `ends_at` only).
- Automated CRM write-back of seat counts (and this pass forbids adding one).
- A formal pre-deal meeting stage in any Armor or license pipeline.
- An individual-member support tier, or any coded block on escalating an individual member to Hoid.

Legacy `seat_key` in `entitlement-client.mjs` is **not** an enterprise token. The CRM explicitly has no Armor seat-key store and refuses that credential (`armor-auth.ts`, “K Office seats are a different product”).

---

## 3. Identity model

### 3.1 Individual paid membership

| Field | Rule |
| --- | --- |
| Identity | The membership **email**, bound to this install after OTP. |
| Entitlement | One current paid term on that email (`armor_entitlements` keyed by email). |
| Install record | One `installationId` reservation under that member, counted toward the individual ceiling. |
| Ceiling | **10 devices** (see §4). “Device” in this policy is enforced through the existing installation-reservation path unless a later decision says otherwise (**TBD** if a stricter hardware-device signal is required; today’s code only counts reservation rows). |
| Rate-limit key | The already-known install identity (email binding), plus client IP — per-install per-IP. |

No individual membership may cover more than 10 devices. A need for an 11th device is automatically an enterprise deal; it is not sold, granted, or silently stacked onto the individual email.

### 3.2 Enterprise contract

| Field | Rule |
| --- | --- |
| Identity | **One enterprise token per enterprise deal**, issued after the required pre-deal meeting (§9) and Hoid’s sign-off. Distinct from any individual install email binding. |
| Seat representation | A **seat pool** (integer blanket count) tied to that enterprise token — **not** per-seat emails. |
| Billing term | Recorded on the same enterprise-token record: `quarterly` or `yearly`, as the customer chose to pay. |
| Installs | Each enterprise-scoped install presents the enterprise token (and its own local `installationId`) and draws from the seat pool. |
| Rate-limit / gate | The **enterprise token** gates the seat pool. Throttles key off that token (and install / IP as specified in §8), not off a personal membership email. |

An enterprise-scoped install must not be treated as a paid individual install that simply happens to share an email. If a person at an enterprise customer also holds a personal membership, those are separate identities and separate ceilings.

---

## 4. Individual 10-device ceiling and the 11th-device redirect

### 4.1 Policy

- **10 is the ceiling** for individual / paid membership installs.
- The cap is enforced on the individual auth / reservation path (the same path that today calls `/api/armor/license/installations/reserve` during activation, and that re-checks the reservation on licensed actions).
- While the active reservation count for that membership is **1–10**, the individual path proceeds as it does today (email binding, paid-term check, reserve/check/revoke/resume).
- The **11th** device-registration / reservation attempt is **not a silent rejection**. The auth / registration / activation path must **return or trigger a user-facing redirect into an enterprise booking flow** — “book an appointment” for enterprise — so the customer is routed to start an enterprise deal rather than left with a dead-end error.
- Crossing 10 devices **triggers the enterprise path**: that customer is no longer a candidate for a larger individual membership. Capacity beyond 10 is sold only as an enterprise contract, under its own enterprise token and seat pool, after the meeting gate in §9.

### 4.2 Implementation notes (to be built)

1. Change the worker cap from `MAX_INSTALLATIONS = 3` to the individual ceiling of **10**, and keep the cap scoped to individual (email-bound) members only. Enterprise-token installs must not be counted against this 10 (**TBD:** exact table / column split).
2. On the 11th reserve attempt for an individual member, do not only return `"Installation limit reached."`. Return a structured 409 (or equivalent) that the client can act on, including an explicit booking redirect payload. Because the client currently **refuses HTTP 3xx** from the account API, the redirect should be an **application-level** instruction (for example a `bookingUrl` / `next` field the dashboard honors), not a raw HTTP redirect. Exact URL and endpoint: **TBD**.
3. Dashboard / activation UI: on that response, **route the user to the enterprise booking flow** (navigate or open the booking URL). Do not only print the error in `#feedback`.
4. Existing client copy (“Book an enterprise appointment for additional capacity.”) can remain as supporting text; it is not a substitute for the redirect.
5. Until the cap is actually 10 and the redirect is wired, treat both as **unimplemented policy**. Tests today expect a 409 on the *fourth* reservation.

### 4.3 What “rejected or gated” means

The 11th individual device is **gated**: the individual membership does not gain an 11th seat, activation must not create a new vault or paid-activation marker for that overflow install (this fail-closed part already exists on any reserve 409), and the user is **sent to book an enterprise appointment**. It is not a silent drop, and it is not an automatic entitlement upgrade.

---

## 5. Seat-pool enforcement (enterprise)

- Hoid sells a **flat price** for the contract (quarterly or yearly).
- From that flat price he charges for a **blanket number of seats**.
- The pool is stored on the enterprise token: `seatPoolSize` (or equivalent) and `seatsInUse` (count of active enterprise-scoped installation reservations against that token).
- Enforcing the pool means: a new enterprise install is admitted only while `seatsInUse < seatPoolSize`. Admission is by **enterprise token**, not by issuing or collecting a per-seat email.

**TBD — do not invent policy in code until decided:**

- Behavior when the seat pool is exceeded (wait-list, 409 plus a “contact your account path” message, option to expand the pool after another meeting, etc.). This is **not** the individual 11th-device booking redirect; that redirect is only for overflowing an *individual* membership.
- Whether a revoked or retired enterprise install immediately frees a pool slot (today, revoking an *individual* reservation does free a slot).
- Whether seats are concurrent devices, named people, or installation reservations.

---

## 6. Billing-term field

Record the customer’s payment term **on the enterprise token record**, not on each seat and not on an individual’s monthly entitlement row.

| Field | Allowed values | Notes |
| --- | --- | --- |
| `billingTerm` | `quarterly` \| `yearly` | The customer’s choice of how they pay the flat enterprise price. |
| Term window | start / end timestamps | **TBD** whether these follow the same lapse rule as individual membership (service remains; improvements lock when the term ends — see `entitlementState` in `armor-funnel.ts`). |

Do not reuse the individual monthly `addTerm()` path (`termMonths: 1`) as a stand-in for quarterly or yearly enterprise terms.

---

## 7. CRM data entry — manual only (this pass)

Hoid inputs enterprise seat data into his CRM **himself**.

- **No automated CRM integration in this pass.** Do not add workers, webhooks, or dashboard calls that create, update, or sync enterprise tokens, seat-pool counts, billing terms, or meeting / sign-off records in the CRM.
- The existing dashboard “Submit a request to Ronin Inc” path (`submit-request.mjs` / CRM intake) is a **product-request intake**. It is not enterprise seat provisioning and must not be extended into one here.
- Suggested manual fields Hoid would enter (for the implementer’s CRM screen later, not built now): enterprise customer name, enterprise token id, seat-pool size, billing term (quarterly / yearly), contract start, meeting-held / Hoid-sign-off flags, and notes.

**TBD:** the exact CRM object shape and where Hoid types it. This addendum only requires that implementation of §§3–6 not depend on an automated CRM write.

---

## 8. Auth and rate-limit path — individual vs enterprise

| | Individual paid install | Enterprise-scoped install |
| --- | --- | --- |
| What gates access | The **email-to-install binding** plus a current paid individual term | The **enterprise token**, which gates the **seat pool** |
| Ceiling | 10 devices; 11th attempt redirects to enterprise booking (§4) | The contract’s seat pool (§5); overflow policy TBD |
| Rate-limit key | Per-install per-IP, keyed off the known install identity (email binding), not a bare token or a bare IP counter | Per-install per-IP, keyed off the **enterprise token** (and the install id / IP). Not the employee’s personal membership email, if any |
| Local dashboard auth | Same in-flight direction for both: Unix socket + UID check so the page never holds a secret; the auth path must still **carry** the install identity (email binding or enterprise token) so the throttle can use it | Same |
| Entitlement check | `POST /api/armor/entitlement` against the email term | **TBD** receipt shape for enterprise (must be distinct from `ronin.armor-entitlement/v1` email membership, or an explicit `scope: enterprise` on a new schema). Do not silently accept an individual email receipt as enterprise capacity |

Licensed local actions (activation, scan, clean, review) should fail closed if the presented identity does not match the install’s scope.

---

## 9. Pre-deal meeting — formal gate

Before any enterprise contract is finalized, a **meeting is a required stage** in the enterprise deal pipeline. It is not optional, and it is not a courtesy call after the paper is signed.

The meeting has two purposes, both mandatory:

1. **Team insulation.** It keeps Hoid’s team insulated from his personal life and personal relationships. No team member is pulled into personal matters in the course of an enterprise deal.
2. **Owner sign-off.** It ensures every enterprise deal reaches Hoid’s desk first, for his sign-off, before the contract is finalized and before an enterprise token or seat pool is issued.

Pipeline order (design):

1. Individual overflow or a direct enterprise inquiry is routed to the enterprise booking flow (§4.2).
2. **Required pre-deal meeting** is held.
3. **Hoid’s sign-off** is recorded.
4. Only then: contract finalization, manual CRM entry of the seat pool and billing term (§7), and issuance of the one enterprise token for that deal.

**TBD, not present in code:** scheduling mechanism (whether the existing Ronin site scheduler is reused, a dedicated enterprise-appointment endpoint, or a manual calendar), who attends besides Hoid, how “meeting held” and “sign-off” are recorded, and what happens if a party tries to skip the meeting (the policy is: no token, no contract finalization).

---

## 10. Individual membership isolation

Hoid’s counterparties for Scripture Armor, at his desk, are **enterprise, industry, and large-company** contacts only.

- **Individual (“member”) support and contact does not reach Hoid.** It routes through a **support tier** that handles individual memberships.
- Any escalation path from an individual member **to Hoid is blocked or redirected** — either back to that support tier, or, when the member’s need is capacity beyond 10 devices, into the **enterprise booking flow** (§4), which then goes through the meeting gate (§9) rather than through ad-hoc personal contact.
- Enterprise deal communication, after the meeting gate, is the path that may reach Hoid for sign-off and ongoing enterprise-counterpart conversation.

**TBD, not present in Armor or license code:** the support-tier tool, inboxes, or staff roster; the concrete block/redirect implementation (help-desk rules, email routing, in-app “Contact” targets); and any exception process. Do not assume a support system already enforces this isolation. The rule in this addendum is the policy to implement.

---

## 11. Open questions (explicit TBDs)

Do not fill these with invented defaults at implementation time; they need a decision:

1. Raise `MAX_INSTALLATIONS` from **3** to **10** for individual members only — confirm production rollout timing, and whether any current member already at the old cap is grandfathered.
2. Whether the “10-device” ceiling is exactly “10 active installation reservations” (today’s mechanism) or requires a stronger device-binding signal.
3. The **enterprise booking URL / flow endpoint**, and the application-level 409 payload the client will honor (HTTP 3xx is not usable with the current account client).
4. Seat-pool overflow behavior for an already-signed enterprise contract.
5. Enterprise token **rotation**, loss, and revocation.
6. **Offline grace** for entitlement / seat-pool checks when ronininc.org is unreachable (individual entitlement currently fails closed on non-200).
7. Enterprise entitlement receipt schema, and how an install is marked individual vs enterprise at activation.
8. Meeting scheduling mechanism, attendees, and how meeting-held + Hoid sign-off are recorded (manual CRM fields vs later tooling).
9. Support-tier routing and the technical block on individual-to-Hoid escalation.
10. Per-install per-IP throttle thresholds and 429 behavior for the dashboard / socket auth path (not specified here; fold into the separate auth hardening job).

---

## 12. Suggested touchpoints for a later implementation (do not change in this pass)

| Area | Likely files |
| --- | --- |
| Individual cap and 11th-device booking payload | `ronininc-crm-deploy/worker/armor-auth.ts`; tests in `test/armor-auth.test.mjs` |
| Client 409 handling and UI redirect | `scripture-armor/account-session.mjs`, `scripture-armor/dashboard.mjs`, `scripture-armor/dashboard-view.mjs`; tests in `scripture-armor/test/installation-quota.test.mjs` |
| Entitlement contrast | `scripture-armor/entitlement-client.mjs`; `worker/armor-funnel.ts` / `armor-auth.ts` |
| Local install identity | `scripture-armor/installation-metadata.mjs` (unchanged role: billing reservation id) |
| Dashboard auth identity carriage | In-flight socket + UID work in `dashboard.mjs` / `dashboard-view.mjs` — not this addendum |

No files were modified to produce this document other than adding this file under `docs/`.
