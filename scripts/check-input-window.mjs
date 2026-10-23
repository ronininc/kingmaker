// Engine-free macOS fixture: compile the actual reopen and sendTurn methods into
// a normal window with inert controls. No production state, permissions, or network.
// node scripts/check-input-window.mjs [--build-only]
// The resulting .app opens an inert window; default invocation runs assertions and exits.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const source = readFileSync(join(root, 'app/Kingmaker.swift'), 'utf8');
function method(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  if (a < 0 || b < a) throw new Error(`Missing production method: ${start}`);
  return source.slice(a, b).trim();
}
const reopen = method('  func applicationShouldHandleReopen(', '\n\n  func applicationDidFinishLaunching(');
const sendTurn = method('  private func sendTurn(', '\n\n  /// Everyday wording');
const out = join(root, 'dist', 'input-window-fixture');
mkdirSync(out, { recursive: true });
const swift = `import AppKit

final class FixtureBar: NSObject {
  let panel = NSWindow(contentRect: NSRect(x: 100, y: 100, width: 700, height: 300), styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
  let field = NSTextField(frame: NSRect(x: 20, y: 215, width: 650, height: 30))
  let output = NSTextField(wrappingLabelWithString: "Engine-free fixture. Send validates and displays the framed payload; it does not submit work to Kingmaker.")
  var busy = false
  var queued: [String] = []
  var received: [String] = []
  var showCount = 0
  var display = false
  var onTurn: (String) -> Void = { _ in }
  override init() {
    super.init()
    panel.title = "Kingmaker Input Fixture — NO ENGINE"
    panel.isReleasedWhenClosed = false
    panel.contentView?.addSubview(field)
    field.placeholderString = "Harmless fixture text"
    let send = NSButton(title: "Validate input", target: self, action: #selector(submit))
    send.frame = NSRect(x: 20, y: 170, width: 160, height: 32)
    panel.contentView?.addSubview(send)
    output.frame = NSRect(x: 20, y: 20, width: 650, height: 130)
    panel.contentView?.addSubview(output)
    onTurn = { [weak self] line in
      self?.received.append(line)
      guard let data = Data(base64Encoded: line), let text = String(data: data, encoding: .utf8) else { return }
      self?.output.stringValue = "VALIDATED FRAMING ONLY: " + text
      self?.busy = false
    }
  }
  func append(who: String, _ text: String) {}
  func show() { showCount += 1; if display { panel.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true); panel.makeFirstResponder(field) } }
  @objc func submit() { submitText(field.stringValue) }
  func submitText(_ text: String) { sendTurn(["text": text, "model": "kingmaker", "programs": []], shown: text, queue: true) }
  ${sendTurn}
}
final class FixtureApp: NSObject, NSApplicationDelegate {
  let bar = FixtureBar()
  ${reopen}
  func applicationDidFinishLaunching(_ notification: Notification) {
    for visible in [false, true] {
      let before = bar.showCount
      precondition(applicationShouldHandleReopen(NSApp, hasVisibleWindows: visible))
      precondition(bar.showCount == before + 1)
    }
    let text = "fixture α\\nquit\\nwake"
    bar.submitText(text)
    precondition(bar.received.count == 1)
    let decoded = try! JSONSerialization.jsonObject(with: Data(base64Encoded: bar.received[0])!) as! [String: Any]
    precondition(decoded["text"] as? String == text)
    precondition(decoded["model"] as? String == "kingmaker")
    bar.busy = true
    bar.submitText("queued fixture")
    precondition(bar.received.count == 1 && bar.queued.count == 1)
    bar.busy = false
    print("PASS: reopen with/without other windows; UTF-8/newline framing; busy input queues once. No engine started.")
    fflush(stdout)
    if !CommandLine.arguments.contains("--self-test") {
      bar.display = true; bar.show()
      DispatchQueue.main.asyncAfter(deadline: .now() + 180) { NSApp.terminate(nil) }
    } else { NSApp.terminate(nil) }
  }
  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}
let app = NSApplication.shared
let delegate = FixtureApp()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
`;
const bundle = join(out, 'Kingmaker Input Fixture.app');
mkdirSync(join(bundle, 'Contents', 'MacOS'), { recursive: true });
writeFileSync(join(bundle, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.ronininc.codex.input-fixture</string>
<key>CFBundleName</key><string>Kingmaker Input Fixture</string>
<key>CFBundleExecutable</key><string>InputFixture</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSUIElement</key><false/>
</dict></plist>`);
const path = join(out, 'Fixture.swift'), binary = join(bundle, 'Contents', 'MacOS', 'InputFixture');
writeFileSync(path, swift);
execFileSync('swiftc', ['-module-cache-path', join(out, 'module-cache'), path, '-o', binary, '-framework', 'AppKit'], { stdio: 'inherit' });
if (!process.argv.includes('--build-only')) {
  const result = spawnSync(binary, ['--self-test'], { stdio: 'inherit', timeout: 30_000 });
  if (result.error) console.error(result.error.message);
  process.exitCode = result.status ?? 1;
}
