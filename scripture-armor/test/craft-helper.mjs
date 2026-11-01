// craft-helper.mjs — battery-only attack fixture builder: re-sign a
// package's frame under the sender store's own key after mutating
// frame fields (body + sealed file key untouched). This is the
// "holder of a legitimately wrapped package edits its frame and
// re-signs as the sender" shape — the daemon's registry cross-checks
// (return-match, scan binding, tier binding) are what must refuse it.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseScriptureFile, frameSignData } from '../armor.mjs';

const fpOfX = (x) => crypto.createHash('sha256').update(Buffer.from(x, 'base64url')).digest('hex');

export function craftResignedFile(pkgPath, outPath, mutate, signerStoreDir) {
  const { frame, body } = parseScriptureFile(fs.readFileSync(pkgPath, 'utf8'));
  mutate(frame);
  const signer = JSON.parse(fs.readFileSync(path.join(signerStoreDir, 'identity.json'), 'utf8'));
  frame.sender_sign_pub = signer.sign_pub;
  frame.sender_sign_fp = fpOfX(signer.sign_pub);
  const priv = crypto.createPrivateKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: signer.sign_pub, d: signer.sign_priv },
    format: 'jwk',
  });
  frame.sig = crypto.sign(null, frameSignData(frame, body), priv).toString('base64');
  fs.writeFileSync(outPath, `SCRIPTURE-ARMOR v${frame.v}\n${JSON.stringify(frame)}\n${body}\n`);
  return frame;
}
