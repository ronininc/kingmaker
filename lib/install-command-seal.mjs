// lib/install-command-seal.mjs — THE SEALED INSTALL COMMAND (Kingmaker code;
// the Launcher-button ruling, Robbie, 2026-10-29 14:23–14:24 MST: the CRM
// serves the install commands "through the installer", and in the Launcher
// "the commands go under a button … they can't see it — also in scripture
// armor's shield").
//
// A product's install command used to be a plaintext catalog string —
// rendered on cards, shipped in page data, visible to anyone who viewed
// source. It is now an opaque Scripture Armor envelope, the shape the CRM
// serves as `install.commandSealed` (never `install.command`):
//
//   { schema: 'ronin.install-command/1', product: '<product id>',
//     package: '<armor package text>',        the command spec, sealed
//     keyPackage: '<armor package text>',     the recipient doc, sealed
//     pin: { schema: 'kingmaker.release-manifest-pin/1', signerSignFp,
//            escrowIdentity } }
//
// The plaintext inside `package` is a command SPEC, not a shell string:
//   { package: '@ronininc/kingmaker', argv: ['install'] }
// — the npm package the command would name, and the argument vector its
// binary runs. The consumer (Launcher core, or the npm shim invoked with
// the envelope) unseals it IN MEMORY and executes the steps internally;
// the familiar `npx @ronininc/…` line is never materialized anywhere —
// not served, not rendered, not logged, not written to disk.
//
// CUSTODY — stated honestly: this is the F-03 / manifest pattern (signer →
// per-bake escrow), NOT per-install sealing. A catalog is built before any
// install exists, so there is no install identity to seal to at catalog
// time; instead each catalog bake mints a per-bake command recipient, its
// document sealed by the operator's signer to a per-bake escrow whose
// document rides in the envelope's pin. The bootstrap is the same one-way
// door the manifest trio uses: pin's escrow identity opens keyPackage →
// recipient → opens package. Anyone holding the envelope can open it —
// the shield's job here is that the command never travels or rests as
// plaintext and only a signer-sealed envelope is accepted (pin-checked),
// not that the envelope is a secret from its intended recipient.
//
// The seal/open call lib/armor-bundle.mjs's package functions through
// lib/release-parts-seal.mjs's session bootstrap. No new cryptography.
import { createReleaseSealSession, openSealedReleasePackage } from './release-parts-seal.mjs';

export const INSTALL_COMMAND_SCHEMA = 'ronin.install-command/1';

/** The command spec the envelope carries: which package, which argv. */
export function installCommandSpec({ packageName, argv } = {}) {
  if (typeof packageName !== 'string' || !packageName) throw new Error('install-command-seal: a spec needs the npm package name');
  if (!Array.isArray(argv) || argv.length === 0 || argv.some((a) => typeof a !== 'string')) {
    throw new Error('install-command-seal: a spec needs a non-empty argv of strings');
  }
  return { package: packageName, argv: [...argv] };
}

/**
 * Seal one product's command spec into the served envelope. `signerIdentity`
 * is the operator's loaded armor identity (the bake never mints one — the
 * session refuses without it, like every seal in this tree). Returns the
 * envelope object, ready to embed as `commandSealed` in catalog/dock data.
 */
export function sealInstallCommand({ product, packageName, argv } = {}, { signerIdentity, scratchRoot } = {}) {
  if (typeof product !== 'string' || !product) throw new Error('install-command-seal: an envelope needs its product id');
  const spec = installCommandSpec({ packageName, argv });
  const session = createReleaseSealSession({ signerIdentity, scratchRoot });
  const sealedText = session.seal(Buffer.from(JSON.stringify(spec), 'utf8'));
  const envelope = {
    schema: INSTALL_COMMAND_SCHEMA,
    product,
    package: sealedText,
    keyPackage: session.escrowText,
    pin: session.pin(),
  };
  // Fail closed: the envelope must open back to the spec that went in.
  const opened = openInstallCommand(envelope, scratchRoot);
  if (opened.package !== spec.package || JSON.stringify(opened.argv) !== JSON.stringify(spec.argv)) {
    throw new Error('install-command-seal: the sealed command did not round-trip — refusing to emit it');
  }
  return envelope;
}

/**
 * Open a served envelope back to its command spec, in memory. Throws the
 * underlying coded ArmorBundleError on any tamper, wrong signer, or bad
 * shape — consumers treat every throw as fatal and never fall back to a
 * plaintext command (there is none).
 */
export function openInstallCommand(envelope, scratchRoot) {
  if (!envelope || envelope.schema !== INSTALL_COMMAND_SCHEMA) {
    throw new Error(`install-command-seal: not a ${INSTALL_COMMAND_SCHEMA} envelope`);
  }
  if (typeof envelope.package !== 'string' || typeof envelope.keyPackage !== 'string' || !envelope.pin) {
    throw new Error('install-command-seal: the envelope is missing its package, key package, or pin');
  }
  const { plaintext } = openSealedReleasePackage(
    { sealedText: envelope.package, escrowText: envelope.keyPackage, pin: envelope.pin },
    scratchRoot,
  );
  let spec;
  try { spec = JSON.parse(plaintext.toString('utf8')); } catch { throw new Error('install-command-seal: the sealed command did not contain a command spec'); }
  return installCommandSpec({ packageName: spec?.package, argv: spec?.argv });
}

/** Shape check for envelope data arriving over the wire (dock/catalog). */
export function isSealedInstallCommand(x) {
  return !!x && typeof x === 'object'
    && x.schema === INSTALL_COMMAND_SCHEMA
    && typeof x.product === 'string' && x.product.length > 0
    && typeof x.package === 'string' && x.package.startsWith('SCRIPTURE-ARMOR v4')
    && typeof x.keyPackage === 'string' && x.keyPackage.startsWith('SCRIPTURE-ARMOR v4')
    && !!x.pin && x.pin.schema === 'kingmaker.release-manifest-pin/1'
    && typeof x.pin.signerSignFp === 'string' && !!x.pin.escrowIdentity;
}
