# Clover Operations Command for Claude

This package contains two complementary components:

1. **Claude Skill** — `SKILL.md` teaches Claude how to use Clover safely and how to format Operations Command outputs.
2. **Remote MCP server scaffold** — `mcp-server/` exposes Clover read tools and guarded item/modifier update tools.

## Package structure

```text
clover-operations-command/
├── SKILL.md
├── README.md
├── references/
│   ├── CLOVER_API_GUIDE.md
│   ├── OPERATIONS_POLICY.md
│   └── TOOL_CONTRACTS.md
└── mcp-server/
    ├── pyproject.toml
    ├── Dockerfile
    ├── .env.example
    ├── merchant_registry.example.json
    ├── README.md
    ├── src/clover_mcp/
    │   ├── __init__.py
    │   ├── config.py
    │   ├── clover_client.py
    │   └── server.py
    └── tests/
        └── test_safety.py
```

## Install the Claude Skill

### Claude web or desktop

Upload this ZIP through **Customize → Skills**, then enable **Clover Operations Command**.

### Claude Code

Copy the skill folder into your project:

```bash
mkdir -p .claude/skills
cp -R clover-operations-command .claude/skills/clover-operations-command
```

Invoke it with `/clover-operations-command` or let Claude load it when a Clover request is detected.

## Connect the actual Clover tools

A Skill cannot directly access Clover. Deploy the MCP server in `mcp-server/`, secure it, and add its public Streamable HTTP URL as a Claude custom connector.

Expected endpoint:

```text
https://YOUR-HOST/mcp
```

The connector name should be `clover_ops` when practical.

## Recommended rollout

1. Start with a Clover sandbox merchant.
2. Keep `ENABLE_CLOVER_WRITES=false`.
3. Test all read and audit tools.
4. Add standards-compliant OAuth protection before production.
5. Connect one production merchant at a time.
6. Enable writes only after reviewing logs, permissions, and approval behavior.
7. Keep payment mutation and deletion capabilities out of this connector.

## Important security boundary

There are two separate authorization layers:

- **Claude → MCP server:** Protect the remote MCP endpoint with OAuth/OIDC or another MCP-compatible authorization layer.
- **MCP server → Clover:** Store each merchant's Clover token server-side in a secret manager or encrypted database.

Never place Clover tokens in `SKILL.md`, Claude prompts, source control, or connector descriptions.
