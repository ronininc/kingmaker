# Clover API Implementation Notes

## Environments

- Sandbox REST base: `https://apisandbox.dev.clover.com`
- North America production: `https://api.clover.com`
- Europe production: `https://api.eu.clover.com`
- Latin America production: `https://api.la.clover.com`

## Authentication

Clover Platform API calls use:

```http
Authorization: Bearer ACCESS_TOKEN
```

Production apps should use Clover v2 OAuth expiring access and refresh token pairs. Refresh tokens are single-use and should be replaced atomically after a successful refresh.

## Key endpoints used

```text
GET  /v3/merchants/{mId}
GET  /v3/merchants/{mId}/items
GET  /v3/merchants/{mId}/items/{itemId}
POST /v3/merchants/{mId}/items/{itemId}

GET  /v3/merchants/{mId}/categories

GET  /v3/merchants/{mId}/modifier_groups
GET  /v3/merchants/{mId}/modifier_groups/{groupId}/modifiers
GET  /v3/merchants/{mId}/modifier_groups/{groupId}/modifiers/{modifierId}
POST /v3/merchants/{mId}/modifier_groups/{groupId}/modifiers/{modifierId}

GET  /v3/merchants/{mId}/orders
GET  /v3/merchants/{mId}/orders/{orderId}
```

## Pagination

Clover commonly returns 100 elements by default. This scaffold uses explicit `limit` and `offset`, caps requested page size at 1000, and reports truncation risk.

Nested expanded collections may still be capped. Do not treat a nested expansion as complete when it reaches the platform limit.

## Rate limits

Design for Clover's per-app, per-token, and concurrent limits. The client:

- Avoids parallel fan-out by default
- Retries a read request only for transient transport/5xx failures
- Does not retry write requests automatically
- Surfaces 429 responses instead of entering a loop

## Money

Clover order, price, and payment integer amounts are minor currency units. For USD, `2099` represents `$20.99`.

## Official references

- https://docs.clover.com/dev/docs/making-rest-api-calls
- https://docs.clover.com/dev/docs/oauth-flows-in-clover
- https://docs.clover.com/dev/docs/refresh-access-tokens
- https://docs.clover.com/dev/docs/api-usage-rate-limits
- https://docs.clover.com/dev/docs/paginating-elements
- https://docs.clover.com/dev/docs/managing-items-item-groups
- https://docs.clover.com/dev/docs/managing-modifier-groups-modifiers
- https://docs.clover.com/dev/docs/creating-custom-orders
