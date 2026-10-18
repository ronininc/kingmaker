import test from 'node:test';
import assert from 'node:assert/strict';
import { callOwner, e164, readPhone, savePhone, twiml } from '../lib/phone.mjs';

const SID = 'AC' + 'a'.repeat(32); const TOKEN = 'b'.repeat(32);

test('numbers: US 10/11 digits and +E.164 accepted, junk refused', () => {
  assert.equal(e164('(602) 555-0100'), '+16025550100');
  assert.equal(e164('1 602 555 0100'), '+16025550100');
  assert.equal(e164('+44 20 7946 0958'), '+442079460958');
  assert.equal(e164('call me'), null);
});

test('the saved setup round-trips through the Keychain, secrets on stdin only', () => {
  const store = {}; const calls = [];
  const run = (args, input) => {
    calls.push({ args, input });
    if (args[0] === '-i') { store.v = input.match(/-w (\S+)\n$/)[1]; return { status: 0, stdout: '' }; }
    if (args[0] === 'find-generic-password') return store.v ? { status: 0, stdout: store.v + '\n' } : { status: 44, stdout: '' };
    return { status: 0, stdout: '' };
  };
  savePhone({ sid: SID, token: TOKEN, from: '602 555 0100', to: '(480) 555-0199' }, { run });
  assert.ok(calls.every((c) => !c.args.join(' ').includes(TOKEN)), 'the token never rides on argv');
  assert.deepEqual(readPhone({ run }), { sid: SID, token: TOKEN, from: '+16025550100', to: '+14805550199' });
  assert.throws(() => savePhone({ sid: 'nope', token: TOKEN, from: '6025550100', to: '4805550199' }, { run }));
});

test('a call goes only to the saved owner number, with the update spoken and escaped', async () => {
  let sent;
  const fetchImpl = async (url, opts) => { sent = { url, body: new URLSearchParams(opts.body) }; return { ok: true, json: async () => ({ sid: 'CA1' }) }; };
  const r = await callOwner('Update <ready> & waiting', { phone: { sid: SID, token: TOKEN, from: '+16025550100', to: '+14805550199' }, fetchImpl });
  assert.equal(r.ok, true);
  assert.match(sent.url, /^https:\/\/api\.twilio\.com\//);
  assert.equal(sent.body.get('To'), '+14805550199');
  assert.match(sent.body.get('Twiml'), /Update &lt;ready&gt; &amp; waiting/);
  assert.equal((await callOwner('x', { phone: null })).ok, false);
  assert.ok(!twiml('<Dial>+15550000</Dial>').includes('<Dial>'), 'spoken text can never become a TwiML verb');
});
