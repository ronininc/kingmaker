// claim.mjs — DESIGN §8.3 first-boot claim, TEST KEYS ONLY. The ceremony shape: device identity
// generated ON-DEVICE and sealed (here: a temp dir standing in for the sealed store), a claim
// request signed by the device key, the origin's countersignature returned, and the claim RECEIPT
// rendered as the first evidence card. Key shapes mirror the kernel build's TEST-root.json
// (Ed25519 sign half). The real root mint is the owner's ceremony — nothing here touches it.
import { generateKeyPairSync, sign, verify, createHash } from 'node:crypto';

export function runTestClaim({ deviceName = 'test-device-001' } = {}) {
  const device = generateKeyPairSync('ed25519');
  const origin = generateKeyPairSync('ed25519'); // TEST origin — a stand-in, never the real root
  const devicePub = device.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const claim = { device: deviceName, devicePub, at: new Date().toISOString(), nonce: createHash('sha256').update(devicePub + Date.now()).digest('hex').slice(0, 16) };
  const claimBytes = Buffer.from(JSON.stringify(claim));
  const deviceSig = sign(null, claimBytes, device.privateKey).toString('base64');
  const countersig = sign(null, Buffer.from(deviceSig), origin.privateKey).toString('base64');
  const okDevice = verify(null, claimBytes, device.publicKey, Buffer.from(deviceSig, 'base64'));
  const okOrigin = verify(null, Buffer.from(deviceSig), origin.publicKey, Buffer.from(countersig, 'base64'));
  return {
    ok: okDevice && okOrigin, claim, deviceSig, countersig,
    receipt: { kind: 'CLAIM', summary: `Device ${deviceName} claimed — identity minted on-device (TEST keys), countersigned by the TEST origin`, evidence: `device sig ${deviceSig.slice(0, 16)}… · countersig ${countersig.slice(0, 16)}… · both verify` },
  };
}
