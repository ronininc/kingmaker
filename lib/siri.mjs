// "Hey Siri, wake Kingmaker" (operator 2026-10-07: "add a base command into my Mac that allows me to use Siri to launch
// Ghost so it's genuinely hands free"). Siri runs any Shortcut by its name, so `kingmaker siri` builds a two-action
// Shortcut — URL kingmaker://wake → Open URLs — signs it with macOS's own `shortcuts sign`, and opens it so Shortcuts
// shows "Add Shortcut". Adding it is the owner's click; Siri itself must be on (System Settings → Siri). A "Wake Ghost"
// shortcut made before the rename keeps working: Kingmaker.app still answers solghost://wake.

import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const SIRI_SHORTCUT_NAME = 'Wake Kingmaker';

const xml = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Pure: the Shortcut as an XML property list (`shortcuts sign` accepts it). */
export function wakeShortcutPlist(link = 'kingmaker://wake') {
  const id = '6E0B2A1C-5D1B-4C2E-9F1A-0A1B2C3D4E5F';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>WFWorkflowMinimumClientVersionString</key><string>900</string>
  <key>WFWorkflowMinimumClientVersion</key><integer>900</integer>
  <key>WFWorkflowClientVersion</key><string>2700.0.4</string>
  <key>WFWorkflowIcon</key><dict><key>WFWorkflowIconStartColor</key><integer>255</integer><key>WFWorkflowIconGlyphNumber</key><integer>59446</integer></dict>
  <key>WFWorkflowImportQuestions</key><array/>
  <key>WFWorkflowTypes</key><array/>
  <key>WFWorkflowInputContentItemClasses</key><array/>
  <key>WFWorkflowHasShortcutInputVariables</key><false/>
  <key>WFWorkflowActions</key><array>
    <dict><key>WFWorkflowActionIdentifier</key><string>is.workflow.actions.url</string>
      <key>WFWorkflowActionParameters</key><dict><key>WFURLActionURL</key><string>${xml(link)}</string><key>UUID</key><string>${id}</string></dict></dict>
    <dict><key>WFWorkflowActionIdentifier</key><string>is.workflow.actions.openurl</string>
      <key>WFWorkflowActionParameters</key><dict><key>WFInput</key><dict>
        <key>Value</key><dict><key>OutputUUID</key><string>${id}</string><key>Type</key><string>ActionOutput</string><key>OutputName</key><string>URL</string></dict>
        <key>WFSerializationType</key><string>WFTextTokenAttachment</string></dict></dict></dict>
  </array>
</dict></plist>
`;
}

const run = (file, args) => new Promise((resolve, reject) => execFile(file, args, { timeout: 60_000 }, (e, out, err) => (e ? reject(new Error(String(err || e.message).trim())) : resolve(out))));

/** Build, sign and open the Shortcut. Returns the signed file's path. */
export async function installSiriShortcut({ exec = run, dir = mkdtempSync(join(tmpdir(), 'kingmaker-siri-')) } = {}) {
  const unsigned = join(dir, `${SIRI_SHORTCUT_NAME}.unsigned.shortcut`);
  const signed = join(dir, `${SIRI_SHORTCUT_NAME}.shortcut`);
  writeFileSync(unsigned, wakeShortcutPlist());
  await exec('/usr/bin/shortcuts', ['sign', '--mode', 'anyone', '--input', unsigned, '--output', signed]);
  await exec('/usr/bin/open', [signed]);
  return signed;
}
