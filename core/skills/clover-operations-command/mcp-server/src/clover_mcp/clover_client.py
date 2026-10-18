from __future__ import annotations

import asyncio
import time
from collections.abc import Iterable
from typing import Any

import httpx

from .config import MerchantConfig, MerchantRegistry


class CloverAPIError(RuntimeError):
    def __init__(
        self,
        message: str,
        *,
        status_code: int | None = None,
        details: Any = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.details = details

    def safe_dict(self) -> dict[str, Any]:
        return {
            "error": str(self),
            "status_code": self.status_code,
            "details": self.details,
        }


class CloverClient:
    def __init__(self, registry: MerchantRegistry) -> None:
        self.registry = registry
        self._http = httpx.AsyncClient(
            timeout=httpx.Timeout(30.0, connect=10.0),
            headers={
                "Accept": "application/json",
                "Content-Type": "application/json",
                "User-Agent": "OperationsCommand-CloverMCP/0.1",
            },
        )
        self._refresh_locks: dict[str, asyncio.Lock] = {}

    async def close(self) -> None:
        await self._http.aclose()

    async def _refresh_if_needed(
        self,
        merchant: MerchantConfig,
        *,
        force: bool = False,
    ) -> bool:
        expiration = merchant.access_token_expiration
        needs_refresh = force or (
            expiration is not None and expiration <= int(time.time()) + 120
        )
        if not needs_refresh:
            return False
        if not merchant.refresh_token or not merchant.client_id:
            return False

        lock = self._refresh_locks.setdefault(merchant.key, asyncio.Lock())
        async with lock:
            # Another coroutine may have refreshed while this request waited.
            expiration = merchant.access_token_expiration
            if (
                not force
                and expiration is not None
                and expiration > int(time.time()) + 120
            ):
                return True

            response = await self._http.post(
                f"{merchant.base_url}/oauth/v2/refresh",
                json={
                    "client_id": merchant.client_id,
                    "refresh_token": merchant.refresh_token,
                },
            )
            if response.status_code >= 400:
                raise CloverAPIError(
                    "Clover token refresh failed; merchant reconnection may be required.",
                    status_code=response.status_code,
                    details=_safe_response_details(response),
                )

            data = response.json()
            access_token = data.get("access_token")
            if not access_token:
                raise CloverAPIError("Clover refresh response omitted access_token.")

            self.registry.update_tokens(
                merchant.key,
                access_token=access_token,
                refresh_token=data.get("refresh_token"),
                access_token_expiration=data.get("access_token_expiration"),
                refresh_token_expiration=data.get("refresh_token_expiration"),
            )
            return True

    async def request(
        self,
        merchant: MerchantConfig,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | list[tuple[str, Any]] | None = None,
        json_body: dict[str, Any] | None = None,
        retry_read: bool = True,
    ) -> dict[str, Any]:
        method = method.upper()
        is_read = method == "GET"

        await self._refresh_if_needed(merchant)

        async def send() -> httpx.Response:
            return await self._http.request(
                method,
                f"{merchant.base_url}{path}",
                params=params,
                json=json_body,
                headers={"Authorization": f"Bearer {merchant.access_token}"},
            )

        attempts = 2 if is_read and retry_read else 1
        last_transport_error: Exception | None = None

        for attempt in range(attempts):
            try:
                response = await send()
            except (httpx.TimeoutException, httpx.TransportError) as exc:
                last_transport_error = exc
                if attempt + 1 < attempts:
                    await asyncio.sleep(0.35)
                    continue
                raise CloverAPIError(
                    "Clover request failed due to a network or timeout error."
                ) from exc

            if response.status_code == 401 and await self._refresh_if_needed(
                merchant, force=True
            ):
                response = await send()

            if response.status_code >= 400:
                raise CloverAPIError(
                    f"Clover API returned HTTP {response.status_code}.",
                    status_code=response.status_code,
                    details=_safe_response_details(response),
                )

            if not response.content:
                return {}
            try:
                data = response.json()
            except ValueError as exc:
                raise CloverAPIError(
                    "Clover returned a non-JSON response.",
                    status_code=response.status_code,
                ) from exc
            if not isinstance(data, dict):
                return {"value": data}
            return data

        raise CloverAPIError(
            "Clover request failed.",
            details=str(last_transport_error) if last_transport_error else None,
        )

    async def get_all(
        self,
        merchant: MerchantConfig,
        path: str,
        *,
        base_params: Iterable[tuple[str, Any]] | None = None,
        max_records: int = 1000,
        page_size: int = 100,
    ) -> tuple[list[dict[str, Any]], bool]:
        if max_records < 1:
            return [], False

        page_size = max(1, min(page_size, 1000, max_records))
        offset = 0
        records: list[dict[str, Any]] = []
        truncated = False

        while len(records) < max_records:
            params = list(base_params or [])
            params.extend(
                [
                    ("limit", min(page_size, max_records - len(records))),
                    ("offset", offset),
                ]
            )
            payload = await self.request(merchant, "GET", path, params=params)
            elements = payload.get("elements") or []
            if not isinstance(elements, list):
                raise CloverAPIError("Clover collection response omitted elements.")

            records.extend(x for x in elements if isinstance(x, dict))
            if len(elements) < page_size:
                break
            offset += len(elements)
            if len(records) >= max_records:
                truncated = True
                break

        return records, truncated


def _safe_response_details(response: httpx.Response) -> Any:
    try:
        data = response.json()
    except ValueError:
        text = response.text.strip()
        return text[:500] if text else None

    if isinstance(data, dict):
        redacted = dict(data)
        for key in list(redacted):
            if any(
                secret_word in key.casefold()
                for secret_word in ("token", "secret", "password", "card")
            ):
                redacted[key] = "[REDACTED]"
        return redacted
    return data
