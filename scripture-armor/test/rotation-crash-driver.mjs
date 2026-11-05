// Test driver: rotates a synthetic store in a child process and exits
// abruptly (exit 86, no cleanup, no catch) immediately after a named
// rotation phase — a real kill-mid-rotation for the recovery test.
// Usage: node rotation-crash-driver.mjs <storeDir> <killPhase> <authorityPrivPemPath>
import fs from 'node:fs';
import crypto from 'node:crypto';
import { SyntheticIdentityStore, SyntheticOwnerAuthorizer } from '../rotation-runtime.mjs';

const [dir, killPhase, authPrivPath] = process.argv.slice(2);
const store = SyntheticIdentityStore.open(dir);
const authorizer = new SyntheticOwnerAuthorizer({ approver: () => true });
const authorityPrivateKey = crypto.createPrivateKey(fs.readFileSync(authPrivPath, 'utf8'));
store.rotate({
  authorizer,
  authorityPrivateKey,
  requestAuthorization: binding => authorizer.authorize('rotate', binding),
  hooks: { afterPhase(phase) { if (phase === killPhase) process.exit(86); } },
});
console.log('rotation completed without kill');
