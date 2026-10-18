# Clover Operations MCP Server

A safe-by-default remote MCP server for Claude.

## What it exposes

Read tools:

- Connector health
- Connected merchants
- Merchant profile
- Inventory search
- Menu structure
- Menu audit
- Orders and order details
- Sales summary

Guarded write tools:

- Inventory item update
- Modifier update

It does **not** expose deletion, payment mutation, refunds, captures, order creation, credentials, or employee administration.

## Local sandbox setup

```bash
cd mcp-server
cp merchant_registry.example.json merchant_registry.json
# Replace the sandbox merchant ID and sandbox token.
export CLOVER_MERCHANTS_FILE="$PWD/merchant_registry.json"
export ENABLE_CLOVER_WRITES=false

python -m venv .venv
source .venv/bin/activate
pip install -e .
clover-mcp
```

The MCP endpoint is:

```text
http://127.0.0.1:8000/mcp
```

Test it with the MCP Inspector:

```bash
npx -y @modelcontextprotocol/inspector
```

Select **Streamable HTTP** and enter the endpoint.

## Registry format

```json
{
  "merchant-key": {
    "display_name": "Merchant Name",
    "merchant_id": "CLOVER_MERCHANT_ID",
    "access_token": "SECRET",
    "refresh_token": "OPTIONAL_SECRET",
    "access_token_expiration": 1780000000,
    "client_id": "OPTIONAL_APP_ID",
    "client_secret": "OPTIONAL_APP_SECRET",
    "region": "NA",
    "environment": "sandbox"
  }
}
```

Supported regions: `NA`, `EU`, `LATAM`.

Supported environments: `sandbox`, `production`.

## Production deployment

1. Store the registry in a secret manager or encrypted database.
2. Put the MCP endpoint behind a standards-compliant OAuth/OIDC authorization layer compatible with remote MCP.
3. Use HTTPS only.
4. Restrict logs so tokens and payment data are never recorded.
5. Set up persistent, atomic token storage before enabling Clover refresh tokens.
6. Add the public `/mcp` URL in Claude under **Customize → Connectors → Add custom connector**.
7. Configure the connector's OAuth client information when your authorization layer requires it.
8. Keep writes disabled until read-only production verification succeeds.

## Token refresh warning

Clover refresh tokens are single-use. This scaffold writes a refreshed token pair back to the JSON registry atomically only when `CLOVER_MERCHANTS_FILE` is used.

For multiple server replicas, replace the JSON registry with a transactional database or secret store. Do not run refresh-token rotation from multiple replicas without locking.

## Write approval

A prepare tool returns an exact phrase such as:

```text
APPROVE CLOVER ITEM UPDATE example-restaurant ITEM123
```

The apply tool rejects:

- Writes disabled by configuration
- Incorrect approval text
- Unsupported fields
- Empty patches

The Claude Skill adds the conversational rule that the user—not Claude—must provide the exact phrase.

This is a strong workflow guard, not a cryptographic proof of human presence. For high-assurance production writes, add an external approval service or operator console.
