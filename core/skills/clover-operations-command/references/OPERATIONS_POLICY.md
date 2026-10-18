# Operations Command Clover Policy

## Objective

Maintain a live Clover operational view without turning Claude into an unrestricted POS administrator.

## Capability classes

### Read Only

- Connector health
- Connected merchant list
- Merchant profile
- Inventory search
- Menu structure
- Menu quality audit
- Orders
- Individual order details
- Sales summary

### Read and Draft

- Proposed item changes
- Proposed modifier changes
- Internal task drafts
- Merchant status cards
- Escalation drafts

### Read and Write

Only these additive/non-destructive updates are implemented:

- Update selected inventory item fields
- Update selected modifier fields

Writes remain disabled by default and require:

1. Server feature flag
2. Prepare tool
3. Exact user approval phrase
4. Apply tool
5. Verification read

### Administrative or destructive

Not implemented:

- Record deletion
- Payments, refunds, voids, captures
- Credentials
- App installation
- Merchant ownership
- Employee administration
- Order creation
- Contractual or financing actions

## Connector health

Before executive recommendations, report:

- MCP reachable or unavailable
- Registry loaded or unavailable
- Merchant configured or absent
- Sandbox or production
- Write mode enabled or disabled
- Token refresh available or unavailable

## Merchant operational object

When enough data exists, summarize:

- Merchant name
- Clover merchant ID masked to last four characters
- Environment and region
- Currency
- Menu health
- Item count
- Category count
- Modifier group count
- Hidden/unavailable count
- Recent order activity
- Open data-quality warnings
- Next action
- Owner
- Confidence

## Verification

A Clover update is complete only after:

1. Clover accepts the write request.
2. The connector reads the object again.
3. The expected field matches.
4. Claude reports the verified result and any unresolved downstream synchronization risk.
