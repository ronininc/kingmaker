/**
 * whatsapp-mcp/lib/whatsapp-gate.mjs
 *
 * The governed gate for the WhatsApp MCP Server (lharries/whatsapp-mcp,
 * MIT). Upstream shape (README, fetched 2026-10-20): a Go bridge
 * (whatsmeow) holds the owner's WhatsApp session and a LOCAL SQLite
 * message store; a Python MCP server exposes twelve tools over it —
 * nine reads, three sends. Upstream's own README flags the
 * prompt-injection risk of an ambient send tool; this gate is the
 * answer, and it encodes the founder's comms law directly:
 *
 *   READS ARE AMBIENT, AUDITED. Searching and reading the owner's own
 *   history is not a governed action. Every read still lands on the
 *   hash-chained audit log (tool name + result count — never bodies).
 *
 *   SENDS ARE A GOVERNED ACTION — NEVER AMBIENT.
 *     1. Known contacts only. The recipient must be in the registered
 *        contact set (by JID or by phone digits). A stranger refuses
 *        even inside an authorized batch — the batch tap authorizes
 *        VOLUME, it never widens WHO can be reached.
 *     2. Per-batch tap. One verified founder tap opens one batch with
 *        a hard send allowance (maxSends). Sends draw the allowance
 *        down; when it is gone, sends refuse until a new batch is
 *        tapped. Inside the batch there are no per-item prompts —
 *        asking per item is itself the violation of the doctrine.
 *     3. The TCPA attestation is the founder's legal act alone. The
 *        gate records THAT a batch was tapped; it never attests.
 *     4. Outbound text passes the CSAM seed screen before the
 *        transport sees it (abort, logged without content).
 *
 *   The transport is injected (the MCP tool call). This module holds
 *   no WhatsApp session, pairs nothing, and sends nothing by itself.
 */

import { fileURLToPath } from 'node:url';
import { openAuditLog } from '../../lib/audit-chain.mjs';
import { createTapGate, csamHit, refused } from '../../lib/governance.mjs';

export const WHATSAPP_READ_TOOLS = Object.freeze([
  'search_contacts', 'list_messages', 'list_chats', 'get_chat',
  'get_direct_chat_by_contact', 'get_contact_chats', 'get_last_interaction',
  'get_message_context', 'download_media',
]);

export const WHATSAPP_SEND_TOOLS = Object.freeze([
  'send_message', 'send_file', 'send_audio_message',
]);

function digits(s) {
  return String(s ?? '').replace(/\D/g, '');
}

function jidOf(contact) {
  if (contact.jid) return String(contact.jid);
  const d = digits(contact.phone);
  return d ? `${d}@s.whatsapp.net` : null;
}

export function createWhatsAppGate({
  transport,
  knownContacts = [],
  verifyTap = null,
  auditLog = null,
  auditPath = null,
} = {}) {
  const audit = auditLog ?? openAuditLog(
    auditPath ?? fileURLToPath(new URL('../audit/whatsapp-audit.jsonl', import.meta.url)),
    { genesisLabel: 'whatsapp-gate-audit-genesis' }
  );
  const log = (action, detail, meta = {}) => audit.append({ actor: 'whatsapp', action, detail, meta });
  const tapGate = createTapGate(verifyTap);

  const knownJids = new Set(knownContacts.map(jidOf).filter(Boolean));
  const knownPhones = new Set(knownContacts.map((c) => digits(c.phone)).filter(Boolean));

  function isKnownRecipient(recipient) {
    if (!recipient || typeof recipient !== 'string') return false;
    if (recipient.endsWith('@g.us')) return knownJids.has(recipient); // groups must be registered explicitly
    if (recipient.includes('@')) return knownJids.has(recipient);
    const d = digits(recipient);
    return d.length > 0 && knownPhones.has(d);
  }

  let batch = null; // { id, remaining, openedAt }

  async function callRead(tool, args = {}) {
    if (!WHATSAPP_READ_TOOLS.includes(tool)) {
      return refused(`whatsapp: '${tool}' is not a read tool — sends go through the batch gate`);
    }
    if (typeof transport !== 'function') {
      const r = refused('whatsapp: no transport wired — refused by default');
      log('read.refused', r.reason, { tool });
      return r;
    }
    const result = await transport(tool, args);
    const count = Array.isArray(result) ? result.length : (result?.count ?? null);
    log('read', `tool=${tool}`, { tool, count });
    return { ok: true, tool, result };
  }

  /**
   * Open a send batch with one founder tap. maxSends is the hard
   * allowance; the tap authorizes volume to KNOWN contacts only.
   */
  async function openBatch({ tapToken, batchId, maxSends = 25 } = {}) {
    if (!batchId || typeof batchId !== 'string') throw new Error('whatsapp: batchId is required');
    if (!Number.isInteger(maxSends) || maxSends < 1 || maxSends > 500) {
      return refused('whatsapp: maxSends must be an integer 1..500');
    }
    if (batch && batch.remaining > 0) {
      return refused(`whatsapp: batch '${batch.id}' is still open with ${batch.remaining} sends left — close it first`);
    }
    const blocked = await tapGate(tapToken);
    if (blocked) {
      log('batch.refused', blocked.reason, { batchId });
      return { ...blocked, reason: `whatsapp: batch refused — ${blocked.reason}` };
    }
    batch = { id: batchId, remaining: maxSends, openedAt: new Date().toISOString() };
    log('batch.open', `batch=${batchId} allowance=${maxSends}`, { batchId, maxSends });
    return { ok: true, batchId, remaining: batch.remaining };
  }

  function closeBatch() {
    if (!batch) return { ok: true, wasOpen: false };
    const closed = { ...batch };
    batch = null;
    log('batch.close', `batch=${closed.id} unused=${closed.remaining}`, { batchId: closed.id });
    return { ok: true, wasOpen: true, unused: closed.remaining };
  }

  /**
   * The governed send. args follows upstream: send_message takes a
   * recipient (phone number or JID) + message; send_file /
   * send_audio_message take recipient + file. The gate reads
   * args.recipient and screens args.message / args.caption.
   */
  async function send(tool, args = {}) {
    if (!WHATSAPP_SEND_TOOLS.includes(tool)) {
      return refused(`whatsapp: '${tool}' is not a send tool`);
    }
    if (!batch) {
      const r = refused('whatsapp: no open batch — sends are a governed action and require a per-batch founder tap');
      log('send.refused', r.reason, { tool });
      return r;
    }
    if (batch.remaining <= 0) {
      const r = refused(`whatsapp: batch '${batch.id}' allowance exhausted — a new batch needs a new tap`);
      log('send.refused', r.reason, { tool, batchId: batch.id });
      return r;
    }
    if (!isKnownRecipient(args.recipient)) {
      const r = refused('whatsapp: recipient is not a known contact — refused (a batch tap never widens who can be reached)');
      log('send.refused', r.reason, { tool, batchId: batch.id });
      return r;
    }
    const outboundText = [args.message, args.caption].filter((t) => typeof t === 'string').join('\n');
    if (outboundText && csamHit(outboundText)) {
      log('csam-abort', `tool=${tool} where=outbound — content withheld by policy`, { tool, batchId: batch.id });
      return { ok: false, aborted: true, reason: 'CSAM auto-abort: no override path exists' };
    }
    if (typeof transport !== 'function') {
      const r = refused('whatsapp: no transport wired — refused by default');
      log('send.refused', r.reason, { tool, batchId: batch.id });
      return r;
    }
    const result = await transport(tool, args);
    batch.remaining -= 1;
    log('send', `tool=${tool} batch=${batch.id} remaining=${batch.remaining}`, {
      tool, batchId: batch.id, remaining: batch.remaining,
    });
    return { ok: true, tool, batchId: batch.id, remaining: batch.remaining, result };
  }

  return Object.freeze({
    callRead,
    openBatch,
    closeBatch,
    send,
    isKnownRecipient,
    batchState: () => (batch ? { ...batch } : null),
    auditPath: audit.path,
    verifyAudit: () => audit.verify(),
  });
}
