// RoninShell.swift — the hosted mounting's frame (DESIGN §5.3): a thin native shell holding a
// full-screen WKWebView that presents the loopback surface. It is the desktop EXPERIENCE on a baked
// host, not its jailer: NSApplicationPresentationOptions are session requests the host honors, and
// this file claims nothing more (§5.3's honesty, kept in the code where a maintainer will meet it).
import Cocoa
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    var webView: WKWebView!

    func applicationDidFinishLaunching(_ notification: Notification) {
        // The kiosk option set (verified from AppKit docs; the same set Electron composes).
        NSApp.presentationOptions = [
            .hideDock, .hideMenuBar, .disableAppleMenu, .disableProcessSwitching,
            .disableForceQuit, .disableSessionTermination, .disableHideApplication,
        ]
        let config = WKWebViewConfiguration()
        config.preferences.javaScriptEnabled = true
        webView = WKWebView(frame: .zero, configuration: config)
        // The surface is loopback-only by architecture (§5.1); the frame loads nothing else.
        webView.load(URLRequest(url: URL(string: "http://127.0.0.1:8931/")!))
        window = NSWindow(contentRect: NSScreen.main!.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = webView
        window.makeKeyAndOrderFront(nil)
        // Presentation options are the class of state hosts reset casually (§8.2): re-apply on wake.
        NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didWakeNotification, object: nil, queue: .main
        ) { [weak self] _ in self?.applicationDidFinishLaunching(notification) }
    }
}
let delegate = AppDelegate()
NSApplication.shared.delegate = delegate
_ = NSApplicationMain(CommandLine.argc, CommandLine.unsafeArgv)
