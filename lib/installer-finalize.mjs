// Final mutation and verification boundary for a production Installer DMG.
// Verification is deliberately last: notarization/stapling changes the bytes.
export async function finalizeInstallerRelease({ image, identity, notaryProfile, notarize, verify }) {
  const events = [];
  if (String(identity).startsWith('Developer ID Application:') && notaryProfile) {
    await notarize(image, notaryProfile); events.push('notarized-and-stapled');
  } else events.push('not-notarized');
  await verify(image); events.push('verified-final-bytes');
  return events;
}
