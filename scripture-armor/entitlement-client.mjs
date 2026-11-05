const ENTITLEMENT_URL = 'https://www.ronininc.org/api/armor/entitlement';
const RONIN_ORIGIN = 'https://www.ronininc.org';
const MAX_RESPONSE_BYTES = 32 * 1024;
const MAX_CLOCK_SKEW_SECONDS = 300;

function credentialBody(input = {}) {
  const seatKey = String(input.seat_key || '').trim().slice(0, 80);
  if (seatKey) return { seat_key: seatKey };
  const email = String(input.email || '').trim().toLowerCase().slice(0, 200);
  const code = String(input.code || '').trim().toUpperCase().slice(0, 40);
  if (!email || !code) throw new Error('Enter your membership email and application code, or a seat key.');
  return { email, code };
}

async function boundedText(response) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error('Membership response was too large.');
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error('Membership response was too large.');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

export async function verifyArmorEntitlement(input, { fetchImpl = globalThis.fetch, now = () => Math.floor(Date.now() / 1000), timeoutMs = 10_000, requestCookie = null, requireAccountSession = true } = {}) {
  if (requestCookie !== null && !/^ronin_armor=[a-f0-9]{64}$/.test(requestCookie)) throw new Error('Invalid account session.');
  if (requireAccountSession && !requestCookie) throw new Error('Sign in and verify the email code first.');
  if (typeof fetchImpl !== 'function') throw new Error('Membership verification is unavailable.');
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('Membership verification is unavailable. Access remains locked.')); }, Math.max(1, Math.min(Number(timeoutMs) || 10_000, 10_000))); });
  try {
    return await Promise.race([(async () => {
    const response = await fetchImpl(ENTITLEMENT_URL, {
      method: 'POST',
      redirect: 'manual',
      signal: controller.signal,
      headers: { origin: RONIN_ORIGIN, accept: 'application/json', 'content-type': 'application/json', ...(requestCookie ? { cookie: requestCookie } : {}) },
      body: JSON.stringify(requestCookie ? {} : credentialBody(input)),
    });
    if (response.status !== 200) throw new Error(response.status === 403 ? 'A current paid Scripture Armor membership is required.' : 'Membership verification is unavailable. Access remains locked.');
    if (!/^application\/json(?:;|$)/i.test(response.headers.get('content-type') || '')) throw new Error('Membership verification returned an invalid response.');
    let receipt;
    try { receipt = JSON.parse(await boundedText(response)); } catch (error) {
      if (controller.signal.aborted) throw new Error('Membership verification is unavailable. Access remains locked.');
      if (/too large/.test(error.message)) throw error;
      throw new Error('Membership verification returned an invalid response.');
    }
    const at = now();
    const startsAt = Number(receipt?.term?.startsAt);
    const endsAt = Number(receipt?.term?.endsAt);
    const verifiedAt = Number(receipt?.verifiedAt);
    if (receipt?.schema !== 'ronin.armor-entitlement/v1'
      || receipt?.product !== 'scripture-armor'
      || receipt?.entitled !== true
      || receipt?.discordAccess !== 'separate_verified_admission_required'
      || !Number.isInteger(startsAt) || !Number.isInteger(endsAt) || startsAt > at || endsAt <= at
      || !Number.isInteger(verifiedAt) || Math.abs(at - verifiedAt) > MAX_CLOCK_SKEW_SECONDS) {
      throw new Error('Membership verification returned an invalid or expired entitlement.');
    }
    return Object.freeze({ schema: receipt.schema, product: receipt.product, verifiedAt, term: Object.freeze({ startsAt, endsAt }), discordAccess: receipt.discordAccess });
    })(), deadline]);
  } catch (error) {
    if (/current paid|invalid|expired|too large/.test(error?.message || '')) throw error;
    throw new Error('Membership verification is unavailable. Access remains locked.');
  } finally {
    clearTimeout(timer);
  }
}

export const armorEntitlementEndpoint = ENTITLEMENT_URL;
