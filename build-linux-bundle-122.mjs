// Linux 1.2.2 bundle build — the builder's own CLI path (buildStandalone),
// invoked exactly as mac/build-native-app.sh invokes it, under the copy
// shim (see copy-shim.mjs) because this sandbox refuses copyfile.
import { installCopyShim } from './copy-shim.mjs';

installCopyShim();
const { buildStandalone } = await import('/home/hatch/workspace/armor-item2-lb-wiring-2026-11-06/kingmaker/scripture-armor/build-standalone.mjs');

buildStandalone([
  '--out', '/home/hatch/workspace/armor-next-build-2026-11-11/build/linux-bundle',
  '--ghidra-home', '/home/hatch/workspace/armor-route-b-2026-11-05/work/full-bundle/tools/ghidra',
  '--jdk-home', '/home/hatch/workspace/armor-route-b-2026-11-05/work/full-bundle/tools/jdk',
  '--rea-dir', '/home/hatch/workspace/armor-item2-lb-wiring-2026-11-06/kingmaker/lib',
]);
