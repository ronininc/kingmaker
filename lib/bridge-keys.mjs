/**
 * Kingmaker — the Bridge: rotating key agreement engine.
 *
 * The trust foundation. Two keys are born at setup — one for the
 * installer/launcher side, one for Kingmaker at first install. They
 * mutually authenticate (docking), then prove liveness with rotating
 * call signs. The long-term keys are never seen after setup; only
 * call signs travel.
 *
 * Sovereign by construction: no GitHub Actions, no billing, no
 * server. Both sides derive the same 24h call signs independently
 * from a shared seed established at pairing — seeded deterministic
 * rotation, synchronized with nothing but math.
 *
 * Pure functions + injected deps. No I/O, no network.
 */
import { createHash } from 'node:crypto';

/** 296 call signs per cycle, 6 digits each, rotating every 24 hours. */
export const CALL_SIGNS_PER_CYCLE = 296;
export const ROTATION_HOURS = 24;

/**
 * Pair the two sides. In production `randomBytes` is node:crypto's;
 * tests inject fixed bytes. Returns { installerId, kingmakerId, seedHex }.
 * The seed is the shared secret both sides derive call signs from.
 */
export function seedPairing({ randomBytes }) {
  const seed = randomBytes(37); // 296 bits of entropy
  const seedHex = Buffer.from(seed).toString('hex');
  const id = (label) =>
    createHash('sha256').update(label).update(seed).digest('hex').slice(0, 16);
  return {
    installerId: `inst-${id('installer')}`,
    kingmakerId: `km-${id('kingmaker')}`,
    seedHex,
  };
}

/**
 * Deterministically derive the 296 call signs from the shared seed.
 * Hash chain: sign[i] = first-6-digits(SHA256(seed || i)).
 * Random to any observer; identical on both sides.
 */
export function deriveCallSigns(seedHex, count = CALL_SIGNS_PER_CYCLE) {
  const signs = [];
  for (let i = 0; i < count; i++) {
    const h = createHash('sha256').update(seedHex).update(String(i)).digest('hex');
    const num = parseInt(h.slice(0, 8), 16) % 1_000_000;
    signs.push(String(num).padStart(6, '0'));
  }
  return signs;
}

/** Which day of the cycle we're in: days since epoch, mod 296. */
export function cycleDay(atMs = Date.now()) {
  return Math.floor(atMs / (1000 * 60 * 60 * ROTATION_HOURS)) % CALL_SIGNS_PER_CYCLE;
}

/**
 * The currently valid call signs: today's plus a small window around
 * it (clock-drift tolerance). Everything outside the window is retired —
 * a stolen call sign must not work forever.
 */
export function activeWindow(signs, atMs = Date.now(), width = 1) {
  const day = cycleDay(atMs);
  const out = [];
  for (let d = -width; d <= width; d++) {
    out.push(signs[(day + d + signs.length) % signs.length]);
  }
  return out;
}

/**
 * Verify a presented call sign for docking. Returns { ok, reason }.
 * Both sides run this on each other's proof: mutual authentication.
 */
export function verifyDock(presentedCode, signs, atMs = Date.now(), width = 1) {
  const code = String(presentedCode ?? '').padStart(6, '0');
  if (!/^\d{6}$/.test(code)) return { ok: false, reason: 'malformed call sign' };
  const valid = activeWindow(signs, atMs, width);
  if (valid.includes(code)) return { ok: true, reason: 'docked' };
  if (signs.includes(code)) return { ok: false, reason: 'retired call sign — outside the active window' };
  return { ok: false, reason: 'unknown call sign — not from this pairing' };
}
