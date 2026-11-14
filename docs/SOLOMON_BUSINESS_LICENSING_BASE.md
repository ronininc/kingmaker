# Solomon — Business & Licensing Base

The operative model for how Solomon is owned, sold, and licensed, ingested from the two draft agreements
(2026-08-20). This is the base the running system honors. **Not legal advice** — it mirrors the draft term
sheets so the system produces the artifacts they rely on; a licensed attorney (and tax advisor) forms the
entity and reviews the contracts before anyone signs. Source docs live in the TSS repo under `legal/`
(`Solomon-Enterprises-LLC-JV-Term-Sheet.html`, `OroTalent-Agent-Residual-Agreement.html`).

## The two agreements

**1. Solomon Enterprises LLC — 50/50 Joint Venture** (the ownership + commercialization of Solomon)
- **Members:** Ronin Inc (Robbie) **50%** + Orosolu LLC (Yordi) **50%**. Profits/losses **50/50** (except
  dissented actions, §7.3).
- **IP:** Ronin **assigns the Solomon system** — software, source, models, weights, tooling, associated IP —
  **into the Company**, which owns it outright. Orosolu's consideration = its funding of Solomon + 50%
  capital; Ronin's = the assignment.
- **Commercialization:** **deal-by-deal / per-merchant.** For each merchant the members negotiate what
  Solomon does + the residual/net split (customizable per merchant), recorded on a **Deal Schedule**.
- **Major decisions** (sell the Company; sell or **license Solomon to a third party**; new owner; debt;
  dissolve) require **both members** (§9.2).
- **Governing law:** Arizona; pass-through K-1s. Binding pre-signature: **§7, §12, §13**.

**2. OroTalent × Ronin — Work Commission & Payment SOP** (Hector commissions work FROM Ronin)
- **Parties:** OroTalent (Hector's LLC) **commissions**; Ronin Inc (Robbie) is an **independent outside
  contractor**. Separate from the JV and from Orosolu's payment-processing business.
- **Mode A — websites:** flat **$250 / site**, one-time, no residual.
- **Mode B — complex work:** a **case-by-case residual** Ronin charges (%, recurring, or per-job), set on a
  per-job **Work Schedule**. Ronin **retains ownership** of the underlying build; OroTalent is **licensed
  while the residual is paid**; if it stops, the use right ends.
- **Authority:** OroTalent decides **WHAT** (deliverable/scope); Ronin decides **HOW** (its methods/tools,
  including whether it uses its own Solomon/Kingmaker tooling).

## Ownership map (the boundary the system enforces)

```
Solomon system ───────────▶ owned by Solomon Enterprises LLC   (Ronin 50% + Orosolu 50%)
Kingmaker + everything else Ronin makes ─▶ 100% Ronin — UNCHAINED, outside the LLC, no non-compete
```

- **Only Solomon** goes into the Company. **Kingmaker, and every other product/tool/engagement Ronin
  creates, stays 100% Ronin** and outside the LLC (§5). This is why Kingmaker is a separate repo and the
  diode keeps it separate at runtime.

## What the contracts wire into the system

- **Record of Dissent (§7.1a) — BUILT.** `contracts/record-of-dissent.ts` + `test/record-of-dissent.test.ts`.
  Kingmaker is the contractual **system-of-record** for a member's dissent: a **timestamped, contemporaneous
  verdict logged before an action proceeds** ("I don't like it, but he can do it") is **valid evidence of a
  dissent**. The record encodes §7.2 (the other member proceeds at **sole** cost/risk/liability and
  indemnifies the dissenter, its owner personally, and the Company), §7.3 (economics → the proceeding
  member's own account), and §7.4 (a dissent **never blocks** — no paralysis). A record made *after* the
  action is **not** §7.1a evidence.
- **Federation / Vault ownership — FLAG for reconciliation.** The Vault (`contracts/vault-registry.ts`)
  marks entries `proprietaryToRonin: true`. But under the JV, **Solomon's IP belongs to Solomon Enterprises
  LLC (50/50)**, not solely to Ronin. Capabilities Solomon acquires and graduates (via the acquisition loop)
  are **Solomon** capabilities → owned by the Company. **Before any such capability is canonized in the
  Vault, its ownership/watermark must be reconciled with the JV** (Company-owned, not Ronin-sole). Kingmaker
  itself and its own capabilities remain 100% Ronin. *(Do not silently canonize a Solomon-derived ability as
  Ronin-proprietary — that would contradict §4/§10.)*
- **Deal-by-deal residuals (§6) — data model, not yet built.** Each merchant deal = a Deal Schedule (scope,
  residual net, term, source). A future `deal-schedule` contract can encode this the way the queue/vault
  contracts do.
- **Solomon-in-OroTalent-work (§4.4) — cross-contract guard.** If work Ronin does for OroTalent **materially
  uses Solomon** (the Company's asset), it must be reconciled with the JV terms — Ronin does not solely own
  Solomon. The system should flag any OroTalent deliverable that pulls in a Company-owned Solomon capability.

## Open items (for counsel — do not auto-resolve)

Management/control model (Managing Member vs equal vs split-by-domain); dissent economics (own-account vs a
reduced objector royalty); buy-sell + valuation and a possible **Ronin right-of-first-refusal on Solomon** at
dissolution; the exact scope of "the Solomon system" vs Ronin's retained general tooling; how OroTalent/Hector
deals reconcile with the Company's model; governing state + tax treatment; and the **Vault-vs-JV ownership
caveat** above. Draft v0.1 — the JV supersedes the earlier Funding & Profit-Share proposal.
