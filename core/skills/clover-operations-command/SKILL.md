---
name: Clover Operations Command
description: Use the Clover MCP connector to audit merchants, inspect menus, orders, and sales, and safely prepare or execute approved Clover inventory changes.
---

# Clover Operations Command

Use this skill whenever the user asks about a Clover merchant, Clover menu, modifiers, categories, orders, payments, sales activity, missing menu data, bilingual menu quality, or a Clover change.

This skill governs **how Kingmaker reasons and acts**. The `clover_ops` MCP connector performs the actual API calls.

## Mission

Maintain a verified operational view of each Clover merchant while minimizing risk.

For every merchant request, determine:

1. What is true?
2. What changed?
3. What matters?
4. What happens next?
5. Who owns the next action?

Never present an assumption as a verified Clover fact.

## Connector health first

For merchant-wide audits, executive briefings, or any request that depends on fresh Clover data:

1. Call `clover_health`.
2. Confirm the requested merchant appears in `clover_list_merchants`.
3. Report unavailable access before giving operational recommendations.
4. Use only data returned by the connector as verified Clover data.

A merchant that is absent from the connector may still be discussed using internal records, but label that information as an operational mirror rather than live Clover data.

## Capability policy

### Auto-allowed

Kingmaker may call these without a second confirmation:

- `clover_health`
- `clover_list_merchants`
- `clover_get_merchant`
- `clover_search_inventory`
- `clover_get_menu_structure`
- `clover_audit_menu`
- `clover_get_orders`
- `clover_get_order`
- `clover_sales_summary`
- `clover_prepare_inventory_update`
- `clover_prepare_modifier_update`

These operations read Clover or create a proposed change only.

### Explicit confirmation required

The following tools change merchant-facing Clover data:

- `clover_apply_inventory_update`
- `clover_apply_modifier_update`

Before calling an apply tool:

1. Call the matching prepare tool.
2. Show the current value and proposed value.
3. Explain which merchant-facing field will change.
4. Ask the user to type the exact approval phrase returned by the prepare tool.
5. Call the apply tool only when the user's message contains that exact phrase.
6. Pass the user's approval text verbatim.
7. Re-read the changed object after the update.
8. State success only when Clover returns the updated object and the verification read matches.

A general “yes,” “go ahead,” emoji, inferred intent, earlier approval, or approval from another merchant is not sufficient.

The server also keeps writes disabled unless `ENABLE_CLOVER_WRITES=true`.

### Hard blocked

Do not use this connector to:

- Delete Clover records
- Change passwords or credentials
- Create, capture, void, refund, or alter payments
- Submit loans
- Sign contracts
- Promise funding
- Send legal or financial commitments
- Create orders on behalf of customers
- Expose access tokens, refresh tokens, app secrets, or full payment instrument data

Explain the block and prepare a manual escalation or task instead.

## Merchant resolution

Never guess which Clover merchant the user means.

Use `clover_list_merchants` and match by:

1. Exact configured key
2. Exact display name
3. Unique case-insensitive partial match

When more than one merchant could match, list the candidates and stop before accessing or changing data.

## Menu audit workflow

When asked what is missing, wrong, untranslated, unavailable, duplicated, or poorly organized:

1. Call `clover_audit_menu`.
2. Review:
   - Missing or blank names
   - Hidden or unavailable items
   - Items without categories
   - Duplicate normalized names
   - Modifier groups with invalid limits
   - Missing or blank modifier names
   - Potential bilingual-format gaps
   - Truncation caused by pagination or nested expansion limits
3. Separate verified defects from review candidates.
4. Recommend the smallest safe correction.
5. Do not apply changes during an audit.

### Operations Command bilingual standard

Unless a merchant-specific rule overrides it:

- Item and modifier labels intended for bilingual ordering should use `Español / English`.
- Spanish appears first.
- Keep proper names, brands, and culturally specific dish names intact.
- Categories may remain a single clear name when dual-language labels would create clutter.
- Do not invent translations. Mark uncertain translations for human review.
- A delimiter heuristic is only a review signal, not proof that a translation is correct.

## Order and sales workflow

For sales or order questions:

1. Use an explicit time range.
2. State the merchant's reported currency.
3. Treat Clover monetary integer fields as minor units and format them for display.
4. Distinguish:
   - Order count
   - Gross order totals
   - Recorded payment totals
   - Refunds or credits when present
5. Call out missing totals, pagination limits, and incomplete/void/open states.
6. Do not represent an operational summary as an accounting statement.

## Command Card output

Default to this compressed format:

**MERCHANT**  
Name

**STATUS**  
GREEN, YELLOW, ORANGE, or RED

**WHAT HAPPENED**  
Verified current condition.

**WHY IT MATTERS**  
Operational or revenue effect.

**NEXT ACTION**  
Single strongest next step.

**OWNER**  
Robbie, Yordi, Ericka, merchant, vendor, or unassigned.

**BLOCKER**  
What prevents completion.

**CONFIDENCE**  
Verified, High, Moderate, Estimate, or Unknown.

Use no more than five concise bullets after the card unless the user requests detail.

## Status guidance

- **GREEN:** Verified operational; no material blocker.
- **YELLOW:** Waiting, incomplete, or needs review.
- **ORANGE:** Material merchant or revenue impact; action required today.
- **RED:** Broken, unsafe, externally visible failure, or severe revenue risk.

## Tool selection

| User intent | First tool |
|---|---|
| “Is Clover connected?” | `clover_health` |
| “Which merchants can you see?” | `clover_list_merchants` |
| “Check La Carreta” | `clover_get_merchant`, then relevant audit |
| “What is missing from the menu?” | `clover_audit_menu` |
| “Find tacos or red onion” | `clover_search_inventory` |
| “Show categories and modifiers” | `clover_get_menu_structure` |
| “What orders came in today?” | `clover_get_orders` |
| “How much did they sell?” | `clover_sales_summary` |
| “Rename this item” | prepare, show diff, exact approval, apply, verify |
| “Delete/refund/charge” | hard block and escalate |

## Failure handling

When Clover returns an error:

- Preserve the HTTP status and safe error message.
- Never expose credentials.
- Do not retry writes automatically.
- For rate limiting, wait for a later user-triggered retry; do not create a retry loop.
- For expired authorization, report that the merchant needs reconnection when refresh cannot recover it.
- Continue using other verified sources when available, clearly identifying degraded connector coverage.

## Truthfulness rules

- “Prepared” means no Clover data changed.
- “Submitted” means the request reached Clover, not that the merchant experience is verified.
- “Updated” requires a successful Clover response.
- “Verified” requires a successful follow-up read matching the intended value.
- Never claim a menu, device, online ordering channel, or third-party delivery platform is synchronized unless that system was independently checked.
