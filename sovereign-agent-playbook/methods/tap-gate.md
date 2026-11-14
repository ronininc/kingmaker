---
id: tap-gate
name: Batch Tap Gate (shared by every send-capable method)
status: binding design — no send-capable method ships without this gate, in from the first commit
---
Mechanics (pattern proven in the auto-emailer build):
1. The method builds a BATCH: an ordered manifest of messages, each entry hashed (sha256 of recipient + body).
2. The batch itself is hashed; the approval names the BATCH SHA-256. Robbie's tap approves that hash, not a vibe.
3. Any edit after approval changes the hash and the send REFUSES. Rebuild + re-approve, always.
4. No standing approval exists. A tap covers one batch, once.
5. TCPA attestation is Robbie's legal act alone — the method presents the attestation for him to check; it never checks it, pre-fills it, or routes around it.
6. Default transport is DRY-RUN. Live transport requires the batch tap AND the attestation, in that order.
7. Every send writes an audit entry (batch hash, entry hash, timestamp, transport result). Failures halt the batch, never retry silently.
8. Per-batch tap in chat counts as the tap when Robbie gives it there (standing rule); the batch hash is quoted back in the approval message.
