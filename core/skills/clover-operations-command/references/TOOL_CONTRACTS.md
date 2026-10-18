# Clover MCP Tool Contracts

## Read tools

### `clover_health`

Returns connector state without secrets.

### `clover_list_merchants`

Returns configured merchant keys, display names, regions, environments, and masked merchant IDs.

### `clover_get_merchant`

Input:

- `merchant`: configured key or unique display-name match

Returns a safe merchant profile from Clover.

### `clover_search_inventory`

Inputs:

- `merchant`
- `query`
- `limit`
- `offset`
- `include_hidden`

Returns matching inventory items. Search is applied locally to the retrieved page.

### `clover_get_menu_structure`

Inputs:

- `merchant`
- `max_records`

Returns compact counts and lists for items, categories, modifier groups, and modifiers.

### `clover_audit_menu`

Inputs:

- `merchant`
- `require_bilingual`
- `max_records`

Returns verified issues and heuristic review candidates.

### `clover_get_orders`

Inputs:

- `merchant`
- `start_iso`
- `end_iso`
- `limit`
- `offset`
- `state`

Returns compact order records for an explicit time range.

### `clover_get_order`

Inputs:

- `merchant`
- `order_id`

Returns one expanded order.

### `clover_sales_summary`

Inputs:

- `merchant`
- `start_iso`
- `end_iso`
- `max_orders`

Returns order and payment totals with completeness warnings.

## Prepare tools

### `clover_prepare_inventory_update`

Reads the current item and returns:

- Current values
- Allowed proposed patch
- Exact approval phrase
- No external side effect

Allowed item fields:

- `name`
- `alternateName`
- `price`
- `available`
- `hidden`

### `clover_prepare_modifier_update`

Reads the current modifier and returns:

- Current values
- Allowed proposed patch
- Exact approval phrase
- No external side effect

Allowed modifier fields:

- `name`
- `price`
- `available`

## Apply tools

### `clover_apply_inventory_update`

Requires:

- `ENABLE_CLOVER_WRITES=true`
- Exact item approval phrase
- Allowed fields only

The server writes, re-reads, and returns verification.

### `clover_apply_modifier_update`

Requires:

- `ENABLE_CLOVER_WRITES=true`
- Exact modifier approval phrase
- Allowed fields only

The server writes, re-reads, and returns verification.

## Intentionally absent tools

No tool exists for deletion, payment mutation, refunds, captures, order creation, credential changes, employee administration, or financing.
