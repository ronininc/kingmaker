from __future__ import annotations

import json
import os
import tempfile
import threading
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any


REGION_BASE_URLS: dict[str, dict[str, str]] = {
    "NA": {
        "sandbox": "https://apisandbox.dev.clover.com",
        "production": "https://api.clover.com",
    },
    "EU": {
        "sandbox": "https://apisandbox.dev.clover.com",
        "production": "https://api.eu.clover.com",
    },
    "LATAM": {
        "sandbox": "https://apisandbox.dev.clover.com",
        "production": "https://api.la.clover.com",
    },
}


@dataclass
class MerchantConfig:
    key: str
    display_name: str
    merchant_id: str
    access_token: str
    region: str = "NA"
    environment: str = "sandbox"
    refresh_token: str | None = None
    access_token_expiration: int | None = None
    refresh_token_expiration: int | None = None
    client_id: str | None = None
    client_secret: str | None = None

    @property
    def base_url(self) -> str:
        region = self.region.upper()
        environment = self.environment.lower()
        try:
            return REGION_BASE_URLS[region][environment]
        except KeyError as exc:
            raise ValueError(
                f"Unsupported Clover region/environment: {self.region}/{self.environment}"
            ) from exc

    def public_dict(self) -> dict[str, Any]:
        masked = (
            f"…{self.merchant_id[-4:]}"
            if len(self.merchant_id) > 4
            else "configured"
        )
        return {
            "key": self.key,
            "display_name": self.display_name,
            "merchant_id_masked": masked,
            "region": self.region.upper(),
            "environment": self.environment.lower(),
            "refresh_available": bool(self.refresh_token and self.client_id),
        }


class MerchantRegistry:
    """Loads merchant credentials from an environment JSON value or JSON file."""

    def __init__(
        self,
        merchants: dict[str, MerchantConfig],
        source_file: Path | None = None,
    ) -> None:
        self._merchants = merchants
        self._source_file = source_file
        self._write_lock = threading.Lock()

    @classmethod
    def from_env(cls) -> "MerchantRegistry":
        raw_inline = os.getenv("CLOVER_MERCHANTS_JSON", "").strip()
        raw_file = os.getenv("CLOVER_MERCHANTS_FILE", "").strip()

        if raw_inline:
            payload = json.loads(raw_inline)
            source_file = None
        elif raw_file:
            source_file = Path(raw_file)
            payload = json.loads(source_file.read_text(encoding="utf-8"))
        else:
            payload = {}
            source_file = None

        if not isinstance(payload, dict):
            raise ValueError("Clover merchant registry must be a JSON object.")

        default_client_id = os.getenv("CLOVER_CLIENT_ID") or None
        default_client_secret = os.getenv("CLOVER_CLIENT_SECRET") or None

        merchants: dict[str, MerchantConfig] = {}
        for key, value in payload.items():
            if not isinstance(value, dict):
                raise ValueError(f"Registry entry {key!r} must be an object.")
            merchant = MerchantConfig(
                key=key,
                display_name=value.get("display_name") or key,
                merchant_id=value["merchant_id"],
                access_token=value["access_token"],
                refresh_token=value.get("refresh_token"),
                access_token_expiration=value.get("access_token_expiration"),
                refresh_token_expiration=value.get("refresh_token_expiration"),
                client_id=value.get("client_id") or default_client_id,
                client_secret=value.get("client_secret") or default_client_secret,
                region=(value.get("region") or "NA").upper(),
                environment=(value.get("environment") or "sandbox").lower(),
            )
            # Validate now instead of at the first API call.
            _ = merchant.base_url
            merchants[key] = merchant

        return cls(merchants=merchants, source_file=source_file)

    def list_public(self) -> list[dict[str, Any]]:
        return [m.public_dict() for m in self._merchants.values()]

    def resolve(self, query: str) -> MerchantConfig:
        normalized = query.strip().casefold()
        if not normalized:
            raise ValueError("Merchant is required.")

        if query in self._merchants:
            return self._merchants[query]

        exact = [
            m for m in self._merchants.values()
            if m.display_name.casefold() == normalized
        ]
        if len(exact) == 1:
            return exact[0]

        partial = [
            m for m in self._merchants.values()
            if normalized in m.key.casefold()
            or normalized in m.display_name.casefold()
        ]
        if len(partial) == 1:
            return partial[0]
        if len(partial) > 1:
            names = ", ".join(sorted(m.display_name for m in partial))
            raise ValueError(f"Ambiguous merchant. Matches: {names}")
        raise KeyError(f"Merchant not configured: {query}")

    def update_tokens(
        self,
        key: str,
        *,
        access_token: str,
        refresh_token: str | None,
        access_token_expiration: int | None,
        refresh_token_expiration: int | None,
    ) -> None:
        merchant = self._merchants[key]
        merchant.access_token = access_token
        merchant.refresh_token = refresh_token
        merchant.access_token_expiration = access_token_expiration
        merchant.refresh_token_expiration = refresh_token_expiration

        if self._source_file is None:
            # Inline JSON cannot be updated durably.
            return

        with self._write_lock:
            payload: dict[str, dict[str, Any]] = {}
            for merchant_key, item in self._merchants.items():
                row = asdict(item)
                row.pop("key", None)
                payload[merchant_key] = row

            self._source_file.parent.mkdir(parents=True, exist_ok=True)
            fd, temp_name = tempfile.mkstemp(
                dir=str(self._source_file.parent),
                prefix=f".{self._source_file.name}.",
                suffix=".tmp",
                text=True,
            )
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as handle:
                    json.dump(payload, handle, indent=2)
                    handle.write("\n")
                    handle.flush()
                    os.fsync(handle.fileno())
                os.replace(temp_name, self._source_file)
            finally:
                if os.path.exists(temp_name):
                    os.unlink(temp_name)
