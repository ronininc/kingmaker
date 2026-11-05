import test from 'node:test';
import assert from 'node:assert/strict';
import { createArmorAccountSession } from '../account-session.mjs';
import { verifyArmorEntitlement } from '../entitlement-client.mjs';
import { activateArmor } from '../activation-flow.mjs';
const installationProvider = () => ({ installationId: 'c'.repeat(64), installationEvidenceRef: 'local-metadata-sha256:' + 'd'.repeat(64) });
const NOW = Math.floor(Date.now() / 1000), EMAIL = 'member@example.test', PASSWORD = 'synthetic-long-password', OTP = '12345678', COOKIE = `ronin_armor=${'a'.repeat(64)}`;
const response = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
function fixture() {
  const seen = []; let expire = false, denyEntitlement = false;
  const fetchImpl = async (url, options) => {
    seen.push({ url, options, body: options.body ? JSON.parse(options.body) : null });
    assert.equal(new URL(url).origin, 'https://www.ronininc.org'); assert.equal(options.redirect, 'manual');
    const action = new URL(url).pathname.split('/').pop();
    if (['login','register','resend'].includes(action)) return response({ ok: true, emailCodeRequired: true, email: EMAIL, purpose: action === 'resend' ? JSON.parse(options.body).purpose : action, challengeId: 'fixture-challenge', expiresAt: NOW + 600 }, 202);
    if (action === 'verify') {
      if (JSON.parse(options.body).code !== OTP) return response({ ok: false, error: PASSWORD }, 403);
      return response({ ok: true, mfaVerified: true, member: { email: EMAIL, paid: false } }, 200, { 'set-cookie': `${COOKIE}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=43200` });
    }
    if (action === 'me') return expire ? response({ ok: false, member: null }, 401) : response({ ok: true, mfaVerified: true, member: { email: EMAIL, paid: false, mfa_verified_at: NOW } });
    if (action === 'check') return response({ ok: true, active: true, installationId: JSON.parse(options.body).installationId, quotaReservationOnly: true, deviceAdmissionGranted: false });
    if (action === 'entitlement') return denyEntitlement ? response({ ok: false }, 403) : response({ schema: 'ronin.armor-entitlement/v1', product: 'scripture-armor', entitled: true, verifiedAt: NOW, term: { startsAt: NOW - 1, endsAt: NOW + 3600 }, discordAccess: 'separate_verified_admission_required' });
    if (action === 'logout') return response({ ok: true });
    throw new Error('unexpected remote route');
  };
  return { seen, fetchImpl, expire: () => { expire = true; }, denyEntitlement: () => { denyEntitlement = true; } };
}
test('password + email OTP establish private cookie, then fresh me + entitlement; public state omits every secret', async () => {
  const f = fixture(), account = createArmorAccountSession({ installationProvider, fetchImpl: f.fetchImpl, now: () => NOW });
  await assert.rejects(account.verifyEntitlement(), /Sign in/); assert.equal(f.seen.length, 0);
  const challenge = await account.login({ email: EMAIL, password: PASSWORD, authCookie: COOKIE, seat_key: 'ignored' });
  assert.equal(challenge.authenticated, false); assert.equal(challenge.challengePending, true);
  assert.deepEqual(f.seen[0].body, { email: EMAIL, password: PASSWORD }); assert.equal(f.seen[0].options.headers.cookie, undefined);
  await assert.rejects(account.verify({ code: '00000000' }), /failed/); assert.equal(account.state().authenticated, false);
  const loggedIn = await account.verify({ code: OTP }); assert.equal(loggedIn.authenticated, true);
  const receipt = await account.verifyEntitlement(); assert.ok(receipt.term.endsAt > NOW);
  const entitlementCall = f.seen.find((call) => call.url.endsWith('/entitlement'));
  assert.deepEqual(entitlementCall.body, {}); assert.equal(entitlementCall.options.headers.cookie, COOKIE);
  const publicData = JSON.stringify({ loggedIn, receipt, state: account.state(), api: account });
  for (const secret of [COOKIE, PASSWORD, OTP]) assert.equal(publicData.includes(secret), false);
  await account.logout(); assert.equal(account.state().authenticated, false);
  assert.equal(f.seen.at(-1).options.headers.cookie, COOKIE);
});
test('resend requires password and original purpose; expired session and entitlement denial lock', async () => {
  const f = fixture(), account = createArmorAccountSession({ installationProvider, fetchImpl: f.fetchImpl, now: () => NOW });
  await account.register({ name: 'Fixture Member', email: EMAIL, password: PASSWORD });
  await account.resend({ password: PASSWORD }); assert.deepEqual(f.seen.at(-1).body, { email: EMAIL, password: PASSWORD, purpose: 'register' });
  await account.verify({ code: OTP }); f.expire(); await assert.rejects(account.verifyEntitlement(), /expired|failed/); assert.equal(account.state().authenticated, false);
  const g = fixture(), other = createArmorAccountSession({ installationProvider, fetchImpl: g.fetchImpl, now: () => NOW });
  await other.login({ email: EMAIL, password: PASSWORD }); await other.verify({ code: OTP }); g.denyEntitlement();
  await assert.rejects(other.verifyEntitlement(), /current paid/); assert.equal(other.state().authenticated, false);
});
test('redirects, oversized bodies and unresponsive remote transport stay bounded and locked', async () => {
  for (const fetchImpl of [async () => new Response('', { status: 302, headers: { location: 'https://elsewhere.invalid' } }), async () => response({ ok: true, pad: 'x'.repeat(33000) }), async () => new Promise(() => {})]) {
    const account = createArmorAccountSession({ installationProvider, fetchImpl, timeoutMs: 25 });
    await assert.rejects(account.login({ email: EMAIL, password: PASSWORD })); assert.equal(account.state().authenticated, false);
  }
});
test('trusted-cookie option ignores body credentials and rejects header injection / absent mandatory MFA session', async () => {
  await assert.rejects(verifyArmorEntitlement({ authCookie: COOKIE, seat_key: 'old-key' }, { requireAccountSession: true, fetchImpl: async () => { throw new Error('must not call'); } }), /Sign in/);
  await assert.rejects(verifyArmorEntitlement({}, { requestCookie: COOKIE + '\r\nx-test: injected' }), /Invalid/);
});
export { fixture, EMAIL, PASSWORD, OTP, COOKIE };

test('a 202 with any cookie is refused; me must prove current email MFA, not just a paid flag', async () => {
  const f = fixture();
  const badChallenge = createArmorAccountSession({ installationProvider, now: () => NOW, fetchImpl: async () => response({ ok: true, emailCodeRequired: true, email: EMAIL, purpose: 'login', challengeId: 'fixture', expiresAt: NOW + 30 }, 202, { 'set-cookie': 'ronin_session=old; HttpOnly; Secure' }) });
  await assert.rejects(badChallenge.login({ email: EMAIL, password: PASSWORD }), /challenge/);
  for (const member of [{ email: EMAIL, paid: true }, { email: EMAIL, paid: true, mfa_verified_at: NOW - 43201 }, { email: 'other@example.test', paid: true, mfa_verified_at: NOW }]) {
    const account = createArmorAccountSession({ installationProvider, now: () => NOW, fetchImpl: (url, opts) => url.endsWith('/me') ? Promise.resolve(response({ ok: true, mfaVerified: true, member })) : f.fetchImpl(url, opts) });
    await account.login({ email: EMAIL, password: PASSWORD }); await assert.rejects(account.verify({ code: OTP })); assert.equal(account.state().authenticated, false);
  }
});

test('transport exceptions cannot echo credentials even when their text contains a known error phrase', async () => {
  const account = createArmorAccountSession({ installationProvider, fetchImpl: async () => { throw new Error('timed out ' + PASSWORD); } });
  await assert.rejects(account.login({ email: EMAIL, password: PASSWORD }), (error) => !error.message.includes(PASSWORD));
});

test('safe live account errors reach the dashboard instead of becoming a false session-expired message', async () => {
  for (const [status, serverError] of [[401, 'Wrong email or password.'], [409, 'An account already uses that email. Sign in instead.']]) {
    const account = createArmorAccountSession({ installationProvider, fetchImpl: async () => response({ ok: false, error: serverError }, status) });
    await assert.rejects(account.login({ email: EMAIL, password: PASSWORD }), (error) => error.message === serverError);
    assert.equal(account.state().authenticated, false);
  }
  const locked = createArmorAccountSession({ installationProvider, fetchImpl: async () => response({ ok: false, error: PASSWORD }, 401) });
  await assert.rejects(locked.login({ email: EMAIL, password: PASSWORD }), (error) => error.message === 'Account verification failed or the session expired. Access remains locked.' && !error.message.includes(PASSWORD));
});

test('trusted entitlement call has a hard deadline even if injected transport ignores abort', async () => {
  await assert.rejects(verifyArmorEntitlement({}, { requestCookie: COOKIE, requireAccountSession: true, timeoutMs: 25, fetchImpl: async () => new Promise(() => {}) }), /unavailable/);
});

test('real session transport + activation flow cannot create identity or migrate before OTP and fresh entitlement', async () => {
  const f = fixture(), account = createArmorAccountSession({ installationProvider, fetchImpl: f.fetchImpl, now: () => NOW }), effects = [];
  const activate = () => activateArmor({ input: { acceptTerms: true, confirmMigration: true }, alreadyActive: false, verifyEntitlement: () => account.verifyEntitlement(),
    ensureIdentity: () => { effects.push('identity'); return { id: 'fixture' }; }, acceptTerms: () => effects.push('terms'),
    migrateCredentials: () => { effects.push('migration'); return { imported: [] }; }, recordFeed: () => effects.push('feed'), recordPaidActivation: () => effects.push('paid-marker') });
  await assert.rejects(activate()); assert.deepEqual(effects, []);
  await account.login({ email: EMAIL, password: PASSWORD }); await assert.rejects(activate()); assert.deepEqual(effects, []);
  await assert.rejects(account.verify({ code: '00000000' })); await assert.rejects(activate()); assert.deepEqual(effects, []);
  await account.verify({ code: OTP }); await activate();
  assert.deepEqual(effects, ['identity','terms','migration','feed','paid-marker']);
  const g = fixture(), denied = createArmorAccountSession({ installationProvider, fetchImpl: g.fetchImpl, now: () => NOW });
  await denied.login({ email: EMAIL, password: PASSWORD }); await denied.verify({ code: OTP }); g.denyEntitlement();
  await assert.rejects(activateArmor({ input: { acceptTerms: true, confirmMigration: true }, verifyEntitlement: () => denied.verifyEntitlement(), ensureIdentity: () => { throw new Error('must never execute'); } }));
  assert.equal(denied.state().authenticated, false);
});

test('entitlement verification defaults to requiring a trusted MFA cookie; legacy body credentials cannot opt out', async () => {
  await assert.rejects(verifyArmorEntitlement({ seat_key: 'legacy-seat', email: EMAIL, code: 'legacy-code', requireAccountSession: false, authCookie: COOKIE }, { fetchImpl: async () => { throw new Error('must never call'); } }), /Sign in/);
});

test('credential-proven existing registration resolves login purpose and still requires OTP', async () => {
  const f=fixture();
  const account=createArmorAccountSession({now:()=>NOW,fetchImpl:async(url,options)=> {
    if(url.endsWith('/register')) return response({ok:true,emailCodeRequired:true,email:EMAIL,purpose:'login',existingAccount:true,challengeId:'linked-account',expiresAt:NOW+600},202);
    return f.fetchImpl(url,options);
  }});
  const state=await account.register({name:'Member',email:'  MEMBER@example.test ',password:PASSWORD});
  assert.equal(state.purpose,'login'); assert.equal(state.authenticated,false);
  await assert.rejects(account.ensureAuthenticated(),/verify/);
  await account.resend({password:PASSWORD}); assert.equal(f.seen.at(-1).body.purpose,'login');
  await assert.rejects(account.verify({code:'00000000'})); assert.equal(account.state().authenticated,false);
  await account.verify({code:OTP}); assert.equal(f.seen.find(x=>x.url.endsWith('/verify')).body.purpose,'login');
  assert.equal(account.state().authenticated,true);
});
test('unexpected challenge purpose changes, missing link flag, email mismatch and cookie fail closed', async () => {
  for(const [action,body,headers] of [
    ['register',{purpose:'login'},{}],['register',{purpose:'login',existingAccount:false},{}],
    ['login',{purpose:'register',existingAccount:true},{}],['register',{purpose:'login',existingAccount:true,email:'other@example.test'},{}],
    ['register',{purpose:'login',existingAccount:true},{'set-cookie':COOKIE}],
    ['register',{purpose:'login',existingAccount:true,expiresAt:NOW-1},{}],
  ]) {
    const account=createArmorAccountSession({now:()=>NOW,fetchImpl:async()=>response({ok:true,emailCodeRequired:true,email:EMAIL,challengeId:'linked',expiresAt:NOW+600,...body},202,headers)});
    await assert.rejects(account[action]({name:'Member',email:EMAIL,password:PASSWORD}),/challenge/);
    assert.equal(account.state().authenticated,false); assert.equal(account.state().challengePending,false);
  }
});
test('password exact spaces case Unicode and long values survive login register resend without persistence', async () => {
  const secret='  Exact Åß😀 CASE '+ 'x'.repeat(3000)+'  ';
  const f=fixture(), account=createArmorAccountSession({now:()=>NOW,fetchImpl:f.fetchImpl});
  await account.login({email:EMAIL,password:secret});
  await account.register({name:'Member',email:EMAIL,password:secret});
  await account.resend({password:secret});
  for(const call of f.seen) assert.equal(call.body.password,secret);
  assert.equal(JSON.stringify(account.state()).includes(secret),false);
  assert.equal(account.state().authenticated,false);
});
test('encoded whole request limit refuses oversized password before transport without truncating', async () => {
  let calls=0;
  const account=createArmorAccountSession({now:()=>NOW,fetchImpl:async()=>{calls++;throw new Error('must not call');}});
  await assert.rejects(account.login({email:EMAIL,password:'😀'.repeat(17000)}),/64 KiB/);
  await assert.rejects(account.register({name:'Member',email:EMAIL,password:'\u0001'.repeat(12000)}),/64 KiB/);
  assert.equal(calls,0); assert.equal(account.state().authenticated,false);
});
