/**
 * whatsapp-mcp tests — fake transport only. Zero network, nothing sent:
 * the "transport" records calls in memory.
 */

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWhatsAppGate, WHATSAPP_READ_TOOLS, WHATSAPP_SEND_TOOLS } from '../lib/whatsapp-gate.mjs';

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}`); }
}

const dir = mkdtempSync(join(tmpdir(), 'km42-wa-'));
const auditPath = join(dir, 'audit.jsonl');
const sent = [];
const transport = async (tool, args) => {
  if (WHATSAPP_SEND_TOOLS.includes(tool)) { sent.push({ tool, args }); return { messageId: `fake-${sent.length}` }; }
  return [{ chat: 'fake' }];
};
const tap = async (t) => t === 'founder-token';
const contacts = [
  { name: 'Known Person', phone: '+1 (555) 010-2030' },
  { name: 'Team Group', jid: '120363000000000000@g.us' },
];

const gate = createWhatsAppGate({ transport, knownContacts: contacts, verifyTap: tap, auditPath });

// 0. Tool split matches upstream README (9 read, 3 send).
check('tool split is 9 read / 3 send', WHATSAPP_READ_TOOLS.length === 9 && WHATSAPP_SEND_TOOLS.length === 3);

// 1. Reads are ambient and audited.
const r1 = await gate.callRead('list_chats');
check('read passes without any tap', r1.ok === true);
check('send tool via the read path refuses', (await gate.callRead('send_message', {})).ok === false);

// 2. A send with NO batch refuses — sends are never ambient.
const r2 = await gate.send('send_message', { recipient: '15550102030', message: 'hi' });
check('send without batch refuses', r2.ok === false && /per-batch founder tap/.test(r2.reason));
check('nothing reached the transport', sent.length === 0);

// 3. A bad tap cannot open a batch.
const r3 = await gate.openBatch({ tapToken: 'nope', batchId: 'b1', maxSends: 2 });
check('bad tap refuses batch', r3.ok === false && gate.batchState() === null);

// 4. The founder tap opens a batch; sends fire without per-item prompts.
const r4 = await gate.openBatch({ tapToken: 'founder-token', batchId: 'b1', maxSends: 2 });
check('batch opens with founder tap', r4.ok === true && r4.remaining === 2);
check('second batch refused while one is open', (await gate.openBatch({ tapToken: 'founder-token', batchId: 'b2' })).ok === false);

const s1 = await gate.send('send_message', { recipient: '+1 555 010 2030', message: 'first' });
check('known contact by phone (formatted) sends', s1.ok === true && s1.remaining === 1);
const s2 = await gate.send('send_message', { recipient: '120363000000000000@g.us', message: 'group note' });
check('registered group JID sends', s2.ok === true && s2.remaining === 0);

// 5. Allowance exhausted → refuse, even to a known contact.
const s3 = await gate.send('send_message', { recipient: '15550102030', message: 'third' });
check('exhausted batch refuses', s3.ok === false && /exhausted/.test(s3.reason));
check('exactly the allowance reached the transport', sent.length === 2);

// 6. Close + reopen; unknown recipients refuse INSIDE a batch too.
await gate.closeBatch();
await gate.openBatch({ tapToken: 'founder-token', batchId: 'b3', maxSends: 5 });
const s4 = await gate.send('send_message', { recipient: '19998887777', message: 'stranger' });
check('stranger refuses inside an open batch', s4.ok === false && /known contact/.test(s4.reason));
const s5 = await gate.send('send_message', { recipient: '15550102030', message: 'known again' });
check('known contact still sends in the new batch', s5.ok === true && sent.length === 3);

// 7. CSAM outbound aborts before the transport.
const s6 = await gate.send('send_message', { recipient: '15550102030', message: 'child porn' });
check('CSAM outbound auto-aborts', s6.ok === false && s6.aborted === true && sent.length === 3);

// 8. Media sends are governed by the same gate.
const s7 = await gate.send('send_file', { recipient: '15550102030', file: '/tmp/x.png' });
check('send_file draws on the same batch allowance', s7.ok === true && sent.length === 4);

// 9. Audit: chain verifies; sends, opens, refusals present; NO bodies.
check('audit chain verifies', gate.verifyAudit().ok === true);
const logText = readFileSync(auditPath, 'utf8');
check('audit logged batch.open + send + refusals', logText.includes('"action":"batch.open"') && logText.includes('"action":"send"') && logText.includes('"action":"send.refused"'));
check('message bodies never land in the audit log', !logText.includes('group note') && !logText.includes('known again'));

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail === 0 ? 0 : 1);
