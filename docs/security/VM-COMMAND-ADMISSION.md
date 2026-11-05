# Scripture Armor command admission — local source checkpoint

Status: built and tested locally. Not deployed. This is not a claim that the
running Muse VM or every VM process has been repaired or audited.

## Mandatory gate in the available executor

The available cloud-to-local executor is the external-security inventory lane:

1. `external-security-attempt-loader.mjs` reads fixed local operator provisioning.
   Missing `commandArmor` configuration stops construction before any CRM call.
   Configuration must identify the recipient state directory, the separately
   enrolled owner-dispatch public block, and an audience equal to the executor ID.
2. The authenticated bootstrap must carry `commandArmorPacket`. Missing packets
   stop loading. Neither the loader nor the receiver signs incoming instructions.
3. `external-security-inventory-runtime.mjs` verifies that packet before journal
   recovery, CRM status/claim calls, or adapter dispatch.
4. `external-review-adapter.mjs` requires an in-process cryptographic admission
   even when called directly or through the durable job queue. Serializing
   `verified:true`, a role, a name or a copied admission object cannot satisfy it.
5. Existing independent CRM authority, executor, manifest, scope, lease and
   immutable evidence gates remain mandatory. Armor admission does not replace
   them, authorize a payment, export a key or grant administrative privileges.
6. Recovery requires a newly issued packet for the same exact saved command job;
   it does not revive a consumed packet or accept a different recovery job.

All bot identities using this shared lane receive the same enforcement. A desk
name (including Muse) selects no exception. The permitted action here is ONLY
`external-static-inventory`; arbitrary shell/model instructions are not adapters
in this lane. Other cloud adapters remain disabled unless separately implemented.

## Packet contract

Use Scripture Armor's existing v4 `sealPlaintext` format, addressed to the enrolled
VM receiver. Its signer must be a distinct, locally pinned owner-dispatch identity.
The signed, sealed plaintext is exactly:

```
{
  "schema": "ronin.scripture-command/v1",
  "audience": "<locally provisioned executor ID>",
  "action": "external-static-inventory",
  "attemptId": "<exact attempt UUID>",
  "issuedAt": "<integer epoch milliseconds>",
  "expiresAt": "<integer epoch milliseconds>",
  "job": "<exact dispatch job object, excluding independently signed dispatchReceipt>"
}
```

Time and job values above are placeholders, not literal JSON types. The expiry
must match the outer signed frame expiry, be in the future, and be no more than
60 seconds after issuance. Future-dated or older issuance is refused. Audience,
action, attempt, canonical job bytes, signature and recipient must all match.
Unknown envelope fields, including role/family/owner assertions, are refused.

A durable SQLite primary-key insertion consumes the canary before any work.
Separate processes and restarts share that ledger. A crash after admission leaves
the command consumed; retries need fresh owner authorization, never an automatic
reset. Missing initialized replay state, corrupt storage, closed gate or expired
admission denies work. The short-lived in-process proof is rechecked after async
authority lookup. The ledger stores canary/hash/expiry only, not plaintext or keys.

## Desk messages

CRM inbox, replies, answered history and recaps carry explicit `data_only` /
`owner_order:false` / `command_admitted:false` provenance for every desk. Known
role impersonation, key requests and instruction overrides are withheld from bot
read surfaces while the original remains in storage for authenticated owner review.
Wake notifications carry fixed text and no message preview, even for owner-labeled
posts. Text screening is supplemental and cannot prove that all possible semantic
injections are detected. No screened or unscreened desk post becomes command proof.

## Release hold and remaining deployment work

No CRM packet issuer or production owner enrollment was added. Existing plaintext
bootstrap responses therefore fail closed in this changed source. Provisioning
must be reviewed and must bind the exact owner-authorized job; automatically sealing
an arriving bot message would defeat the authority boundary.

The live Muse VM definition, launch configuration, firewall, process list and full
HTTP/WebSocket/queue/stdin/cron ingress inventory are not available in this checkout.
Consequently, SSH, direct shell access, browser automation, other VM agents and
external provider entry points are NOT certified covered by these local tests.
The benchmark VM script and historical proof harness are not deployment evidence.
Spoken-order and ordinary local-work server contracts are separate interfaces and
are NOT certified Armor-admitted by this change.

Before publication, isolate the gate as a dedicated service principal; prevent
agents from reading or modifying its state, pins and credentials; keep the owner
signing private key outside the agent VM; and remove direct access to any agent
listener that could bypass the gate. File permissions alone cannot isolate two
processes running as the same OS user. A sandboxed agent must have no host shell,
mount, socket, environment or credential-store capability that reads the owner key.
The receiver's own key must never be accepted as its owner-dispatch signer.

A valid signed command authenticates bytes and scope; it does not make a document
inside the job safe to execute as new instructions. Existing typed static-inventory
restrictions prevent target-code execution. Any future model/tool adapter needs its
own least-privilege data/command boundary and explicit review before enabling.

No deployment, service restart, signing-key access, real charge, or live intrusion
attempt was performed. Tests use disposable synthetic identities and inert jobs.
