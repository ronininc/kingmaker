# CRM tenant lock

`kingmaker crm-lock ronininc` is an optional, per-install boundary. The default remains unlocked with no CRM attached.

Set the lock only while Kingmaker is stopped. The command refuses to change it while the recorded daemon is alive; after setting it, start Kingmaker again. Changing the JSON file behind a running process is unsupported and requires a restart.

On a locked start, the launcher pins the home CRM and primary CRM MCP endpoint, removes the independent `SOLOMON_CRM_MCP_CONFIG` lane, and supplies an exact tenant/host/endpoint tuple to Solomon. Solomon validates that tuple fail-closed and applies it to the primary CRM client, all three Kingmaker seat clients (including old sealed configs), HTTP seat operations, connection discovery/sealing/live checks, and root generic CRM bindings. A partial or forged tuple disables the affected connector.

The device map also removes cached apps, gaps, proposals, and candidate-search state belonging to another tenant. This is an application-routing safeguard, not browser URL/origin enforcement: a person can still navigate a general-purpose browser independently. Browser-level tenant isolation remains unsupported and must not be inferred from the device-map filter.

The lock does not grant new authority, enable approvals, migrate knowledge bases, copy credentials, or activate a connection. Existing approval and tenant governance remain in force.
