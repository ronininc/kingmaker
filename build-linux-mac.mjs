// Linux 1.2.2 bundle build for the Mac seat — the builder's own buildStandalone,
// Mac paths, no sandbox shim (the Mac has no write guard).
const { buildStandalone } = await import('/Users/robbiebrown/armor-122-build/scripture-armor/build-standalone.mjs');
await buildStandalone([
  '--out', '/Users/robbiebrown/armor-122-build/out-122/linux-bundle',
  '--ghidra-home', '/Users/robbiebrown/armor-mac-build/tools/ghidra_12.2_PUBLIC',
  '--jdk-home', '/Users/robbiebrown/armor-mac-build/tools/jdk-25.0.5+8',
  '--rea-dir', '/Users/robbiebrown/armor-122-build/lib',
]);
console.log('LINUX BUNDLE BUILD DONE');
