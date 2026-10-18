from clover_mcp.server import (
    ITEM_ALLOWED_FIELDS,
    MODIFIER_ALLOWED_FIELDS,
    _looks_bilingual,
)


def test_no_destructive_item_fields() -> None:
    assert "deleted" not in ITEM_ALLOWED_FIELDS
    assert "id" not in ITEM_ALLOWED_FIELDS
    assert "stockCount" not in ITEM_ALLOWED_FIELDS


def test_no_destructive_modifier_fields() -> None:
    assert "deleted" not in MODIFIER_ALLOWED_FIELDS
    assert "id" not in MODIFIER_ALLOWED_FIELDS


def test_bilingual_delimiter_heuristic() -> None:
    assert _looks_bilingual("Cebolla morada / Red onion")
    assert not _looks_bilingual("Cebolla morada")
