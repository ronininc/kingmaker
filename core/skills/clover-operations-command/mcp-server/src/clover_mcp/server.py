from __future__ import annotations

import os
import re
from datetime import datetime, timezone
from typing import Any

from mcp.server.fastmcp import FastMCP

from .clover_client import CloverAPIError, CloverClient
from .config import MerchantConfig, MerchantRegistry


HOST = os.getenv("HOST", "0.0.0.0")
PORT = int(os.getenv("PORT", "8000"))
WRITES_ENABLED = os.getenv("ENABLE_CLOVER_WRITES", "false").strip().lower() == "true"

registry = MerchantRegistry.from_env()
client = CloverClient(registry)

mcp = FastMCP(
    "Clover Operations Command",
    host=HOST,
    port=PORT,
    stateless_http=True,
    json_response=True,
)

READ_ONLY = {
    "readOnlyHint": True,
    "destructiveHint": False,
    "idempotentHint": True,
    "openWorldHint": True,
}
DRAFT_ONLY = {
    "readOnlyHint": True,
    "destructiveHint": False,
    "idempotentHint": True,
    "openWorldHint": True,
}
GUARDED_WRITE = {
    "readOnlyHint": False,
    "destructiveHint": False,
    "idempotentHint": True,
    "openWorldHint": True,
}

ITEM_ALLOWED_FIELDS = {"name", "alternateName", "price", "available", "hidden"}
MODIFIER_ALLOWED_FIELDS = {"name", "price", "available"}


def _merchant(query: str) -> MerchantConfig:
    return registry.resolve(query)


def _result(data: Any) -> dict[str, Any]:
    return {"ok": True, "data": data}


def _error(exc: Exception) -> dict[str, Any]:
    if isinstance(exc, CloverAPIError):
        return {"ok": False, **exc.safe_dict()}
    return {"ok": False, "error": str(exc)}


def _elements(value: Any) -> list[dict[str, Any]]:
    if isinstance(value, dict):
        items = value.get("elements")
        if isinstance(items, list):
            return [x for x in items if isinstance(x, dict)]
    if isinstance(value, list):
        return [x for x in value if isinstance(x, dict)]
    return []


def _parse_iso_ms(value: str) -> int:
    candidate = value.strip()
    if candidate.endswith("Z"):
        candidate = candidate[:-1] + "+00:00"
    parsed = datetime.fromisoformat(candidate)
    if parsed.tzinfo is None:
        raise ValueError("ISO time must include a timezone offset or Z.")
    return int(parsed.astimezone(timezone.utc).timestamp() * 1000)


def _minor_to_decimal(amount: int | float | None) -> float | None:
    if amount is None:
        return None
    return round(float(amount) / 100.0, 2)


def _compact_item(item: dict[str, Any]) -> dict[str, Any]:
    return {
        key: item.get(key)
        for key in (
            "id",
            "name",
            "alternateName",
            "price",
            "available",
            "hidden",
            "deleted",
            "modifiedTime",
        )
        if key in item
    } | {
        "categories": [
            {"id": c.get("id"), "name": c.get("name")}
            for c in _elements(item.get("categories"))
        ]
    }


def _compact_modifier(modifier: dict[str, Any]) -> dict[str, Any]:
    group = modifier.get("modifierGroup") or {}
    return {
        "id": modifier.get("id"),
        "name": modifier.get("name"),
        "price": modifier.get("price"),
        "available": modifier.get("available"),
        "deleted": modifier.get("deleted"),
        "modifiedTime": modifier.get("modifiedTime"),
        "modifier_group_id": group.get("id") if isinstance(group, dict) else None,
    }


def _looks_bilingual(text: str | None) -> bool:
    if not text:
        return False
    return bool(re.search(r"\s(?:/|\||—|–)\s", text))


async def _fetch_menu(
    merchant: MerchantConfig,
    max_records: int,
) -> dict[str, Any]:
    cap = max(1, min(max_records, 5000))
    mid = merchant.merchant_id

    items, items_truncated = await client.get_all(
        merchant,
        f"/v3/merchants/{mid}/items",
        base_params=[("expand", "categories")],
        max_records=cap,
    )
    categories, categories_truncated = await client.get_all(
        merchant,
        f"/v3/merchants/{mid}/categories",
        max_records=cap,
    )
    groups, groups_truncated = await client.get_all(
        merchant,
        f"/v3/merchants/{mid}/modifier_groups",
        max_records=cap,
    )

    modifiers: list[dict[str, Any]] = []
    modifiers_truncated = False
    remaining = cap
    for group in groups:
        group_id = group.get("id")
        if not group_id or remaining <= 0:
            modifiers_truncated = True
            break
        group_modifiers, group_truncated = await client.get_all(
            merchant,
            f"/v3/merchants/{mid}/modifier_groups/{group_id}/modifiers",
            max_records=remaining,
        )
        for modifier in group_modifiers:
            if "modifierGroup" not in modifier:
                modifier["modifierGroup"] = {"id": group_id}
        modifiers.extend(group_modifiers)
        remaining = cap - len(modifiers)
        modifiers_truncated = modifiers_truncated or group_truncated

    return {
        "items": items,
        "categories": categories,
        "modifier_groups": groups,
        "modifiers": modifiers,
        "truncated": {
            "items": items_truncated,
            "categories": categories_truncated,
            "modifier_groups": groups_truncated,
            "modifiers": modifiers_truncated,
        },
    }


@mcp.tool(annotations=READ_ONLY)
async def clover_health() -> dict[str, Any]:
    """Report connector configuration and safety state without exposing secrets."""
    return _result(
        {
            "status": "configured" if registry.list_public() else "no_merchants",
            "merchant_count": len(registry.list_public()),
            "writes_enabled": WRITES_ENABLED,
            "transport": "streamable-http",
            "endpoint": "/mcp",
        }
    )


@mcp.tool(annotations=READ_ONLY)
async def clover_list_merchants() -> dict[str, Any]:
    """List Clover merchants configured for this connector without exposing credentials."""
    return _result(registry.list_public())


@mcp.tool(annotations=READ_ONLY)
async def clover_get_merchant(merchant: str) -> dict[str, Any]:
    """Get a Clover merchant profile by configured key or unique display-name match."""
    try:
        selected = _merchant(merchant)
        data = await client.request(
            selected,
            "GET",
            f"/v3/merchants/{selected.merchant_id}",
        )
        safe = {
            key: data.get(key)
            for key in (
                "id",
                "name",
                "currency",
                "timezone",
                "address",
                "phoneNumber",
                "website",
                "createdTime",
            )
            if key in data
        }
        safe["connector"] = selected.public_dict()
        return _result(safe)
    except Exception as exc:
        return _error(exc)


@mcp.tool(annotations=READ_ONLY)
async def clover_search_inventory(
    merchant: str,
    query: str = "",
    limit: int = 100,
    offset: int = 0,
    include_hidden: bool = True,
) -> dict[str, Any]:
    """Search one Clover inventory page by item name, alternate name, or ID."""
    try:
        selected = _merchant(merchant)
        limit = max(1, min(limit, 1000))
        offset = max(0, offset)
        payload = await client.request(
            selected,
            "GET",
            f"/v3/merchants/{selected.merchant_id}/items",
            params=[
                ("limit", limit),
                ("offset", offset),
                ("expand", "categories"),
            ],
        )
        items = _elements(payload)
        needle = query.strip().casefold()
        if needle:
            items = [
                item
                for item in items
                if needle in str(item.get("id", "")).casefold()
                or needle in str(item.get("name", "")).casefold()
                or needle in str(item.get("alternateName", "")).casefold()
            ]
        if not include_hidden:
            items = [item for item in items if not item.get("hidden", False)]

        return _result(
            {
                "merchant": selected.display_name,
                "query": query,
                "page_limit": limit,
                "offset": offset,
                "matches": [_compact_item(item) for item in items],
                "warning": (
                    "Search is applied to this retrieved page, not the entire inventory."
                    if query
                    else None
                ),
            }
        )
    except Exception as exc:
        return _error(exc)


@mcp.tool(annotations=READ_ONLY)
async def clover_get_menu_structure(
    merchant: str,
    max_records: int = 1000,
) -> dict[str, Any]:
    """Return compact Clover menu items, categories, modifier groups, and modifiers."""
    try:
        selected = _merchant(merchant)
        menu = await _fetch_menu(selected, max_records)
        return _result(
            {
                "merchant": selected.display_name,
                "counts": {
                    "items": len(menu["items"]),
                    "categories": len(menu["categories"]),
                    "modifier_groups": len(menu["modifier_groups"]),
                    "modifiers": len(menu["modifiers"]),
                },
                "items": [_compact_item(x) for x in menu["items"]],
                "categories": [
                    {
                        "id": x.get("id"),
                        "name": x.get("name"),
                        "sortOrder": x.get("sortOrder"),
                    }
                    for x in menu["categories"]
                ],
                "modifier_groups": [
                    {
                        "id": x.get("id"),
                        "name": x.get("name"),
                        "minRequired": x.get("minRequired"),
                        "maxAllowed": x.get("maxAllowed"),
                        "showByDefault": x.get("showByDefault"),
                    }
                    for x in menu["modifier_groups"]
                ],
                "modifiers": [_compact_modifier(x) for x in menu["modifiers"]],
                "truncated": menu["truncated"],
            }
        )
    except Exception as exc:
        return _error(exc)


@mcp.tool(annotations=READ_ONLY)
async def clover_audit_menu(
    merchant: str,
    require_bilingual: bool = False,
    max_records: int = 1000,
) -> dict[str, Any]:
    """Audit Clover menu completeness and flag bilingual-format review candidates."""
    try:
        selected = _merchant(merchant)
        menu = await _fetch_menu(selected, max_records)
        items = menu["items"]
        groups = menu["modifier_groups"]
        modifiers = menu["modifiers"]

        missing_item_names = [
            {"id": x.get("id")} for x in items if not str(x.get("name") or "").strip()
        ]
        hidden_items = [
            {"id": x.get("id"), "name": x.get("name")}
            for x in items
            if x.get("hidden") is True
        ]
        unavailable_items = [
            {"id": x.get("id"), "name": x.get("name")}
            for x in items
            if x.get("available") is False
        ]
        uncategorized_items = [
            {"id": x.get("id"), "name": x.get("name")}
            for x in items
            if not _elements(x.get("categories"))
        ]

        names: dict[str, list[dict[str, Any]]] = {}
        for item in items:
            normalized = re.sub(
                r"\s+", " ", str(item.get("name") or "").strip().casefold()
            )
            if normalized:
                names.setdefault(normalized, []).append(
                    {"id": item.get("id"), "name": item.get("name")}
                )
        duplicate_names = [
            records for records in names.values() if len(records) > 1
        ]

        invalid_group_limits = []
        for group in groups:
            min_required = group.get("minRequired")
            max_allowed = group.get("maxAllowed")
            if (
                isinstance(min_required, int)
                and isinstance(max_allowed, int)
                and max_allowed >= 0
                and min_required > max_allowed
            ):
                invalid_group_limits.append(
                    {
                        "id": group.get("id"),
                        "name": group.get("name"),
                        "minRequired": min_required,
                        "maxAllowed": max_allowed,
                    }
                )

        missing_modifier_names = [
            {"id": x.get("id"), "group": (x.get("modifierGroup") or {}).get("id")}
            for x in modifiers
            if not str(x.get("name") or "").strip()
        ]

        bilingual_item_candidates = []
        bilingual_modifier_candidates = []
        if require_bilingual:
            bilingual_item_candidates = [
                {"id": x.get("id"), "name": x.get("name")}
                for x in items
                if x.get("name") and not _looks_bilingual(str(x.get("name")))
            ]
            bilingual_modifier_candidates = [
                {"id": x.get("id"), "name": x.get("name")}
                for x in modifiers
                if x.get("name") and not _looks_bilingual(str(x.get("name")))
            ]

        verified_issue_count = sum(
            len(x)
            for x in (
                missing_item_names,
                hidden_items,
                unavailable_items,
                uncategorized_items,
                duplicate_names,
                invalid_group_limits,
                missing_modifier_names,
            )
        )

        return _result(
            {
                "merchant": selected.display_name,
                "status": (
                    "RED"
                    if missing_item_names or invalid_group_limits
                    else "ORANGE"
                    if unavailable_items
                    else "YELLOW"
                    if verified_issue_count or require_bilingual
                    else "GREEN"
                ),
                "counts": {
                    "items": len(items),
                    "categories": len(menu["categories"]),
                    "modifier_groups": len(groups),
                    "modifiers": len(modifiers),
                    "verified_issue_groups": verified_issue_count,
                },
                "verified_issues": {
                    "missing_item_names": missing_item_names,
                    "hidden_items": hidden_items,
                    "unavailable_items": unavailable_items,
                    "uncategorized_items": uncategorized_items,
                    "duplicate_normalized_names": duplicate_names,
                    "invalid_modifier_group_limits": invalid_group_limits,
                    "missing_modifier_names": missing_modifier_names,
                },
                "review_candidates": {
                    "items_without_bilingual_delimiter": bilingual_item_candidates,
                    "modifiers_without_bilingual_delimiter": bilingual_modifier_candidates,
                    "note": (
                        "Delimiter checks are heuristic and do not validate translation quality."
                        if require_bilingual
                        else "Bilingual review was not requested."
                    ),
                },
                "truncated": menu["truncated"],
            }
        )
    except Exception as exc:
        return _error(exc)


@mcp.tool(annotations=READ_ONLY)
async def clover_get_orders(
    merchant: str,
    start_iso: str,
    end_iso: str,
    limit: int = 100,
    offset: int = 0,
    state: str | None = None,
) -> dict[str, Any]:
    """Get Clover orders in an explicit ISO-8601 time range."""
    try:
        selected = _merchant(merchant)
        start_ms = _parse_iso_ms(start_iso)
        end_ms = _parse_iso_ms(end_iso)
        if end_ms <= start_ms:
            raise ValueError("end_iso must be after start_iso.")

        limit = max(1, min(limit, 1000))
        offset = max(0, offset)
        params: list[tuple[str, Any]] = [
            ("filter", f"createdTime>={start_ms}"),
            ("filter", f"createdTime<={end_ms}"),
            ("limit", limit),
            ("offset", offset),
            ("expand", "payments"),
        ]
        if state:
            params.append(("filter", f"state={state}"))

        payload = await client.request(
            selected,
            "GET",
            f"/v3/merchants/{selected.merchant_id}/orders",
            params=params,
        )
        orders = _elements(payload)
        compact = []
        for order in orders:
            payments = _elements(order.get("payments"))
            compact.append(
                {
                    "id": order.get("id"),
                    "state": order.get("state"),
                    "createdTime": order.get("createdTime"),
                    "modifiedTime": order.get("modifiedTime"),
                    "total_minor": order.get("total"),
                    "total_decimal": _minor_to_decimal(order.get("total")),
                    "payment_count": len(payments),
                    "payment_total_minor": sum(
                        int(p.get("amount") or 0) for p in payments
                    ),
                    "title": order.get("title"),
                    "note": order.get("note"),
                }
            )

        return _result(
            {
                "merchant": selected.display_name,
                "currency": None,
                "start_iso": start_iso,
                "end_iso": end_iso,
                "limit": limit,
                "offset": offset,
                "orders": compact,
                "warning": (
                    "Expanded payment collections may be incomplete on very large orders."
                ),
            }
        )
    except Exception as exc:
        return _error(exc)


@mcp.tool(annotations=READ_ONLY)
async def clover_get_order(
    merchant: str,
    order_id: str,
) -> dict[str, Any]:
    """Get one Clover order with line items and payments."""
    try:
        selected = _merchant(merchant)
        data = await client.request(
            selected,
            "GET",
            f"/v3/merchants/{selected.merchant_id}/orders/{order_id}",
            params=[("expand", "lineItems,payments,refunds,credits")],
        )
        return _result(
            {
                "merchant": selected.display_name,
                "order": data,
                "warning": (
                    "Nested expanded collections can be capped by Clover; verify separately "
                    "for unusually large orders."
                ),
            }
        )
    except Exception as exc:
        return _error(exc)


@mcp.tool(annotations=READ_ONLY)
async def clover_sales_summary(
    merchant: str,
    start_iso: str,
    end_iso: str,
    max_orders: int = 1000,
) -> dict[str, Any]:
    """Summarize Clover order totals and recorded payment totals for a time range."""
    try:
        selected = _merchant(merchant)
        start_ms = _parse_iso_ms(start_iso)
        end_ms = _parse_iso_ms(end_iso)
        if end_ms <= start_ms:
            raise ValueError("end_iso must be after start_iso.")

        merchant_profile = await client.request(
            selected,
            "GET",
            f"/v3/merchants/{selected.merchant_id}",
        )
        orders, truncated = await client.get_all(
            selected,
            f"/v3/merchants/{selected.merchant_id}/orders",
            base_params=[
                ("filter", f"createdTime>={start_ms}"),
                ("filter", f"createdTime<={end_ms}"),
                ("expand", "payments"),
            ],
            max_records=max(1, min(max_orders, 5000)),
        )

        states: dict[str, int] = {}
        order_total_minor = 0
        payment_total_minor = 0
        missing_order_totals = 0
        orders_with_payments = 0

        for order in orders:
            state = str(order.get("state") or "null")
            states[state] = states.get(state, 0) + 1

            total = order.get("total")
            if isinstance(total, (int, float)):
                order_total_minor += int(total)
            else:
                missing_order_totals += 1

            payments = _elements(order.get("payments"))
            if payments:
                orders_with_payments += 1
            payment_total_minor += sum(
                int(p.get("amount") or 0)
                for p in payments
                if not p.get("voided")
            )

        return _result(
            {
                "merchant": selected.display_name,
                "currency": merchant_profile.get("currency"),
                "start_iso": start_iso,
                "end_iso": end_iso,
                "order_count": len(orders),
                "states": states,
                "orders_with_recorded_payments": orders_with_payments,
                "gross_order_total_minor": order_total_minor,
                "gross_order_total_decimal": _minor_to_decimal(order_total_minor),
                "recorded_payment_total_minor": payment_total_minor,
                "recorded_payment_total_decimal": _minor_to_decimal(payment_total_minor),
                "missing_order_totals": missing_order_totals,
                "truncated": truncated,
                "accounting_warning": (
                    "Operational summary only. Expanded payments, refunds, credits, taxes, "
                    "tips, and settlement timing may require separate reconciliation."
                ),
            }
        )
    except Exception as exc:
        return _error(exc)


@mcp.tool(annotations=DRAFT_ONLY)
async def clover_prepare_inventory_update(
    merchant: str,
    item_id: str,
    patch: dict[str, Any],
) -> dict[str, Any]:
    """Prepare, but do not apply, a guarded inventory item update."""
    try:
        selected = _merchant(merchant)
        if not patch:
            raise ValueError("Patch cannot be empty.")
        unsupported = sorted(set(patch) - ITEM_ALLOWED_FIELDS)
        if unsupported:
            raise ValueError(f"Unsupported item fields: {', '.join(unsupported)}")

        current = await client.request(
            selected,
            "GET",
            f"/v3/merchants/{selected.merchant_id}/items/{item_id}",
        )
        proposed = {key: patch[key] for key in patch}
        approval = f"APPROVE CLOVER ITEM UPDATE {selected.key} {item_id}"

        return _result(
            {
                "prepared_only": True,
                "merchant": selected.display_name,
                "merchant_key": selected.key,
                "item_id": item_id,
                "current": {key: current.get(key) for key in proposed},
                "proposed": proposed,
                "approval_phrase": approval,
                "writes_enabled": WRITES_ENABLED,
            }
        )
    except Exception as exc:
        return _error(exc)


@mcp.tool(annotations=GUARDED_WRITE)
async def clover_apply_inventory_update(
    merchant: str,
    item_id: str,
    patch: dict[str, Any],
    user_approval_text: str,
) -> dict[str, Any]:
    """Apply an approved item update, then re-read and verify it."""
    try:
        if not WRITES_ENABLED:
            raise PermissionError("Clover writes are disabled on the server.")
        selected = _merchant(merchant)
        expected = f"APPROVE CLOVER ITEM UPDATE {selected.key} {item_id}"
        if user_approval_text.strip() != expected:
            raise PermissionError("Exact user approval phrase is required.")
        if not patch:
            raise ValueError("Patch cannot be empty.")
        unsupported = sorted(set(patch) - ITEM_ALLOWED_FIELDS)
        if unsupported:
            raise ValueError(f"Unsupported item fields: {', '.join(unsupported)}")

        await client.request(
            selected,
            "POST",
            f"/v3/merchants/{selected.merchant_id}/items/{item_id}",
            json_body=patch,
            retry_read=False,
        )
        verified = await client.request(
            selected,
            "GET",
            f"/v3/merchants/{selected.merchant_id}/items/{item_id}",
        )
        mismatches = {
            key: {"expected": value, "actual": verified.get(key)}
            for key, value in patch.items()
            if verified.get(key) != value
        }
        return _result(
            {
                "merchant": selected.display_name,
                "item_id": item_id,
                "updated": True,
                "verified": not mismatches,
                "mismatches": mismatches,
                "item": _compact_item(verified),
            }
        )
    except Exception as exc:
        return _error(exc)


@mcp.tool(annotations=DRAFT_ONLY)
async def clover_prepare_modifier_update(
    merchant: str,
    modifier_group_id: str,
    modifier_id: str,
    patch: dict[str, Any],
) -> dict[str, Any]:
    """Prepare, but do not apply, a guarded modifier update."""
    try:
        selected = _merchant(merchant)
        if not patch:
            raise ValueError("Patch cannot be empty.")
        unsupported = sorted(set(patch) - MODIFIER_ALLOWED_FIELDS)
        if unsupported:
            raise ValueError(f"Unsupported modifier fields: {', '.join(unsupported)}")

        current = await client.request(
            selected,
            "GET",
            (
                f"/v3/merchants/{selected.merchant_id}/modifier_groups/"
                f"{modifier_group_id}/modifiers/{modifier_id}"
            ),
        )
        approval = (
            f"APPROVE CLOVER MODIFIER UPDATE {selected.key} "
            f"{modifier_group_id} {modifier_id}"
        )
        return _result(
            {
                "prepared_only": True,
                "merchant": selected.display_name,
                "merchant_key": selected.key,
                "modifier_group_id": modifier_group_id,
                "modifier_id": modifier_id,
                "current": {key: current.get(key) for key in patch},
                "proposed": {key: patch[key] for key in patch},
                "approval_phrase": approval,
                "writes_enabled": WRITES_ENABLED,
            }
        )
    except Exception as exc:
        return _error(exc)


@mcp.tool(annotations=GUARDED_WRITE)
async def clover_apply_modifier_update(
    merchant: str,
    modifier_group_id: str,
    modifier_id: str,
    patch: dict[str, Any],
    user_approval_text: str,
) -> dict[str, Any]:
    """Apply an approved modifier update, then re-read and verify it."""
    try:
        if not WRITES_ENABLED:
            raise PermissionError("Clover writes are disabled on the server.")
        selected = _merchant(merchant)
        expected = (
            f"APPROVE CLOVER MODIFIER UPDATE {selected.key} "
            f"{modifier_group_id} {modifier_id}"
        )
        if user_approval_text.strip() != expected:
            raise PermissionError("Exact user approval phrase is required.")
        if not patch:
            raise ValueError("Patch cannot be empty.")
        unsupported = sorted(set(patch) - MODIFIER_ALLOWED_FIELDS)
        if unsupported:
            raise ValueError(f"Unsupported modifier fields: {', '.join(unsupported)}")

        path = (
            f"/v3/merchants/{selected.merchant_id}/modifier_groups/"
            f"{modifier_group_id}/modifiers/{modifier_id}"
        )
        await client.request(
            selected,
            "POST",
            path,
            json_body=patch,
            retry_read=False,
        )
        verified = await client.request(selected, "GET", path)
        mismatches = {
            key: {"expected": value, "actual": verified.get(key)}
            for key, value in patch.items()
            if verified.get(key) != value
        }
        return _result(
            {
                "merchant": selected.display_name,
                "modifier_group_id": modifier_group_id,
                "modifier_id": modifier_id,
                "updated": True,
                "verified": not mismatches,
                "mismatches": mismatches,
                "modifier": _compact_modifier(verified),
            }
        )
    except Exception as exc:
        return _error(exc)


def main() -> None:
    mcp.run(transport="streamable-http")


if __name__ == "__main__":
    main()
