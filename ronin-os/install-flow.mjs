// install-flow.mjs — DESIGN §8.1 + §9.2 as an executable record machine.
// Sequence: engine -> claim -> vault/armor -> mesh join (failures land in SEALED, never an error)
// -> surface enrollment -> THE BUTTON (own screen, after the claim commits; default No; equal clicks;
// a decline is recorded and never re-asked) -> replacement registration (only on accept).
// TEST identities only: every claim here is minted from the kernel build's TEST key material shape.
export function runInstall({ meshReachable = true } = {}) {
  const steps = []; const rec = { roninOS: 'not-asked', buttonAsked: 0, reprompts: 0 };
  steps.push('engine laid down');
  steps.push('identity claim committed (TEST identity)');
  steps.push('vault installed by the install; signer held in the vault');
  steps.push(meshReachable ? 'mesh join complete; entry check passed' : 'mesh unreachable — install completes; first boot is SEALED');
  rec.state = meshReachable ? 'OPS' : 'SEALED';
  steps.push('surface enrolled; lanes bound to this install\u2019s records');
  rec.steps = steps;
  return {
    record: rec, steps,
    askButton() { rec.buttonAsked++; rec.roninOS = 'asked'; return 'Would you also like Ronin OS?'; },
    answer(a) {
      if (a === 'yes') { rec.roninOS = 'accepted'; steps.push('Ronin OS accepted — replacement registered as the installer\u2019s last step'); }
      else { rec.roninOS = 'declined'; steps.push('Ronin OS declined — recorded; the question is never re-asked unbidden'); }
      return rec.roninOS;
    },
    relaunch() { if (rec.roninOS === 'declined') { /* no re-prompt, ever */ } return rec.roninOS; },
    acceptLater() { if (rec.roninOS === 'declined') { rec.roninOS = 'accepted'; steps.push('accepted later from inside Kingmaker — identical provisioning, its own receipt'); } return rec.roninOS; },
    remove() { if (rec.roninOS === 'accepted') { rec.roninOS = 'removed'; steps.push('Ronin OS removed — §8.4 reversal, residue list receipted'); } return rec.roninOS; },
  };
}
