// Kingmaker.app — no window, no Dock icon. Its only UI is a tiny Ronin Inc logo in the menu bar (the crest's shield
// and eye, app/Resources/MenuBarLogo.png, a template image), which says what Kingmaker is doing (operator
// 2026-10-08: "a tiny Ronin Inc logo that glows when awake, pulses while speaking to the user, and shows an RGB
// outline while listening; no windows"). It starts its engine headless (lib/cli.mjs start --agent) on the runtime this
// bundle carries (Contents/MacOS/Solomon, from the engine build), reads its "@@ghost {json}" state
// lines, and stops it on quit. A thin dev build (scripts/build-app.sh) carries no runtime and borrows the installed
// Kingmaker.app's (KINGMAKER_RUNTIME_APP). Approvals are never a click: they are your word.
//
// The logo, by state (all drawn by Core Animation in the render server; asleep there is no animation at all):
//   starting   dimmed while the engine boots
//   asleep     plain (the menu bar's own colour), nothing animating
//   awake      it GLOWS: talk to it
//   hearing    an RGB OUTLINE turns around the shield: it is listening to you
//   thinking   it glows amber: it is working on your command
//   speaking   it PULSES while it talks to you (talk over it to stop it)
//   waiting    a slow amber pulse: something is waiting for your word
//   down       red, then the app quits with the engine (logs: ~/Library/Application Support/sol-ghost/logs)
// A left click on the logo wakes it (the kingmaker://wake path); right-, control- or option-click opens its menu,
// which holds one status line and Quit Kingmaker. KINGMAKER_EDGE_GLOW=1 adds the old screen-edge RGB ring (four
// click-through strip windows per screen) on top. SOL_GHOST_GLOW_DEMO=1 plays every state once without starting
// the engine, then quits. SOL_GHOST_GLOW_ATTACH=1 is the indicator for a Kingmaker started from a terminal (`kingmaker
// start`): it starts no engine, reads the same "@@ghost {json}" lines from its stdin, answers "@@glow ready" once it
// can draw, and quits when stdin closes. The indicator travels with the voice: the CLI will not listen without it.
// Links: kingmaker://wake (and the old solghost://wake) wake it ("Hey Siri, wake Kingmaker").
// While it works on a spoken command, the words it heard show at the bottom centre of the screen (TranscriptPanel):
// click-through, never focused, gone after a few seconds or when it sleeps; nothing is recorded.

import AppKit
import ApplicationServices
import ImageIO
import QuartzCore
import ServiceManagement
import Darwin
import Carbon.HIToolbox
import Contacts
import AVFoundation

// ── The menu bar logo ─────────────────────────────────────────────────────────────────────────────────

/// What the logo shows for a CLI state.
enum MarkLook: Equatable {
  case dim, plain, glow, ring, glowWorking, pulse, pulseWaiting, down

  static func forState(_ s: String) -> MarkLook {
    switch s {
    case "starting": return .dim
    case "awake": return .glow
    case "hearing": return .ring
    case "thinking": return .glowWorking
    case "speaking": return .pulse
    case "waiting": return .pulseWaiting
    case "down": return .down
    default: return .plain // asleep, or anything unknown
    }
  }
}

/// The Ronin Inc logo as the status item's template image, with three Core Animation layers over it: a glow (the
/// shield in colour with a soft shadow), the pulse (that glow's opacity breathing), and the RGB outline (a conic
/// gradient turning, masked to the shield's outline). Asleep the overlay is hidden and every animation removed, so
/// an idle Kingmaker costs no CPU for its UI.
final class MenuBarMark: NSObject {
  let item: NSStatusItem
  private let overlay = CALayer()
  private let glow = CALayer()        // carries the shadow; its child is the tinted shield
  private let tint = CALayer()
  private let ring = CALayer()        // masked to the outline; its child turns
  private let colours = CAGradientLayer()
  private(set) var look: MarkLook = .plain
  private let logo: NSImage
  private var reduceMotion: Bool { NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }

  static let cyan = NSColor(srgbRed: 0x7f / 255, green: 0xe3 / 255, blue: 0xff / 255, alpha: 1)   // the Machine's cyan
  static let amber = NSColor(srgbRed: 1, green: 0x9a / 255, blue: 0x2e / 255, alpha: 1)           // the Machine's amber
  static let alert = NSColor(srgbRed: 0xe3 / 255, green: 0x17 / 255, blue: 0x1f / 255, alpha: 1)  // the Machine's red

  /// The status line + Quit menu. Not attached to the item (an attached menu swallows every click): a right-click,
  /// control-click or option-click opens it; a plain left click calls `onClick` (wake to listen).
  private let menu: NSMenu
  private let onClick: () -> Void

  init(menu: NSMenu, onClick: @escaping () -> Void = {}) {
    item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    self.menu = menu
    self.onClick = onClick
    let image = Bundle.main.image(forResource: "MenuBarLogo") ?? NSImage(systemSymbolName: "shield.lefthalf.filled", accessibilityDescription: "Kingmaker")!
    image.isTemplate = true
    image.size = NSSize(width: 18, height: 18)
    image.accessibilityDescription = "Kingmaker"
    logo = image
    super.init()
    guard let button = item.button else { return }
    button.image = image
    button.imagePosition = .imageOnly
    button.wantsLayer = true
    button.target = self
    button.action = #selector(clicked(_:))
    button.sendAction(on: [.leftMouseUp, .rightMouseUp])
    let scale = NSScreen.main?.backingScaleFactor ?? 2
    let mask = MenuBarMark.cgImage(named: "MenuBarLogo", fallback: image)
    let outline = MenuBarMark.cgImage(named: "MenuBarOutline", fallback: image)

    overlay.isHidden = true
    overlay.contentsScale = scale
    for layer in [glow, tint, ring, colours] { layer.contentsScale = scale }
    tint.mask = MenuBarMark.maskLayer(mask, scale: scale)
    glow.addSublayer(tint)
    glow.shadowOffset = .zero
    glow.shadowRadius = 2.5
    glow.shadowOpacity = 1
    colours.type = .conic
    colours.startPoint = CGPoint(x: 0.5, y: 0.5)
    colours.endPoint = CGPoint(x: 0.5, y: 0)
    colours.colors = [NSColor.systemRed, .systemOrange, .systemYellow, .systemGreen, .systemTeal, .systemBlue, .systemPurple, .systemPink, .systemRed].map { $0.cgColor }
    ring.addSublayer(colours)
    ring.mask = MenuBarMark.maskLayer(outline, scale: scale)
    overlay.addSublayer(ring)
    overlay.addSublayer(glow)
    button.layer?.addSublayer(overlay)
    layout()
    NotificationCenter.default.addObserver(forName: NSView.frameDidChangeNotification, object: button, queue: .main) { [weak self] _ in self?.layout() }
  }

  /// The 2x PNG from Resources as a CGImage (the template image's own pixels, when the PNG is missing).
  private static func cgImage(named name: String, fallback: NSImage) -> CGImage? {
    if let url = Bundle.main.url(forResource: "\(name)@2x", withExtension: "png") ?? Bundle.main.url(forResource: name, withExtension: "png"),
       let source = CGImageSourceCreateWithURL(url as CFURL, nil), let image = CGImageSourceCreateImageAtIndex(source, 0, nil) { return image }
    var rect = CGRect(origin: .zero, size: fallback.size)
    return fallback.cgImage(forProposedRect: &rect, context: nil, hints: nil)
  }

  private static func maskLayer(_ image: CGImage?, scale: CGFloat) -> CALayer {
    let m = CALayer()
    m.contents = image
    m.contentsGravity = .resizeAspect
    m.contentsScale = scale
    return m
  }

  /// A click on the logo. Left click: wake to listen (the same path as kingmaker://wake). It is never an approval:
  /// approvals stay spoken or typed. Right-click, control-click or option-click: the menu (status line, Quit).
  @objc private func clicked(_ sender: NSStatusBarButton) {
    let event = NSApp.currentEvent
    let wantsMenu = event?.type == .rightMouseUp || event?.modifierFlags.contains(.control) == true || event?.modifierFlags.contains(.option) == true
    if wantsMenu {
      item.menu = menu
      sender.performClick(nil)
      item.menu = nil
    } else {
      onClick()
    }
  }

  /// The logo's 18-pt square, centred in the button (where AppKit draws the template image).
  private func layout() {
    guard let button = item.button else { return }
    let b = button.bounds
    let side: CGFloat = 18
    let frame = CGRect(x: (b.width - side) / 2, y: (b.height - side) / 2, width: side, height: side)
    CATransaction.begin(); CATransaction.setDisableActions(true)
    overlay.frame = frame
    for layer in [glow, tint, ring] { layer.frame = overlay.bounds }
    tint.mask?.frame = tint.bounds
    ring.mask?.frame = ring.bounds
    // The gradient is a square covering the ring's diagonal, so it can turn without showing a corner.
    let d = side * 1.5
    colours.bounds = CGRect(x: 0, y: 0, width: d, height: d)
    colours.position = CGPoint(x: side / 2, y: side / 2)
    CATransaction.commit()
  }

  func show(_ next: MarkLook) {
    guard next != look else { return }
    look = next
    CATransaction.begin(); CATransaction.setDisableActions(true)
    for layer in [overlay, glow, colours] { layer.removeAllAnimations() }
    item.button?.appearsDisabled = next == .dim
    switch next {
    case .plain, .dim:
      overlay.isHidden = true // nothing drawn over the template, nothing animating
    case .glow, .glowWorking, .pulse, .pulseWaiting, .down:
      overlay.isHidden = false
      ring.isHidden = true
      glow.isHidden = false
      let colour: NSColor = next == .down ? MenuBarMark.alert : (next == .glowWorking || next == .pulseWaiting) ? MenuBarMark.amber : MenuBarMark.cyan
      tint.backgroundColor = (next == .down ? MenuBarMark.alert : NSColor.white.blended(withFraction: 0.25, of: colour) ?? colour).cgColor
      glow.shadowColor = colour.cgColor
      glow.opacity = 1
      if next == .pulse || next == .pulseWaiting {
        let breathe = CABasicAnimation(keyPath: "opacity")
        breathe.fromValue = 1.0
        breathe.toValue = reduceMotion ? 1.0 : 0.15
        breathe.duration = next == .pulse ? 0.55 : 1.4
        breathe.autoreverses = true
        breathe.repeatCount = .infinity
        breathe.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        if #available(macOS 12.0, *) { breathe.preferredFrameRateRange = CAFrameRateRange(minimum: 10, maximum: 30, preferred: 30) }
        glow.add(breathe, forKey: "pulse")
      }
    case .ring:
      overlay.isHidden = false
      glow.isHidden = true
      ring.isHidden = false
      if !reduceMotion {
        let turn = CABasicAnimation(keyPath: "transform.rotation.z")
        turn.fromValue = 0
        turn.toValue = -2 * Double.pi
        turn.duration = 1.8
        turn.repeatCount = .infinity
        if #available(macOS 12.0, *) { turn.preferredFrameRateRange = CAFrameRateRange(minimum: 15, maximum: 30, preferred: 30) }
        colours.add(turn, forKey: "turn")
      }
    }
    CATransaction.commit()
  }
}

/// A real text command path in the menu-bar dropdown. The command is handed to the same governed owner-turn
/// pipeline as terminal text; base64 at the app/CLI pipe boundary keeps newlines from becoming control messages.
final class CommandEntryView: NSView, NSTextFieldDelegate {
  private let field = NSTextField()
  private let send = NSButton(title: UI.t("Send"), target: nil, action: nil)
  private let onSubmit: (String) -> Void

  init(onSubmit: @escaping (String) -> Void) {
    self.onSubmit = onSubmit
    super.init(frame: NSRect(x: 0, y: 0, width: 340, height: 46))
    field.frame = NSRect(x: 12, y: 9, width: 260, height: 28)
    field.placeholderString = UI.t("Type a command…")
    field.setAccessibilityLabel("Command for Kingmaker")
    field.delegate = self
    field.target = self
    field.action = #selector(submit)
    send.frame = NSRect(x: 278, y: 8, width: 52, height: 30)
    send.bezelStyle = .rounded
    send.target = self
    send.action = #selector(submit)
    send.setAccessibilityLabel("Send command to Kingmaker")
    addSubview(field)
    addSubview(send)
  }

  required init?(coder: NSCoder) { nil }

  @objc private func submit() {
    let command = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !command.isEmpty else { NSSound.beep(); return }
    field.stringValue = ""
    onSubmit(command)
    enclosingMenuItem?.menu?.cancelTracking()
  }
}

// ── The Kingmaker bar ─────────────────────────────────────────────────────────────────────────────────
// Clicking the logo (or ⌥Space anywhere) opens a chat bar on the desktop, like Claude's composer: + on the left (choose the
// folder, which picks the CRM and project; attach a file), the text box (Enter sends, ⌘Enter queues it for after the
// current answer), Stop and the mic; under it the folder, Mute and the model. The model is one of the local abliterated
// models (Ollama on this Mac) or Kingmaker itself, the governed brain that can act. Typing / lists the programs on this Mac
// (Kingmaker's tools, the plugin connectors, the apps from its device scan): the ones named are the program it drives, so
// a small model doesn't have to guess the route. Anything else typed also searches the Mac (apps, files, tools) as you go;
// ↓ picks a result and Enter opens it. /off is a real off (no listening, no wake word) until /on; /mute, /unmute.
// Replies show here as text, so Kingmaker can be used by typing alone, muted.

/// The bar's shortcut anywhere (Carbon's hot key: no Accessibility or Input Monitoring needed). Chosen in Customize.
var kingmakerHotKeyAction: (() -> Void)?
private var kingmakerHotKeyRef: EventHotKeyRef?
private var kingmakerHotKeyHandlerInstalled = false
func registerKingmakerHotKey(_ choice: String = UserDefaults.standard.string(forKey: "km.hotkey") ?? "opt-space") {
  if !kingmakerHotKeyHandlerInstalled {
    var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
    InstallEventHandler(GetApplicationEventTarget(), { _, _, _ in DispatchQueue.main.async { kingmakerHotKeyAction?() }; return noErr }, 1, &spec, nil, nil)
    kingmakerHotKeyHandlerInstalled = true
  }
  if let r = kingmakerHotKeyRef { UnregisterEventHotKey(r); kingmakerHotKeyRef = nil }
  let combos: [String: (UInt32, UInt32)] = ["opt-space": (UInt32(kVK_Space), UInt32(optionKey)), "ctrl-space": (UInt32(kVK_Space), UInt32(controlKey)),
                                            "cmd-shift-k": (UInt32(kVK_ANSI_K), UInt32(cmdKey | shiftKey))]
  guard let (key, mods) = combos[choice] else { return } // "none"
  let id = EventHotKeyID(signature: OSType(0x4B4D4252), id: 1) // 'KMBR'
  RegisterEventHotKey(key, mods, id, GetApplicationEventTarget(), 0, &kingmakerHotKeyRef)
}

/// The bar's backdrop also takes files dropped on it: they go along with the message.
final class DropBackdrop: NSVisualEffectView {
  var onFiles: ([URL]) -> Void = { _ in }
  override init(frame: NSRect) { super.init(frame: frame); registerForDraggedTypes([.fileURL, .png, .tiff] + PastedMedia.mediaTypes) }
  required init?(coder: NSCoder) { nil }
  override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation { .copy }
  override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
    let urls = PastedMedia.files(from: sender.draggingPasteboard)
    if !urls.isEmpty { onFiles(urls) }
    return !urls.isEmpty
  }
}

/// What a paste or a drop carries, as files the bar can attach: copied files (Finder: documents, images, video, audio)
/// as they are; an image, video or audio clip copied as data (a screenshot to the clipboard, Copy Image in Chrome) is
/// saved first, 0600, in ~/Library/Application Support/sol-ghost/pasted. Plain text is left to the text box.
enum PastedMedia {
  static let dir = URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support/sol-ghost/pasted")
  /// Video and audio data types a clipboard can hold, with the extension each is saved under.
  static let media: [(type: NSPasteboard.PasteboardType, ext: String)] = [
    (.init("public.mpeg-4"), "mp4"), (.init("com.apple.quicktime-movie"), "mov"), (.init("public.mpeg-4-audio"), "m4a"),
    (.init("public.mp3"), "mp3"), (.init("com.microsoft.waveform-audio"), "wav"), (.init("public.aiff-audio"), "aiff"),
    (.init("public.jpeg"), "jpg"), (.init("com.compuserve.gif"), "gif"), (.init("public.heic"), "heic"),
  ]
  static var mediaTypes: [NSPasteboard.PasteboardType] { media.map { $0.type } }

  static func files(from pb: NSPasteboard) -> [URL] {
    let urls = pb.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL] ?? []
    if !urls.isEmpty { return urls }
    for (type, ext) in media { if let data = pb.data(forType: type), let u = save(data, ext: ext) { return [u] } }
    // Any other image (PNG, TIFF, a screenshot): saved as PNG.
    if pb.canReadObject(forClasses: [NSImage.self], options: nil), let img = NSImage(pasteboard: pb), let tiff = img.tiffRepresentation,
       let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]), let u = save(png, ext: "png") { return [u] }
    return []
  }
  /// Does the pasteboard hold something to attach (rather than plain text to type)?
  static func hasMedia(_ pb: NSPasteboard) -> Bool {
    let types = Set(pb.types ?? [])
    return types.contains(.fileURL) || types.contains(.png) || types.contains(.tiff) || !types.isDisjoint(with: mediaTypes)
  }
  private static func save(_ data: Data, ext: String) -> URL? {
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd 'at' HH.mm.ss"
    let url = dir.appendingPathComponent("Pasted \(f.string(from: Date())).\(ext)")
    guard FileManager.default.createFile(atPath: url.path, contents: data, attributes: [.posixPermissions: 0o600]) else { return nil }
    return url
  }
}

/// A list that reads top-down (the sidebar's chats).
final class FlippedView: NSView { override var isFlipped: Bool { true } }

// ── THE SETUP SCREEN (lib/flow.mjs: @@ghost flow) ─────────────────────────────────────────────────────────────────────
// The owner's words at the top, one card per step under them with its caption, and a line from the words to each card.
// A line pulses only while its step is working; done, it's a still green line; failed, red; waiting, faint. Drawn with
// plain AppKit (one small timer, only while something is working), so it runs on any Mac.
final class FlowView: NSView {
  override var isFlipped: Bool { true }
  static let green = NSColor(srgbRed: 0.29, green: 0.87, blue: 0.5, alpha: 1)
  private(set) var flowID = ""
  private(set) var done = false
  private var lines: [(from: NSPoint, to: NSPoint, state: String)] = []
  private var phase: CGFloat = 0
  private var pulse: Timer?

  /// Lay one flow out at this width; → the height it needs.
  @discardableResult func show(_ flow: [String: Any], width: CGFloat) -> CGFloat {
    subviews.forEach { $0.removeFromSuperview() }; lines = []
    flowID = (flow["id"] as? String) ?? ""; done = (flow["done"] as? Bool) ?? false
    let steps = ((flow["steps"] as? [[String: Any]]) ?? []).filter { ($0["state"] as? String) != "skipped" }
    let ask = NSTextField(labelWithString: "“\(((flow["ask"] as? String) ?? "").trimmingCharacters(in: .whitespaces))”")
    ask.font = .systemFont(ofSize: 17, weight: .semibold); ask.textColor = .white; ask.alignment = .center; ask.lineBreakMode = .byTruncatingTail
    let bubble = NSView(); bubble.wantsLayer = true; bubble.layer?.cornerRadius = 22; bubble.layer?.backgroundColor = NSColor.white.withAlphaComponent(0.05).cgColor
    bubble.layer?.borderWidth = 1; bubble.layer?.borderColor = FlowView.green.withAlphaComponent(0.35).cgColor
    let bw = min(width - 60, max(200, ask.intrinsicContentSize.width + 48))
    bubble.frame = NSRect(x: (width - bw) / 2, y: 10, width: bw, height: 44)
    ask.frame = NSRect(x: 16, y: 11, width: bw - 32, height: 22); bubble.addSubview(ask); addSubview(bubble)
    var y = bubble.frame.maxY + 28
    let cardX: CGFloat = 44, cardW = max(160, width - cardX - 14)
    for s in steps {
      let state = (s["state"] as? String) ?? "waiting"
      let card = FlowView.card(s, width: cardW, state: state)
      card.frame.origin = NSPoint(x: cardX, y: y); addSubview(card)
      let cap = NSTextField(wrappingLabelWithString: (s["caption"] as? String) ?? "")
      cap.font = .systemFont(ofSize: 13, weight: .medium); cap.alignment = .center; cap.preferredMaxLayoutWidth = cardW
      cap.textColor = state == "failed" ? .systemRed : state == "waiting" ? NSColor.white.withAlphaComponent(0.4) : FlowView.green
      let ch = ceil(cap.sizeThatFits(NSSize(width: cardW, height: 400)).height)
      cap.frame = NSRect(x: cardX, y: card.frame.maxY + 8, width: cardW, height: ch); addSubview(cap)
      lines.append((NSPoint(x: bubble.frame.minX + 4, y: bubble.frame.midY), NSPoint(x: cardX - 1, y: card.frame.midY), state))
      y = cap.frame.maxY + 24
    }
    let working = lines.contains { $0.state == "active" }
    if working && pulse == nil {
      pulse = Timer.scheduledTimer(withTimeInterval: 1 / 15, repeats: true) { [weak self] _ in self?.phase -= 1.2; self?.needsDisplay = true }
    } else if !working { pulse?.invalidate(); pulse = nil }
    needsDisplay = true
    return y + 6
  }
  func stop() { pulse?.invalidate(); pulse = nil }

  override func draw(_ dirtyRect: NSRect) {
    for (i, l) in lines.enumerated() {
      // Out of the words to the left, down its own lane in the gutter, then into its card: no line crosses a card.
      let p = NSBezierPath()
      let lane = 10 + CGFloat(i % 5) * 6
      let turn: CGFloat = 16
      p.move(to: l.from)
      p.curve(to: NSPoint(x: lane, y: l.from.y + turn * 2), controlPoint1: NSPoint(x: lane + 30, y: l.from.y), controlPoint2: NSPoint(x: lane, y: l.from.y + 4))
      p.line(to: NSPoint(x: lane, y: l.to.y - turn))
      p.curve(to: l.to, controlPoint1: NSPoint(x: lane, y: l.to.y - 2), controlPoint2: NSPoint(x: lane + 8, y: l.to.y))
      p.lineWidth = l.state == "active" ? 1.6 : 1.1
      switch l.state {
      case "active": FlowView.green.withAlphaComponent(0.95).setStroke(); p.setLineDash([5, 6], count: 2, phase: phase)
      case "done": FlowView.green.withAlphaComponent(0.45).setStroke()
      case "failed": NSColor.systemRed.withAlphaComponent(0.7).setStroke()
      default: NSColor.white.withAlphaComponent(0.12).setStroke()
      }
      p.stroke()
      let dot = NSBezierPath(ovalIn: NSRect(x: l.to.x - 3, y: l.to.y - 3, width: 6, height: 6))
      (l.state == "waiting" ? NSColor.white.withAlphaComponent(0.2) : l.state == "failed" ? NSColor.systemRed : FlowView.green).setFill(); dot.fill()
    }
  }

  /// One step's card: page (a site's page), secret (the hidden key), log (what ran), table (what's now in reach).
  static func card(_ s: [String: Any], width: CGFloat, state: String) -> NSView {
    let v = FlippedView(); v.wantsLayer = true
    v.layer?.cornerRadius = 12; v.layer?.backgroundColor = NSColor.white.withAlphaComponent(0.035).cgColor
    v.layer?.borderWidth = 1
    v.layer?.borderColor = (state == "active" ? green.withAlphaComponent(0.55) : state == "failed" ? NSColor.systemRed.withAlphaComponent(0.5) : NSColor.white.withAlphaComponent(0.08)).cgColor
    func label(_ t: String, _ font: NSFont, _ color: NSColor, _ r: NSRect) { let l = NSTextField(labelWithString: t); l.font = font; l.textColor = color; l.lineBreakMode = .byTruncatingTail; l.frame = r; v.addSubview(l) }
    func bar(_ r: NSRect, _ a: CGFloat = 0.07) { let b = NSView(); b.wantsLayer = true; b.layer?.cornerRadius = r.height / 2; b.layer?.backgroundColor = NSColor.white.withAlphaComponent(a).cgColor; b.frame = r; v.addSubview(b) }
    var h: CGFloat
    switch (s["kind"] as? String) ?? "log" {
    case "page":
      for (i, c) in [NSColor.systemRed, .systemYellow, .systemGreen].enumerated() { let d = NSView(); d.wantsLayer = true; d.layer?.cornerRadius = 4; d.layer?.backgroundColor = c.withAlphaComponent(0.8).cgColor; d.frame = NSRect(x: 12 + CGFloat(i) * 13, y: 11, width: 8, height: 8); v.addSubview(d) }
      bar(NSRect(x: 56, y: 7, width: width - 68, height: 16), 0.06)
      let host = (s["url"] as? String).flatMap { URL(string: $0)?.host } ?? ""
      label("🔒 \(host)\((s["url"] as? String).flatMap { URL(string: $0)?.path }.map { $0.count > 1 ? $0 : "" } ?? "")", .systemFont(ofSize: 10.5), NSColor.white.withAlphaComponent(0.55), NSRect(x: 64, y: 8, width: width - 84, height: 14))
      label("API keys", .systemFont(ofSize: 13, weight: .semibold), .white, NSRect(x: 14, y: 36, width: width - 28, height: 18))
      bar(NSRect(x: 14, y: 62, width: width - 28, height: 7)); bar(NSRect(x: 14, y: 76, width: (width - 28) * 0.8, height: 7))
      h = 96
    case "secret":
      label("API KEY", .systemFont(ofSize: 9.5, weight: .semibold), NSColor.white.withAlphaComponent(0.45), NSRect(x: 14, y: 12, width: 120, height: 12))
      let f = NSView(); f.wantsLayer = true; f.layer?.cornerRadius = 8; f.layer?.backgroundColor = NSColor.white.withAlphaComponent(0.04).cgColor
      f.layer?.borderWidth = 1; f.layer?.borderColor = green.withAlphaComponent(state == "waiting" ? 0.15 : 0.45).cgColor
      f.frame = NSRect(x: 14, y: 30, width: width - 28, height: 34); v.addSubview(f)
      label(state == "active" ? "Paste it into the green field below…" : String(repeating: "•", count: 26), .monospacedSystemFont(ofSize: 13, weight: .regular),
            state == "active" ? NSColor.white.withAlphaComponent(0.4) : .white, NSRect(x: 26, y: 38, width: width - 52, height: 18))
      label("Sealed in this Mac's vault", .systemFont(ofSize: 10.5), NSColor.white.withAlphaComponent(0.45), NSRect(x: 14, y: 76, width: width - 120, height: 14))
      if state == "done" {
        let badge = NSTextField(labelWithString: "Saved ✓"); badge.font = .systemFont(ofSize: 11, weight: .semibold); badge.textColor = .black; badge.alignment = .center
        badge.wantsLayer = true; badge.drawsBackground = true; badge.backgroundColor = green; badge.layer?.cornerRadius = 7; badge.layer?.masksToBounds = true
        badge.frame = NSRect(x: width - 14 - 70, y: 72, width: 70, height: 20); v.addSubview(badge)
      }
      h = 102
    case "table":
      let rows = (s["rows"] as? [[String]]) ?? []
      var ry: CGFloat = 12
      for (i, r) in rows.prefix(6).enumerated() {
        let colW = (width - 28) / CGFloat(max(1, r.count))
        for (j, cell) in r.enumerated() {
          label(cell, i == 0 ? .systemFont(ofSize: 10, weight: .semibold) : .systemFont(ofSize: 12), i == 0 ? NSColor.white.withAlphaComponent(0.45) : (j == r.count - 1 ? green : .white), NSRect(x: 14 + CGFloat(j) * colW, y: ry, width: colW - 6, height: 16))
        }
        ry += 24
      }
      h = max(40, ry + 6)
    default:   // log
      let lines = (s["lines"] as? [String]) ?? []
      var ly: CGFloat = 14
      for (i, t) in lines.enumerated() {
        let finished = state == "done" || t.contains("✓")
        let isResult = !t.hasPrefix("›")
        label(isResult ? (state == "done" ? "✓ \(t)" : t) : t, .monospacedSystemFont(ofSize: 12.5, weight: .regular),
              isResult || finished ? green : NSColor.white.withAlphaComponent(state == "waiting" ? 0.4 : 0.88), NSRect(x: 16 + (isResult ? 0 : 0), y: ly, width: width - 32, height: 17))
        ly += i == lines.count - 1 ? 17 : 24
      }
      h = max(46, ly + 14)
    }
    v.frame = NSRect(x: 0, y: 0, width: width, height: h)
    return v
  }
}
/// One conversation in the bar's sidebar: its title (the first thing asked), when it last moved, and its lines.
/// A chat in the sidebar. `pinned` and `project` are optional so chats.json files written before them still load.
struct BarChat: Codable { var id: String; var title: String; var at: Double; var lines: [[String]]; var pinned: Bool? = nil; var project: String? = nil }

final class KeyPanel: NSPanel {
  /// ⌘V goes here first: true when it attached what was copied (files, an image, video, audio).
  var onPaste: () -> Bool = { false }
  var onMinimize: () -> Void = {}
  /// ⌘X ⌘C ⌘V ⌘A ⌘Z (⇧⌘Z) in the bar: a menu bar app has no Edit menu on screen to deliver them, so the panel does.
  override func performKeyEquivalent(with e: NSEvent) -> Bool {
    let mods = e.modifierFlags.intersection(.deviceIndependentFlagsMask)
    if mods == .command, e.charactersIgnoringModifiers?.lowercased() == "v", onPaste() { return true }
    if mods == .command, ["m", "w"].contains(e.charactersIgnoringModifiers?.lowercased() ?? "") { onMinimize(); return true }
    if mods == .command || mods == [.command, .shift], let k = e.charactersIgnoringModifiers?.lowercased() {
      let action: Selector? = switch (k, mods.contains(.shift)) {
      case ("x", false): #selector(NSText.cut(_:))
      case ("c", false): #selector(NSText.copy(_:))
      case ("v", false): #selector(NSText.paste(_:))
      case ("a", false): #selector(NSResponder.selectAll(_:))
      case ("z", false): Selector(("undo:"))
      case ("z", true): Selector(("redo:"))
      default: nil
      }
      if let action, NSApp.sendAction(action, to: nil, from: self) { return true }
    }
    return super.performKeyEquivalent(with: e)
  }
  override var canBecomeKey: Bool { true }
  override var canBecomeMain: Bool { false }
}

final class KingmakerBar: NSObject, NSTextFieldDelegate, NSWindowDelegate, NSTextViewDelegate {
  struct Pick { let kind: String; let title: String; let detail: String; let value: String; var path: String? = nil }
  static let width: CGFloat = 680
  // Resizable from any edge or corner, from a small corner bar up to the whole screen; the size and place the owner picks are kept.
  let panel = KeyPanel(contentRect: NSRect(x: 0, y: 0, width: KingmakerBar.width, height: 120), styleMask: [.borderless, .nonactivatingPanel, .resizable], backing: .buffered, defer: false)
  static let minSize = NSSize(width: 420, height: 170)
  private let backdrop = DropBackdrop(frame: .zero)
  private let composer = NSView()
  private let scroll = NSScrollView()
  private let log = NSTextView()
  private let picksBox = NSStackView()
  private let field = NSTextField()
  private let plus = NSButton(), stop = NSButton(), mic = NSButton(), sendButton = NSButton()
  private let folderButton = NSButton(), muteButton = NSButton(), powerButton = NSButton(), commandsButton = NSButton()
  private let modelPopup = NSPopUpButton(frame: .zero, pullsDown: false)
  private let statusLabel = NSTextField(labelWithString: "")
  private let blackFill = NSView()                      // the Black look: a solid black sheet under everything
  private let titleLabel = NSTextField(labelWithString: "Kingmaker")
  private let gear = NSButton()
  /// The first-run tour while it shows (lib/first-run.mjs, @@ghost tour).
  private var tourCtl: TourController?
  // THE SETUP SCREEN (FlowView): over the conversation while a key or connector is being set up.
  private let flowScroll = NSScrollView(), flowView = FlowView(), flowClose = NSButton()
  private var flowData: [String: Any]?
  private var flowShown = false
  // THE IN-BAR SHEET (owner 2026-10-15: settings and connectors "inside the full-screen window", not floating windows):
  // when the bar is large (full screen, or a big window), Customize and Connectors open in the conversation's place, with
  // a button back to the chat. A small bar keeps them as their own windows.
  private let sheetHost = NSView(), sheetClose = NSButton()
  private var sheetShown: String? = nil
  private var barIsLarge: Bool { panel.isVisible && sized != nil && panel.frame.width >= 700 && panel.frame.height >= 560 }
  private let customizeButton = NSButton()          // Customize: the functions' calibration and weights (only on a big bar)
  private var customizePanel: NSPanel?             // ONE settings window: This Mac · Functions (no setting lives twice)
  private let customizeTabs = NSTabView()
  private let behavior = BehaviorEditor()   // Customize → Behavior: how Kingmaker should think and act, and its guardrails
  private var calControls: [String: NSControl] = [:]
  private var calFunctions: [[String: Any]] = []
  private let calStatus = NSTextField(labelWithString: "")
  static let customizeMinWidth: CGFloat = 900
  private let minimize = NSButton()
  private let fill = NSButton()                     // fill the screen / back to the size before
  private var sized: NSSize? = KingmakerBar.d.string(forKey: "km.size").flatMap { KingmakerBar.size($0) }   // nil: the bar fits its talk
  private var beforeFill: NSRect?
  private var beforeSized: NSSize?
  // THE SIDEBAR: New chat, New project, then Pinned, each project with its chats, then Recent (newest first). The chats are
  // kept in ~/Library/Application Support/sol-ghost/chats.json; the projects (empty ones too) in the defaults (km.projects).
  private let side = NSView(), sideScroll = NSScrollView(), sideList = FlippedView(), newChatButton = NSButton(), newProjectButton = NSButton(), sideToggle = NSButton()
  private let swapButton = NSButton()   // beside mode: the key page and the bar side by side; a click swaps the front window
  private var projects: [String] = KingmakerBar.d.stringArray(forKey: "km.projects") ?? []
  // THE SIDEBAR'S TABS: Chats · Artifacts (what Kingmaker made) · Skills · Plugins, and Select for many at once.
  private let sideTabs = NSSegmentedControl(), selectToggle = NSButton()
  private var sideTab = min(3, max(0, KingmakerBar.d.integer(forKey: "km.sideTab")))
  private var artifacts: [[String: Any]] = []
  private var selecting = false
  private var marked = Set<String>()                // chat ids, "project:<name>", artifact paths, connector ids
  private let selectBar = NSView(), selectCount = NSTextField(labelWithString: ""), selectDelete = NSButton(), selectMove = NSButton(), selectPin = NSButton()
  private var skillPanel: NSPanel?
  private var settingsLevelObserver: NSObjectProtocol?   // while the owner is in System Settings, the floating bar drops below it; restored when Kingmaker is next active
  private let skillName = NSTextField(), skillWhat = NSTextField(), skillText = NSTextView()
  private var newChatProject: String?               // "+" on a project: the next chat starts in it
  // PROJECT DOCTRINE & SETTINGS: per project, the owner's standing instructions (doctrine), its own folder and model.
  private var projectSettings: [String: [String: String]] = (KingmakerBar.d.dictionary(forKey: "km.projectSettings") as? [String: [String: String]]) ?? [:]
  private var projectPanel: NSPanel?
  private var projectEditing: String?
  private let doctrineView = NSTextView()
  private let projectFolderLabel = NSTextField(labelWithString: "")
  private let projectModelPopup = NSPopUpButton(frame: .zero, pullsDown: false)
  private var projectFolderPath = ""
  private var sideShown = KingmakerBar.d.object(forKey: "km.sidebar") as? Bool ?? true
  static let sideW: CGFloat = 210
  private var chats: [BarChat] = KingmakerBar.loadChats()
  private var chatIndex: Int?                       // the chat being written; nil: the next message starts a new one
  private var restoring = false                     // replaying a past chat into the log: nothing is recorded again
  private var contentWidth: CGFloat = KingmakerBar.width
  // THE NEXT COMMAND: what Kingmaker suggests typing next, shown in the empty box in a soft colour (Tab or → takes it).
  private var suggestion: String?
  private static let hint = "Ask or tell Kingmaker anything — open, text, connect…   / for a program"
  private var lastAsked = false                     // Kingmaker's last line asked something: the answer goes back to it
  // The key field: shown only while the engine waits for an API key ("connect my CRM at …"). Hidden typing, never logged.
  private let keyStrip = NSView()
  private let keyLabel = NSTextField(labelWithString: "")
  private let keyField = NSSecureTextField()
  private let keySave = NSButton(), keyCancel = NSButton(), keyPage = NSButton()
  private var keyRequest: [String: Any]?
  var onKeySeal: (String) -> Void = { _ in }    // base64 of the pasted key, for `key-seal`
  var onQuit: () -> Void = {}
  private var picks: [Pick] = []
  private var selected = -1
  private var searchWork: DispatchWorkItem?
  private var queued: [String] = []
  private var busy = false
  private(set) var muted = UserDefaults.standard.bool(forKey: "km.muted")
  private(set) var on = true
  private var folder: URL? = UserDefaults.standard.string(forKey: "km.folder").map { URL(fileURLWithPath: $0) }
  private var programs: [Pick] = []
  // CRM SKILLS (lib/crm-skills.mjs): the connected CRM's tools as /name picks, read through the engine. Owner only: shown and
  // asked for only while Customize → "CRM skills in /" is on (off by default).
  private var crmSkills: [Pick] = []
  private var crmSkillsAt: Date?
  private var crmSkillsAsked = false                // the owner just turned it on: say what came of it
  private var crmSkillsOn: Bool { KingmakerBar.d.string(forKey: "km.crmSkills") == "on" }
  // CONNECTORS (lib/connectors.mjs): what Kingmaker can use besides its own tools, each inspected by REA first.
  private var connectors: [[String: Any]] = []
  private var connectorsPanel: NSPanel?
  private var connectorsView: NSView?
  private let connKind = NSPopUpButton(frame: .zero, pullsDown: false), connName = NSTextField(), connTarget = NSTextField()
  private let connHub = NSPopUpButton(frame: .zero, pullsDown: false), connStatus = NSTextField(wrappingLabelWithString: "")
  private let connList = NSStackView()
  private var hasLog = false
  var onTurn: (String) -> Void = { _ in }       // base64 JSON for `typed-turn`
  var onCommand: (String) -> Void = { _ in }    // a raw control line: voice-out on|off, power on|off, stop
  var onWake: () -> Void = {}

  override init() {
    // One setting for "never speak": the Mute pill. An old "Speaks answers: Never" becomes Mute on.
    let wasNever = KingmakerBar.d.string(forKey: "km.speak") == "never"
    if wasNever { KingmakerBar.d.set("short", forKey: "km.speak"); KingmakerBar.d.set(true, forKey: "km.muted") }
    super.init()
    if wasNever { muted = true }
    panel.isOpaque = false; panel.backgroundColor = .clear; panel.hasShadow = true
    panel.level = .floating; panel.hidesOnDeactivate = false; panel.isReleasedWhenClosed = false
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
    panel.isMovableByWindowBackground = true
    panel.minSize = KingmakerBar.minSize
    panel.delegate = self
    // One rounded glass sheet, like the current macOS panels (Spotlight, the Claude composer).
    backdrop.material = .hudWindow; backdrop.blendingMode = .behindWindow; backdrop.state = .active
    backdrop.wantsLayer = true; backdrop.layer?.cornerRadius = 24; backdrop.layer?.cornerCurve = .continuous; backdrop.layer?.masksToBounds = true
    backdrop.layer?.borderWidth = 0.5; backdrop.layer?.borderColor = NSColor.white.withAlphaComponent(0.18).cgColor
    panel.contentView = backdrop
    backdrop.onFiles = { [weak self] urls in self?.attach(urls) }

    log.isEditable = false; log.isSelectable = true; log.drawsBackground = false; log.delegate = self
    log.textContainerInset = NSSize(width: 4, height: 6)
    log.linkTextAttributes = [.foregroundColor: KingmakerBar.gold, .underlineStyle: NSUnderlineStyle.single.rawValue, .cursor: NSCursor.pointingHand]
    scroll.documentView = log; scroll.hasVerticalScroller = true; scroll.autohidesScrollers = true; scroll.scrollerStyle = .overlay
    scroll.drawsBackground = false; scroll.borderType = .noBorder
    log.autoresizingMask = [.width]

    picksBox.orientation = .vertical; picksBox.alignment = .leading; picksBox.spacing = 2

    // The composer: a soft rounded field inside the sheet, + on the left, stop and mic on the right.
    composer.wantsLayer = true; composer.layer?.cornerRadius = 16; composer.layer?.cornerCurve = .continuous
    composer.layer?.backgroundColor = NSColor.white.withAlphaComponent(0.07).cgColor
    composer.layer?.borderWidth = 0.5; composer.layer?.borderColor = NSColor.white.withAlphaComponent(0.14).cgColor
    field.placeholderString = UI.t("Ask or tell Kingmaker anything — open, text, connect…   / for a program")
    field.font = .systemFont(ofSize: 15); field.isBordered = false; field.drawsBackground = false; field.focusRingType = .none
    field.delegate = self; field.cell?.usesSingleLineMode = true; field.cell?.wraps = false; field.cell?.isScrollable = true
    field.setAccessibilityLabel("Message for Kingmaker")

    func symbol(_ b: NSButton, _ name: String, _ label: String, _ action: Selector, size: CGFloat = 15) {
      b.bezelStyle = .regularSquare; b.isBordered = false; b.imagePosition = .imageOnly
      b.image = NSImage(systemSymbolName: name, accessibilityDescription: label)?.withSymbolConfiguration(.init(pointSize: size, weight: .medium))
      b.contentTintColor = .secondaryLabelColor
      b.target = self; b.action = action; b.toolTip = label; b.setAccessibilityLabel(label)
    }
    symbol(plus, "plus", "Choose a folder or attach a file", #selector(plusMenu(_:)), size: 16)
    symbol(stop, "stop.circle", "Stop", #selector(stopTapped))
    symbol(mic, "mic", "Dictate into the box (⌥-click: talk to Kingmaker)", #selector(micTapped))
    // ↵ at the right end: the same as Return (⌘- or ⌥-click queues it, like ⌘↵); dim while the box is empty.
    symbol(sendButton, "return", "Send (↵) · ⌘↵ to queue", #selector(sendTapped), size: 15)
    for v in [plus, field, stop, mic, sendButton] as [NSView] { composer.addSubview(v) }

    // The footer: small pills with symbols (folder, on/off, voice), the model on the right.
    for b in [folderButton, muteButton, powerButton, commandsButton] {
      b.bezelStyle = .regularSquare; b.isBordered = false; b.imagePosition = .imageLeading; b.imageHugsTitle = true
      b.font = .systemFont(ofSize: 12, weight: .medium); b.contentTintColor = .secondaryLabelColor; b.target = self
      b.wantsLayer = true; b.layer?.cornerRadius = 10; b.layer?.backgroundColor = NSColor.white.withAlphaComponent(0.06).cgColor
    }
    folderButton.action = #selector(chooseFolder); muteButton.action = #selector(toggleMute); powerButton.action = #selector(togglePower)
    commandsButton.action = #selector(commandsMenu(_:)); commandsButton.toolTip = UI.t("Every shortcut key, command and phrase"); commandsButton.setAccessibilityLabel("Commands")
    modelPopup.font = .systemFont(ofSize: 12, weight: .medium); modelPopup.isBordered = false; modelPopup.target = self; modelPopup.action = #selector(modelChanged)
    (modelPopup.cell as? NSPopUpButtonCell)?.arrowPosition = .arrowAtBottom
    statusLabel.font = .systemFont(ofSize: 11); statusLabel.textColor = .tertiaryLabelColor
    blackFill.wantsLayer = true
    // The wordmark, like RONIN INC on ronininc.org (Bodoni, wide capitals), centred at the top.
    titleLabel.attributedStringValue = KingmakerBar.wordmark(kern: 4.5)
    titleLabel.lineBreakMode = .byClipping
    symbol(gear, "gearshape", "Settings: API keys and tokens, MCP servers and connectors, and what Kingmaker may reach on this Mac", #selector(openSettings(_:)), size: 13)
    customizeButton.title = UI.t(" Customize"); customizeButton.image = NSImage(systemSymbolName: "slider.horizontal.3", accessibilityDescription: "Customize")?.withSymbolConfiguration(.init(pointSize: 11, weight: .semibold))
    customizeButton.imagePosition = .imageLeading; customizeButton.bezelStyle = .regularSquare; customizeButton.isBordered = false
    customizeButton.font = .systemFont(ofSize: 12, weight: .medium); customizeButton.contentTintColor = NSColor.white.withAlphaComponent(0.8)
    customizeButton.wantsLayer = true; customizeButton.layer?.cornerRadius = 10; customizeButton.layer?.backgroundColor = NSColor.white.withAlphaComponent(0.07).cgColor
    customizeButton.target = self; customizeButton.action = #selector(openCalibration)
    flowScroll.documentView = flowView; flowScroll.drawsBackground = false; flowScroll.hasVerticalScroller = true; flowScroll.autohidesScrollers = true
    flowScroll.scrollerStyle = .overlay; flowScroll.borderType = .noBorder; flowScroll.isHidden = true
    symbol(flowClose, "xmark.circle.fill", "Back to the chat", #selector(closeFlow), size: 14); flowClose.isHidden = true
    symbol(sheetClose, "xmark.circle.fill", "Back to the chat", #selector(closeSheet), size: 16); sheetClose.isHidden = true
    sheetHost.isHidden = true; sheetHost.appearance = NSAppearance(named: .darkAqua); sheetHost.wantsLayer = true
    sheetHost.layer?.cornerRadius = 12; sheetHost.layer?.backgroundColor = NSColor.white.withAlphaComponent(0.03).cgColor
    customizeButton.toolTip = "Customize each function: the model weights it runs on and its calibration"; customizeButton.setAccessibilityLabel("Customize functions")
    symbol(minimize, "minus", "Minimize (Kingmaker keeps running; click the logo or ⌥Space to bring it back)", #selector(minimizeTapped), size: 13)
    symbol(sideToggle, "sidebar.left", UI.t("Show or hide your chats"), #selector(toggleSidebar), size: 12)
    symbol(swapButton, "rectangle.2.swap", "Swap: bring the key page or Kingmaker to the front", #selector(swapBeside), size: 12)
    swapButton.isHidden = true
    newChatButton.title = UI.t(" New chat"); newChatButton.image = NSImage(systemSymbolName: "square.and.pencil", accessibilityDescription: "New chat")?.withSymbolConfiguration(.init(pointSize: 12, weight: .medium))
    newChatButton.imagePosition = .imageLeading; newChatButton.bezelStyle = .regularSquare; newChatButton.isBordered = false; newChatButton.alignment = .left
    newChatButton.font = .systemFont(ofSize: 12.5, weight: .semibold); newChatButton.contentTintColor = NSColor.white.withAlphaComponent(0.85)
    newChatButton.target = self; newChatButton.action = #selector(newChat); newChatButton.wantsLayer = true
    newChatButton.layer?.cornerRadius = 9; newChatButton.layer?.backgroundColor = NSColor.white.withAlphaComponent(0.07).cgColor
    newProjectButton.title = UI.t(" New project"); newProjectButton.image = NSImage(systemSymbolName: "folder.badge.plus", accessibilityDescription: "New project")?.withSymbolConfiguration(.init(pointSize: 12, weight: .medium))
    newProjectButton.imagePosition = .imageLeading; newProjectButton.bezelStyle = .regularSquare; newProjectButton.isBordered = false; newProjectButton.alignment = .left
    newProjectButton.font = .systemFont(ofSize: 12.5, weight: .medium); newProjectButton.contentTintColor = NSColor.white.withAlphaComponent(0.7)
    newProjectButton.target = self; newProjectButton.action = #selector(newProject); newProjectButton.wantsLayer = true; newProjectButton.layer?.cornerRadius = 9
    side.wantsLayer = true; side.layer?.backgroundColor = NSColor.white.withAlphaComponent(0.035).cgColor
    sideScroll.documentView = sideList; sideScroll.drawsBackground = false; sideScroll.hasVerticalScroller = true; sideScroll.autohidesScrollers = true
    sideScroll.scrollerStyle = .overlay; sideScroll.borderType = .noBorder
    sideTabs.segmentStyle = .separated; sideTabs.trackingMode = .selectOne; sideTabs.segmentCount = 4
    for (i, (sym, tip)) in [("bubble.left.and.bubble.right", UI.t("Chats and projects")), ("photo.on.rectangle.angled", UI.t("Artifacts: what Kingmaker made")), ("wand.and.stars", UI.t("Skills")), ("puzzlepiece.extension", UI.t("Plugins and connectors"))].enumerated() {
      sideTabs.setImage(NSImage(systemSymbolName: sym, accessibilityDescription: tip)?.withSymbolConfiguration(.init(pointSize: 11, weight: .medium)), forSegment: i)
      sideTabs.setToolTip(tip, forSegment: i); sideTabs.setWidth(32, forSegment: i)
    }
    sideTabs.selectedSegment = sideTab; sideTabs.target = self; sideTabs.action = #selector(sideTabChanged)
    selectToggle.image = NSImage(systemSymbolName: "checkmark.circle", accessibilityDescription: "Select")?.withSymbolConfiguration(.init(pointSize: 12, weight: .medium))
    selectToggle.isBordered = false; selectToggle.bezelStyle = .regularSquare; selectToggle.imagePosition = .imageOnly; selectToggle.contentTintColor = NSColor.white.withAlphaComponent(0.6)
    selectToggle.toolTip = UI.t("Select several to delete, move or pin at once"); selectToggle.target = self; selectToggle.action = #selector(toggleSelecting)
    selectBar.wantsLayer = true; selectBar.layer?.backgroundColor = NSColor.white.withAlphaComponent(0.05).cgColor; selectBar.isHidden = true
    selectCount.font = .systemFont(ofSize: 11, weight: .medium); selectCount.textColor = NSColor.white.withAlphaComponent(0.6)
    for (b, sym, tip, act) in [(selectDelete, "trash", "Delete the selected", #selector(deleteMarked)), (selectMove, "folder", "Move the selected chats to a project", #selector(moveMarked(_:))), (selectPin, "pin", "Pin or unpin the selected chats", #selector(pinMarked))] {
      b.image = NSImage(systemSymbolName: sym, accessibilityDescription: tip)?.withSymbolConfiguration(.init(pointSize: 12, weight: .medium))
      b.isBordered = false; b.bezelStyle = .regularSquare; b.imagePosition = .imageOnly; b.contentTintColor = NSColor.white.withAlphaComponent(0.75)
      b.toolTip = tip; b.target = self; b.action = act; selectBar.addSubview(b)
    }
    selectBar.addSubview(selectCount)
    for v in [sideTabs, selectToggle, newChatButton, newProjectButton, sideScroll, selectBar] as [NSView] { side.addSubview(v) }
    refreshSideButtons()
    symbol(fill, "plus", "Maximize (again: back to the size before). Drag any edge or corner to resize.", #selector(fillTapped), size: 13)
    // The key strip: 🔒 what to paste · the hidden field · Save · Cancel · Key page
    keyStrip.wantsLayer = true; keyStrip.layer?.cornerRadius = 14; keyStrip.layer?.cornerCurve = .continuous
    keyStrip.layer?.backgroundColor = NSColor(srgbRed: 0.29, green: 0.87, blue: 0.5, alpha: 0.10).cgColor
    keyStrip.layer?.borderWidth = 0.5; keyStrip.layer?.borderColor = NSColor(srgbRed: 0.29, green: 0.87, blue: 0.5, alpha: 0.45).cgColor
    keyLabel.font = .systemFont(ofSize: 11, weight: .medium); keyLabel.textColor = NSColor.white.withAlphaComponent(0.75); keyLabel.lineBreakMode = .byTruncatingTail
    keyField.font = .monospacedSystemFont(ofSize: 13, weight: .regular); keyField.isBordered = false; keyField.drawsBackground = true
    keyField.backgroundColor = NSColor.white.withAlphaComponent(0.08); keyField.textColor = .white; keyField.focusRingType = .none
    keyField.target = self; keyField.action = #selector(saveKey); keyField.setAccessibilityLabel("API key (hidden)")
    for (b, title, action) in [(keySave, "Save", #selector(saveKey)), (keyCancel, "Cancel", #selector(cancelKey)), (keyPage, "Key page", #selector(openKeyPage))] {
      b.title = title; b.bezelStyle = .regularSquare; b.isBordered = false; b.font = .systemFont(ofSize: 12, weight: .semibold)
      b.contentTintColor = b === keySave ? NSColor(srgbRed: 0.29, green: 0.87, blue: 0.5, alpha: 1) : .secondaryLabelColor
      b.target = self; b.action = action; b.wantsLayer = true; b.layer?.cornerRadius = 9; b.layer?.backgroundColor = NSColor.white.withAlphaComponent(0.07).cgColor
    }
    for v in [keyLabel, keyField, keySave, keyCancel, keyPage] as [NSView] { keyStrip.addSubview(v) }
    keyStrip.isHidden = true
    panel.onPaste = { [weak self] in self?.pasteMedia() ?? false }
    for v in [blackFill, side, scroll, picksBox, composer, keyStrip, folderButton, muteButton, powerButton, commandsButton, modelPopup, statusLabel, titleLabel, gear, customizeButton, minimize, fill, sideToggle, swapButton, flowScroll, flowClose, sheetHost, sheetClose] as [NSView] { backdrop.addSubview(v) }
    drawChats()
    panel.onMinimize = { [weak self] in self?.hide() }
    applyLook(); refreshFooter(); loadModels(); loadPrograms(); layout()
  }

  // ── Customize (this Mac's own settings, kept in its defaults) ──
  private static let d = UserDefaults.standard
  private var lookPref: String { KingmakerBar.d.string(forKey: "km.look") ?? "black" }
  private var replyColour: NSColor {
    switch KingmakerBar.d.string(forKey: "km.replyColor") ?? "green" {
    case "white": return .white
    case "blue": return NSColor(srgbRed: 0.45, green: 0.72, blue: 1, alpha: 1)
    case "amber": return NSColor(srgbRed: 1, green: 0.75, blue: 0.3, alpha: 1)
    default: return NSColor(srgbRed: 0.29, green: 0.87, blue: 0.5, alpha: 1)   // green
    }
  }
  private var textSize: CGFloat { CGFloat(KingmakerBar.d.object(forKey: "km.textSize") as? Double ?? 14) }
  var browserBundle: String? { switch KingmakerBar.d.string(forKey: "km.browser") ?? "chrome" { case "safari": return "com.apple.Safari"; case "default": return nil; default: return "com.google.Chrome" } }
  private var searchWhileTyping: Bool { KingmakerBar.d.object(forKey: "km.search") as? Bool ?? true }
  var speakPref: String { KingmakerBar.d.string(forKey: "km.speak") ?? "short" }      // short | full | never
  private var offAction: String { KingmakerBar.d.string(forKey: "km.offAction") ?? "ask" } // ask | auto | close

  private func applyLook() {
    let black = lookPref == "black"
    panel.appearance = lookPref == "system" ? nil : NSAppearance(named: .darkAqua)
    blackFill.isHidden = !black
    blackFill.layer?.backgroundColor = NSColor.black.withAlphaComponent(0.96).cgColor
    backdrop.layer?.borderColor = (black ? NSColor.white.withAlphaComponent(0.14) : NSColor.white.withAlphaComponent(0.18)).cgColor
    composer.layer?.backgroundColor = NSColor.white.withAlphaComponent(black ? 0.09 : 0.07).cgColor
    field.textColor = .white
    field.font = .systemFont(ofSize: textSize + 1)
    applyPlaceholder()
  }

  /// The empty box shows the suggested next command in a soft off colour (lavender), else the usual hint in grey.
  private func applyPlaceholder() {
    let font = NSFont.systemFont(ofSize: textSize + 1)
    if let s = suggestion {
      let t = NSMutableAttributedString(string: s, attributes: [.foregroundColor: NSColor(srgbRed: 0.70, green: 0.64, blue: 1.0, alpha: 0.72), .font: font])
      t.append(NSAttributedString(string: "   ⇥ Tab", attributes: [.foregroundColor: NSColor.white.withAlphaComponent(0.28), .font: NSFont.systemFont(ofSize: textSize - 2)]))
      field.placeholderAttributedString = t
    } else {
      field.placeholderAttributedString = NSAttributedString(string: KingmakerBar.hint, attributes: [.foregroundColor: NSColor.white.withAlphaComponent(0.45), .font: font])
    }
  }
  /// LIVE DICTATION (lib/voice.mjs): while fn is held, what Kingmaker hears so far is written into the box as it's said;
  /// on release (partial null) the box clears, because the spoken command goes in by itself.
  private var dictating = false
  func partial(_ text: String?) {
    if let t = text?.trimmingCharacters(in: .whitespacesAndNewlines) {
      if !panel.isVisible { show() }
      dictating = true; field.stringValue = t; field.currentEditor()?.moveToEndOfDocument(nil)
    } else if dictating { dictating = false; field.stringValue = "" }
  }
  /// Kingmaker's suggested next command (@@ghost suggest).
  func suggest(_ s: String) { suggestion = s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : s; applyPlaceholder() }
  private func clearSuggestion() { if suggestion != nil { suggestion = nil; applyPlaceholder() } }
  /// Tab or → in the empty box: the suggestion becomes the message, ready to send or edit.
  private func takeSuggestion() -> Bool {
    guard field.stringValue.isEmpty, let s = suggestion else { return false }
    field.stringValue = s; field.currentEditor()?.moveToEndOfDocument(nil); clearSuggestion(); refreshSend()
    return true
  }

  // ── the sidebar: New chat and the past chats ──
  private static let chatsURL = URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support/sol-ghost/chats.json")
  static func loadChats() -> [BarChat] { (try? JSONDecoder().decode([BarChat].self, from: Data(contentsOf: chatsURL))) ?? [] }
  private func saveChats() {
    guard let data = try? JSONEncoder().encode(chats) else { return }
    try? data.write(to: KingmakerBar.chatsURL, options: .atomic)
    try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: KingmakerBar.chatsURL.path)
  }
  /// Every line shown goes into the chat being written (a note before anything was asked doesn't start one).
  private func remember(_ who: String, _ text: String) {
    if staging { return }   // an ad's stage chat is never saved
    if chatIndex == nil {
      if who.isEmpty { return }
      chats.insert(BarChat(id: UUID().uuidString, title: String(text.replacingOccurrences(of: "\n", with: " ").prefix(60)), at: Date().timeIntervalSince1970, lines: [], project: newChatProject), at: 0)
      chatIndex = 0; newChatProject = nil
    }
    guard let i = chatIndex, i < chats.count else { return }
    var c = chats.remove(at: i)
    c.lines.append([who, String(text.prefix(8000))]); if c.lines.count > 400 { c.lines.removeFirst(c.lines.count - 400) }
    c.at = Date().timeIntervalSince1970
    chats.insert(c, at: 0); chatIndex = 0
    // Over 80: the oldest unpinned chats go (a pinned chat stays until it's unpinned or deleted).
    while chats.count > 80, let old = chats.lastIndex(where: { $0.pinned != true && $0.id != c.id }) { chats.remove(at: old) }
    saveChats(); drawChats()
  }
  private func saveProjects() { KingmakerBar.d.set(projects, forKey: "km.projects") }
  /// The sidebar list: Pinned, then each project (its header has + for a new chat in it), then Recent.
  private func drawChats() {
    sideList.subviews.forEach { $0.removeFromSuperview() }
    if sideTab != 0 { drawTab(); return }
    let bw = KingmakerBar.sideW - 16
    var y: CGFloat = 0
    func header(_ title: String, project: String? = nil) {
      let l = NSTextField(labelWithString: title.uppercased())
      l.font = .systemFont(ofSize: 10.5, weight: .semibold); l.textColor = NSColor.white.withAlphaComponent(0.42); l.lineBreakMode = .byTruncatingTail
      l.frame = NSRect(x: 14, y: y + 8, width: bw - (project == nil ? 12 : 58), height: 14)
      sideList.addSubview(l)
      if let p = project, selecting {   // Select: the project itself can be marked (deleting it sends its chats to Recent)
        let id = "project:\(p)", on = marked.contains(id)
        let mark = NSButton(title: "", target: self, action: #selector(markTapped(_:)))
        mark.image = NSImage(systemSymbolName: on ? "checkmark.circle.fill" : "circle", accessibilityDescription: "Select \(p)")?.withSymbolConfiguration(.init(pointSize: 12, weight: .medium))
        mark.isBordered = false; mark.bezelStyle = .regularSquare; mark.imagePosition = .imageOnly; mark.contentTintColor = on ? .controlAccentColor : NSColor.white.withAlphaComponent(0.5)
        mark.identifier = NSUserInterfaceItemIdentifier(id); mark.frame = NSRect(x: 8 + bw - 22, y: y + 4, width: 22, height: 22)
        sideList.addSubview(mark)
      } else if let p = project {
        l.toolTip = p
        let plus = NSButton(title: "", target: self, action: #selector(newChatInProject(_:)))
        plus.image = NSImage(systemSymbolName: "plus", accessibilityDescription: "New chat in \(p)")?.withSymbolConfiguration(.init(pointSize: 11, weight: .semibold))
        plus.isBordered = false; plus.bezelStyle = .regularSquare; plus.imagePosition = .imageOnly; plus.contentTintColor = NSColor.white.withAlphaComponent(0.55)
        plus.identifier = NSUserInterfaceItemIdentifier(p); plus.toolTip = "New chat in \(p)"; plus.setAccessibilityLabel("New chat in \(p)")
        plus.frame = NSRect(x: 8 + bw - 22, y: y + 4, width: 22, height: 22)
        sideList.addSubview(plus)
        let gearB = NSButton(title: "", target: self, action: #selector(projectSettingsTapped(_:)))
        let hasDoctrine = !(projectSettings[p]?["doctrine"] ?? "").isEmpty
        gearB.image = NSImage(systemSymbolName: hasDoctrine ? "scroll.fill" : "scroll", accessibilityDescription: "Doctrine & settings for \(p)")?.withSymbolConfiguration(.init(pointSize: 10.5, weight: .semibold))
        gearB.isBordered = false; gearB.bezelStyle = .regularSquare; gearB.imagePosition = .imageOnly; gearB.contentTintColor = NSColor.white.withAlphaComponent(hasDoctrine ? 0.75 : 0.45)
        gearB.identifier = NSUserInterfaceItemIdentifier(p); gearB.toolTip = "Doctrine & settings for \(p)"; gearB.setAccessibilityLabel("Doctrine and settings for \(p)")
        gearB.frame = NSRect(x: 8 + bw - 46, y: y + 4, width: 22, height: 22)
        sideList.addSubview(gearB)
        // Right-click the project's name: its doctrine & settings, rename, or delete (its chats move to Recent).
        let m = NSMenu()
        for (t, a) in [("Doctrine & settings…", #selector(projectSettingsFromMenu(_:))), ("Rename project…", #selector(renameProject(_:))), ("Delete project", #selector(deleteProject(_:)))] {
          let it = NSMenuItem(title: t, action: a, keyEquivalent: ""); it.target = self; it.representedObject = p; m.addItem(it)
        }
        l.menu = m
      }
      y += 26
    }
    func row(_ c: BarChat) {
      let current = chatIndex.map { $0 < chats.count && chats[$0].id == c.id } ?? false
      let b = NSButton(title: "", target: self, action: #selector(openChat(_:)))
      b.identifier = NSUserInterfaceItemIdentifier(c.id); b.isBordered = false; b.bezelStyle = .regularSquare; b.alignment = .left
      b.attributedTitle = NSAttributedString(string: c.title.isEmpty ? "Chat" : c.title, attributes: [.font: NSFont.systemFont(ofSize: 12.5), .foregroundColor: NSColor.white.withAlphaComponent(current ? 0.95 : 0.7)])
      (b.cell as? NSButtonCell)?.lineBreakMode = .byTruncatingTail
      b.toolTip = c.title
      b.wantsLayer = true; b.layer?.cornerRadius = 8
      b.layer?.backgroundColor = marked.contains(c.id) ? NSColor.controlAccentColor.withAlphaComponent(0.30).cgColor : current ? NSColor.white.withAlphaComponent(0.10).cgColor : NSColor.clear.cgColor
      b.frame = NSRect(x: 8, y: y, width: bw - 24, height: 28)
      b.menu = chatMenu(c)
      let more = NSButton(title: "", target: self, action: #selector(chatMenuTapped(_:)))
      more.image = NSImage(systemSymbolName: "ellipsis", accessibilityDescription: "Chat options")?.withSymbolConfiguration(.init(pointSize: 11, weight: .semibold))
      more.isBordered = false; more.bezelStyle = .regularSquare; more.imagePosition = .imageOnly; more.contentTintColor = NSColor.white.withAlphaComponent(0.45)
      more.identifier = NSUserInterfaceItemIdentifier(c.id); more.toolTip = "Pin, move, rename or delete"; more.setAccessibilityLabel("Options for \(c.title)")
      more.frame = NSRect(x: 8 + bw - 24, y: y + 3, width: 22, height: 22)
      sideList.addSubview(b); sideList.addSubview(more); y += 30
    }
    let pinned = chats.filter { $0.pinned == true }
    if !pinned.isEmpty { header("Pinned"); pinned.forEach(row) }
    for p in projects {
      header(p, project: p)
      chats.filter { $0.pinned != true && $0.project == p }.forEach(row)
    }
    let recent = chats.filter { $0.pinned != true && !($0.project.map { projects.contains($0) } ?? false) }
    if !recent.isEmpty { header("Recent"); recent.forEach(row) }
    sideList.frame = NSRect(x: 0, y: 0, width: KingmakerBar.sideW, height: max(y, sideScroll.contentSize.height))
  }
  // ── the other tabs: Artifacts · Skills · Plugins ──
  @objc private func sideTabChanged() {
    sideTab = sideTabs.selectedSegment; KingmakerBar.d.set(sideTab, forKey: "km.sideTab")
    marked = []; refreshSideButtons()
    if sideTab == 1 { onCommand("artifacts") } else if sideTab >= 2 { onCommand("connectors") }
    drawChats(); layout()
  }
  /// Each tab's two buttons: Chats (New chat, New project), Artifacts (Refresh, Open folder), Skills (New skill, Add a
  /// skill folder), Plugins (Add plugin, Refresh). The second hides when a tab has none.
  private func refreshSideButtons() {
    let sets: [(String, String, Selector, String, String, Selector?)] = [
      (" New chat", "square.and.pencil", #selector(newChat), " New project", "folder.badge.plus", #selector(newProject)),
      (" Refresh", "arrow.clockwise", #selector(refreshArtifacts), " Open Kingmaker's folder", "folder", #selector(openArtifactsFolder)),
      (" New skill", "wand.and.stars", #selector(openSkillPanel), " Add a skill folder…", "folder.badge.plus", #selector(openConnectorsFromSide)),
      (" Add plugin", "puzzlepiece.extension", #selector(openConnectorsFromSide), " Refresh", "arrow.clockwise", #selector(refreshConnectorsFromSide)),
    ]
    let t = sets[sideTab]
    newChatButton.title = t.0; newChatButton.image = NSImage(systemSymbolName: t.1, accessibilityDescription: nil)?.withSymbolConfiguration(.init(pointSize: 12, weight: .medium)); newChatButton.action = t.2
    newProjectButton.title = t.3; newProjectButton.image = NSImage(systemSymbolName: t.4, accessibilityDescription: nil)?.withSymbolConfiguration(.init(pointSize: 12, weight: .medium)); newProjectButton.action = t.5
    selectMove.isHidden = sideTab != 0; selectPin.isHidden = sideTab != 0
    selectDelete.toolTip = ["Delete the selected chats and projects", "Move the selected files to the Trash", "Remove the selected skills", "Remove the selected plugins"][sideTab]
  }
  @objc private func refreshArtifacts() { onCommand("artifacts") }
  @objc private func refreshConnectorsFromSide() { onCommand("connectors") }
  @objc private func openConnectorsFromSide() { openConnectors() }
  /// Kingmaker's one hidden folder (lib/kingmaker-home.mjs): opened only when the owner asks for it.
  @objc private func openArtifactsFolder() {
    let u = BehaviorEditor.dir.appendingPathComponent("Files")
    try? FileManager.default.createDirectory(at: u, withIntermediateDirectories: true); NSWorkspace.shared.open(u)
  }
  /// @@ghost artifacts: everything Kingmaker made (lib/artifacts.mjs), newest first.
  func setArtifacts(_ list: [[String: Any]]) { artifacts = list; if sideTab == 1 { drawChats() } }
  /// One row in the Artifacts, Skills or Plugins tab: an icon, the name, a grey line, a menu; in Select, a click marks it.
  private func tabRow(_ id: String, _ title: String, _ detail: String, icon: NSImage?, y: inout CGFloat, menu: NSMenu, action: Selector) {
    let bw = KingmakerBar.sideW - 16
    let b = NSButton(title: "", target: self, action: selecting ? #selector(markTapped(_:)) : action)
    b.identifier = NSUserInterfaceItemIdentifier(id); b.isBordered = false; b.bezelStyle = .regularSquare; b.alignment = .left
    b.imagePosition = .imageLeading; b.imageHugsTitle = true
    icon?.size = NSSize(width: 16, height: 16); b.image = icon
    let t = NSMutableAttributedString(string: " \(title)", attributes: [.font: NSFont.systemFont(ofSize: 12), .foregroundColor: NSColor.white.withAlphaComponent(0.82)])
    t.append(NSAttributedString(string: "\n  \(detail)", attributes: [.font: NSFont.systemFont(ofSize: 10), .foregroundColor: NSColor.white.withAlphaComponent(0.4)]))
    b.attributedTitle = t; (b.cell as? NSButtonCell)?.lineBreakMode = .byTruncatingTail; b.toolTip = "\(title)\n\(detail)"
    b.wantsLayer = true; b.layer?.cornerRadius = 8
    b.layer?.backgroundColor = marked.contains(id) ? NSColor.controlAccentColor.withAlphaComponent(0.30).cgColor : NSColor.clear.cgColor
    b.frame = NSRect(x: 8, y: y, width: bw, height: 36); b.menu = menu
    sideList.addSubview(b); y += 38
  }
  private func drawTab() {
    var y: CGFloat = 4
    func menu(_ items: [(String, Selector)], _ value: String) -> NSMenu {
      let m = NSMenu(); for (t, a) in items { let it = NSMenuItem(title: t, action: a, keyEquivalent: ""); it.target = self; it.representedObject = value; m.addItem(it) }; return m
    }
    func empty(_ s: String) { let l = NSTextField(wrappingLabelWithString: s); l.font = .systemFont(ofSize: 11.5); l.textColor = NSColor.white.withAlphaComponent(0.4); l.frame = NSRect(x: 14, y: y + 6, width: KingmakerBar.sideW - 28, height: 60); sideList.addSubview(l); y += 70 }
    let df = DateFormatter(); df.dateStyle = .short; df.timeStyle = .short
    switch sideTab {
    case 1:
      if artifacts.isEmpty { empty("What Kingmaker makes lands here: documents, pictures, videos, reports.") }
      for a in artifacts {
        guard let path = a["path"] as? String, let name = a["name"] as? String else { continue }
        let when = (a["at"] as? Double).map { df.string(from: Date(timeIntervalSince1970: $0 / 1000)) } ?? ""
        tabRow(path, name, "\((a["where"] as? String) ?? "") · \(when)", icon: NSWorkspace.shared.icon(forFile: path), y: &y,
               menu: menu([("Open", #selector(openArtifact(_:))), ("Show in Finder", #selector(revealArtifact(_:))), ("Move to Trash", #selector(trashArtifact(_:)))], path), action: #selector(openArtifactRow(_:)))
      }
    case 2, 3:
      let items = connectors.filter { ((($0["kind"] as? String) ?? "") == "skill") == (sideTab == 2) }
      if items.isEmpty { empty(sideTab == 2 ? "No skills yet. New skill writes one; Add a skill folder brings one in." : "No plugins yet. Add plugin connects a CLI, an MCP server or a repo; REA checks each one first.") }
      for c in items {
        guard let id = c["id"] as? String else { continue }
        let name = (c["name"] as? String) ?? id, verdict = (c["verdict"] as? String) ?? ""
        let source = (c["source"] as? String) ?? ((c["kind"] as? String) ?? "")
        let detail = [source, verdict == "clean" ? "" : verdict, (c["enabled"] as? Bool) == false ? "off" : ""].filter { !$0.isEmpty }.joined(separator: " · ")
        let builtIn = c["builtIn"] is String
        var items: [(String, Selector)] = sideTab == 2 ? [("Open SKILL.md", #selector(openConnectorTarget(_:))), ("Show in Finder", #selector(revealConnectorTarget(_:)))] : [("Connectors & keys…", #selector(openConnectorsFromMenu(_:)))]
        if !builtIn { items.append(("Remove", #selector(removeConnectorFromSide(_:)))) }
        let sym = sideTab == 2 ? "wand.and.stars" : ["mcp": "server.rack", "cli": "terminal", "repo": "shippingbox"][(c["kind"] as? String) ?? ""] ?? "puzzlepiece.extension"
        tabRow(id, name, detail, icon: NSImage(systemSymbolName: sym, accessibilityDescription: nil), y: &y, menu: menu(items, id),
               action: sideTab == 2 ? #selector(openConnectorRow(_:)) : #selector(openConnectorsFromRow(_:)))
      }
    default: break
    }
    sideList.frame = NSRect(x: 0, y: 0, width: KingmakerBar.sideW, height: max(y, sideScroll.contentSize.height))
  }
  private func artifactPath(_ v: Any?) -> String? { guard let p = v as? String, artifacts.contains(where: { ($0["path"] as? String) == p }) else { return nil }; return p }
  @objc private func openArtifactRow(_ b: NSButton) { if let p = artifactPath(b.identifier?.rawValue) { NSWorkspace.shared.open(URL(fileURLWithPath: p)) } }
  @objc private func openArtifact(_ m: NSMenuItem) { if let p = artifactPath(m.representedObject) { NSWorkspace.shared.open(URL(fileURLWithPath: p)) } }
  @objc private func revealArtifact(_ m: NSMenuItem) { if let p = artifactPath(m.representedObject) { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: p)]) } }
  @objc private func trashArtifact(_ m: NSMenuItem) { if let p = artifactPath(m.representedObject) { trashArtifacts([p]) } }
  /// Only files from Kingmaker's own list (lib/artifacts.mjs), into the Trash (Put Back works), never deleted outright.
  private func trashArtifacts(_ paths: [String]) {
    let ok = paths.filter { artifactPath($0) != nil }
    guard !ok.isEmpty else { return }
    let alert = NSAlert(); alert.messageText = ok.count == 1 ? "Move “\((ok[0] as NSString).lastPathComponent)” to the Trash?" : "Move \(ok.count) files to the Trash?"
    alert.informativeText = "You can put them back from the Trash."; alert.addButton(withTitle: "Move to Trash"); alert.addButton(withTitle: "Cancel")
    NSApp.activate(ignoringOtherApps: true)
    guard alert.runModal() == .alertFirstButtonReturn else { return }
    var moved = 0
    for p in ok { if (try? FileManager.default.trashItem(at: URL(fileURLWithPath: p), resultingItemURL: nil)) != nil { moved += 1 } }
    append(who: "", "\(moved) file\(moved == 1 ? "" : "s") moved to the Trash.")
    marked = []; onCommand("artifacts")
  }
  private func connector(_ id: Any?) -> [String: Any]? { guard let id = id as? String else { return nil }; return connectors.first { ($0["id"] as? String) == id } }
  @objc private func openConnectorRow(_ b: NSButton) { if let t = connector(b.identifier?.rawValue)?["target"] as? String, t.hasPrefix("/") { NSWorkspace.shared.open(URL(fileURLWithPath: t)) } }
  @objc private func openConnectorTarget(_ m: NSMenuItem) { if let t = connector(m.representedObject)?["target"] as? String, t.hasPrefix("/") { NSWorkspace.shared.open(URL(fileURLWithPath: t)) } }
  @objc private func revealConnectorTarget(_ m: NSMenuItem) { if let t = connector(m.representedObject)?["target"] as? String, t.hasPrefix("/") { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: t)]) } }
  @objc private func openConnectorsFromRow(_ b: NSButton) { openConnectors() }
  @objc private func openConnectorsFromMenu(_ m: NSMenuItem) { openConnectors() }
  @objc private func removeConnectorFromSide(_ m: NSMenuItem) { if let id = m.representedObject as? String { removeConnectors([id]) } }
  /// Remove connectors the owner added (a built-in skill can't be removed; it's skipped and said so).
  private func removeConnectors(_ ids: [String]) {
    let mine = ids.compactMap { connector($0) }.filter { !($0["builtIn"] is String) }
    let builtIns = ids.count - mine.count
    guard !mine.isEmpty else { if builtIns > 0 { append(who: "", "Built-in skills can't be removed (they ship with Kingmaker).") }; return }
    let alert = NSAlert(); alert.messageText = mine.count == 1 ? "Remove \((mine[0]["name"] as? String) ?? "it")?" : "Remove \(mine.count) connectors?"
    alert.informativeText = "Kingmaker stops using \(mine.count == 1 ? "it" : "them"). The files on this Mac stay where they are."
    alert.addButton(withTitle: "Remove"); alert.addButton(withTitle: "Cancel"); NSApp.activate(ignoringOtherApps: true)
    guard alert.runModal() == .alertFirstButtonReturn else { return }
    for c in mine { if let id = c["id"] as? String { onCommand("connector-remove \(id)") } }
    if builtIns > 0 { append(who: "", "\(builtIns) built-in skill\(builtIns == 1 ? "" : "s") left alone (they ship with Kingmaker).") }
    marked = []; DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in self?.onCommand("connectors") }
  }

  // ── Select: many at once ──
  @objc private func toggleSelecting() {
    selecting.toggle(); marked = []
    selectToggle.image = NSImage(systemSymbolName: selecting ? "checkmark.circle.fill" : "checkmark.circle", accessibilityDescription: "Select")?.withSymbolConfiguration(.init(pointSize: 12, weight: .medium))
    selectToggle.contentTintColor = selecting ? .controlAccentColor : NSColor.white.withAlphaComponent(0.6)
    refreshMarks(); drawChats(); layout()
  }
  @objc private func markTapped(_ b: NSButton) { if let id = b.identifier?.rawValue { toggleMark(id) } }
  private func toggleMark(_ id: String) { if marked.contains(id) { marked.remove(id) } else { marked.insert(id) }; refreshMarks(); drawChats() }
  private func refreshMarks() {
    selectCount.stringValue = marked.isEmpty ? "Select…" : "\(marked.count) selected"
    for b in [selectDelete, selectMove, selectPin] { b.isEnabled = !marked.isEmpty }
  }
  @objc private func deleteMarked() {
    switch sideTab {
    case 1: trashArtifacts(Array(marked))
    case 2, 3: removeConnectors(Array(marked))
    default:
      let ids = Set(chats.map(\.id)).intersection(marked), projs = marked.filter { $0.hasPrefix("project:") }.map { String($0.dropFirst(8)) }
      guard !ids.isEmpty || !projs.isEmpty else { return }
      let alert = NSAlert()
      alert.messageText = "Delete \([ids.isEmpty ? nil : "\(ids.count) chat\(ids.count == 1 ? "" : "s")", projs.isEmpty ? nil : "\(projs.count) project\(projs.count == 1 ? "" : "s")"].compactMap { $0 }.joined(separator: " and "))?"
      alert.informativeText = projs.isEmpty ? "They're removed from this Mac's chats." : "A deleted project's other chats go back to Recent."
      alert.addButton(withTitle: "Delete"); alert.addButton(withTitle: "Cancel"); NSApp.activate(ignoringOtherApps: true)
      guard alert.runModal() == .alertFirstButtonReturn else { return }
      let open = chatIndex.flatMap { $0 < chats.count ? chats[$0].id : nil }
      chats.removeAll { ids.contains($0.id) }
      for p in projs { projects.removeAll { $0 == p }; projectSettings.removeValue(forKey: p); for j in chats.indices where chats[j].project == p { chats[j].project = nil } }
      saveChats(); saveProjects(); saveProjectSettings(); marked = []; refreshMarks()
      if let o = open, ids.contains(o) { newChat() } else { chatIndex = open.flatMap { o in chats.firstIndex { $0.id == o } }; drawChats() }
    }
  }
  @objc private func pinMarked() {
    let ids = Set(chats.map(\.id)).intersection(marked); guard !ids.isEmpty else { return }
    let allPinned = chats.filter { ids.contains($0.id) }.allSatisfy { $0.pinned == true }
    for j in chats.indices where ids.contains(chats[j].id) { chats[j].pinned = allPinned ? nil : true }
    saveChats(); marked = []; refreshMarks(); drawChats()
  }
  @objc private func moveMarked(_ sender: NSButton) {
    let m = NSMenu()
    for p in projects { let it = NSMenuItem(title: p, action: #selector(moveMarkedTo(_:)), keyEquivalent: ""); it.target = self; it.representedObject = p; m.addItem(it) }
    if !projects.isEmpty { m.addItem(.separator()) }
    let none = NSMenuItem(title: "No project (Recent)", action: #selector(moveMarkedTo(_:)), keyEquivalent: ""); none.target = self; none.representedObject = ""; m.addItem(none)
    m.popUp(positioning: nil, at: NSPoint(x: 0, y: sender.bounds.height + 2), in: sender)
  }
  @objc private func moveMarkedTo(_ item: NSMenuItem) {
    let p = (item.representedObject as? String) ?? ""
    for j in chats.indices where marked.contains(chats[j].id) { chats[j].project = p.isEmpty ? nil : p }
    saveChats(); marked = []; refreshMarks(); drawChats()
  }

  // ── New skill: a name, what it's for, its instructions → skill-create (REA reads it on the setup screen) ──
  @objc private func openSkillPanel() {
    skillName.placeholderString = "Name (e.g. taco-truck-ads)"; skillWhat.placeholderString = "What it's for, in one line"
    skillName.stringValue = ""; skillWhat.stringValue = ""; skillText.string = ""
    skillText.font = .systemFont(ofSize: 13); skillText.isRichText = false; skillText.textContainerInset = NSSize(width: 6, height: 6)
    let scroll = NSScrollView(); scroll.documentView = skillText; scroll.hasVerticalScroller = true; scroll.borderType = .bezelBorder
    skillText.autoresizingMask = [.width]; skillText.isVerticallyResizable = true; skillText.minSize = NSSize(width: 0, height: 200)
    scroll.heightAnchor.constraint(equalToConstant: 220).isActive = true; scroll.widthAnchor.constraint(equalToConstant: 520).isActive = true
    for f in [skillName, skillWhat] { f.widthAnchor.constraint(equalToConstant: 520).isActive = true }
    let hint = NSTextField(wrappingLabelWithString: "Instructions: how to do the job, step by step, and what to never do. Kingmaker reads them whenever the skill is used (/name in the box). REA reads the skill first.")
    hint.font = .systemFont(ofSize: 11.5); hint.textColor = .secondaryLabelColor; hint.preferredMaxLayoutWidth = 520
    let create = NSButton(title: UI.t("Create skill"), target: self, action: #selector(createSkill)); create.bezelStyle = .rounded; create.keyEquivalent = "\r"
    let cancel = NSButton(title: UI.t("Cancel"), target: self, action: #selector(closeSkillPanel)); cancel.bezelStyle = .rounded
    let buttons = NSStackView(views: [create, cancel]); buttons.spacing = 10
    let stack = NSStackView(views: [skillName, skillWhat, hint, scroll, buttons]); stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 10
    stack.edgeInsets = NSEdgeInsets(top: 18, left: 20, bottom: 18, right: 20)
    let p = skillPanel ?? NSPanel(contentRect: NSRect(x: 0, y: 0, width: 560, height: 430), styleMask: [.titled, .closable, .utilityWindow], backing: .buffered, defer: false)
    p.title = "New skill"; p.isReleasedWhenClosed = false; p.level = .floating + 1; p.appearance = NSAppearance(named: .darkAqua); p.contentView = stack
    skillPanel = p; p.center(); NSApp.activate(ignoringOtherApps: true); p.makeKeyAndOrderFront(nil); p.makeFirstResponder(skillName)
  }
  @objc private func closeSkillPanel() { skillPanel?.orderOut(nil) }
  @objc private func createSkill() {
    let spec: [String: String] = ["name": skillName.stringValue, "description": skillWhat.stringValue, "instructions": skillText.string]
    guard !(spec["name"] ?? "").trimmingCharacters(in: .whitespaces).isEmpty, let json = try? JSONSerialization.data(withJSONObject: spec) else { NSSound.beep(); return }
    closeSkillPanel(); onCommand("skill-create \(json.base64EncodedString())")
  }

  /// A chat row's menu: Pin/Unpin, Move to project ▸, Rename…, Delete.
  private func chatMenu(_ c: BarChat) -> NSMenu {
    let m = NSMenu()
    func item(_ title: String, _ action: Selector, _ value: Any, symbol: String? = nil) -> NSMenuItem {
      let it = NSMenuItem(title: title, action: action, keyEquivalent: ""); it.target = self; it.representedObject = value
      if let s = symbol { it.image = NSImage(systemSymbolName: s, accessibilityDescription: nil) }
      return it
    }
    m.addItem(item(c.pinned == true ? "Unpin" : "Pin", #selector(togglePin(_:)), c.id, symbol: c.pinned == true ? "pin.slash" : "pin"))
    let move = NSMenuItem(title: "Move to project", action: nil, keyEquivalent: ""); move.image = NSImage(systemSymbolName: "folder", accessibilityDescription: nil)
    let sub = NSMenu()
    for p in projects { let it = item(p, #selector(moveChat(_:)), [c.id, p]); it.state = c.project == p ? .on : .off; sub.addItem(it) }
    if !projects.isEmpty { sub.addItem(.separator()) }
    if c.project != nil { sub.addItem(item("No project", #selector(moveChat(_:)), [c.id, ""])) }
    sub.addItem(item("New project…", #selector(moveChatToNewProject(_:)), c.id))
    move.submenu = sub; m.addItem(move)
    m.addItem(item("Rename…", #selector(renameChat(_:)), c.id, symbol: "pencil"))
    m.addItem(.separator())
    m.addItem(item("Delete", #selector(deleteChat(_:)), c.id, symbol: "trash"))
    return m
  }
  @objc private func chatMenuTapped(_ sender: NSButton) {
    guard let id = sender.identifier?.rawValue, let c = chats.first(where: { $0.id == id }) else { return }
    chatMenu(c).popUp(positioning: nil, at: NSPoint(x: 0, y: sender.bounds.height + 2), in: sender)
  }
  /// Changes one chat by id, keeps the open chat open, saves and redraws.
  private func editChat(_ id: String, _ change: (inout BarChat) -> Void) {
    guard let i = chats.firstIndex(where: { $0.id == id }) else { return }
    change(&chats[i]); saveChats(); drawChats()
  }
  @objc private func togglePin(_ sender: NSMenuItem) {
    guard let id = sender.representedObject as? String else { return }
    editChat(id) { $0.pinned = $0.pinned == true ? nil : true }
  }
  @objc private func moveChat(_ sender: NSMenuItem) {
    guard let v = sender.representedObject as? [String], v.count == 2 else { return }
    editChat(v[0]) { $0.project = v[1].isEmpty ? nil : v[1] }
  }
  @objc private func moveChatToNewProject(_ sender: NSMenuItem) {
    guard let id = sender.representedObject as? String, let name = askName("New project", "Its chats are kept together in the sidebar.", "") else { return }
    addProject(name); editChat(id) { $0.project = name }
  }
  @objc private func renameChat(_ sender: NSMenuItem) {
    guard let id = sender.representedObject as? String, let c = chats.first(where: { $0.id == id }),
          let name = askName("Rename chat", "", c.title, limit: 60) else { return }
    editChat(id) { $0.title = name }
  }
  @objc private func deleteChat(_ sender: NSMenuItem) {
    guard let id = sender.representedObject as? String, let i = chats.firstIndex(where: { $0.id == id }) else { return }
    let alert = NSAlert(); alert.messageText = "Delete “\(chats[i].title.isEmpty ? "Chat" : chats[i].title)”?"
    alert.informativeText = "It's removed from this Mac's chats. The bar's log (logs/bar.log) keeps its lines."
    alert.addButton(withTitle: "Delete"); alert.addButton(withTitle: "Cancel")
    NSApp.activate(ignoringOtherApps: true)
    guard alert.runModal() == .alertFirstButtonReturn, let j = chats.firstIndex(where: { $0.id == id }) else { return }
    let open = chatIndex.flatMap { $0 < chats.count ? chats[$0].id : nil }
    chats.remove(at: j); saveChats()
    if open == id { newChat() } else { chatIndex = open.flatMap { o in chats.firstIndex { $0.id == o } }; drawChats() }
  }
  /// A one-line name from the owner (a project or a chat title), or nil when cancelled or empty.
  private func askName(_ title: String, _ info: String, _ value: String, limit: Int = 40) -> String? {
    let alert = NSAlert(); alert.messageText = title; alert.informativeText = info
    let f = NSTextField(frame: NSRect(x: 0, y: 0, width: 260, height: 24)); f.stringValue = value; alert.accessoryView = f
    alert.addButton(withTitle: "OK"); alert.addButton(withTitle: "Cancel")
    NSApp.activate(ignoringOtherApps: true)
    alert.window.initialFirstResponder = f
    defer { show() }
    guard alert.runModal() == .alertFirstButtonReturn else { return nil }
    let name = String(f.stringValue.replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespaces).prefix(limit))
    return name.isEmpty ? nil : name
  }
  private func addProject(_ name: String) { if !projects.contains(name) { projects.append(name); saveProjects() } }
  @objc private func newProject() {
    guard let name = askName("New project", "Its chats are kept together in the sidebar. + on the project starts a chat in it.", "") else { return }
    addProject(name); drawChats()
  }
  @objc private func newChatInProject(_ sender: NSButton) {
    guard let p = sender.identifier?.rawValue else { return }
    newChat(); newChatProject = p
    append(who: "", "New chat in \(p).")
  }
  private func saveProjectSettings() { KingmakerBar.d.set(projectSettings, forKey: "km.projectSettings") }
  @objc private func projectSettingsTapped(_ sender: NSButton) { if let p = sender.identifier?.rawValue { openProjectSettings(p) } }
  @objc private func projectSettingsFromMenu(_ sender: NSMenuItem) { if let p = sender.representedObject as? String { openProjectSettings(p) } }
  /// The project's doctrine (standing instructions every turn in it follows), its folder and its model.
  private func openProjectSettings(_ p: String) {
    projectEditing = p
    let s = projectSettings[p] ?? [:]
    let title = NSTextField(labelWithString: "Doctrine"); title.font = .systemFont(ofSize: 13, weight: .semibold)
    let hint = NSTextField(wrappingLabelWithString: "How Kingmaker works in this project: its voice, its rules, what it must always or never do. Every turn in the project's chats follows it.")
    hint.font = .systemFont(ofSize: 11.5); hint.textColor = .secondaryLabelColor; hint.preferredMaxLayoutWidth = 520
    doctrineView.string = s["doctrine"] ?? ""; doctrineView.font = .systemFont(ofSize: 13); doctrineView.isRichText = false
    doctrineView.isAutomaticQuoteSubstitutionEnabled = false; doctrineView.textContainerInset = NSSize(width: 6, height: 6)
    let docScroll = NSScrollView(); docScroll.documentView = doctrineView; docScroll.hasVerticalScroller = true; docScroll.borderType = .bezelBorder
    doctrineView.autoresizingMask = [.width]; doctrineView.minSize = NSSize(width: 0, height: 200); doctrineView.isVerticallyResizable = true
    docScroll.heightAnchor.constraint(equalToConstant: 240).isActive = true; docScroll.widthAnchor.constraint(equalToConstant: 540).isActive = true
    let settingsTitle = NSTextField(labelWithString: "Settings"); settingsTitle.font = .systemFont(ofSize: 13, weight: .semibold)
    projectFolderPath = s["folder"] ?? ""
    projectFolderLabel.stringValue = projectFolderPath.isEmpty ? "The bar's folder" : (projectFolderPath as NSString).abbreviatingWithTildeInPath
    projectFolderLabel.font = .systemFont(ofSize: 12); projectFolderLabel.textColor = .secondaryLabelColor; projectFolderLabel.lineBreakMode = .byTruncatingMiddle
    let choose = NSButton(title: "Choose…", target: self, action: #selector(projectChooseFolder)); choose.bezelStyle = .rounded
    let clear = NSButton(title: "Use the bar's", target: self, action: #selector(projectClearFolder)); clear.bezelStyle = .rounded
    projectModelPopup.removeAllItems(); projectModelPopup.addItem(withTitle: "The bar's model (Auto or its pin)"); projectModelPopup.lastItem?.representedObject = ""
    for item in modelPopup.itemArray { if let v = item.representedObject as? String, v != "auto", !v.hasPrefix("pull:") { projectModelPopup.addItem(withTitle: "Pin: \(item.title)"); projectModelPopup.lastItem?.representedObject = v } }
    if let pin = s["pin"], let i = projectModelPopup.itemArray.firstIndex(where: { ($0.representedObject as? String) == pin }) { projectModelPopup.selectItem(at: i) }
    let grid = NSGridView(views: [[NSTextField(labelWithString: "Folder"), projectFolderLabel, choose, clear], [NSTextField(labelWithString: "Writes with"), projectModelPopup, NSView(), NSView()]])
    grid.rowSpacing = 8; grid.columnSpacing = 8
    let save = NSButton(title: "Save", target: self, action: #selector(saveProjectSettingsTapped)); save.bezelStyle = .rounded; save.keyEquivalent = "\r"
    let cancel = NSButton(title: UI.t("Cancel"), target: self, action: #selector(closeProjectSettings)); cancel.bezelStyle = .rounded
    let buttons = NSStackView(views: [save, cancel]); buttons.spacing = 10
    let stack = NSStackView(views: [title, hint, docScroll, settingsTitle, grid, buttons]); stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 10
    stack.edgeInsets = NSEdgeInsets(top: 18, left: 20, bottom: 18, right: 20)
    let panel = projectPanel ?? NSPanel(contentRect: NSRect(x: 0, y: 0, width: 580, height: 520), styleMask: [.titled, .closable, .utilityWindow], backing: .buffered, defer: false)
    panel.title = "\(p): doctrine & settings"; panel.isReleasedWhenClosed = false; panel.level = .floating + 1; panel.appearance = NSAppearance(named: .darkAqua)
    panel.contentView = stack; projectPanel = panel
    panel.center(); NSApp.activate(ignoringOtherApps: true); panel.makeKeyAndOrderFront(nil); panel.makeFirstResponder(doctrineView)
  }
  @objc private func projectChooseFolder() {
    let o = NSOpenPanel(); o.canChooseDirectories = true; o.canChooseFiles = false; o.prompt = "Use for this project"; o.level = .floating + 2
    if o.runModal() == .OK, let u = o.url { projectFolderPath = u.path; projectFolderLabel.stringValue = (u.path as NSString).abbreviatingWithTildeInPath }
  }
  @objc private func projectClearFolder() { projectFolderPath = ""; projectFolderLabel.stringValue = "The bar's folder" }
  @objc private func closeProjectSettings() { projectPanel?.orderOut(nil); projectEditing = nil }
  @objc private func saveProjectSettingsTapped() {
    guard let p = projectEditing else { return }
    let doctrine = String(doctrineView.string.trimmingCharacters(in: .whitespacesAndNewlines).prefix(4000))
    let pin = (projectModelPopup.selectedItem?.representedObject as? String) ?? ""
    let s: [String: String] = ["doctrine": doctrine, "folder": projectFolderPath, "pin": pin].filter { !$0.value.isEmpty }
    if s.isEmpty { projectSettings.removeValue(forKey: p) } else { projectSettings[p] = s }
    saveProjectSettings(); closeProjectSettings(); drawChats()
    append(who: "", doctrine.isEmpty ? "Saved \(p)'s settings." : "Saved \(p)'s doctrine: every turn in its chats follows it.")
  }
  /// The project the next turn belongs to: the open chat's, or the one a "+" started.
  private var currentProject: String? { chatIndex.flatMap { $0 < chats.count ? chats[$0].project : nil } ?? newChatProject }
  @objc private func renameProject(_ sender: NSMenuItem) {
    guard let old = sender.representedObject as? String, let i = projects.firstIndex(of: old),
          let name = askName("Rename project", "", old), name != old, !projects.contains(name) else { return }
    projects[i] = name; saveProjects()
    if let s = projectSettings.removeValue(forKey: old) { projectSettings[name] = s; saveProjectSettings() }
    for j in chats.indices where chats[j].project == old { chats[j].project = name }
    saveChats(); drawChats()
  }
  @objc private func deleteProject(_ sender: NSMenuItem) {
    guard let p = sender.representedObject as? String else { return }
    projects.removeAll { $0 == p }; saveProjects()
    projectSettings.removeValue(forKey: p); saveProjectSettings()
    for j in chats.indices where chats[j].project == p { chats[j].project = nil }   // its chats go back to Recent
    saveChats(); drawChats()
  }
  @objc private func openChat(_ sender: NSButton) {
    if selecting, let id = sender.identifier?.rawValue { toggleMark(id); return }
    guard let id = sender.identifier?.rawValue, let i = chats.firstIndex(where: { $0.id == id }) else { return }
    restoring = true; log.string = ""; hasLog = false
    for l in chats[i].lines where l.count == 2 {
      if l[0] == "Sources" { appendSources(l[1].split(separator: "\n").compactMap { p in let f = p.split(separator: "\t", maxSplits: 1).map(String.init); return f.count == 2 ? (f[0], f[1]) : nil }) }
      else if l[0] == "Image" { appendImage(l[1]) }
      else { append(who: l[0], l[1]) }
    }
    restoring = false; chatIndex = i; newChatProject = nil
    drawChats(); layout(); log.scrollToEndOfDocument(nil)
    panel.makeFirstResponder(field)
  }
  @objc private func newChat() {
    chatIndex = nil; newChatProject = nil; log.string = ""; hasLog = false; clearSuggestion()
    drawChats(); layout(); panel.makeFirstResponder(field)
  }
  @objc private func toggleSidebar() { sideShown.toggle(); KingmakerBar.d.set(sideShown, forKey: "km.sidebar"); layout() }

  // ── kingmaker://bar?text=… (Shortcuts, Siri, scripts): the text goes in the box; with the local key it's sent too ──
  func fromLink(_ text: String, send: Bool) {
    show(); field.stringValue = text
    if send { self.send(queue: false) } else { field.currentEditor()?.moveToEndOfDocument(nil) }
  }
  /// The bar's conversation, for its owner to look back at: ~/Library/Application Support/sol-ghost/logs/bar.log (0600).
  private static let logURL: URL = URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support/sol-ghost/logs/bar.log")
  private func record(_ who: String, _ text: String) {
    let line = "\(ISO8601DateFormatter().string(from: Date())) \(who.isEmpty ? "note" : who): \(text.replacingOccurrences(of: "\n", with: " "))\n"
    let url = KingmakerBar.logURL
    if !FileManager.default.fileExists(atPath: url.path) { FileManager.default.createFile(atPath: url.path, contents: nil, attributes: [.posixPermissions: 0o600]) }
    if let h = try? FileHandle(forWritingTo: url) { h.seekToEndOfFile(); h.write(line.data(using: .utf8)!); try? h.close() }
  }

  /// @@ghost flow: one setup's steps, drawn as they change. When it finishes, the last caption goes into the chat and
  /// the screen gives the chat back after a few seconds (or at once with the ×, or with the next message).
  func showFlow(_ f: [String: Any]) {
    flowData = f; flowShown = true
    if !panel.isVisible { show() }
    layout(); flowView.scrollToVisible(NSRect(x: 0, y: flowView.frame.height - 1, width: 1, height: 1))
    guard (f["done"] as? Bool) == true, let id = f["id"] as? String else { return }
    let steps = (f["steps"] as? [[String: Any]]) ?? []
    let last = steps.last { ["done", "failed"].contains(($0["state"] as? String) ?? "") }
    if let c = last?["caption"] as? String, !c.isEmpty { record("Kingmaker", c); remember("Kingmaker", c) }
    DispatchQueue.main.asyncAfter(deadline: .now() + 8) { [weak self] in
      guard let self, (self.flowData?["id"] as? String) == id, self.flowShown else { return }
      self.closeFlow(); if let c = last?["caption"] as? String, !c.isEmpty { self.appendQuiet(who: "Kingmaker", c) }
    }
  }
  @objc private func closeFlow() { flowShown = false; flowData = nil; flowView.stop(); layout() }
  /// A line into the log without recording it again (the flow's own record already has it).
  private func appendQuiet(who: String, _ text: String) { restoring = true; append(who: who, text); restoring = false }

  // ── CUSTOMIZE: each function's model weights and calibration (lib/calibration.mjs), read and saved through the engine ──
  @objc private func openCalibration() { openCustomize(tab: 1) }
  /// @@ghost calibration: the functions, their values and this Mac's models → the Customize panel (or "Saved").
  func showCalibration(_ c: [String: Any]) {
    if (c["saved"] as? Bool) == true { calStatus.stringValue = "Saved. It applies to the next turn."; return }
    guard let functions = c["functions"] as? [[String: Any]], let values = c["values"] as? [String: Any] else { return }
    calFunctions = functions; calControls = [:]
    let models = (c["models"] as? [String]) ?? []
    let stack = NSStackView(); stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 14
    stack.edgeInsets = NSEdgeInsets(top: 18, left: 20, bottom: 18, right: 20)
    let intro = NSTextField(wrappingLabelWithString: "Each function runs on the model weights you pick here, tuned by its numbers. Changes apply to the next turn. Sends, payments and record changes keep their approvals whatever you set.")
    intro.font = .systemFont(ofSize: 12); intro.textColor = .secondaryLabelColor; intro.preferredMaxLayoutWidth = 520
    stack.addArrangedSubview(intro)
    for f in functions {
      guard let fid = f["id"] as? String, let controls = f["controls"] as? [[String: Any]] else { continue }
      let name = NSTextField(labelWithString: (f["name"] as? String) ?? fid); name.font = .systemFont(ofSize: 13, weight: .semibold)
      let what = NSTextField(wrappingLabelWithString: (f["what"] as? String) ?? ""); what.font = .systemFont(ofSize: 11.5); what.textColor = .secondaryLabelColor; what.preferredMaxLayoutWidth = 520
      stack.addArrangedSubview(name); stack.addArrangedSubview(what)
      let grid = NSGridView(numberOfColumns: 3, rows: 0); grid.rowSpacing = 6; grid.columnSpacing = 10
      let current = (values[fid] as? [String: Any]) ?? [:]
      for ctl in controls {
        guard let key = ctl["key"] as? String, let kind = ctl["kind"] as? String else { continue }
        let label = NSTextField(labelWithString: (ctl["label"] as? String) ?? key); label.font = .systemFont(ofSize: 12); label.textColor = .secondaryLabelColor
        let id = "\(fid).\(key)"
        switch kind {
        case "switch":
          let sw = NSSwitch(); sw.state = (current[key] as? Bool ?? (ctl["default"] as? Bool ?? true)) ? .on : .off
          calControls[id] = sw; grid.addRow(with: [label, sw, NSView()])
        case "choice":   // a fixed list ({value, label}), e.g. Mac profile: Auto, 8 GB … 64 GB (lib/calibration.mjs)
          let pop = NSPopUpButton(frame: .zero, pullsDown: false); pop.font = .systemFont(ofSize: 12)
          let value = (current[key] as? String) ?? (ctl["default"] as? String) ?? ""
          for o in (ctl["options"] as? [[String: Any]]) ?? [] {
            guard let v = o["value"] as? String else { continue }
            pop.addItem(withTitle: (o["label"] as? String) ?? v); pop.lastItem?.representedObject = v
            if v == value { pop.select(pop.lastItem) }
          }
          calControls[id] = pop; grid.addRow(with: [label, pop, NSView()])
        case "model":
          let pop = NSPopUpButton(frame: .zero, pullsDown: false); pop.font = .systemFont(ofSize: 12)
          let value = (current[key] as? String) ?? (ctl["default"] as? String) ?? ""
          var names = models; for extra in [value, (ctl["default"] as? String) ?? ""] where !extra.isEmpty && !names.contains(extra) { names.insert(extra, at: 0) }
          for n in names { pop.addItem(withTitle: KingmakerBar.pretty(n)); pop.lastItem?.representedObject = n; pop.lastItem?.toolTip = n }
          if let i = names.firstIndex(of: value) { pop.selectItem(at: i) }
          calControls[id] = pop; grid.addRow(with: [label, pop, NSView()])
        default:   // number
          let lo = (ctl["min"] as? Double) ?? 0, hi = (ctl["max"] as? Double) ?? 100, step = (ctl["step"] as? Double) ?? 1
          let v = (current[key] as? Double) ?? (ctl["default"] as? Double) ?? lo
          let slider = NSSlider(value: v, minValue: lo, maxValue: hi, target: self, action: #selector(calSliderMoved(_:)))
          slider.widthAnchor.constraint(equalToConstant: 240).isActive = true
          let shown = NSTextField(labelWithString: KingmakerBar.calNumber(v, step)); shown.font = .monospacedDigitSystemFont(ofSize: 12, weight: .regular)
          slider.identifier = NSUserInterfaceItemIdentifier(id); shown.identifier = NSUserInterfaceItemIdentifier("value:\(id)")
          calControls[id] = slider; grid.addRow(with: [label, slider, shown])
        }
      }
      stack.addArrangedSubview(grid)
    }
    calStatus.font = .systemFont(ofSize: 11.5); calStatus.textColor = .secondaryLabelColor; calStatus.stringValue = ""
    let save = NSButton(title: "Save", target: self, action: #selector(saveCalibration)); save.bezelStyle = .rounded; save.keyEquivalent = "\r"
    let reset = NSButton(title: UI.t("Defaults"), target: self, action: #selector(resetCalibration)); reset.bezelStyle = .rounded
    let buttons = NSStackView(views: [save, reset, calStatus]); buttons.spacing = 10
    stack.addArrangedSubview(buttons)
    let scrollView = NSScrollView(); scrollView.documentView = stack; scrollView.hasVerticalScroller = true; scrollView.drawsBackground = false
    stack.translatesAutoresizingMaskIntoConstraints = false
    let tab = ensureCustomizePanel().tabViewItem(at: 1)
    tab.view = scrollView
    stack.widthAnchor.constraint(equalTo: scrollView.contentView.widthAnchor).isActive = true
  }
  /// The one settings window (gear on a narrow bar, Customize on a wide one): This Mac (look, keys, voice, the CRM,
  /// connectors, permissions) and Functions (each function's model weights and calibration).
  @discardableResult private func ensureCustomizePanel() -> NSTabView {
    if customizePanel == nil {
      let p = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 620, height: 680), styleMask: [.titled, .closable, .resizable, .utilityWindow], backing: .buffered, defer: false)
      p.title = "Customize Kingmaker"; p.isReleasedWhenClosed = false; p.level = .floating + 1; p.appearance = NSAppearance(named: .darkAqua)
      p.minSize = NSSize(width: 520, height: 420)
      for (i, t) in ["Interaction", "Functions", "Behavior"].enumerated() { let item = NSTabViewItem(identifier: i); item.label = UI.t(t); customizeTabs.addTabViewItem(item) }
      p.contentView = customizeTabs; customizePanel = p
    }
    return customizeTabs
  }
  private func openCustomize(tab: Int) {
    let tabs = ensureCustomizePanel()
    let mac = NSScrollView(); mac.documentView = macSettingsView(); mac.hasVerticalScroller = true; mac.drawsBackground = false
    mac.documentView?.translatesAutoresizingMaskIntoConstraints = false
    mac.documentView?.widthAnchor.constraint(equalTo: mac.contentView.widthAnchor).isActive = true
    tabs.tabViewItem(at: 0).view = mac
    // A tab item comes with an empty view of its own, so "not built yet" is "not our scroll view yet".
    if !(tabs.tabViewItem(at: 2).view is NSScrollView) { tabs.tabViewItem(at: 2).view = behavior.view(onSaved: { [weak self] in self?.onCommand("instructions reload") }) }
    if tabs.tabViewItem(at: 1).view == nil || tab == 1 {
      let loading = NSTextField(labelWithString: "Loading the functions…"); loading.textColor = .secondaryLabelColor
      if tabs.tabViewItem(at: 1).view == nil { tabs.tabViewItem(at: 1).view = loading }
    }
    calStatus.stringValue = ""; onCommand("calibration")   // the Functions tab fills itself when the engine answers
    tabs.selectTabViewItem(at: tab)
    if barIsLarge { showSheet("customize", tabs); return }
    guard let p = customizePanel else { return }
    if p.contentView !== tabs { p.contentView = tabs }
    if !p.isVisible { p.center() }
    NSApp.activate(ignoringOtherApps: true); p.makeKeyAndOrderFront(nil)
  }
  /// Put a settings view in the bar, in the conversation's place.
  private func showSheet(_ id: String, _ v: NSView) {
    if id == "customize" { customizePanel?.orderOut(nil) } else { connectorsPanel?.orderOut(nil) }
    sheetHost.subviews.forEach { $0.removeFromSuperview() }
    v.removeFromSuperview(); v.autoresizingMask = [.width, .height]; v.translatesAutoresizingMaskIntoConstraints = true
    sheetHost.addSubview(v); sheetShown = id
    layout(); panel.makeKey()   // the owner opened it: the keyboard goes with it
  }
  @objc private func closeSheet() {
    sheetHost.subviews.forEach { $0.removeFromSuperview() }; sheetShown = nil
    layout(); panel.makeFirstResponder(field)
  }
  /// The bar got too small for the sheet: it goes back to its own window, as it was.
  private func moveSheetToWindow() {
    guard let id = sheetShown, let v = sheetHost.subviews.first else { sheetShown = nil; return }
    v.removeFromSuperview(); sheetShown = nil
    if id == "customize", let p = customizePanel { p.contentView = v; p.center(); p.orderFront(nil) }
    if id == "connectors", let p = connectorsPanel { p.contentView = v; p.center(); p.orderFront(nil) }
  }
  static func calNumber(_ v: Double, _ step: Double) -> String { step < 1 ? String(format: "%.1f", v) : String(Int(v.rounded())) }
  @objc private func calSliderMoved(_ s: NSSlider) {
    guard let id = s.identifier?.rawValue, let step = calStep(id) else { return }
    let v = (s.doubleValue / step).rounded() * step
    (customizeTabs.numberOfTabViewItems > 1 ? customizeTabs.tabViewItem(at: 1).view as? NSScrollView : nil)?.documentView?.subviewsDeep.first { $0.identifier?.rawValue == "value:\(id)" }.flatMap { $0 as? NSTextField }?.stringValue = KingmakerBar.calNumber(v, step)
  }
  private func calStep(_ id: String) -> Double? {
    let parts = id.split(separator: ".", maxSplits: 1).map(String.init)
    guard parts.count == 2, let f = calFunctions.first(where: { ($0["id"] as? String) == parts[0] }),
          let c = (f["controls"] as? [[String: Any]])?.first(where: { ($0["key"] as? String) == parts[1] }) else { return nil }
    return (c["step"] as? Double) ?? 1
  }
  @objc private func saveCalibration() {
    var out: [String: [String: Any]] = [:]
    for (id, control) in calControls {
      let parts = id.split(separator: ".", maxSplits: 1).map(String.init); guard parts.count == 2 else { continue }
      var f = out[parts[0]] ?? [:]
      if let sw = control as? NSSwitch { f[parts[1]] = sw.state == .on }
      else if let pop = control as? NSPopUpButton { f[parts[1]] = pop.selectedItem?.representedObject as? String ?? "" }
      else if let s = control as? NSSlider { let step = calStep(id) ?? 1; f[parts[1]] = (s.doubleValue / step).rounded() * step }
      out[parts[0]] = f
    }
    guard let json = try? JSONSerialization.data(withJSONObject: out) else { return }
    calStatus.stringValue = "Saving…"; onCommand("calibration-set \(json.base64EncodedString())")
  }
  @objc private func resetCalibration() {
    guard let json = try? JSONSerialization.data(withJSONObject: [String: Any]()) else { return }
    calStatus.stringValue = "Back to the defaults…"; onCommand("calibration-set \(json.base64EncodedString())")
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in self?.onCommand("calibration") }
  }

  // ── THE STAGE (an ad's scenes: @@ghost {"stage": true|false}, always in pairs) ──
  // On: a fresh chat that is never saved, the sidebar (the owner's chats) out of the shot, the bar centred at a normal size
  // (~58% of the screen's width, never full screen), floating above whatever app the scene brings forward. Off: the
  // owner's chat, frame, level, sidebar and visibility come back exactly, and the stage chat is gone.
  private var staging = false
  private struct StageSaved { let chatIndex: Int?; let project: String?; let log: NSAttributedString; let hasLog: Bool; let frame: NSRect; let sized: NSSize?; let level: NSWindow.Level; let visible: Bool; let sideShown: Bool; let hides: Bool; let hiddenApps: [NSRunningApplication] }
  private var stageSaved: StageSaved?
  /// "aside" (the picture scene): the bar steps out of the shot but stays staged; true brings it back.
  func stageAside() { guard stageSaved != nil else { return }; panel.orderOut(nil) }
  func setStage(_ on: Bool) {
    if on {
      // Already staged (back from "aside"): just in front again.
      if stageSaved != nil { modelPopup.menu?.cancelTracking(); panel.alphaValue = 1; panel.orderFrontRegardless(); return }
      // No open menu or popover in the shot (the model picker's list was open over the bar in the 11:52 run).
      modelPopup.menu?.cancelTracking(); customizePanel?.orderOut(nil); clearPicks()
      if shareCard != nil { pendingShareBox = lastShareBox; shareCard?.removeFromSuperview(); shareCard = nil; shareYes = nil }
      // The owner's other windows out of the shot: every visible app is hidden now and exactly those come back after.
      let me = ProcessInfo.processInfo.processIdentifier
      let shown = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular && !$0.isHidden && $0.processIdentifier != me && !$0.isTerminated }
      for app in shown { app.hide() }
      stageSaved = StageSaved(chatIndex: chatIndex, project: newChatProject, log: NSAttributedString(attributedString: log.textStorage ?? NSAttributedString()), hasLog: hasLog,
                              frame: panel.frame, sized: sized, level: panel.level, visible: panel.isVisible, sideShown: sideShown, hides: panel.hidesOnDeactivate, hiddenApps: shown)
      staging = true
      chatIndex = nil; newChatProject = nil; log.string = ""; hasLog = false; clearPicks(); clearSuggestion()
      sideShown = false
      let vf = (NSScreen.main ?? NSScreen.screens[0]).visibleFrame
      let w = (vf.width * 0.58).rounded(), h = min(560, (vf.height * 0.6).rounded())
      sized = NSSize(width: w, height: h)
      panel.hidesOnDeactivate = false; panel.level = .floating
      panel.setFrame(NSRect(x: vf.midX - w / 2, y: vf.midY - h / 2, width: w, height: h), display: true)
      layout()   // keeps the top edge, so centre it again after
      panel.setFrameOrigin(NSPoint(x: (vf.midX - panel.frame.width / 2).rounded(), y: (vf.midY - panel.frame.height / 2).rounded()))
      panel.alphaValue = 1; panel.orderFrontRegardless()
      drawChats()
    } else {
      guard let s = stageSaved else { return }
      stageSaved = nil; staging = false
      chatIndex = s.chatIndex; newChatProject = s.project; sideShown = s.sideShown; sized = s.sized
      log.textStorage?.setAttributedString(s.log); hasLog = s.hasLog
      panel.level = s.level; panel.hidesOnDeactivate = s.hides
      panel.setFrame(s.frame, display: true); layout(); drawChats()
      if !s.visible { hide() } else { panel.orderFrontRegardless() }
      for app in s.hiddenApps where !app.isTerminated { app.unhide() }   // exactly the apps the stage hid
      if let b = pendingShareBox { DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in self?.showShareBox(b) } }
    }
  }

  // ── THE SHARING BOX (community learning, option B: docs/community-learning.md; lib/sharing.mjs) ──
  // @@ghost {"shareAsk": {...}}: asked once, in the bar, in the bar's own look (km.look → background, km.replyColor → title,
  // default button, link and focus ring, km.textSize → text). Share is the default (Return); Esc keeps it on this Mac, so
  // declining is never harder. Never while staged (an ad's recording) or while the owner is typing: it waits, then shows.
  // The answer goes back as `share yes|no`; "See exactly what's sent" asks `share log`. @@ghost {"sharing"} keeps the
  // ACCESS row (Connectors & keys) in step.
  private var sharingOn = true
  private var pendingShareBox: [String: Any]?
  private var shareCard: NSView?
  private var shareYes: NSButton?
  private var lastShareBox: [String: Any]?
  // The same card asks other one-click questions (@@ghost {"approvalAsk": {...}}: an add-on's overnight list): the
  // box then names its own words and the control lines its buttons send (yesCommand / noCommand / seeCommand).
  private var shareCommands = (yes: "share yes", no: "share no", see: "share log")
  private var shareIsSharing = true
  // One card shows at a time; a card of another kind waits here (keyed by kind, the newest of each) and shows when the
  // current one is answered, so the sharing question and the overnight list never hide each other.
  private var shownBoxKind: String?
  private var waitingBoxes: [(kind: String, box: [String: Any])] = []
  private func boxKind(_ box: [String: Any]) -> String { (box["kind"] as? String) ?? "sharing" }
  private func waitBox(_ box: [String: Any]) {
    let k = boxKind(box)
    waitingBoxes.removeAll { $0.kind == k }; waitingBoxes.append((kind: k, box: box))
  }
  func setSharing(_ on: Bool) { sharingOn = on }
  /** The overnight card is no longer current (approved, or replaced): take it down, and drop it if it was still waiting. */
  func closeApprovalBox() {
    if (pendingShareBox?["kind"] as? String) == "nightly" { pendingShareBox = nil }
    waitingBoxes.removeAll { $0.kind == "nightly" }
    if shownBoxKind == "nightly", shareCard != nil { closeShareBox() }
  }
  func showShareBox(_ box: [String: Any]) {
    let kind = boxKind(box)
    // Another kind's card is up: this one waits its turn instead of replacing it.
    if shareCard != nil, let shown = shownBoxKind, shown != kind { waitBox(box); return }
    // Another kind is already waiting for the bar to be free: keep it, queued, rather than dropping it.
    if let pending = pendingShareBox, boxKind(pending) != kind { waitBox(pending) }
    pendingShareBox = box; lastShareBox = box
    // Never while staged, while the owner is typing in the bar, while another Kingmaker window (Customize…) has the
    // keyboard, or while the bar is closed (opening it would pull the owner out of whatever app they're typing in):
    // the box would take the keyboard, and their next Return would answer "Share" without their meaning to.
    let otherKey = NSApp.keyWindow != nil && NSApp.keyWindow !== panel
    guard !staging, !otherKey, panel.isVisible, sheetShown == nil, field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
      DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in if let b = self?.pendingShareBox { self?.showShareBox(b) } }
      return
    }
    pendingShareBox = nil
    shareCard?.removeFromSuperview()
    waitingBoxes.removeAll { $0.kind == kind }
    shownBoxKind = kind
    shareIsSharing = box["kind"] == nil
    shareCommands = (yes: (box["yesCommand"] as? String) ?? "share yes", no: (box["noCommand"] as? String) ?? "share no", see: (box["seeCommand"] as? String) ?? "share log")
    let look = lookPref, accent = replyColour, size = textSize
    let systemLook = look == "system"
    let ink: NSColor = systemLook ? .labelColor : .white
    let soft: NSColor = systemLook ? .secondaryLabelColor : NSColor.white.withAlphaComponent(0.72)
    let card: NSView
    if look == "glass" {
      let fx = NSVisualEffectView(); fx.material = .hudWindow; fx.blendingMode = .withinWindow; fx.state = .active; card = fx
    } else {
      card = NSView(); card.wantsLayer = true
      card.layer?.backgroundColor = systemLook ? NSColor.windowBackgroundColor.cgColor : NSColor.black.withAlphaComponent(0.97).cgColor
    }
    card.wantsLayer = true
    card.layer?.cornerRadius = 14; card.layer?.masksToBounds = true
    card.layer?.borderWidth = 1; card.layer?.borderColor = accent.withAlphaComponent(0.55).cgColor
    card.setAccessibilityRole(.group); card.setAccessibilityLabel((box["title"] as? String) ?? "Sharing")
    func label(_ text: NSAttributedString) -> NSTextField {
      let l = NSTextField(labelWithAttributedString: text); l.lineBreakMode = .byWordWrapping; l.maximumNumberOfLines = 0
      l.isSelectable = false; card.addSubview(l); return l
    }
    let title = label(NSAttributedString(string: (box["title"] as? String) ?? "Help every Kingmaker get smarter", attributes: [.font: NSFont.systemFont(ofSize: size + 2, weight: .semibold), .foregroundColor: accent]))
    let body = label(NSAttributedString(string: (box["body"] as? String) ?? "", attributes: [.font: NSFont.systemFont(ofSize: size), .foregroundColor: ink]))
    let detail = NSMutableAttributedString()
    detail.append(NSAttributedString(string: (box["sharedLabel"] as? String) ?? "Shared: ", attributes: [.font: NSFont.systemFont(ofSize: size - 1, weight: .semibold), .foregroundColor: ink]))
    detail.append(NSAttributedString(string: ((box["shared"] as? String) ?? "") + ".\n", attributes: [.font: NSFont.systemFont(ofSize: size - 1), .foregroundColor: soft]))
    detail.append(NSAttributedString(string: (box["neverLabel"] as? String) ?? "Never shared: ", attributes: [.font: NSFont.systemFont(ofSize: size - 1, weight: .semibold), .foregroundColor: ink]))
    detail.append(NSAttributedString(string: ((box["never"] as? String) ?? "") + ".", attributes: [.font: NSFont.systemFont(ofSize: size - 1), .foregroundColor: soft]))
    let lines = label(detail)
    let see = NSButton(title: "", target: self, action: #selector(shareSee)); see.isBordered = false
    see.attributedTitle = NSAttributedString(string: (box["see"] as? String) ?? "See exactly what's sent", attributes: [.font: NSFont.systemFont(ofSize: size - 1), .foregroundColor: accent, .underlineStyle: NSUnderlineStyle.single.rawValue])
    let no = NSButton(title: (box["no"] as? String) ?? "Keep it on this Mac", target: self, action: #selector(shareNo))
    no.bezelStyle = .rounded; no.keyEquivalent = "\u{1b}"; no.font = .systemFont(ofSize: size - 1)
    let yes = NSButton(title: "", target: self, action: #selector(shareYesTapped))
    yes.isBordered = false; yes.wantsLayer = true; yes.layer?.cornerRadius = 7; yes.layer?.backgroundColor = accent.cgColor
    var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
    (accent.usingColorSpace(.sRGB) ?? accent).getRed(&r, green: &g, blue: &b, alpha: &a)
    let onAccent: NSColor = (0.299 * r + 0.587 * g + 0.114 * b) > 0.6 ? .black : .white
    yes.attributedTitle = NSAttributedString(string: "  \((box["yes"] as? String) ?? "Share and get improvements")  ", attributes: [.font: NSFont.systemFont(ofSize: size - 1, weight: .semibold), .foregroundColor: onAccent])
    yes.keyEquivalent = "\r"; yes.focusRingType = .exterior
    for v in [see, no, yes] as [NSView] { card.addSubview(v) }
    card.identifier = NSUserInterfaceItemIdentifier("shareCard")
    // Frame inside the card (bottom-up, the backdrop isn't flipped); the card's own frame is set in layout().
    let cw = min(600, max(320, contentWidth - 32)), inset: CGFloat = 18, tw = cw - inset * 2
    for l in [title, body, lines] { l.preferredMaxLayoutWidth = tw }
    let bh: CGFloat = max(28, size + 16)
    yes.sizeToFit(); no.sizeToFit(); see.sizeToFit()
    var y: CGFloat = inset
    yes.frame = NSRect(x: cw - inset - yes.frame.width - 8, y: y, width: yes.frame.width + 8, height: bh)
    no.frame = NSRect(x: yes.frame.minX - 10 - no.frame.width, y: y, width: no.frame.width, height: bh)
    see.frame = NSRect(x: inset, y: y + (bh - see.frame.height) / 2, width: min(see.frame.width, max(0, no.frame.minX - inset - 8)), height: see.frame.height)
    y += bh + 14
    for l in [lines, body, title] {
      let h = ceil(l.attributedStringValue.boundingRect(with: NSSize(width: tw, height: 2000), options: [.usesLineFragmentOrigin, .usesFontLeading]).height) + 2
      l.frame = NSRect(x: inset, y: y, width: tw, height: h); y += h + (l === title ? 0 : 10)
    }
    card.frame = NSRect(x: 0, y: 0, width: cw, height: y + inset)
    backdrop.addSubview(card)
    shareCard = card; shareYes = yes
    layout()
    // It never takes the keyboard: Return/Esc answer it only when the owner is already in the bar and not typing;
    // otherwise it's click-only.
    if panel.isKeyWindow && field.stringValue.isEmpty { panel.makeFirstResponder(yes) }
  }
  private func closeShareBox() {
    shareCard?.removeFromSuperview(); shareCard = nil; shareYes = nil; shownBoxKind = nil; panel.makeFirstResponder(field)
    // The next waiting card, if any, after a beat (so one click never answers two cards).
    if !waitingBoxes.isEmpty {
      let next = waitingBoxes.removeFirst().box
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { [weak self] in self?.showShareBox(next) }
    }
  }
  @objc private func shareYesTapped() { onCommand(shareCommands.yes); if shareIsSharing { sharingOn = true }; closeShareBox() }
  @objc private func shareNo() { onCommand(shareCommands.no); if shareIsSharing { sharingOn = false }; closeShareBox() }
  @objc private func shareSee() { onCommand(shareCommands.see) }
  private func positionShareCard() {
    guard let card = shareCard else { return }
    let x = composer.frame.minX + (composer.frame.width - card.frame.width) / 2
    card.setFrameOrigin(NSPoint(x: max(composer.frame.minX, x.rounded()), y: composer.frame.maxY + 12))
  }

  // ── EXTENSIONS (lib/extensions.mjs): the directory and each extension's page, in the bar's own look (the owner pointed at
  // Claude's Blender page: "with his ui of course"). Reached from Connectors & keys (one settings surface). Install shows
  // its progress; a key opens its page BESIDE the bar; the key itself only ever goes through the hidden key box → vault.
  private var extList: [[String: Any]] = []
  private var extPage: String?
  private var extProgress: [String: (Int, String)] = [:]
  func setExtensions(_ list: [[String: Any]]) { extList = list; renderExtensions() }
  func extInstalling(_ p: [String: Any]) {
    guard let id = p["id"] as? String else { return }
    let pct = (p["pct"] as? Int) ?? Int((p["pct"] as? Double) ?? 0), line = (p["line"] as? String) ?? ""
    extProgress[id] = (pct, line)
    if (p["stage"] as? String) == "done" || (p["stage"] as? String) == "failed" { DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in self?.extProgress[id] = nil } }
    appendProgress(id, pct: pct, line: line)
  }
  private func appendProgress(_ id: String, pct: Int, line: String) {
    let name = (extList.first { ($0["id"] as? String) == id }?["name"] as? String) ?? id
    let filled = max(0, min(20, pct / 5)), bar = String(repeating: "▰", count: filled) + String(repeating: "▱", count: 20 - filled)
    let t = NSMutableAttributedString(string: "\n\(name)  ", attributes: [.font: NSFont.systemFont(ofSize: textSize, weight: .semibold), .foregroundColor: NSColor.white])
    t.append(NSAttributedString(string: "\(bar)  \(pct)%\n", attributes: [.font: NSFont.monospacedSystemFont(ofSize: textSize - 3, weight: .medium), .foregroundColor: replyColour]))
    t.append(NSAttributedString(string: line, attributes: [.font: NSFont.systemFont(ofSize: textSize - 2), .foregroundColor: NSColor.white.withAlphaComponent(0.6)]))
    log.textStorage?.append(t); hasLog = true; layout(); log.scrollToEndOfDocument(nil)
  }
  private func renderExtensions() {
    let t = NSMutableAttributedString(), base = NSFont.systemFont(ofSize: textSize)
    let head = NSFont(name: "BodoniSvtyTwoITCTT-Bold", size: textSize + 10) ?? .boldSystemFont(ofSize: textSize + 10)
    let mono = NSFont.monospacedSystemFont(ofSize: textSize - 3, weight: .medium)
    let dim = NSColor.white.withAlphaComponent(0.5), body = NSColor.white.withAlphaComponent(0.88), accent = replyColour, gold = KingmakerBar.gold
    func add(_ s: String, _ a: [NSAttributedString.Key: Any]) { t.append(NSAttributedString(string: s, attributes: a)) }
    func link(_ s: String, _ url: String, _ c: NSColor = KingmakerBar.gold) { if let u = URL(string: url) { add(s, [.font: base, .link: u, .foregroundColor: c]) } }
    func web(_ s: String, _ url: String?) { guard let url, url.hasPrefix("https://"), let enc = url.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) else { return }; link(s + " ↗", "kmbar://ext/open?u=\(enc)") }
    if hasLog { add("\n\n", [.font: base]) }
    if let id = extPage, let e = extList.first(where: { ($0["id"] as? String) == id }) {
      // ONE EXTENSION'S PAGE (the layout of Claude's directory page, in Kingmaker's colours).
      link("← Extensions", "kmbar://ext/list"); add("\n\n", [.font: base])
      add((e["name"] as? String) ?? id, [.font: head, .foregroundColor: NSColor.white])
      if (e["verified"] as? Bool) == true { add("  ✓", [.font: NSFont.systemFont(ofSize: textSize + 2, weight: .bold), .foregroundColor: accent, .toolTip: "Checked against its maker's own page"]) }
      add("\n\((e["summary"] as? String) ?? "")\n\n", [.font: base, .foregroundColor: dim])
      let installed = (e["installed"] as? Bool) == true
      if let (pct, line) = extProgress[id] {
        let filled = max(0, min(20, pct / 5))
        add("Installing…  ", [.font: NSFont.systemFont(ofSize: textSize, weight: .semibold), .foregroundColor: NSColor.white])
        add(String(repeating: "▰", count: filled) + String(repeating: "▱", count: 20 - filled) + "  \(pct)%\n", [.font: mono, .foregroundColor: accent])
        add(line + "\n", [.font: NSFont.systemFont(ofSize: textSize - 2), .foregroundColor: dim])
      } else if installed {
        add("● Installed", [.font: NSFont.systemFont(ofSize: textSize, weight: .semibold), .foregroundColor: accent])
      } else {
        add(" ", [.font: base]); link("  Install  ", "kmbar://ext/install/\(id)", accent)
      }
      add("\n\n\((e["description"] as? String) ?? "")\n", [.font: base, .foregroundColor: body])
      for r in (e["requires"] as? [[String: Any]]) ?? [] {
        add("\nNEEDS\n", [.font: mono, .foregroundColor: dim, .kern: 2])
        add("\((r["name"] as? String) ?? "")\((r["minVersion"] as? String).map { " \($0) or newer" } ?? "")   ", [.font: NSFont.systemFont(ofSize: textSize, weight: .semibold), .foregroundColor: NSColor.white])
        web("Get it", r["getUrl"] as? String); add("\n", [.font: base])
        if let a = r["addon"] as? [String: Any] {
          add("\((a["name"] as? String) ?? "Its add-on"): \((a["steps"] as? String) ?? "")  ", [.font: NSFont.systemFont(ofSize: textSize - 1), .foregroundColor: body])
          web("Download the add-on", a["url"] as? String); add("\n", [.font: base])
        }
      }
      for k in (e["keys"] as? [[String: Any]]) ?? [] {
        add("\nKEY\n", [.font: mono, .foregroundColor: dim, .kern: 2])
        add("\((k["label"] as? String) ?? "")   ", [.font: NSFont.systemFont(ofSize: textSize, weight: .semibold), .foregroundColor: NSColor.white])
        link("Get key ↗ (opens beside Kingmaker)", "kmbar://ext/install/\(id)")
        add("\n\((k["help"] as? String) ?? "")\n", [.font: NSFont.systemFont(ofSize: textSize - 2), .foregroundColor: dim])
        let accounts = (k["accounts"] as? [String]) ?? []
        if !accounts.isEmpty { add("Accounts: " + accounts.joined(separator: " · ") + "\n", [.font: NSFont.systemFont(ofSize: textSize - 1), .foregroundColor: body]) }
        if (k["multi"] as? Bool) == true { link(accounts.isEmpty ? "Name this account first…" : "Add another account…", "kmbar://ext/account/\(id)"); add("\n", [.font: base]) }
        add("The key goes only into Kingmaker's vault, sealed. It is never shown, written or spoken.\n", [.font: NSFont.systemFont(ofSize: textSize - 3), .foregroundColor: dim])
      }
      if let w = e["warning"] as? String, !w.isEmpty {
        add("\n⚠︎  ", [.font: base, .foregroundColor: gold]); add(w + "\n", [.font: NSFont.systemFont(ofSize: textSize - 1), .foregroundColor: gold])
      }
      add("\nOnly add extensions from makers you trust. Kingmaker reads each one first (REA) and turns its tools on only when you approve them.\n", [.font: NSFont.systemFont(ofSize: textSize - 2), .foregroundColor: dim])
      add("\nMADE BY  ", [.font: mono, .foregroundColor: dim, .kern: 2]); web((e["maker"] as? String) ?? "", e["makerUrl"] as? String)
      add("\nVERSION  ", [.font: mono, .foregroundColor: dim, .kern: 2]); add((e["version"] as? String) ?? "", [.font: base, .foregroundColor: body])
      add("\nADDED  ", [.font: mono, .foregroundColor: dim, .kern: 2]); add((e["added"] as? String) ?? "", [.font: base, .foregroundColor: body])
      add("\nMORE INFO  ", [.font: mono, .foregroundColor: dim, .kern: 2]); web("Support", e["support"] as? String); add("   ", [.font: base]); web("Privacy policy", e["privacy"] as? String)
    } else {
      // THE DIRECTORY
      add("EXTENSIONS\n", [.font: mono, .foregroundColor: dim, .kern: 2])
      add("Add a skill to Kingmaker\n", [.font: head, .foregroundColor: NSColor.white])
      add("Each one is checked against its maker's page. Keys open beside Kingmaker and go straight into its vault.\n", [.font: NSFont.systemFont(ofSize: textSize - 2), .foregroundColor: dim])
      for e in extList {
        let id = (e["id"] as? String) ?? "", installed = (e["installed"] as? Bool) == true
        add("\n", [.font: base])
        link((e["name"] as? String) ?? id, "kmbar://ext/detail/\(id)", NSColor.white)
        if (e["verified"] as? Bool) == true { add(" ✓", [.font: base, .foregroundColor: accent]) }
        add("  \((e["maker"] as? String) ?? "")", [.font: mono, .foregroundColor: dim])
        add(installed ? "   ● installed" : "", [.font: mono, .foregroundColor: accent])
        add("\n\((e["summary"] as? String) ?? "")   ", [.font: NSFont.systemFont(ofSize: textSize - 1), .foregroundColor: body])
        link(installed ? "Open" : "Details", "kmbar://ext/detail/\(id)"); add("\n", [.font: base])
      }
    }
    let para = NSMutableParagraphStyle(); para.lineSpacing = 3
    t.addAttribute(.paragraphStyle, value: para, range: NSRange(location: 0, length: t.length))
    log.textStorage?.append(t); hasLog = true
    layout(); log.scrollToEndOfDocument(nil)
  }
  /// "Add another account…": the account's name (a label, never the key), then its key page opens beside the bar.
  private func askExtAccount(_ id: String) {
    let a = NSAlert(); a.messageText = "Name this account"; a.informativeText = "A label so you can tell them apart (for example Work or Personal). The key comes next, in Kingmaker's key box."
    let f = NSTextField(frame: NSRect(x: 0, y: 0, width: 240, height: 24)); f.placeholderString = "Work"; a.accessoryView = f
    a.addButton(withTitle: "Next"); a.addButton(withTitle: "Cancel")
    guard a.runModal() == .alertFirstButtonReturn else { return }
    let name = f.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
    let b64 = Data((name.isEmpty ? "default" : String(name.prefix(40))).utf8).base64EncodedString()
    onCommand("ext-account \(id) \(b64)")
  }

  // ── BESIDE: a key's page and the bar side by side (@@ghost beside). The browser takes the left ~55% of the screen, the bar
  // the right; Swap (in the header) brings the other one to the front, only when the owner clicks it. When the key box is
  // done (sealed or cancelled), the bar goes back where it was.
  private var besideSaved: NSRect?
  private var besideBrowser: String?
  func showBeside(_ url: String, title: String) {
    guard url.hasPrefix("https://"), let u = URL(string: url) else { return }
    guard panel.isVisible else { NSWorkspace.shared.open(u); return }   // a closed bar is never opened for this
    let scr = panel.screen ?? NSScreen.main ?? NSScreen.screens[0], vf = scr.visibleFrame
    let leftW = (vf.width * 0.55).rounded()
    let bundle = browserBundle ?? "com.google.Chrome"
    besideBrowser = bundle
    // Global top-left coordinates for AppleScript bounds.
    let top = scr.frame.maxY - vf.maxY, x1 = Int(vf.minX), y1 = Int(top), x2 = Int(vf.minX + leftW), y2 = Int(top + vf.height)
    let esc = url.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
    let script: String
    if bundle == "com.apple.Safari" {
      script = "tell application id \"com.apple.Safari\"\nmake new document with properties {URL:\"\(esc)\"}\nset bounds of front window to {\(x1), \(y1), \(x2), \(y2)}\nend tell"
    } else {
      script = "tell application id \"com.google.Chrome\"\nset w to make new window\nset URL of active tab of w to \"\(esc)\"\nset bounds of w to {\(x1), \(y1), \(x2), \(y2)}\nend tell"
    }
    var err: NSDictionary?
    if NSAppleScript(source: script)?.executeAndReturnError(&err) == nil { NSWorkspace.shared.open(u) }   // no tiling: still opens
    if besideSaved == nil { besideSaved = panel.frame }
    sized = NSSize(width: vf.width - leftW, height: vf.height)
    panel.setFrame(NSRect(x: vf.minX + leftW, y: vf.minY, width: vf.width - leftW, height: vf.height), display: true)
    swapButton.isHidden = false; layout()
    append(who: "", "\(title.isEmpty ? "The key page" : title) is open beside me. Make the key there, copy it, and paste it into my key box. Swap (top left) brings either window to the front.")
  }
  @objc private func swapBeside() {
    guard let bundle = besideBrowser else { return }
    let browser = NSRunningApplication.runningApplications(withBundleIdentifier: bundle).first
    if browser?.isActive == true { panel.orderFrontRegardless(); NSApp.activate(ignoringOtherApps: true) }
    else { browser?.activate() }
  }
  func endBeside() {
    guard let f = besideSaved else { return }
    besideSaved = nil; besideBrowser = nil; swapButton.isHidden = true
    sized = f.size; panel.setFrame(f, display: true); layout()
  }

  // ── showing ──
  func toggle() {
    if panel.isVisible { hide(); return }
    show()
    if !on { append(who: "", "Kingmaker is off on this Mac (still working for the CRM). Type /on or click On below to turn it back on.") }
  }
  func show() {
    loadPrograms(); loadModels(); askCrmSkills()
    if sideTab == 1 { onCommand("artifacts") }   // the Artifacts tab is fresh whenever the bar opens on it
    let pointer = NSEvent.mouseLocation
    let screen = NSScreen.screens.first(where: { NSMouseInRect(pointer, $0.frame, false) }) ?? NSScreen.main ?? NSScreen.screens[0]
    layout()
    let vf = screen.visibleFrame, f = panel.frame
    // Where the owner left it (moved or resized), while that is still on a screen; else the chosen position.
    if let o = KingmakerBar.d.string(forKey: "km.origin").flatMap({ KingmakerBar.size($0) }).map({ NSPoint(x: $0.width, y: $0.height) }),
       NSScreen.screens.contains(where: { $0.visibleFrame.intersects(NSRect(origin: o, size: f.size)) }) {
      panel.setFrameOrigin(o)
    } else {
      let pos = KingmakerBar.d.string(forKey: "km.position") ?? "top"
      let topY = pos == "middle" ? vf.midY + f.height / 2 : pos == "bottom" ? vf.minY + f.height + 40 : vf.maxY - vf.height * 0.2
      panel.setFrameTopLeftPoint(NSPoint(x: vf.midX - f.width / 2, y: topY))
    }
    // Left full screen (the + or a restart): still the whole display, above the menu bar.
    if isMaxed || (sized.map { abs($0.width - screen.frame.width) < 4 && abs($0.height - screen.frame.height) < 4 } ?? false) {
      fullScreenLevel(true); panel.setFrame(screen.frame, display: true)
    } else { fullScreenLevel(false) }
    NSApp.activate(ignoringOtherApps: true)
    panel.makeKeyAndOrderFront(nil)
    panel.makeFirstResponder(field)
  }
  func hide() { tourCtl?.close(); tourCtl = nil; panel.orderOut(nil); clearPicks() }
  @objc private func minimizeTapped() { hide() }

  /// The wordmark, like RONIN INC on ronininc.org (Bodoni, wide capitals), centred in its own frame.
  static func wordmark(kern: CGFloat) -> NSAttributedString {
    let bodoni = NSFont(name: "BodoniSvtyTwoITCTT-Bold", size: 15) ?? NSFont(name: "Didot-Bold", size: 15) ?? .boldSystemFont(ofSize: 14)
    let para = NSMutableParagraphStyle(); para.alignment = .center
    return NSAttributedString(string: "KINGMAKER", attributes: [.font: bodoni, .kern: kern, .foregroundColor: NSColor.white.withAlphaComponent(0.94), .paragraphStyle: para])
  }

  // ── resizing: any edge or corner, or fill the screen and back ──
  static func size(_ s: String) -> NSSize? {
    let p = s.split(separator: ",").compactMap { Double($0) }
    return p.count == 2 ? NSSize(width: p[0], height: p[1]) : nil
  }
  private func keepFrame() {
    if staging { return }   // the stage's frame is the ad's, never the owner's
    if let s = sized { KingmakerBar.d.set("\(Int(s.width)),\(Int(s.height))", forKey: "km.size") }
    KingmakerBar.d.set("\(Int(panel.frame.minX)),\(Int(panel.frame.minY))", forKey: "km.origin")
  }
  /// Is the bar filling its screen now (by the + or left that way from before a restart)?
  private var isMaxed: Bool {
    guard let full = (panel.screen ?? NSScreen.main)?.frame else { return false }
    return abs(panel.frame.width - full.width) < 4 && abs(panel.frame.height - full.height) < 4
  }
  /// Full screen covers the whole display, menu bar included (owner 2026-10-15: "full screen should actually mean full screen,
  /// not with the top of the screen still showing the desktop"): the bar sits above the menu bar while it fills the screen.
  private func fullScreenLevel(_ on: Bool) { panel.level = on ? NSWindow.Level(rawValue: NSWindow.Level.mainMenu.rawValue + 1) : .floating }
  private var resizingByButton = false
  @objc private func fillTapped() {
    let screen = panel.screen ?? NSScreen.main ?? NSScreen.screens[0], vf = screen.visibleFrame, full = screen.frame
    resizingByButton = true
    if isMaxed || beforeFill != nil {
      // Back to the small box: the size before (or, maximized since a restart, the bar's own fit-to-talk size).
      let back = beforeFill; beforeFill = nil; beforeSized = nil
      sized = back.map { $0.size }
      if sized == nil || abs(sized!.width - vf.width) < 4 { sized = nil; KingmakerBar.d.removeObject(forKey: "km.size") }
      let w = sized?.width ?? (KingmakerBar.width + (sideShown ? KingmakerBar.sideW : 0)), h = sized?.height ?? 200
      fullScreenLevel(false)
      panel.setFrame(back ?? NSRect(x: vf.midX - w / 2, y: vf.maxY - vf.height * 0.2 - h, width: w, height: h), display: true)
    } else {
      beforeFill = panel.frame; beforeSized = sized
      sized = full.size; fullScreenLevel(true); panel.setFrame(full, display: true)
    }
    layout(); fillIcon(); keepFrame()
    resizingByButton = false
  }
  /// + maximizes; while maximized it shows "restore", back to the size before.
  private func fillIcon() {
    let maxed = beforeFill != nil || isMaxed
    fill.image = NSImage(systemSymbolName: maxed ? "arrow.down.right.and.arrow.up.left" : "plus", accessibilityDescription: maxed ? "Restore size" : "Maximize")?
      .withSymbolConfiguration(.init(pointSize: maxed ? 12 : 13, weight: .medium))
    fill.toolTip = maxed ? "Back to the size before" : "Maximize (again: back to the size before). Drag any edge or corner to resize."
  }
  func windowDidResize(_ notification: Notification) {
    guard panel.inLiveResize, !resizingByButton else { return }   // the owner dragging an edge: the bar takes that size
    sized = panel.frame.size
    if beforeFill != nil { beforeFill = nil; fillIcon() }
    layout()
  }
  func windowDidEndLiveResize(_ notification: Notification) { keepFrame() }
  func windowDidMove(_ notification: Notification) { if panel.isVisible { keepFrame() } }

  // ── what Kingmaker says, and its state ──
  func said(_ line: String) {
    if lastHeardNoise && line.hasPrefix("I didn't catch that") { lastHeardNoise = false; busy = false; return } // its answer to room noise
    append(who: "Kingmaker", line); busy = false
    lastAsked = line.trimmingCharacters(in: .whitespacesAndNewlines).hasSuffix("?") || line.range(of: #"\b[Ss]ay (“|"|')"#, options: .regularExpression) != nil
    sendQueued()
  }
  func setState(_ s: String) {
    tourCtl?.state(s)
    statusLabel.stringValue = (["thinking": "Working…", "speaking": "Speaking…", "hearing": "Listening…", "waiting": "Waiting for your word", "down": "Not running", "starting": "Starting…"][s]).map(UI.t) ?? ""
    if ["asleep", "awake", "text"].contains(s) { busy = false; sendQueued() }
  }
  /// The first-run tour (@@ghost tour: lib/first-run.mjs): the bar opens, everything but one control dims, and a card
  /// beside it says what to do. Finished or skipped, the engine is told (tour-done) and it doesn't show by itself again.
  func startTour(_ t: [String: Any]) {
    guard let steps = t["steps"] as? [[String: Any]], !steps.isEmpty else { return }
    tourCtl?.close()
    if !panel.isVisible { show() }
    let ctl = TourController(steps: steps, panel: panel, accent: replyColour, look: lookPref, size: textSize)
    ctl.target = { [weak self] id in
      guard let self else { return nil }
      switch id { case "mic": return self.mic; case "field": return self.field; case "gear": return self.gear; default: return nil }
    }
    ctl.permissionTarget = self
    ctl.send = { [weak self] line in self?.onCommand(line) }
    ctl.fill = { [weak self] text in guard let self else { return }; self.field.stringValue = text; self.panel.makeKeyAndOrderFront(nil); self.panel.makeFirstResponder(self.field) }
    ctl.ended = { [weak self] in self?.tourCtl = nil }
    tourCtl = ctl
    ctl.start(at: Int(ProcessInfo.processInfo.environment["KINGMAKER_TOUR_DEMO_STEP"] ?? "") ?? 0)
  }
  /// TEXT ONLY: the bar is just the box. No mic, no voice pill; what Kingmaker says is only written here.
  private(set) var textOnly = false
  func setTextOnly(_ t: Bool) { textOnly = t; mic.isHidden = t; muteButton.isHidden = t; layout() }
  func setMuted(_ m: Bool) { muted = m; UserDefaults.standard.set(m, forKey: "km.muted"); refreshFooter() }
  /// OFF: Kingmaker leaves the desktop (no mic, nothing spoken, the bar closes) and keeps working for the CRM in the
  /// background. It stays off across restarts until turned on.
  func setPower(_ p: Bool) {
    on = p; UserDefaults.standard.set(!p, forKey: "km.off"); refreshFooter()
    append(who: "", p ? "Kingmaker is on." : "Kingmaker is off on this Mac — it keeps working for the CRM in the background. Click the logo to turn it back on.")
    onPower(p)
    if !p { DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { [weak self] in self?.hide() } }
  }
  var onPower: (Bool) -> Void = { _ in }
  var wantsOff: Bool { UserDefaults.standard.bool(forKey: "km.off") }

  /// Your messages in white on the right, Kingmaker's in its colour (green) on the left, notes small and grey.
  private func append(who: String, _ text: String) {
    if !restoring { record(who, text); remember(who, text) }
    let para = NSMutableParagraphStyle(); para.paragraphSpacingBefore = hasLog ? 10 : 0; para.lineSpacing = 2
    var attrs: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: textSize), .foregroundColor: replyColour]
    switch who {
    case "You", "You (said)": para.alignment = .right; attrs[.foregroundColor] = NSColor.white; attrs[.font] = NSFont.systemFont(ofSize: textSize, weight: .medium)
    case "": attrs[.font] = NSFont.systemFont(ofSize: textSize - 2); attrs[.foregroundColor] = NSColor.white.withAlphaComponent(0.45)
    default: break
    }
    attrs[.paragraphStyle] = para
    let s = NSMutableAttributedString()
    if hasLog { s.append(NSAttributedString(string: "\n", attributes: attrs)) }
    let body = NSMutableAttributedString(string: (who == "You (said)" ? "🎙 " : "") + text, attributes: attrs)
    // Web addresses in Kingmaker's answers are links: a click opens that page (in the visible Chrome), nothing opens alone.
    if !["You", "You (said)"].contains(who), let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue) {
      for m in detector.matches(in: body.string, range: NSRange(location: 0, length: (body.string as NSString).length)) {
        if let u = m.url, ["http", "https"].contains(u.scheme?.lowercased() ?? ""), let link = KingmakerBar.barLink(u.absoluteString) { body.addAttribute(.link, value: link, range: m.range) }
      }
    }
    s.append(body)
    log.textStorage?.append(s); hasLog = true
    if let len = log.textStorage?.length, len > 60_000 { log.textStorage?.deleteCharacters(in: NSRange(location: 0, length: len - 40_000)) }
    log.setSelectedRange(NSRange(location: log.string.count, length: 0))
    layout(); log.scrollToEndOfDocument(nil)
  }

  // ── sending ──
  private func send(queue: Bool) {
    var text = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else { return }
    if flowShown && (flowData?["done"] as? Bool) == true { closeFlow() }
    field.stringValue = ""; clearPicks(); clearSuggestion()
    switch text.lowercased() {
    case "/off", "off": turnOff(); return
    case "/on", "on": onCommand(muted ? "power on muted" : "power on"); return
    case "/mute": onCommand("voice-out off"); return
    case "/unmute": onCommand("voice-out on"); return
    case "/folder": chooseFolder(); return
    case "/clear", "/new": newChat(); return
    case "/connectors", "/keys", "/settings", "/connections": onCommand("screen connectors"); return
    case "/behave", "/behavior", "/instructions", "/guardrails": openCustomize(tab: 2); return
    default: break
    }
    // "/recall what did Ana say": a CRM skill first word (when the owner turned them on and no program has that name) goes
    // to the engine as that skill; the rest of the words are its instruction.
    if crmSkillsOn, let first = text.split(separator: " ", maxSplits: 1).first.map(String.init), first.hasPrefix("/"),
       let skill = crmSkills.first(where: { $0.value.lowercased() == first.dropFirst().lowercased() }),
       !programs.contains(where: { $0.value.lowercased() == skill.value.lowercased() }) {
      let rest = String(text.dropFirst(first.count)).trimmingCharacters(in: .whitespaces)
      var payload: [String: Any] = ["text": rest, "model": "kingmaker", "crmSkill": skill.value, "programs": [String](), "speak": speakPref]
      if let f = folder { payload["folder"] = f.path }
      lastAsked = false
      sendTurn(payload, shown: text, queue: queue); return
    }
    // /Program tags, anywhere in the message: what to drive (Google_Chrome → Google Chrome).
    var named: [String] = []
    let known = Set(programs.map { $0.value.lowercased() })
    var kept: [String] = []
    for word in text.split(separator: " ").map(String.init) {
      if word.hasPrefix("/"), word.count > 2 {
        let name = String(word.dropFirst()).replacingOccurrences(of: "_", with: " ")
        if known.contains(name.lowercased()) || kept.isEmpty { named.append(name); continue }
      }
      kept.append(word)
    }
    text = kept.joined(separator: " ").trimmingCharacters(in: .whitespaces)
    // a half-typed word left before the tag ("wha /WhatsApp send…"): drop it when it's the start of the program's name
    if let first = kept.first, named.contains(where: { $0.lowercased().hasPrefix(first.lowercased()) && first.count < $0.count }) {
      text = kept.dropFirst().joined(separator: " ")
    }
    // WhatsApp to someone by name: their number from Contacts; WhatsApp opens with the message written, you press Send.
    if named.contains(where: { $0.lowercased() == "whatsapp" }) || text.lowercased().contains("whatsapp") {
      if whatsappToContact(text, shown: (named.map { "/\($0) " }.joined()) + text) { return }
    }
    guard !text.isEmpty else { NSSound.beep(); return }
    if named.isEmpty, let done = quickAction(text) { append(who: "You", text); append(who: "Kingmaker", done); return }
    // "/Chrome open apple.com": open it in that program, at once.
    if named.count == 1, let r = text.lowercased().range(of: #"^(open|go to|show)\s+"#, options: .regularExpression) {
      var target = String(text[r.upperBound...]).trimmingCharacters(in: .whitespaces)
      if let site = KingmakerBar.sites[target.lowercased()] { target = site }
      else if target.range(of: #"^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+(/\S*)?$"#, options: .regularExpression) != nil { target = "https://" + target }
      let appName = named[0].lowercased() == "chrome" ? "Google Chrome" : named[0]
      let p = Process(); p.executableURL = URL(fileURLWithPath: "/usr/bin/open"); p.arguments = ["-a", appName, target]
      p.standardError = FileHandle.nullDevice; p.standardOutput = FileHandle.nullDevice
      if (try? p.run()) != nil { p.waitUntilExit(); if p.terminationStatus == 0 { append(who: "You", "/\(named[0]) \(text)"); append(who: "Kingmaker", "Opened \(target) in \(appName)."); return } }
    }
    let shown = text
    text = KingmakerBar.kingmakerWords(text)
    // Every turn goes to Kingmaker, the governed brain with the fast lanes (Auto). A pinned local model only takes the write
    // lane's place (lib/fast-route.mjs writerModel); actions and lookups still go to the governed brain with their gates.
    lastAsked = false
    var payload: [String: Any] = ["text": text, "model": "kingmaker", "programs": named, "speak": speakPref]
    if let pin = modelPin { payload["pin"] = pin }
    if let f = folder { payload["folder"] = f.path }
    if !personality.isEmpty { payload["personality"] = personality }   // Customize → Personality
    // A turn in a project carries its doctrine, and its own folder and model when it has them.
    if let p = currentProject, let s = projectSettings[p] {
      payload["project"] = p
      if let d = s["doctrine"], !d.isEmpty { payload["doctrine"] = d }
      if let f = s["folder"], !f.isEmpty { payload["folder"] = f }
      if let pin = s["pin"], !pin.isEmpty { payload["pin"] = pin }
    }
    sendTurn(payload, shown: (named.isEmpty ? "" : named.map { "/\($0) " }.joined()) + shown, queue: queue)
  }
  /// One typed turn to Kingmaker (base64 JSON for `typed-turn`), shown as the owner's line; queued while it's busy.
  private func sendTurn(_ payload: [String: Any], shown: String, queue: Bool) {
    guard let json = try? JSONSerialization.data(withJSONObject: payload) else { return }
    let line = json.base64EncodedString()
    append(who: "You", shown)
    if queue && busy { queued.append(line); append(who: "", "Queued — it goes after the current answer."); return }
    busy = true; onTurn(line)
  }

  /// Everyday wording → the phrases Kingmaker knows ("dock with crm.example.com" → "connect my CRM at crm.example.com").
  /// Any CRM: no address is assumed, so a bare "connect my CRM" goes to Kingmaker, which asks for it.
  static func kingmakerWords(_ text: String) -> String {
    let low = text.lowercased()
    let pattern = #"^(?:please\s+)?(?:dock|connect|link|hook|pair|attach|plug)(?:\s+(?:me|it|you|kingmaker|up))?(?:\s+(?:my|the|your))?(?:\s+crm)?\s*(?:with|to|at|into|in|up to)\s*(?:the\s+)?(?:https?://)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?:/\S*)?\s*$"#
    if let re = try? NSRegularExpression(pattern: pattern), let m = re.firstMatch(in: low, range: NSRange(low.startIndex..., in: low)),
       let r = Range(m.range(at: 1), in: low), low.contains("crm") || low.hasPrefix("dock") {
      return "connect my CRM at \(low[r])"
    }
    return text
  }

  // ── the device hub: what the bar does itself, at once ──
  /// A plain question a local model can answer in words (what/why/how…, explain, define, summarize, ends with ?).
  static func isQuestion(_ text: String) -> Bool {
    let t = text.lowercased().trimmingCharacters(in: .whitespaces)
    return t.hasSuffix("?") || t.range(of: #"^(what|who|why|how|when|where|which|is|are|was|were|(do|does|did) (i|you|we|they|it|he|she|people|the|a|an)|can|could|should|would|will|explain|define|describe|summari[sz]e|tell me about|in one sentence|give me (an? )?(idea|example|list|summary)|write (me )?(a|an) (poem|story|paragraph|note|caption|reply|email draft))\b"#, options: .regularExpression) != nil
  }
  static func isCommand(_ text: String) -> Bool {
    let t = text.lowercased().trimmingCharacters(in: .whitespaces)
    return t.range(of: #"^(please\s+|can you\s+|could you\s+)?(open|launch|start|go to|visit|look at|send|text|message|whatsapp|imessage|email|e-mail|mail|call|ring|facetime|connect|link|unlink|dock|play|pause|remind|schedule|book|search|look up|find|post|reply|turn|install|close|quit|create|make|draw|design|generate|build|edit|add|delete|move|copy|download|upload|pay|order|show|check|read|set|change|fix|update)\b"#, options: .regularExpression) != nil
  }
  private static let sites: [String: String] = [
    "youtube": "https://www.youtube.com", "gmail": "https://mail.google.com", "email": "https://mail.google.com", "google": "https://www.google.com",
    "maps": "https://maps.google.com", "google maps": "https://maps.google.com", "drive": "https://drive.google.com", "google drive": "https://drive.google.com",
    "calendar": "https://calendar.google.com", "google calendar": "https://calendar.google.com", "sheets": "https://sheets.google.com", "docs": "https://docs.google.com",
    "instagram": "https://www.instagram.com", "facebook": "https://www.facebook.com", "linkedin": "https://www.linkedin.com", "x": "https://x.com", "twitter": "https://x.com",
    "clover": "https://www.clover.com/dashboard", "clover dashboard": "https://www.clover.com/dashboard",
    "github": "https://github.com", "cloudflare": "https://dash.cloudflare.com", "whatsapp web": "https://web.whatsapp.com"]
  /// "open youtube", "open gmail", "open Safari", "open example.com", "whatsapp +1 602 555 0100 saying on my way": done here,
  /// at once. → what happened, or nil (Kingmaker takes it). Never sends anything: a message opens ready, you press Send.
  private func quickAction(_ text: String) -> String? {
    let t = text.trimmingCharacters(in: .whitespaces)
    let low = t.lowercased()
    // Web pages open in Chrome (the owner's browser), else the default browser.
    func open(_ url: String, app: String = "Google Chrome") -> Bool {
      guard let u = URL(string: url) else { return false }
      if u.scheme?.hasPrefix("http") == true, let chrome = (app == "Google Chrome" ? browserBundle.flatMap { NSWorkspace.shared.urlForApplication(withBundleIdentifier: $0) } : URL(fileURLWithPath: "/Applications/\(app).app")) {
        let cfg = NSWorkspace.OpenConfiguration(); NSWorkspace.shared.open([u], withApplicationAt: chrome, configuration: cfg, completionHandler: nil); return true
      }
      return NSWorkspace.shared.open(u)
    }
    // WhatsApp to a number: opens WhatsApp with the message written in it.
    if let r = low.range(of: #"^(send\s+)?(a\s+)?whats\s?app(\s+(message|text))?\s+(to\s+)?\+?[\d\s().-]{7,}"#, options: .regularExpression) {
      let head = String(t[r]), digits = head.filter(\.isNumber)
      var msg = String(t[r.upperBound...]).trimmingCharacters(in: .whitespaces)
      for lead in ["saying ", "that says ", "says ", ": ", "- "] where msg.lowercased().hasPrefix(lead) { msg = String(msg.dropFirst(lead.count)); break }
      let num = digits.count == 10 ? "1\(digits)" : digits
      let q = msg.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? ""
      if open("whatsapp://send?phone=\(num)&text=\(q)") { return "WhatsApp is open with your message to +\(num). Press Send when it looks right." }
      if open("https://wa.me/\(num)?text=\(q)") { return "WhatsApp Web is open with your message to +\(num). Press Send when it looks right." }
      return nil
    }
    // "what can you do (right now)", "list your abilities", "your ability schema", "what are you capable of": the real
    // list, here, whichever model is chosen (a local model only knows it can't act; the governed brain web-searched it).
    if low.range(of: #"^(help|\?|commands)$|what (can|do) you do|what (are|is) (you|kingmaker) (able|capable)|what can kingmaker|\byour (current )?(abilit|capabilit|skills|features|commands|tools|powers)|\babilit(y|ies) (schema|list)|\bcapabilit(y|ies) (schema|list)"#, options: .regularExpression) != nil {
      return "Here's what I can do on this Mac, with local models only:\n• At once: open apps and sites (open youtube, open Photos, open gmail), count files (how many files on my desktop), WhatsApp someone from Contacts (whatsapp Ana saying on my way — it opens ready, you press Send).\n• Through Kingmaker, which acts: your CRM (connect my CRM at its address), messages, calendar and reminders, web research with sources, files and folders, keys (connect my CRM, connect my GitHub key) into a hidden field.\n• Make things: say \"make a poster for …\" and I draw it on this Mac (Z-Image, about 90 s, saved in Pictures › Kingmaker); or start with a Craft app, e.g. /VectorCraft a Ronin Inc poster.\n• Writing (summaries, drafts, ideas) goes straight to the local writer model; only actions and lookups go through Kingmaker's approvals.\n• Paste or drop files, images, video and audio into the bar to attach them; @name finds a file.\n• /mute · /unmute · /off (auto mode: I keep routing CRM work to agents in the background) · /on · /folder · /clear · ⌘M minimizes.\nThe model on the right: Auto, or pin a local model to write with it (actions and lookups still go through Kingmaker)."
    }
    // "how many files are on my desktop / in downloads": counted here, on this Mac.
    if let m = low.range(of: #"how many (files|items|things|folders|pdfs|images|photos|videos)\b.*\b(desktop|downloads|documents)"#, options: .regularExpression) {
      let q = String(low[m]); let place = q.contains("desktop") ? "Desktop" : q.contains("downloads") ? "Downloads" : "Documents"
      let dir = URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent(place)
      let all = (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.isDirectoryKey], options: [.skipsHiddenFiles])) ?? []
      let folders = all.filter { (try? $0.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true }
      let ext: Set<String>? = q.contains("pdf") ? ["pdf"] : (q.contains("image") || q.contains("photo")) ? ["png", "jpg", "jpeg", "heic", "gif", "webp"] : q.contains("video") ? ["mov", "mp4", "m4v"] : nil
      if q.contains("folder") { return "\(folders.count) folder\(folders.count == 1 ? "" : "s") on your \(place)." }
      let files = all.filter { !folders.contains($0) && (ext == nil || ext!.contains($0.pathExtension.lowercased())) }
      return "\(files.count) file\(files.count == 1 ? "" : "s") and \(folders.count) folder\(folders.count == 1 ? "" : "s") on your \(place)\(ext == nil ? "" : " (counting only those types)")."
    }
    // "find invoices on my mac": the matches, from Spotlight's index.
    if let m = low.range(of: #"^(find|search( for)?|where is|where are|look for)\s+(.+?)(\s+on (my|this) (mac|computer))?$"#, options: .regularExpression), low.contains(" on my mac") || low.contains(" on this mac") || low.hasPrefix("where is") || low.hasPrefix("where are") {
      var q = String(low[m]).replacingOccurrences(of: #"^(find|search( for)?|where is|where are|look for)\s+"#, with: "", options: .regularExpression)
      q = q.replacingOccurrences(of: #"\s+on (my|this) (mac|computer)$"#, with: "", options: .regularExpression).replacingOccurrences(of: #"^(my|the)\s+"#, with: "", options: .regularExpression)
      let p = Process(); p.executableURL = URL(fileURLWithPath: "/usr/bin/mdfind"); p.arguments = ["-name", q]
      let out = Pipe(); p.standardOutput = out; p.standardError = FileHandle.nullDevice
      try? p.run(); p.waitUntilExit()
      let hits = (String(data: out.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? "").split(separator: "\n").map(String.init).filter { !$0.contains("/Library/") && !$0.contains("/.") }
      if hits.isEmpty { return "Nothing on this Mac is named like “\(q)”." }
      setPicks(hits.prefix(8).map { Pick(kind: $0.hasSuffix(".app") ? "app" : "file", title: (($0 as NSString).lastPathComponent as NSString).deletingPathExtension, detail: ($0 as NSString).deletingLastPathComponent.replacingOccurrences(of: NSHomeDirectory(), with: "~"), value: $0, path: $0) }, select: 0)
      return "\(hits.count) match\(hits.count == 1 ? "" : "es") for “\(q)” on this Mac — the top ones are listed; ↓ and Enter opens one."
    }
    guard let r = low.range(of: #"^(please\s+)?(open|launch|start|go to|show me)\s+"#, options: .regularExpression) else { return nil }
    var target = String(low[r.upperBound...]).trimmingCharacters(in: .whitespaces)
    if target.contains(" and ") || target.contains(" then ") { return nil } // open-and-do: Kingmaker's job
    for lead in ["the ", "my ", "up "] where target.hasPrefix(lead) { target = String(target.dropFirst(lead.count)) }
    target = target.trimmingCharacters(in: CharacterSet(charactersIn: ".!? "))
    if let url = KingmakerBar.sites[target] ?? KingmakerBar.sites["the " + target] {
      if target == "whatsapp" || target.hasPrefix("whatsapp") { return nil }
      return open(url) ? "Opened \(target)." : nil
    }
    if target.range(of: #"^[a-z0-9-]+(\.[a-z0-9-]+)+(/\S*)?$"#, options: .regularExpression) != nil { return open("https://\(target)") ? "Opened \(target)." : nil }
    // an app on this Mac, by name (WhatsApp included)
    let p = Process(); p.executableURL = URL(fileURLWithPath: "/usr/bin/open"); p.arguments = ["-a", target]
    p.standardError = FileHandle.nullDevice; p.standardOutput = FileHandle.nullDevice
    if (try? p.run()) != nil { p.waitUntilExit(); if p.terminationStatus == 0 { return "Opened \(target.capitalized)." } }
    if target == "whatsapp" { return open("https://web.whatsapp.com") ? "Opened WhatsApp Web." : nil }
    return nil
  }

  /// What Kingmaker heard when spoken to (its own mic), shown in the conversation.
  /// What Kingmaker heard when spoken to: a stray syllable or two ("lu") is room noise, not the owner speaking.
  private var lastHeardNoise = false
  func heard(_ text: String) {
    let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
    lastHeardNoise = t.count < 4 || t.range(of: #"^\W*\w{1,3}\W*$"#, options: .regularExpression) != nil
    if lastHeardNoise { return }
    append(who: "You (said)", t); busy = true
  }

  /// "send a text to Ana saying test" with WhatsApp: the person from Contacts, WhatsApp opened with the message written.
  private func whatsappToContact(_ text: String, shown: String) -> Bool {
    let t = text.replacingOccurrences(of: "\"", with: "").replacingOccurrences(of: "“", with: "").replacingOccurrences(of: "”", with: "")
    guard let r = t.range(of: #"(?i)^(?:please\s+)?(?:send\s+)?(?:an?\s+)?(?:whats\s?app\s+)?(?:message|text|msg|whatsapp)?\s*(?:to\s+)(.+?)\s+(?:saying|that says|says|with|:)\s+(.+)$"#, options: .regularExpression) else { return false }
    let m = String(t[r])
    let re = try! NSRegularExpression(pattern: #"(?i)to\s+(.+?)\s+(?:saying|that says|says|with|:)\s+(.+)$"#)
    guard let g = re.firstMatch(in: m, range: NSRange(m.startIndex..., in: m)), let nr = Range(g.range(at: 1), in: m), let br = Range(g.range(at: 2), in: m) else { return false }
    let name = String(m[nr]).trimmingCharacters(in: .whitespaces), body = String(m[br]).trimmingCharacters(in: .whitespaces)
    append(who: "You", shown)
    if name.filter(\.isNumber).count >= 7 { openWhatsApp(name.filter(\.isNumber), body, who: name); return true }
    let store = CNContactStore()
    store.requestAccess(for: .contacts) { [weak self] ok, _ in
      DispatchQueue.main.async {
        guard let self else { return }
        guard ok else { self.append(who: "Kingmaker", "I need Contacts to find \(name). Turn it on in ⚙︎ → Permissions, then ask again."); return }
        let keys = [CNContactGivenNameKey, CNContactFamilyNameKey, CNContactNicknameKey, CNContactPhoneNumbersKey] as [CNKeyDescriptor]
        let people = ((try? store.unifiedContacts(matching: CNContact.predicateForContacts(matchingName: name), keysToFetch: keys)) ?? []).filter { !$0.phoneNumbers.isEmpty }
        if people.isEmpty { self.append(who: "Kingmaker", "No contact named “\(name)” with a phone number. Say the number instead (whatsapp +1 602 555 0100 saying …)."); return }
        if people.count > 1 {
          self.append(who: "Kingmaker", "More than one \(name) — pick one below.")
          self.setPicks(people.prefix(6).flatMap { c in c.phoneNumbers.prefix(2).map { n in
            Pick(kind: "whatsapp", title: "\(c.givenName) \(c.familyName)".trimmingCharacters(in: .whitespaces), detail: n.value.stringValue, value: "\(n.value.stringValue.filter(\.isNumber))|\(body)") } }, select: 0)
          return
        }
        let c = people[0]
        self.openWhatsApp(c.phoneNumbers[0].value.stringValue.filter(\.isNumber), body, who: "\(c.givenName) \(c.familyName)".trimmingCharacters(in: .whitespaces))
      }
    }
    return true
  }
  private func openWhatsApp(_ digits: String, _ body: String, who: String) {
    let num = digits.count == 10 ? "1\(digits)" : digits
    let q = body.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? ""
    if let u = URL(string: "whatsapp://send?phone=\(num)&text=\(q)"), NSWorkspace.shared.urlForApplication(toOpen: u) != nil, NSWorkspace.shared.open(u) {
      append(who: "Kingmaker", "WhatsApp is open with “\(body)” to \(who). Press Send when it looks right.")
    } else if let u = URL(string: "https://wa.me/\(num)?text=\(q)"), NSWorkspace.shared.open(u) {
      append(who: "Kingmaker", "WhatsApp Web is open with “\(body)” to \(who). Press Send when it looks right.")
    }
  }

  // ── the key field ──
  /// The engine wants a key (@@ghost keyRequest) or is done with it (null). `result` is what came of a paste.
  func keyRequested(_ request: [String: Any]?, result: [String: Any]?) {
    if let spoken = result?["spoken"] as? String { append(who: "Kingmaker", spoken) }
    keyRequest = request
    keyField.stringValue = ""
    keyStrip.isHidden = request == nil
    if let r = request {
      let noun = (r["keyNoun"] as? String) ?? "API key"
      keyLabel.stringValue = "🔒  Paste your \(noun) — hidden, saved only in this Mac's vault"
      append(who: "", "Waiting for your \(noun): paste it into the green field and press Save.")
      keyPage.isHidden = (r["keyPageUrl"] as? String).flatMap(URL.init(string:)) == nil
      show(); layout(); panel.makeFirstResponder(keyField)
    } else { layout(); if panel.isVisible { panel.makeFirstResponder(field) } }
  }
  @objc private func saveKey() {
    let key = keyField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
    keyField.stringValue = ""
    guard keyRequest != nil, !key.isEmpty, let data = key.data(using: .utf8) else { NSSound.beep(); return }
    append(who: "", "Key pasted (hidden). Saving it…")
    onKeySeal(data.base64EncodedString())
  }
  @objc private func cancelKey() { keyField.stringValue = ""; onCommand("key-cancel") }
  @objc private func openKeyPage() {
    guard let s = keyRequest?["keyPageUrl"] as? String, let u = URL(string: s), ["https", "http"].contains(u.scheme ?? "") else { return }
    if let id = browserBundle, let app = NSWorkspace.shared.urlForApplication(withBundleIdentifier: id) {
      NSWorkspace.shared.open([u], withApplicationAt: app, configuration: NSWorkspace.OpenConfiguration())
    } else { NSWorkspace.shared.open(u) }
  }

  /// ⌘V in the bar: copied files, images, video and audio attach to the message; text pastes as text. The key field
  /// always takes a plain paste.
  private func pasteMedia() -> Bool {
    let pb = NSPasteboard.general
    if panel.firstResponder === keyField || (panel.firstResponder as? NSTextView)?.delegate === keyField { return false }
    // While a key is wanted, a pasted key (one word, no spaces) goes into the hidden field wherever the cursor is.
    if keyRequest != nil, !PastedMedia.hasMedia(pb), let t = pb.string(forType: .string)?.trimmingCharacters(in: .whitespacesAndNewlines),
       t.count >= 16, !t.contains(where: { $0.isWhitespace }) {
      keyField.stringValue = t; panel.makeFirstResponder(keyField)
      append(who: "", "Key pasted into the hidden field (not shown). Press Save.")
      return true
    }
    guard PastedMedia.hasMedia(pb) else { return false }
    let urls = PastedMedia.files(from: pb)
    guard !urls.isEmpty else { return false }
    attach(urls)
    append(who: "", "Attached " + urls.map { $0.lastPathComponent }.joined(separator: ", ") + ".")
    return true
  }

  /// Files picked (@name, dropped on the bar, pasted, or + Attach): their paths go in the message, quoted.
  func attach(_ urls: [URL]) {
    let paths = urls.map { $0.path.contains(" ") ? "\"\($0.path)\"" : $0.path }
    let cur = field.stringValue.trimmingCharacters(in: .whitespaces)
    field.stringValue = (cur.isEmpty ? "" : cur + " ") + paths.joined(separator: " ") + " "
    clearPicks(); show(); field.currentEditor()?.moveToEndOfDocument(nil)
  }
  static func spotlight(_ q: String, limit: Int) -> [String] {
    let p = Process(); p.executableURL = URL(fileURLWithPath: "/usr/bin/mdfind"); p.arguments = ["-name", q]
    let out = Pipe(); p.standardOutput = out; p.standardError = FileHandle.nullDevice
    try? p.run()
    let deadline = Date().addingTimeInterval(1.5)
    while p.isRunning && Date() < deadline { usleep(30_000) }
    if p.isRunning { p.terminate() }
    return Array((String(data: out.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? "").split(separator: "\n").map(String.init)
      .filter { !$0.contains("/Library/") && !$0.contains("/.") }.prefix(limit))
  }

  private func sendQueued() { guard !busy, !queued.isEmpty else { return }; busy = true; onTurn(queued.removeFirst()) }

  // ── typing: / programs, or search the Mac ──
  func controlTextDidChange(_ obj: Notification) {
    refreshSend()
    let text = field.stringValue
    searchWork?.cancel()
    if let last = text.split(separator: " ", omittingEmptySubsequences: false).last, last.hasPrefix("/") {
      let q = last.dropFirst().lowercased().replacingOccurrences(of: "_", with: " ")
      let commands = [Pick(kind: "command", title: "/off", detail: "Turn Kingmaker off (no listening)", value: "/off"), Pick(kind: "command", title: "/on", detail: "Turn it back on", value: "/on"),
                      Pick(kind: "command", title: "/mute", detail: "No voice — answers here as text", value: "/mute"), Pick(kind: "command", title: "/unmute", detail: "Speak again", value: "/unmute"),
                      Pick(kind: "command", title: "/folder", detail: "Choose the folder (the CRM and project)", value: "/folder"), Pick(kind: "command", title: "/clear", detail: "Clear this conversation", value: "/clear")]
      let all = commands + (crmSkillsOn ? crmSkills : []) + programs
      setPicks(Array(all.filter { q.isEmpty || $0.title.lowercased().contains(q) || $0.detail.lowercased().contains(q) }.prefix(8)), select: 0)
      return
    }
    // @name: pick a file on this Mac to go along with the message.
    if let last = text.split(separator: " ", omittingEmptySubsequences: false).last, last.hasPrefix("@"), last.count >= 3 {
      let fq = String(last.dropFirst()), tail = String(last)
      let work = DispatchWorkItem { [weak self] in
        let hits = KingmakerBar.spotlight(fq, limit: 8)
        DispatchQueue.main.async { guard let self, self.field.stringValue.hasSuffix(tail) else { return }
          self.setPicks(hits.map { Pick(kind: "attach", title: ($0 as NSString).lastPathComponent, detail: ($0 as NSString).deletingLastPathComponent.replacingOccurrences(of: NSHomeDirectory(), with: "~"), value: $0, path: $0) }, select: 0) }
      }
      searchWork = work
      DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + 0.2, execute: work)
      return
    }
    let q = text.trimmingCharacters(in: .whitespaces)
    guard searchWhileTyping, q.count >= 2, !q.hasPrefix("/"), !KingmakerBar.isCommand(q) else { clearPicks(); return }
    let local = programs.filter { $0.title.lowercased().contains(q.lowercased()) }.prefix(3)
    setPicks(Array(local), select: -1)
    let work = DispatchWorkItem { [weak self] in
      let p = Process(); p.executableURL = URL(fileURLWithPath: "/usr/bin/mdfind"); p.arguments = ["-name", q]
      let out = Pipe(); p.standardOutput = out; p.standardError = FileHandle.nullDevice
      try? p.run()
      let deadline = Date().addingTimeInterval(1.5)
      while p.isRunning && Date() < deadline { usleep(30_000) }
      if p.isRunning { p.terminate() }
      let paths = (String(data: out.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? "").split(separator: "\n").map(String.init)
        .filter { !$0.contains("/Library/Caches/") && !$0.contains("/.") }.prefix(5)
      let files = paths.map { Pick(kind: $0.hasSuffix(".app") ? "app" : "file", title: (($0 as NSString).lastPathComponent as NSString).deletingPathExtension, detail: ($0 as NSString).deletingLastPathComponent.replacingOccurrences(of: NSHomeDirectory(), with: "~"), value: $0, path: $0) }
      DispatchQueue.main.async { guard let self, self.field.stringValue.trimmingCharacters(in: .whitespaces) == q else { return }; self.setPicks(Array(local) + files, select: -1) }
    }
    searchWork = work
    DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + 0.25, execute: work)
  }

  func control(_ control: NSControl, textView: NSTextView, doCommandBy sel: Selector) -> Bool {
    switch sel {
    case #selector(NSResponder.moveDown(_:)): if !picks.isEmpty { selected = min(picks.count - 1, selected + 1); drawPicks() }; return true
    case #selector(NSResponder.moveUp(_:)): if !picks.isEmpty { selected = max(-1, selected - 1); drawPicks() }; return true
    case #selector(NSResponder.cancelOperation(_:)): if !picks.isEmpty { clearPicks() } else { hide() }; return true
    case #selector(NSResponder.insertTab(_:)): if selected >= 0 { choose(picks[selected]) } else { _ = takeSuggestion() }; return true
    case #selector(NSResponder.moveRight(_:)): return picks.isEmpty && takeSuggestion()
    case #selector(NSResponder.insertNewline(_:)), #selector(NSResponder.insertLineBreak(_:)), #selector(NSResponder.insertNewlineIgnoringFieldEditor(_:)):
      let cmd = NSApp.currentEvent?.modifierFlags.contains(.command) == true
      if selected >= 0, selected < picks.count, !cmd { choose(picks[selected]) } else { send(queue: cmd) }
      return true
    default: return false
    }
  }

  private func choose(_ p: Pick) {
    switch p.kind {
    case "command": field.stringValue = p.value; send(queue: false)
    case "program", "crmskill":
      var words = field.stringValue.split(separator: " ", omittingEmptySubsequences: false).map(String.init)
      if let last = words.last, last.hasPrefix("/") { words.removeLast() }
      field.stringValue = (words + ["/" + p.value.replacingOccurrences(of: " ", with: "_"), ""]).joined(separator: " ").trimmingCharacters(in: .init(charactersIn: " ")) + " "
      clearPicks(); field.currentEditor()?.moveToEndOfDocument(nil)
    case "attach":
      var words = field.stringValue.split(separator: " ", omittingEmptySubsequences: false).map(String.init)
      if let last = words.last, last.hasPrefix("@") { words.removeLast() }
      field.stringValue = words.joined(separator: " ")
      attach([URL(fileURLWithPath: p.value)])
    case "whatsapp":
      let parts = p.value.split(separator: "|", maxSplits: 1).map(String.init)
      clearPicks(); if parts.count == 2 { openWhatsApp(parts[0], parts[1], who: p.title) }
    default: NSWorkspace.shared.open(URL(fileURLWithPath: p.value)); field.stringValue = ""; clearPicks(); hide()
    }
  }

  private func setPicks(_ p: [Pick], select: Int) { picks = p; selected = p.isEmpty ? -1 : select; drawPicks() }
  private func clearPicks() { picks = []; selected = -1; drawPicks() }
  /// Rows like Spotlight's: the real icon (app or file) or a symbol, the name, then where/what in grey; the selected row
  /// gets a soft highlight.
  private func drawPicks() {
    picksBox.arrangedSubviews.forEach { $0.removeFromSuperview() }
    let w = contentWidth - 32
    for (i, p) in picks.enumerated() {
      let b = NSButton(title: "", target: self, action: #selector(pickClicked(_:)))
      b.tag = i; b.isBordered = false; b.alignment = .left; b.imagePosition = .imageLeading; b.imageHugsTitle = true
      let icon: NSImage? = p.path.map { NSWorkspace.shared.icon(forFile: $0) }
        ?? NSImage(systemSymbolName: ["command": "command", "program": "puzzlepiece.extension", "crmskill": "briefcase"][p.kind] ?? "circle", accessibilityDescription: nil)?.withSymbolConfiguration(.init(pointSize: 13, weight: .regular))
      icon?.size = NSSize(width: 18, height: 18); b.image = icon; b.contentTintColor = .secondaryLabelColor
      let t = NSMutableAttributedString(string: "  \(p.title)", attributes: [.font: NSFont.systemFont(ofSize: 13, weight: .medium), .foregroundColor: NSColor.labelColor])
      t.append(NSAttributedString(string: "   \(p.detail)", attributes: [.font: NSFont.systemFont(ofSize: 12), .foregroundColor: NSColor.secondaryLabelColor]))
      b.attributedTitle = t
      b.wantsLayer = true; b.layer?.cornerRadius = 8; b.layer?.cornerCurve = .continuous
      b.layer?.backgroundColor = i == selected ? NSColor.controlAccentColor.withAlphaComponent(0.28).cgColor : NSColor.clear.cgColor
      b.widthAnchor.constraint(equalToConstant: w).isActive = true
      b.heightAnchor.constraint(equalToConstant: 30).isActive = true
      picksBox.addArrangedSubview(b)
    }
    layout()
  }
  @objc private func pickClicked(_ b: NSButton) { if b.tag < picks.count { choose(picks[b.tag]) } }

  // ── the footer: folder, on/off, voice, model ──
  private func pill(_ b: NSButton, _ symbolName: String, _ title: String, tint: NSColor = .secondaryLabelColor) {
    b.image = NSImage(systemSymbolName: symbolName, accessibilityDescription: nil)?.withSymbolConfiguration(.init(pointSize: 11, weight: .semibold))
    b.attributedTitle = NSAttributedString(string: " \(title)", attributes: [.font: NSFont.systemFont(ofSize: 12, weight: .medium), .foregroundColor: NSColor.secondaryLabelColor])
    b.contentTintColor = tint
  }
  private func refreshFooter() {
    pill(folderButton, "folder", folder.map { $0.lastPathComponent } ?? UI.t("No folder"))
    pill(powerButton, "power", UI.t(on ? "On" : "Off"), tint: on ? .systemGreen : .tertiaryLabelColor)
    pill(muteButton, muted ? "speaker.slash.fill" : "speaker.wave.2.fill", UI.t(muted ? "Muted" : "Voice"))
    // Icon only, small: a game controller (the owner, 2026-10-16: "it should be a small controller icon"); its name is the tooltip.
    pill(commandsButton, "gamecontroller", ""); commandsButton.attributedTitle = NSAttributedString(string: ""); commandsButton.imagePosition = .imageOnly
    layout()
  }

  // ── THE COMMAND LIBRARY (a small controller icon in the bottom row; lib/command-list.mjs, the same list as the README's):
  // a glassy panel with every category side by side and a search bar on top, laid out like the Ronin Inc site's mega menu.
  // Choosing an entry puts it in the box, ready to finish and send: nothing is sent from the library.
  private var commandGroups: [[String: Any]] = []
  func setCommands(_ groups: [[String: Any]]) { commandGroups = groups }
  private lazy var library: CommandLibrary = {
    let l = CommandLibrary()
    l.onFill = { [weak self] fill in self?.fillBox(fill) }
    return l
  }()
  @objc private func commandsMenu(_ sender: NSButton) { library.show(commandGroups, over: panel) }
  private func fillBox(_ fill: String) {
    show()
    field.stringValue = fill
    panel.makeKeyAndOrderFront(nil); panel.makeFirstResponder(field)
    field.currentEditor()?.selectedRange = NSRange(location: (fill as NSString).length, length: 0)
    refreshSend()
  }
  // ── Customize ──
  /// The apps Automation drives (Messages, Chrome, FaceTime), by bundle id.
  static let automationTargets: [(String, String)] = [("Messages", "com.apple.MobileSMS"), ("Google Chrome", "com.google.Chrome"), ("FaceTime", "com.apple.FaceTime")]
  /// Automation for one app: true/false once macOS has an answer, nil while it hasn't asked (or the app isn't running).
  static func automationAllowed(_ bundleID: String, ask: Bool) -> Bool? {
    let target = NSAppleEventDescriptor(bundleIdentifier: bundleID)
    guard let desc = target.aeDesc else { return nil }
    let st = AEDeterminePermissionToAutomateTarget(desc, typeWildCard, typeWildCard, ask)
    return st == noErr ? true : st == OSStatus(errAEEventNotPermitted) ? false : nil
  }
  /// Full Disk Access shows as being able to read the privacy database (no other way to ask macOS).
  static var fullDiskAccess: Bool { FileManager.default.isReadableFile(atPath: NSHomeDirectory() + "/Library/Application Support/com.apple.TCC/TCC.db") }
  /// Each permission Kingmaker uses: is it on here (nil = macOS doesn't say), and its System Settings page.
  static func permissionRows() -> [(String, String, Bool?, String)] {
    let mic = AVCaptureDevice.authorizationStatus(for: .audio)
    let contacts = CNContactStore.authorizationStatus(for: .contacts)
    let auto = automationTargets.compactMap { automationAllowed($0.1, ask: false) }
    return [
      ("Microphone", "hear you", mic == .authorized ? true : mic == .notDetermined ? nil : false, "Privacy_Microphone"),
      ("Accessibility", "click and type in apps", AXIsProcessTrusted(), "Privacy_Accessibility"),
      ("Screen Recording", "see the screen when asked", CGPreflightScreenCaptureAccess(), "Privacy_ScreenCapture"),
      ("Contacts", "find who to text", contacts == .authorized ? true : contacts == .notDetermined ? nil : false, "Privacy_Contacts"),
      ("Automation", "drive Messages, Chrome, FaceTime", auto.isEmpty ? nil : auto.allSatisfy { $0 }, "Privacy_Automation"),
      ("App Management", "update itself", nil, "Privacy_AppBundles"),
      ("Full Disk Access", "read your files when asked", fullDiskAccess, "Privacy_AllFiles"),
    ]
  }
  /// "Turn on" (the owner's click): the real macOS prompt for exactly that permission when macOS will still ask;
  /// otherwise (settings-only, or already denied, which macOS never re-asks) its exact System Settings page and a line
  /// saying what to switch on. The Access list refreshes itself when the answer changes.
  @objc fileprivate func openPermission(_ b: NSButton) {
    let pane = b.identifier?.rawValue ?? "Privacy"
    let d = KingmakerBar.d, askedKey = "km.asked.\(pane)", askedBefore = d.bool(forKey: askedKey)
    d.set(true, forKey: askedKey)
    let refresh = { [weak self] in DispatchQueue.main.async { self?.watchPermissions() } }
    func settings(_ what: String) {
      NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?\(pane)")!)
      append(who: "", "In System Settings → Privacy & Security → \(what), turn on Kingmaker. This list updates by itself.")
      refresh()
      // The bar normally floats above everything; drop it below System Settings so that window isn't hidden behind the
      // bar (confusing), and float again the next time the owner comes back to Kingmaker.
      if self.settingsLevelObserver == nil {
        let prior = self.panel.level
        self.panel.level = .normal
        self.settingsLevelObserver = NotificationCenter.default.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
          guard let self = self else { return }
          self.panel.level = prior
          if let o = self.settingsLevelObserver { NotificationCenter.default.removeObserver(o); self.settingsLevelObserver = nil }
        }
      }
    }
    switch pane {
    case "Privacy_Microphone":
      if AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined { AVCaptureDevice.requestAccess(for: .audio) { _ in refresh() } } else { settings("Microphone") }
    case "Privacy_Contacts":
      if CNContactStore.authorizationStatus(for: .contacts) == .notDetermined { CNContactStore().requestAccess(for: .contacts) { _, _ in refresh() } } else { settings("Contacts") }
    case "Privacy_Accessibility":
      // macOS's own "would like to control this computer" prompt, every time it isn't trusted.
      if AXIsProcessTrusted() { settings("Accessibility") } else {
        let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        _ = AXIsProcessTrustedWithOptions(opts); refresh()
      }
    case "Privacy_ScreenCapture":
      // macOS asks only once; after that it's the Settings page.
      if !CGPreflightScreenCaptureAccess() && !askedBefore { _ = CGRequestScreenCaptureAccess(); refresh() } else { settings("Screen & System Audio Recording") }
    case "Privacy_Automation":
      // One prompt per app: an app that isn't running is started hidden first (never brought forward), since macOS
      // can only ask about a running app.
      var pending = false
      for (name, id) in KingmakerBar.automationTargets where KingmakerBar.automationAllowed(id, ask: false) != true {
        guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: id) else { continue }
        pending = true
        let ask = { DispatchQueue.global().async { if KingmakerBar.automationAllowed(id, ask: true) == false { DispatchQueue.main.async { [weak self] in self?.append(who: "", "Automation for \(name) is off: System Settings → Privacy & Security → Automation → Kingmaker → \(name).") } }; refresh() } }
        if NSRunningApplication.runningApplications(withBundleIdentifier: id).isEmpty {
          let cfg = NSWorkspace.OpenConfiguration(); cfg.activates = false; cfg.hides = true
          NSWorkspace.shared.openApplication(at: url, configuration: cfg) { _, _ in DispatchQueue.global().asyncAfter(deadline: .now() + 1.5) { ask() } }
        } else { ask() }
      }
      if !pending { settings("Automation") }
    default:   // App Management and Full Disk Access are switched on in System Settings only.
      settings(pane == "Privacy_AllFiles" ? "Full Disk Access" : pane == "Privacy_AppBundles" ? "App Management" : "the list")
    }
  }
  /// After a "Turn on": check every 2 s for two minutes, and redraw the Access list the moment anything changes.
  private var permWatch: Timer?
  /// Arm the duress wipe: a SEPARATE duress password, entered hidden, sent to the engine (:duress arm … WIPE). Giving
  /// that password later (typed, from the phone, or spoken) exports a last CSV and then wipes all of Kingmaker. No undo.
  private func openDuressArm() {
    let alert = NSAlert()
    alert.messageText = "Arm the duress wipe"
    alert.informativeText = "Set a SEPARATE duress password (never your normal one). Entering it later — typed here, sent from your phone, or spoken — exports one last CSV to a cloud folder and then PERMANENTLY wipes everything of Kingmaker on this Mac. There is no undo."
    let field = NSSecureTextField(frame: NSRect(x: 0, y: 0, width: 240, height: 24))
    field.placeholderString = "duress password (10+ characters)"
    alert.accessoryView = field
    alert.addButton(withTitle: "Arm")
    alert.addButton(withTitle: "Cancel")
    NSApp.activate(ignoringOtherApps: true)
    guard alert.runModal() == .alertFirstButtonReturn else { return }
    let pass = field.stringValue
    guard pass.count >= 10 else { append(who: "", "Not armed: the duress password needs at least 10 characters."); return }
    onCommand(":duress arm \(pass) WIPE")
  }

  private func watchPermissions() {
    permWatch?.invalidate()
    var last = KingmakerBar.permissionRows().map { $0.2 }, ticks = 0
    permWatch = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] t in
      ticks += 1
      let now = KingmakerBar.permissionRows().map { $0.2 }
      if now != last { last = now; self?.onCommand("screen connectors") }
      if ticks >= 60 { t.invalidate() }
    }
  }

  /// Settings (the gear, bottom left): everything a program needs to dock: API keys and tokens, MCP servers and other
  /// connectors, and what Kingmaker may reach on this Mac. Drawn as the Connectors & keys screen, with Access under it.
  @objc private func openSettings(_ sender: NSButton) { customizePanel?.orderOut(nil); onCommand("screen connectors") }
  /// Interaction (Customize, top left): how Kingmaker looks, sounds and talks: colour, size, voice, personality, where it
  /// opens. Each setting lives once: the model is the picker, "never speak" is Mute, keys and access are the gear's.
  static let personalities: [(String, String, String)] = [
    ("Plain", "plain", ""), ("Warm", "warm", "Warm and encouraging, in plain words."), ("Direct", "direct", "Direct and brief: no filler, straight to the point."),
    ("Playful", "playful", "Playful and witty, and still useful."), ("Formal", "formal", "Formal and polished, like a professional assistant."),
    ("Teacher", "teacher", "Patient and clear; explains the why in simple steps.")]
  /// What the personality setting asks for, in words the engine puts ahead of the turn ("" for Plain).
  var personality: String {
    let own = (KingmakerBar.d.string(forKey: "km.personalityText") ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    if !own.isEmpty { return String(own.prefix(300)) }
    let id = KingmakerBar.d.string(forKey: "km.personality") ?? "plain"
    return KingmakerBar.personalities.first { $0.1 == id }?.2 ?? ""
  }
  @objc private func personalityTextChanged(_ f: NSTextField) { KingmakerBar.d.set(f.stringValue, forKey: "km.personalityText") }
  private func macSettingsView() -> NSView {
    let grid = NSGridView(numberOfColumns: 2, rows: 0)
    grid.rowSpacing = 10; grid.columnSpacing = 14
    func row(_ label: String, _ key: String, _ options: [(String, String)], _ fallback: String) {
      let l = NSTextField(labelWithString: label); l.font = .systemFont(ofSize: 12, weight: .medium); l.textColor = .secondaryLabelColor
      let pop = NSPopUpButton(frame: .zero, pullsDown: false); pop.font = .systemFont(ofSize: 12)
      for (title, value) in options { pop.addItem(withTitle: title); pop.lastItem?.representedObject = value }
      let cur = KingmakerBar.d.string(forKey: key) ?? fallback
      if let i = options.firstIndex(where: { $0.1 == cur }) { pop.selectItem(at: i) }
      pop.identifier = NSUserInterfaceItemIdentifier(key); pop.target = self; pop.action = #selector(settingChanged(_:))
      grid.addRow(with: [l, pop])
    }
    row("Look", "km.look", [("Black", "black"), ("Dark glass", "glass"), ("Match the Mac", "system")], "black")
    row("Kingmaker's replies", "km.replyColor", [("Green", "green"), ("White", "white"), ("Blue", "blue"), ("Amber", "amber")], "green")
    row("Text size", "km.textSize", [("Small", "13"), ("Medium", "14"), ("Large", "16")], "14")
    row("Opens at", "km.position", [("Top", "top"), ("Middle", "middle"), ("Bottom", "bottom")], "top")
    row("Shortcut", "km.hotkey", [("⌥ Space", "opt-space"), ("⌃ Space", "ctrl-space"), ("⌘ ⇧ K", "cmd-shift-k"), ("None", "none")], "opt-space")
    row("Links open in", "km.browser", [("Chrome", "chrome"), ("Safari", "safari"), ("Default browser", "default")], "chrome")
    row("Speaks answers", "km.speak", [("The start (rest on screen)", "short"), ("In full", "full")], "short")
    row("Search this Mac as I type", "km.search", [("On", "on"), ("Off", "off")], (KingmakerBar.d.object(forKey: "km.search") as? Bool ?? true) ? "on" : "off")
    row("Off button", "km.offAction", [("Ask each time", "ask"), ("Auto mode", "auto"), ("Close out", "close")], "ask")
    row("Hold to talk", "km.ptt", [("fn key", "fn"), ("Off", "off")], "fn")
    row("Voice", "km.voiceMode", [("Default for this Mac (text only on 8 GB)", "auto"), ("Voice", "voice"), ("Text only", "text")], "auto")
    row("Personality", "km.personality", KingmakerBar.personalities.map { ($0.0, $0.1) }, "plain")
    let title = NSTextField(labelWithString: UI.t("How Kingmaker looks, sounds and talks with you")); title.font = .systemFont(ofSize: 13, weight: .semibold)
    let note = NSTextField(wrappingLabelWithString: "The model it writes with is the picker at the bottom right; Mute there silences it. Keys, APIs, MCPs and access are under the gear, bottom left.")
    note.font = .systemFont(ofSize: 11.5); note.textColor = .secondaryLabelColor; note.preferredMaxLayoutWidth = 540
    let own = NSTextField(); own.placeholderString = "Or describe its personality in your words (overrides the choice above)"
    own.stringValue = KingmakerBar.d.string(forKey: "km.personalityText") ?? ""; own.font = .systemFont(ofSize: 12)
    own.target = self; own.action = #selector(personalityTextChanged(_:)); own.widthAnchor.constraint(equalToConstant: 520).isActive = true
    let stack = NSStackView(views: [title, note, grid, own]); stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 12
    stack.edgeInsets = NSEdgeInsets(top: 16, left: 16, bottom: 16, right: 16)
    return stack
  }
  // ── THE CONNECTORS & KEYS SCREEN, written into the bar like the CRM's Connections page: each provider with its status,
  //    "Get key ↗" (its own key page, in the Mac's browser) and "Add key" (the bar's hidden key field → the vault, once);
  //    then the connected tools with REA's verdict. Links inside the text: kmbar://key/<id>, kmbar://add, kmbar://remove/<id>.
  @objc private func showConnectorsScreen() { customizePanel?.orderOut(nil); onCommand("screen connectors") }
  func showScreen(_ sc: [String: Any]) {
    guard (sc["kind"] as? String) == "connectors" else { return }
    if !panel.isVisible { show() }
    if sheetShown != nil { closeSheet() }   // the screen is written into the conversation: show the conversation
    let t = NSMutableAttributedString(), base = NSFont.systemFont(ofSize: textSize)
    let head = NSFont(name: "BodoniSvtyTwoITCTT-Bold", size: textSize + 4) ?? .boldSystemFont(ofSize: textSize + 4)
    let mono = NSFont.monospacedSystemFont(ofSize: textSize - 3, weight: .medium)
    let dim = NSColor.white.withAlphaComponent(0.5), body = NSColor.white.withAlphaComponent(0.88), on = NSColor(srgbRed: 0.40, green: 0.82, blue: 0.48, alpha: 1)
    let gold = NSColor(srgbRed: 0.91, green: 0.73, blue: 0.27, alpha: 1)
    func add(_ s: String, _ a: [NSAttributedString.Key: Any]) { t.append(NSAttributedString(string: s, attributes: a)) }
    func link(_ s: String, _ url: String) { if let u = URL(string: url) { add(s, [.font: base, .link: u, .foregroundColor: gold]) } }
    if hasLog { add("\n\n", [.font: base]) }
    add("CREDENTIALS\n", [.font: mono, .foregroundColor: dim, .kern: 2])
    add("Connectors & keys\n", [.font: head, .foregroundColor: NSColor.white])
    add((sc["engine"] as? Bool) == false ? "Kingmaker’s engine isn’t answering yet; open this again in a moment.\n" : "Copy a key from its page and paste it into the box Kingmaker opens. It goes only into the vault, once.\n", [.font: NSFont.systemFont(ofSize: textSize - 2), .foregroundColor: dim])
    for k in (sc["keys"] as? [[String: Any]]) ?? [] {
      let id = (k["id"] as? String) ?? "", label = (k["label"] as? String) ?? id, stored = (k["stored"] as? Bool) == true
      add("\n● ", [.font: base, .foregroundColor: stored ? on : dim])
      add(label, [.font: NSFont.systemFont(ofSize: textSize, weight: .semibold), .foregroundColor: NSColor.white])
      add(stored ? "   SET" : (k["free"] as? String).map { "   free: \($0)" } ?? "", [.font: mono, .foregroundColor: stored ? on : dim])
      add("\n   ", [.font: base])
      if let l = k["link"] as? String, l.hasPrefix("https://") { link("Get key ↗", l); add("   ·   ", [.font: base, .foregroundColor: dim]) }
      link(stored ? "Replace key" : "Add key", "kmbar://key/\(id)")
    }
    add("\n\nTOOLS\n", [.font: mono, .foregroundColor: dim, .kern: 2])
    let tools = (sc["connectors"] as? [[String: Any]]) ?? []
    if tools.isEmpty { add("Nothing connected yet. ", [.font: base, .foregroundColor: body]) }
    for c in tools {
      let v = (c["verdict"] as? String) ?? "", id = (c["id"] as? String) ?? ""
      add("● ", [.font: base, .foregroundColor: v == "clean" ? on : v == "sandboxed" ? gold : NSColor.systemOrange])
      add("/\((c["name"] as? String) ?? "?")", [.font: NSFont.systemFont(ofSize: textSize, weight: .semibold), .foregroundColor: NSColor.white])
      add("  \((c["kind"] as? String) ?? "") · \(v)   ", [.font: mono, .foregroundColor: dim])
      link("Remove", "kmbar://remove/\(id)"); add("\n", [.font: base])
    }
    link("Add a connector (CLI, CLI Hub, MCP, skill, repo) →", "kmbar://add")
    add("\n", [.font: base]); link("Browse extensions: Blender, Cloudflare, GitHub, social media →", "kmbar://ext/list")
    // ACCESS: what macOS lets Kingmaker reach here, each with its System Settings page, and the owner-only CRM skills.
    add("\n\nACCESS ON THIS MAC\n", [.font: mono, .foregroundColor: dim, .kern: 2])
    for (name, why, state, pane) in KingmakerBar.permissionRows() {
      add("● ", [.font: base, .foregroundColor: state == true ? on : state == false ? NSColor.systemOrange : dim])
      add(name, [.font: NSFont.systemFont(ofSize: textSize, weight: .semibold), .foregroundColor: NSColor.white])
      add("  \(why)   ", [.font: NSFont.systemFont(ofSize: textSize - 2), .foregroundColor: dim])
      link(state == true ? "Open" : "Turn on", "kmbar://perm/\(pane)"); add("\n", [.font: base])
    }
    add("● ", [.font: base, .foregroundColor: sharingOn ? on : dim])
    add("Share what Kingmaker learns", [.font: NSFont.systemFont(ofSize: textSize, weight: .semibold), .foregroundColor: NSColor.white])
    add("  never your words or files   ", [.font: NSFont.systemFont(ofSize: textSize - 2), .foregroundColor: dim])
    link(sharingOn ? "On, turn off" : "Off, turn on", "kmbar://share/toggle"); add("   ·   ", [.font: base, .foregroundColor: dim]); link("What was sent", "kmbar://share/log"); add("\n", [.font: base])
    add("● ", [.font: base, .foregroundColor: NSColor.systemRed])
    add("Duress wipe", [.font: NSFont.systemFont(ofSize: textSize, weight: .semibold), .foregroundColor: NSColor.white])
    add("  beta · a duress password wipes all of Kingmaker on this Mac, no undo   ", [.font: NSFont.systemFont(ofSize: textSize - 2), .foregroundColor: dim])
    link("Arm…", "kmbar://duress/arm"); add("   ·   ", [.font: base, .foregroundColor: dim]); link("Disarm", "kmbar://duress/off"); add("\n", [.font: base])
    add("\nCRM skills in / (owner only): ", [.font: base, .foregroundColor: body])
    link(crmSkillsOn ? "On, turn off" : "Off, turn on", "kmbar://crmskills/toggle")
    let para = NSMutableParagraphStyle(); para.lineSpacing = 3
    t.addAttribute(.paragraphStyle, value: para, range: NSRange(location: 0, length: t.length))
    log.textStorage?.append(t); hasLog = true
    layout(); log.scrollToEndOfDocument(nil)
  }
  static let gold = NSColor(srgbRed: 0.91, green: 0.73, blue: 0.27, alpha: 1)
  /// The answer's sources and what Kingmaker made (@@ghost sources): listed under it as gold links, one per line, and
  /// kept with the chat. Nothing is opened until one is clicked.
  // ── A PICTURE KINGMAKER MADE (@@ghost {"image": {"path": …}}: the image lane, lib/image-lane.mjs) is shown right here in
  // the chat, scaled to fit, instead of opening Preview behind the bar (the owner, 2026-10-16: "images are still appearing
  // behind the chat window instead of inside it"). A click on it opens the file. Kept with the chat like its sources.
  func showImage(_ path: String) {
    guard appendImage(path) else { return }
    record("Image", path)
    remember("Image", path)
  }
  @discardableResult private func appendImage(_ path: String) -> Bool {
    guard let pic = inlineImage(path: path, maxWidth: max(160, min(560, contentWidth - 48))) else { return false }
    let gap = NSMutableParagraphStyle(); gap.paragraphSpacingBefore = 8
    let s = NSMutableAttributedString()
    if hasLog { s.append(NSAttributedString(string: "\n", attributes: [.paragraphStyle: gap])) }
    s.append(pic)
    log.textStorage?.append(s); hasLog = true
    layout(); log.scrollToEndOfDocument(nil)
    return true
  }
  func showSources(_ list: [[String: Any]]) {
    let items: [(String, String)] = list.prefix(8).compactMap { s in
      guard let u = s["url"] as? String, let t = s["title"] as? String, KingmakerBar.barLink(u) != nil else { return nil }
      return (t.replacingOccurrences(of: "\t", with: " ").replacingOccurrences(of: "\n", with: " "), u)
    }
    guard !items.isEmpty else { return }
    record("Sources", items.map { "\($0.0) — \($0.1)" }.joined(separator: " · "))
    remember("Sources", items.map { "\($0.0)\t\($0.1)" }.joined(separator: "\n"))
    appendSources(items)
  }
  private func appendSources(_ items: [(String, String)]) {
    let head = NSMutableParagraphStyle(); head.paragraphSpacingBefore = 8
    let line = NSMutableParagraphStyle(); line.paragraphSpacingBefore = 2
    let s = NSMutableAttributedString()
    if hasLog { s.append(NSAttributedString(string: "\n", attributes: [.paragraphStyle: head])) }
    s.append(NSAttributedString(string: "Sources", attributes: [.font: NSFont.systemFont(ofSize: textSize - 2, weight: .semibold), .foregroundColor: NSColor.white.withAlphaComponent(0.45), .paragraphStyle: head]))
    for (title, url) in items {
      guard let link = KingmakerBar.barLink(url) else { continue }
      s.append(NSAttributedString(string: "\n", attributes: [.paragraphStyle: line]))
      s.append(NSAttributedString(string: "↗ \(title)", attributes: [.font: NSFont.systemFont(ofSize: textSize - 1), .link: link, .foregroundColor: KingmakerBar.gold, .toolTip: url, .paragraphStyle: line]))
    }
    log.textStorage?.append(s); hasLog = true
    layout(); log.scrollToEndOfDocument(nil)
  }
  /// A web page → kmbar://open?u=… (the engine opens it in the visible Chrome); a file Kingmaker made → its file URL.
  static func barLink(_ s: String) -> URL? {
    guard let u = URL(string: s), let scheme = u.scheme?.lowercased() else { return nil }
    if scheme == "file" { return u }
    guard scheme == "http" || scheme == "https" else { return nil }
    var c = URLComponents(); c.scheme = "kmbar"; c.host = "open"; c.queryItems = [URLQueryItem(name: "u", value: s)]
    return c.url
  }
  /// A link in the bar's text: the screen's own actions; web links open in the Mac's browser.
  func textView(_ textView: NSTextView, clickedOnLink link: Any, at charIndex: Int) -> Bool {
    guard let u = (link as? URL) ?? (link as? String).flatMap(URL.init(string:)) else { return false }
    if u.scheme == "kmbar" {
      let arg = u.pathComponents.dropFirst().first ?? ""
      switch u.host {
      case "key": onCommand("key-start \(arg)")
      case "remove": onCommand("connector-remove \(arg)"); DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in self?.onCommand("screen connectors") }
      case "add": openConnectors()
      case "perm": let b = NSButton(); b.identifier = NSUserInterfaceItemIdentifier(arg); openPermission(b)
      case "ext":
        let parts = Array(u.pathComponents.dropFirst()), what = parts.first ?? "list", id = parts.count > 1 ? parts[1] : ""
        switch what {
        case "list": extPage = nil; onCommand("ext-list")
        case "detail": extPage = id; renderExtensions()
        case "install": extProgress[id] = (0, "Starting…"); onCommand("ext-install \(id)"); renderExtensions()
        case "account": askExtAccount(id)
        case "open": if let v = URLComponents(url: u, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "u" })?.value, let url = URL(string: v), url.scheme == "https" { NSWorkspace.shared.open(url) }
        default: break
        }
      case "share":
        if arg == "log" { onCommand("share log") } else { sharingOn.toggle(); onCommand(sharingOn ? "share yes" : "share no") }
      case "duress":
        if arg == "off" { onCommand(":duress off") } else { openDuressArm() }
      case "crmskills":
        let on = !crmSkillsOn; KingmakerBar.d.set(on ? "on" : "off", forKey: "km.crmSkills")
        if on { crmSkillsAsked = true; askCrmSkills(force: true) } else { crmSkills = []; crmSkillsAt = nil }
        append(who: "", on ? "CRM skills are on: type / to see them." : "CRM skills are off.")
      case "open":   // a source or a link in an answer: the engine opens it in the visible Chrome, else the default browser
        if let v = URLComponents(url: u, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "u" })?.value, let d = v.data(using: .utf8) {
          onCommand("open-url \(d.base64EncodedString())")
        }
      default: break
      }
      return true
    }
    if u.isFileURL { NSWorkspace.shared.open(u); return true }   // something Kingmaker made: its own app
    if let b = browserBundle, let app = NSWorkspace.shared.urlForApplication(withBundleIdentifier: b) {
      NSWorkspace.shared.open([u], withApplicationAt: app, configuration: NSWorkspace.OpenConfiguration()); return true
    }
    NSWorkspace.shared.open(u); return true
  }

  // ── the Connectors page: everything connected (with REA's verdict) and Add connector ──
  private static let connKinds: [(String, String, String)] = [
    ("cli", "Any CLI on this Mac", "The program: a name (ffmpeg) or a path (~/bin/tool)"),
    ("hub", "Kingmaker CLI Hub", "A CLI from Ronin's catalog (pick it below)"),
    ("mcp", "MCP server", "A command (npx my-mcp) or an address (https://…/mcp)"),
    ("skill", "Skill folder", "The folder with its SKILL.md"),
    ("repo", "Repo folder", "The folder, then its program below (or a SKILL.md in it)"),
  ]
  /// The Kingmaker CLI Hub's catalog (Ronin's copy, shipped beside lib/): every CLI it can install, by name.
  private static func hubCatalog() -> [(String, String)] {
    let base = Bundle.main.resourceURL?.appendingPathComponent("sol-ghost/vendor/kingmaker-cli-hub/catalog")
    var out: [(String, String)] = []
    for f in ["registry.json", "public_registry.json"] {
      guard let u = base?.appendingPathComponent(f), let d = try? Data(contentsOf: u), let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { continue }
      for c in (j["clis"] as? [[String: Any]]) ?? [] { if let n = c["name"] as? String { out.append((n, (c["description"] as? String) ?? "")) } }
    }
    return out.sorted { $0.0 < $1.0 }
  }
  @objc private func openConnectors() {
    customizePanel?.orderOut(nil)
    if let p = connectorsPanel {
      drawConnectors()
      if let v = connectorsView, barIsLarge { showSheet("connectors", v); return }
      if let v = connectorsView, p.contentView !== v { p.contentView = v }
      NSApp.activate(ignoringOtherApps: true); p.makeKeyAndOrderFront(nil); return
    }
    let p = KeyPanel(contentRect: NSRect(x: 0, y: 0, width: 560, height: 520), styleMask: [.titled, .closable, .resizable, .utilityWindow], backing: .buffered, defer: false)
    p.title = "Connectors"; p.appearance = NSAppearance(named: .darkAqua); p.level = .floating; p.isReleasedWhenClosed = false; p.hidesOnDeactivate = false
    p.minSize = NSSize(width: 460, height: 400)
    let head = NSTextField(wrappingLabelWithString: "Connect anything: any CLI, a CLI from the Kingmaker CLI Hub (Ronin's copy of CLI-Anything), an MCP server, a skill or a repo. Kingmaker's local models use it from the bar (/its name). REA reads its code first: clean runs as itself; code that phones home, reads keys or installs itself runs sandboxed with those parts blocked; code that downloads-and-runs or hides what it runs is rejected.")
    head.font = .systemFont(ofSize: 12); head.textColor = .secondaryLabelColor
    connKind.removeAllItems(); for (v, t, _) in KingmakerBar.connKinds { connKind.addItem(withTitle: t); connKind.lastItem?.representedObject = v }
    connKind.target = self; connKind.action = #selector(connKindChanged)
    connHub.removeAllItems(); for (n, d) in KingmakerBar.hubCatalog() { connHub.addItem(withTitle: d.isEmpty ? n : "\(n) — \(String(d.prefix(60)))"); connHub.lastItem?.representedObject = n }
    connName.placeholderString = "Name (optional)"
    let choose = NSButton(title: "Choose…", target: self, action: #selector(chooseConnectorPath)); choose.bezelStyle = .rounded
    let add = NSButton(title: "Add", target: self, action: #selector(addConnectorTapped)); add.bezelStyle = .rounded; add.keyEquivalent = "\r"
    let targetRow = NSStackView(views: [connTarget, choose]); targetRow.spacing = 8
    connTarget.setContentHuggingPriority(.defaultLow, for: .horizontal)
    let form = NSGridView(views: [[NSTextField(labelWithString: "Kind"), connKind], [NSTextField(labelWithString: "Hub CLI"), connHub], [NSTextField(labelWithString: "What"), targetRow], [NSTextField(labelWithString: "Name"), connName]])
    form.rowSpacing = 8; form.columnSpacing = 10
    connStatus.font = .systemFont(ofSize: 12); connStatus.textColor = .secondaryLabelColor
    let listTitle = NSTextField(labelWithString: "Connected"); listTitle.font = .systemFont(ofSize: 13, weight: .semibold)
    connList.orientation = .vertical; connList.alignment = .leading; connList.spacing = 6
    let listScroll = NSScrollView(); listScroll.hasVerticalScroller = true; listScroll.drawsBackground = false; listScroll.borderType = .noBorder
    let doc = FlippedView(); doc.addSubview(connList); listScroll.documentView = doc
    let stack = NSStackView(views: [head, form, add, connStatus, listTitle, listScroll]); stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 12
    stack.edgeInsets = NSEdgeInsets(top: 16, left: 16, bottom: 16, right: 16)
    for v in [head, form, listScroll] as [NSView] { v.translatesAutoresizingMaskIntoConstraints = false; v.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -32).isActive = true }
    listScroll.heightAnchor.constraint(greaterThanOrEqualToConstant: 160).isActive = true
    connTarget.widthAnchor.constraint(greaterThanOrEqualToConstant: 300).isActive = true
    p.contentView = stack
    connectorsPanel = p; connectorsView = stack
    connKindChanged(); drawConnectors()
    onCommand("connectors")
    if barIsLarge { showSheet("connectors", stack); return }
    p.center(); NSApp.activate(ignoringOtherApps: true); p.makeKeyAndOrderFront(nil)
  }
  @objc private func connKindChanged() {
    let k = (connKind.selectedItem?.representedObject as? String) ?? "cli"
    connTarget.placeholderString = KingmakerBar.connKinds.first { $0.0 == k }?.2
    connHub.isEnabled = k == "hub"; connTarget.isEnabled = k != "hub"
  }
  @objc private func chooseConnectorPath() {
    let k = (connKind.selectedItem?.representedObject as? String) ?? "cli"
    let o = NSOpenPanel(); o.canChooseDirectories = k == "skill" || k == "repo"; o.canChooseFiles = k == "cli" || k == "mcp"; o.allowsMultipleSelection = false
    NSApp.activate(ignoringOtherApps: true)
    if o.runModal() == .OK, let u = o.url { connTarget.stringValue = u.path }
  }
  @objc private func addConnectorTapped() {
    let k = (connKind.selectedItem?.representedObject as? String) ?? "cli", t = connTarget.stringValue.trimmingCharacters(in: .whitespaces)
    var spec: [String: Any] = ["kind": k]
    if !connName.stringValue.isEmpty { spec["name"] = connName.stringValue }
    switch k {
    case "hub": spec["hub"] = connHub.selectedItem?.representedObject as? String ?? ""
    case "skill": spec["path"] = t
    case "repo": let parts = t.components(separatedBy: " "); spec["path"] = parts[0]; if parts.count > 1 { spec["command"] = parts.dropFirst().joined(separator: " ") }
    case "mcp":
      if t.hasPrefix("http") { spec["url"] = t } else { let parts = t.split(separator: " ").map(String.init); spec["command"] = parts.first ?? ""; spec["args"] = Array(parts.dropFirst()) }
    default: let parts = t.split(separator: " ").map(String.init); spec["command"] = parts.first ?? ""; spec["args"] = Array(parts.dropFirst())
    }
    guard k == "hub" || !t.isEmpty, let json = try? JSONSerialization.data(withJSONObject: spec) else { NSSound.beep(); return }
    connStatus.stringValue = k == "hub" ? "Installing it from the Kingmaker CLI Hub, then REA reads it…" : "REA is reading its code…"
    onCommand("connector-add \(json.base64EncodedString())")
  }
  @objc private func removeConnectorTapped(_ sender: NSButton) { if let id = sender.identifier?.rawValue { onCommand("connector-remove \(id)") } }
  /// Kingmaker's list of connectors (@@ghost connectors), and what came of an Add (connectorResult).
  /// Ask Kingmaker for the CRM's skills (@@ghost crmSkills comes back): only while the owner-only setting is on, and at
  /// most every five minutes unless just turned on.
  private func askCrmSkills(force: Bool = false) {
    guard crmSkillsOn, force || crmSkillsAt.map({ Date().timeIntervalSince($0) > 300 }) ?? true else { return }
    crmSkillsAt = Date(); onCommand("crm-skills")
  }
  /// The CRM's skills (@@ghost crmSkills): each a /name pick with what its gate means, or why there are none.
  func setCrmSkills(_ list: [[String: Any]], from crm: String?, problem: String?) {
    let gateWords = ["read": "reads only", "auto": "runs on your word", "confirm": "asks you first"]
    crmSkills = list.compactMap { s in
      guard let n = s["name"] as? String else { return nil }
      let gate = gateWords[(s["gate"] as? String) ?? ""] ?? "asks you first"
      let desc = (s["description"] as? String).flatMap { $0.isEmpty ? nil : " · \($0)" } ?? ""
      return Pick(kind: "crmskill", title: "/\(n)", detail: "CRM skill · \(gate)\(desc)", value: n)
    }
    if crmSkillsAsked {
      crmSkillsAsked = false
      append(who: "", problem ?? "\(crmSkills.count) CRM skill\(crmSkills.count == 1 ? "" : "s")\(crm.map { " from \($0)" } ?? "") \(crmSkills.count == 1 ? "is" : "are") in the / list. Type / and a name.")
    }
  }
  func setConnectors(_ list: [[String: Any]], result: [String: Any]?) {
    connectors = list; loadPrograms(); drawConnectors(); if sideTab >= 2 { drawChats() }
    if let r = result {
      let ok = (r["ok"] as? Bool) == true
      connStatus.stringValue = ok ? "Connected \(r["name"] as? String ?? ""): \((r["summary"] as? String) ?? "")" : "Not connected: \((r["error"] as? String) ?? (r["summary"] as? String) ?? "it failed")"
      connStatus.textColor = ok ? NSColor(srgbRed: 0.29, green: 0.87, blue: 0.5, alpha: 1) : .systemOrange
      if ok { connTarget.stringValue = ""; connName.stringValue = "" }
    }
  }
  private func drawConnectors() {
    connList.arrangedSubviews.forEach { $0.removeFromSuperview() }
    if connectors.isEmpty { let l = NSTextField(labelWithString: "Nothing connected yet."); l.textColor = .tertiaryLabelColor; connList.addArrangedSubview(l) }
    for c in connectors {
      let name = (c["name"] as? String) ?? "?", kind = (c["kind"] as? String) ?? "", verdict = (c["verdict"] as? String) ?? ""
      let badge = NSTextField(labelWithString: verdict == "clean" ? "● clean" : verdict == "sandboxed" ? "◐ sandboxed" : "○ rejected")
      badge.textColor = verdict == "clean" ? .systemGreen : verdict == "sandboxed" ? .systemYellow : .systemOrange; badge.font = .systemFont(ofSize: 11, weight: .medium)
      let t = NSTextField(labelWithString: "\(name)  ·  \(kind)\((c["source"] as? String).map { "  ·  \($0)" } ?? "")"); t.font = .systemFont(ofSize: 12.5, weight: .medium)
      let blocked = (c["blocked"] as? [String]) ?? []
      let why = NSTextField(wrappingLabelWithString: verdict == "sandboxed" && !blocked.isEmpty ? "Blocked: \(blocked.joined(separator: "; "))." : ((c["summary"] as? String) ?? ""))
      why.font = .systemFont(ofSize: 11); why.textColor = .secondaryLabelColor; why.preferredMaxLayoutWidth = 440
      let x = NSButton(title: "Remove", target: self, action: #selector(removeConnectorTapped(_:))); x.bezelStyle = .inline; x.font = .systemFont(ofSize: 11)
      x.identifier = NSUserInterfaceItemIdentifier((c["id"] as? String) ?? name)
      let top = NSStackView(views: [badge, t, x]); top.spacing = 8
      let cell = NSStackView(views: [top, why]); cell.orientation = .vertical; cell.alignment = .leading; cell.spacing = 2
      connList.addArrangedSubview(cell)
    }
    connList.layoutSubtreeIfNeeded()
    let size = connList.fittingSize
    connList.frame = NSRect(x: 0, y: 0, width: max(460, size.width), height: size.height)
    connList.superview?.frame = connList.frame
  }
  @objc private func settingChanged(_ sender: NSPopUpButton) {
    guard let key = sender.identifier?.rawValue, let v = sender.selectedItem?.representedObject as? String else { return }
    switch key {
    case "km.textSize": KingmakerBar.d.set(Double(v) ?? 14, forKey: key)
    case "km.search": KingmakerBar.d.set(v == "on", forKey: key)
    default: KingmakerBar.d.set(v, forKey: key)
    }
    if key == "km.hotkey" { registerKingmakerHotKey(v) }
    if key == "km.voiceMode" {
      let now = v == "text" || (v == "auto" && ProcessInfo.processInfo.physicalMemory <= 10 * 1_073_741_824)
      append(who: "", now == textOnly ? (textOnly ? "Kingmaker is already text only." : "Kingmaker already has its voice.")
        : now ? "Text only from the next start: no listening and no spoken answers, so the memory goes to the model. Quit Kingmaker and open it again."
        : "Voice from the next start (listening, fn to talk, spoken answers). Quit Kingmaker and open it again.")
    }
    if key == "km.crmSkills" { if v == "on" { crmSkillsAsked = true; askCrmSkills(force: true) } else { crmSkills = []; crmSkillsAt = nil } }
    applyLook(); refreshFooter(); layout()
  }

  @objc private func toggleMute() { onCommand(muted ? "voice-out on" : "voice-out off") }
  @objc private func togglePower() { if on { turnOff() } else { onCommand(muted ? "power on muted" : "power on") } }
  /// Off asks (unless Customize says what Off does): Auto mode keeps Kingmaker as the CRM's battery in the background;
  /// Close out quits it completely.
  private func turnOff() {
    var choice = offAction
    if choice == "ask" {
      let a = NSAlert(); a.alertStyle = .informational
      a.messageText = "Turn Kingmaker off on this Mac?"
      a.informativeText = "Auto mode — Kingmaker stays the CRM's battery: it keeps routing work to the agents and running their jobs in the background, so basic upkeep happens without anyone here. Nothing on your screen, no voice, no mic.\n\nClose out — Kingmaker quits completely. The CRM's cloud brain covers until you open it again."
      a.addButton(withTitle: "Auto mode"); a.addButton(withTitle: "Close out"); a.addButton(withTitle: "Cancel")
      a.window.appearance = NSAppearance(named: .darkAqua)
      NSApp.activate(ignoringOtherApps: true)
      switch a.runModal() { case .alertFirstButtonReturn: choice = "auto"; case .alertSecondButtonReturn: choice = "close"; default: return }
    }
    if choice == "close" { hide(); onQuit() } else { onCommand("power off") }
  }
  @objc private func sendTapped() {
    let mods = NSApp.currentEvent?.modifierFlags ?? []
    send(queue: mods.contains(.command) || mods.contains(.option))
    panel.makeFirstResponder(field); refreshSend()
  }
  /// The ↵ button is bright when there's something to send, dim (and inert) while the box is empty.
  private func refreshSend() {
    let has = !field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    sendButton.isEnabled = has
    sendButton.contentTintColor = has ? NSColor.white.withAlphaComponent(0.92) : NSColor.white.withAlphaComponent(0.28)
  }
  @objc private func stopTapped() { onCommand("stop"); busy = false }
  /// The mic dictates into the box (macOS dictation, like a phone keyboard): voice to type. ⌥-click talks to Kingmaker
  /// directly (its own ears; what it heard shows here).
  @objc private func micTapped() {
    if NSApp.currentEvent?.modifierFlags.contains(.option) == true {
      if !on { append(who: "", "Kingmaker is off. Type /on first."); return }
      onWake(); return
    }
    panel.makeFirstResponder(field)
    if let editor = field.currentEditor() { NSApp.sendAction(Selector(("startDictation:")), to: editor, from: self) }
  }
  /// THE MODEL PIN: Auto (nil, the default) or the local model pinned for writing (km.modelPin).
  private var modelPin: String? { KingmakerBar.d.string(forKey: "km.modelPin").flatMap { $0.isEmpty ? nil : $0 } }
  /// Choosing a local model pins it; choosing Auto unpins.
  @objc private func modelChanged() {
    let v = modelPopup.selectedItem?.representedObject as? String
    if let v, v.hasPrefix("pull:") { pullModel(String(v.dropFirst(5))); return }
    if let v, v != "auto" { KingmakerBar.d.set(v, forKey: "km.modelPin") } else { KingmakerBar.d.removeObject(forKey: "km.modelPin") }
    loadModels()
  }
  @objc private func plusMenu(_ sender: NSButton) {
    let m = NSMenu()
    let a = NSMenuItem(title: "Choose folder…", action: #selector(chooseFolder), keyEquivalent: ""); a.target = self; a.image = NSImage(systemSymbolName: "folder", accessibilityDescription: nil); m.addItem(a)
    let b = NSMenuItem(title: "Attach files…", action: #selector(attachFile), keyEquivalent: ""); b.target = self; b.image = NSImage(systemSymbolName: "paperclip", accessibilityDescription: nil); m.addItem(b)
    if folder != nil { let c = NSMenuItem(title: "No folder", action: #selector(clearFolder), keyEquivalent: ""); c.target = self; m.addItem(c) }
    m.popUp(positioning: nil, at: NSPoint(x: 0, y: sender.bounds.height + 4), in: sender)
  }
  @objc private func chooseFolder() {
    let o = NSOpenPanel(); o.canChooseDirectories = true; o.canChooseFiles = false; o.allowsMultipleSelection = false; o.prompt = "Use this folder"
    o.message = "The folder Kingmaker works in."
    o.level = .floating + 1
    if o.runModal() == .OK, let u = o.url { folder = u; UserDefaults.standard.set(u.path, forKey: "km.folder"); refreshFooter() }
    show()
  }
  @objc private func clearFolder() { folder = nil; UserDefaults.standard.removeObject(forKey: "km.folder"); refreshFooter() }
  @objc private func attachFile() {
    let o = NSOpenPanel(); o.canChooseFiles = true; o.allowsMultipleSelection = true; o.level = .floating + 1
    if o.runModal() == .OK { field.stringValue += (field.stringValue.isEmpty ? "" : " ") + o.urls.map { $0.path }.joined(separator: " ") + " " }
    show()
  }

  /// The models: Auto (Kingmaker picks: the governed brain, which acts, and its fast lanes), then the local models installed
  /// in Ollama (named by family, abliterated marked), each with a pin (the pinned one writes), then the catalog models that
  /// fit this Mac and aren't installed yet (lib/models.mjs) — choosing one asks, then downloads it from Ollama with its
  /// progress here. The picker shows "Auto" or the pinned model's name.
  // The strongest uncensored (Heretic-abliterated) models that run on a Mac, best first: Kingmaker's picks
  // (catalog/kingmaker-picks.json, chosen 2026-10-15), pulled by Ollama straight from Hugging Face (hf.co/owner/repo:quant,
  // each tag checked against Hugging Face's manifest). minGb: the smallest Mac it runs on beside Kingmaker; "tight" ones
  // fill a 24 GB Mac's GPU share, so they run a little slower there. The older builds stay for smaller Macs.
  private static let catalog: [(tag: String, name: String, gb: Double, minGb: Int, abl: Bool)] = [
    ("hf.co/0bserverx/Qwen3.8-27B-Heretic-Abliterated-Uncensored-GGUF:RVN-Q4_K_M", "Qwen3.8 27B Heretic (sees images)", 17.2, 24, true),
    ("hf.co/mradermacher/Qwen3.6-27B-heretic-i1-GGUF:i1-Q4_K_M", "Qwen3.6 27B Heretic", 16.5, 24, true),
    ("hf.co/mradermacher/gemma-4-31B-it-heretic-i1-GGUF:i1-Q4_K_M", "Gemma 4 31B Heretic (sees images, tight)", 18.7, 24, true),
    ("hf.co/mradermacher/Qwen3-Coder-30B-A3B-Instruct-Heretic-i1-GGUF:i1-Q4_K_M", "Qwen3 Coder 30B-A3B Heretic (fast, code)", 18.6, 24, true),
    ("hf.co/mradermacher/Qwen3.8-9B-heretic-uncensored-i1-GGUF:i1-Q4_K_M", "Qwen3.8 9B Heretic", 5.6, 8, true),
    ("hf.co/JMingo/gemma-4-E4B-it-ultra-uncensored-heretic-UD-GGUF:Q4_K_M", "Gemma 4 E4B Heretic (sees images)", 4.9, 8, true),
    ("hf.co/mradermacher/Qwen3.5-4B-heretic-i1-GGUF:i1-Q4_K_M", "Qwen3.5 4B Heretic", 2.7, 8, true),
    ("huihui_ai/deepseek-r1-abliterated:14b", "DeepSeek-R1 14B", 9.0, 16, true), ("dolphin3:8b", "Dolphin 3 8B (uncensored)", 4.9, 8, true),
    ("huihui_ai/llama3.2-abliterate:3b", "Llama 3.2 3B", 2.0, 8, true)]
  static func pretty(_ tag: String) -> String {
    if let c = catalog.first(where: { $0.tag.lowercased() == tag.lowercased() }) { return "\(c.name)\(c.abl ? " · abliterated" : "")" }
    let t = tag.lowercased()
    let base = tag.split(separator: "/").last.map(String.init) ?? tag
    let parts = base.split(separator: ":").map(String.init)
    var family = parts.first ?? base
    for cut in ["-abliterated", "-abliterate"] { family = family.replacingOccurrences(of: cut, with: "") }
    family = family.replacingOccurrences(of: "qwen2.5-coder", with: "Qwen2.5 Coder").replacingOccurrences(of: "qwen3.5", with: "Qwen3.5 (sees images)")
      .replacingOccurrences(of: "qwen3", with: "Qwen3").replacingOccurrences(of: "deepseek-r1", with: "DeepSeek-R1").replacingOccurrences(of: "gemma3", with: "Gemma 3").replacingOccurrences(of: "llama", with: "Llama ")
    let size = parts.count > 1 ? " \(parts[1].uppercased())" : ""
    return "\(family)\(size)\(t.contains("abliterat") || t.contains("dolphin") ? " · abliterated" : "")"
  }
  private func loadModels() {
    let keep = modelPin ?? "auto"
    var req = URLRequest(url: URL(string: "http://127.0.0.1:11434/api/tags")!); req.timeoutInterval = 2
    URLSession.shared.dataTask(with: req) { [weak self] data, _, _ in
      let models = ((data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] })?["models"] as? [[String: Any]] ?? [])
      let installed = models.compactMap { m -> (String, Double)? in guard let n = m["name"] as? String else { return nil }; return (n, Double((m["size"] as? NSNumber)?.int64Value ?? 0) / 1e9) }
      DispatchQueue.main.async {
        guard let self, let menu = self.modelPopup.menu else { return }
        self.modelPopup.removeAllItems()
        let auto = NSMenuItem(title: "Auto", action: nil, keyEquivalent: ""); auto.representedObject = "auto"
        auto.toolTip = "Kingmaker picks: writing goes to the local writer, actions and lookups to Kingmaker (with its approvals)."; menu.addItem(auto)
        var local = installed.filter { !$0.0.contains("embed") }.sorted(by: { $0.0 < $1.0 })
        if keep != "auto", !local.contains(where: { $0.0 == keep }) { local.insert((keep, 0), at: 0) }   // pinned, but Ollama didn't list it
        if !local.isEmpty { menu.addItem(.separator()); let h = NSMenuItem(title: "On this Mac — pin one to write with it", action: nil, keyEquivalent: ""); h.isEnabled = false; menu.addItem(h) }
        for (n, gb) in local {
          let it = NSMenuItem(title: KingmakerBar.pretty(n), action: nil, keyEquivalent: ""); it.representedObject = n
          it.image = NSImage(systemSymbolName: n == keep ? "pin.fill" : "pin", accessibilityDescription: n == keep ? "Pinned" : "Pin")
          it.toolTip = (gb > 0 ? "\(String(format: "%.1f", gb)) GB · " : "Not listed by Ollama right now · ") + (n == keep ? "Pinned: writing goes to this model. Choose Auto to unpin." : "Pin it: writing goes to this model; actions and lookups still go to Kingmaker.")
          menu.addItem(it)
        }
        let have = Set(installed.map { $0.0 })
        let mem = Int(ProcessInfo.processInfo.physicalMemory / 1_073_741_824)
        let more = KingmakerBar.catalog.filter { !have.contains($0.tag) && $0.minGb <= mem }
        if !more.isEmpty {
          menu.addItem(.separator()); let h = NSMenuItem(title: "Download (from Ollama)", action: nil, keyEquivalent: ""); h.isEnabled = false; menu.addItem(h)
          for c in more { let it = NSMenuItem(title: "↓ \(c.name)\(c.abl ? " · abliterated" : "")  ·  \(String(format: "%.1f", c.gb)) GB", action: nil, keyEquivalent: ""); it.representedObject = "pull:\(c.tag)"; menu.addItem(it) }
        }
        if let i = self.modelPopup.itemArray.firstIndex(where: { ($0.representedObject as? String) == keep }) { self.modelPopup.selectItem(at: i) }
        self.layout()
      }
    }.resume()
  }
  /// A model from the Download section: ask, then pull it from Ollama with its progress in the status line.
  private func pullModel(_ tag: String) {
    let c = KingmakerBar.catalog.first { $0.tag == tag }
    let alert = NSAlert(); alert.messageText = "Download \(c?.name ?? tag)?"
    alert.informativeText = "About \(String(format: "%.1f", c?.gb ?? 0)) GB from \(tag.hasPrefix("hf.co/") ? "Hugging Face, through Ollama" : "Ollama's registry") (\(tag)). It runs on this Mac only."
    alert.addButton(withTitle: "Download"); alert.addButton(withTitle: "Cancel")
    NSApp.activate(ignoringOtherApps: true)
    guard alert.runModal() == .alertFirstButtonReturn else { loadModels(); return }
    loadModels()   // the picker goes back to Auto or the pinned model while it downloads (not the ↓ row)
    append(who: "", "Downloading \(c?.name ?? tag)…")
    var req = URLRequest(url: URL(string: "http://127.0.0.1:11434/api/pull")!); req.httpMethod = "POST"; req.timeoutInterval = 6 * 3600
    req.httpBody = try? JSONSerialization.data(withJSONObject: ["name": tag, "stream": true])
    let task = URLSession.shared.dataTask(with: req) { [weak self] _, _, err in
      DispatchQueue.main.async {
        guard let self else { return }
        self.statusLabel.stringValue = ""
        self.append(who: "", err == nil ? "\(c?.name ?? tag) is ready and pinned: writing goes to it. Choose Auto on the right to unpin." : "The download stopped: \(err!.localizedDescription)")
        if err == nil { KingmakerBar.d.set(tag, forKey: "km.modelPin") }
        self.loadModels()
      }
    }
    task.resume()
    statusLabel.stringValue = "Downloading…"
  }

  /// The / list: Kingmaker's own tools, the plugin connectors (MCP servers) and the apps from its device scan.
  private func loadPrograms() {
    let url = URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support/sol-ghost/runtime/device-capabilities.json")
    var out: [Pick] = ["PhotoCraft", "VectorCraft", "FilmCraft", "LightCraft", "EffectCraft", "PrintCraft", "DesignCraft"].map { Pick(kind: "program", title: "/\($0)", detail: "Kingmaker creative tool", value: $0) }
    out.append(Pick(kind: "program", title: "/Hands", detail: "Kingmaker's hands — clicks and typing in any app", value: "the Hands of Horus"))
    if let data = try? Data(contentsOf: url), let map = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
      for m in (map["mcp"] as? [[String: Any]]) ?? [] where (m["disabled"] as? Bool) != true {
        if let n = m["name"] as? String { out.append(Pick(kind: "program", title: "/\(n)", detail: "Plugin connector\((m["client"] as? String).map { " · \($0)" } ?? "")", value: n)) }
      }
      for a in (map["apps"] as? [[String: Any]]) ?? [] where (a["self"] as? Bool) != true {
        guard let n = a["name"] as? String else { continue }
        let how = (a["scriptable"] as? Bool) == true ? "App · scriptable" : (a["system"] as? Bool) == true ? "App · system" : "App"
        out.append(Pick(kind: "program", title: "/\(n.replacingOccurrences(of: " ", with: "_"))", detail: how, value: n, path: a["path"] as? String))
      }
    }
    for c in connectors where (c["enabled"] as? Bool) == true {
      guard let n = c["name"] as? String else { continue }
      let kind = (c["kind"] as? String) ?? "cli", verdict = (c["verdict"] as? String) ?? ""
      out.append(Pick(kind: "program", title: "/\(n)", detail: "Connector · \(kind)\(verdict == "sandboxed" ? " · sandboxed" : "")", value: n))
    }
    programs = out
  }

  // ── layout: the conversation (when there is one), the picks, the composer, the footer ──
  private func layout() {
    // The sidebar (when shown and the bar is wide enough) takes the left; the conversation the rest.
    let sideOn = sideShown && (sized?.width ?? .greatestFiniteMagnitude) >= 600
    let W = max(KingmakerBar.minSize.width, sized?.width ?? (KingmakerBar.width + (sideOn ? KingmakerBar.sideW : 0)))
    let s: CGFloat = sideOn ? KingmakerBar.sideW : 0, w = W - s, pad: CGFloat = 16
    contentWidth = w
    let picksH = picks.isEmpty ? 0 : CGFloat(picks.count) * 32
    // Full screen covers the menu bar, so on a Mac with a camera notch the header would sit under it: while the bar fills
    // its screen, everything starts below the screen's safe area (owner 2026-10-15: "you have to account for the drop-down
    // bar in the center of the screen"). Zero on a display without a notch.
    let scr = panel.screen ?? NSScreen.main
    let filling = scr.map { sc in sized.map { abs($0.width - sc.frame.width) < 4 && abs($0.height - sc.frame.height) < 4 } ?? false } ?? false
    let notch: CGFloat = filling ? (scr?.safeAreaInsets.top ?? 0) : 0
    let composerH: CGFloat = 48, footerH: CGFloat = 30, headerH: CGFloat = 30 + notch
    let keyH: CGFloat = keyRequest == nil ? 0 : 66
    let fixedH = 12 + footerH + 8 + composerH + (keyH > 0 ? keyH + 8 : 0) + (picksH > 0 ? picksH + 8 : 0) + 6 + headerH
    // The owner's size: the conversation takes all the room left. Otherwise the bar grows with its talk (up to 300).
    var logH: CGFloat = sized != nil ? max(0, max(KingmakerBar.minSize.height, sized!.height) - fixedH - 10)
      : hasLog ? min(300, max(44, (log.layoutManager.map { lm -> CGFloat in lm.ensureLayout(for: log.textContainer!); return lm.usedRect(for: log.textContainer!).height } ?? 44) + 14)) : 0
    if sideOn && sized == nil && fixedH + logH + 10 < 380 { logH = 380 - fixedH - 10 }   // room for the chats list
    // The setup screen takes the conversation's place (as tall as it needs, up to 560, when the bar fits its talk).
    var flowH: CGFloat = 0
    if flowShown, let f = flowData { flowH = flowView.show(f, width: w - pad * 2 - 4); if sized == nil { logH = min(560, flowH) } }
    let h = fixedH + (logH > 0 ? logH + 10 : 0)
    let top = panel.frame.maxY
    panel.setFrame(NSRect(x: panel.frame.minX, y: top - h, width: W, height: h), display: true)
    backdrop.frame = NSRect(x: 0, y: 0, width: W, height: h)
    blackFill.frame = backdrop.bounds
    // The wordmark sits between the window buttons (– + sidebar, to x 96) and the gear, over the conversation.
    // Customize shows only when the bar is big enough to hold its screen beside the talk.
    // Customize, top left beside the window buttons: an icon, with its name when the bar has room for it.
    let bigEnough = W >= KingmakerBar.customizeMinWidth
    customizeButton.title = bigEnough ? " Customize" : ""; customizeButton.imagePosition = bigEnough ? .imageLeading : .imageOnly
    customizeButton.frame = NSRect(x: pad + 78, y: h - headerH - 4, width: bigEnough ? 98 : 24, height: 24)
    swapButton.frame = NSRect(x: customizeButton.frame.maxX + 6, y: h - headerH - 3, width: 22, height: 22)
    let tx = max(s + 16, (swapButton.isHidden ? customizeButton.frame.maxX : swapButton.frame.maxX) + 10), tw = max(60, W - pad - 30 - tx)
    titleLabel.frame = NSRect(x: tx, y: h - headerH - 3, width: tw, height: 22)
    titleLabel.attributedStringValue = KingmakerBar.wordmark(kern: tw < 300 ? 2.0 : 4.5)
    minimize.frame = NSRect(x: pad, y: h - headerH - 3, width: 22, height: 22)
    fill.frame = NSRect(x: pad + 26, y: h - headerH - 3, width: 22, height: 22)
    sideToggle.frame = NSRect(x: pad + 52, y: h - headerH - 3, width: 22, height: 22)
    side.isHidden = !sideOn
    if sideOn {
      let sh = h - headerH - 8
      side.frame = NSRect(x: 0, y: 0, width: s, height: sh)
      sideTabs.frame = NSRect(x: 8, y: sh - 30, width: s - 16 - 26, height: 24)
      selectToggle.frame = NSRect(x: s - 8 - 22, y: sh - 29, width: 22, height: 22)
      newChatButton.frame = NSRect(x: 8, y: sh - 64, width: s - 16, height: 28)
      newProjectButton.frame = NSRect(x: 8, y: sh - 94, width: s - 16, height: 28)
      newProjectButton.isHidden = newProjectButton.title.isEmpty
      let listTop = newProjectButton.isHidden ? sh - 64 - 8 : sh - 94 - 8
      let barH: CGFloat = selecting ? 34 : 0
      selectBar.isHidden = !selecting
      selectBar.frame = NSRect(x: 0, y: 0, width: s, height: barH)
      selectCount.frame = NSRect(x: 10, y: 9, width: 70, height: 16)
      for (i, b) in [selectPin, selectMove, selectDelete].enumerated() { b.frame = NSRect(x: s - 10 - 24 - CGFloat(i) * 28, y: 5, width: 24, height: 24) }
      sideScroll.frame = NSRect(x: 0, y: 8 + barH, width: s, height: max(0, listTop - 8 - barH))
      sideList.frame.size.height = max(sideList.frame.height, sideScroll.contentSize.height)
    }
    var y: CGFloat = 12
    var x = s + pad
    gear.frame = NSRect(x: x, y: y + 4, width: 22, height: 22); x += 28   // Settings, bottom left
    for b in [folderButton, powerButton, muteButton, commandsButton] where !b.isHidden { let bw = ceil(b.intrinsicContentSize.width) + 14; b.frame = NSRect(x: x, y: y + 4, width: bw, height: 22); x += bw + 6 }
    // The model picker takes the right, never over the pills: it shrinks (its name truncates) to the room they leave, and
    // the status line gets what's left between them.
    modelPopup.sizeToFit()
    let room = (W - pad) - (x + 6)
    let mw = max(min(96, room), min(240, modelPopup.frame.width + 8, room))
    modelPopup.frame = NSRect(x: W - pad - mw, y: y + 2, width: mw, height: 26)
    (modelPopup.cell as? NSPopUpButtonCell)?.lineBreakMode = .byTruncatingTail
    statusLabel.frame = NSRect(x: x + 4, y: y + 7, width: max(0, modelPopup.frame.minX - x - 10), height: 16)
    y += footerH + 8
    composer.frame = NSRect(x: s + pad, y: y, width: w - pad * 2, height: composerH)
    let cw = composer.frame.width
    plus.frame = NSRect(x: 10, y: 12, width: 24, height: 24)
    // From the right edge: ↵ send, then the mic (hidden when text only), then stop; the box takes what's left.
    var rx = cw - 10
    for b in [sendButton, mic, stop] where !b.isHidden { rx -= 24; b.frame = NSRect(x: rx, y: 12, width: 24, height: 24); rx -= 6 }
    field.frame = NSRect(x: 40, y: 13, width: max(60, rx - 40), height: 22)
    refreshSend()
    y += composerH
    if keyH > 0 {
      y += 8
      keyStrip.frame = NSRect(x: s + pad, y: y, width: w - pad * 2, height: keyH)
      let kw = keyStrip.frame.width
      keyLabel.frame = NSRect(x: 12, y: keyH - 22, width: kw - 24, height: 16)
      keyPage.frame = NSRect(x: kw - 12 - 74, y: 8, width: 74, height: 26)
      keyCancel.frame = NSRect(x: keyPage.frame.minX - 6 - 64, y: 8, width: 64, height: 26)
      keySave.frame = NSRect(x: keyCancel.frame.minX - 6 - 56, y: 8, width: 56, height: 26)
      keyField.frame = NSRect(x: 12, y: 9, width: keySave.frame.minX - 12 - 10, height: 24)
      y += keyH
    }
    if picksH > 0 { y += 8 }
    picksBox.frame = NSRect(x: s + pad, y: y, width: w - pad * 2, height: picksH)
    picksBox.isHidden = picksH == 0
    if picksH > 0 { y += picksH }
    if logH > 0 { y += 10 }
    scroll.frame = NSRect(x: s + pad + 2, y: y, width: w - pad * 2 - 4, height: logH)
    if sheetShown != nil && !barIsLarge { moveSheetToWindow() }   // the bar got small: the sheet goes back to its window
    let sheetOn = sheetShown != nil
    scroll.isHidden = logH == 0 || flowShown || sheetOn
    sheetHost.isHidden = !sheetOn; sheetClose.isHidden = !sheetOn
    if sheetOn {
      sheetHost.frame = NSRect(x: s + pad, y: scroll.frame.minY, width: w - pad * 2, height: scroll.frame.height)
      sheetHost.subviews.first?.frame = sheetHost.bounds.insetBy(dx: 4, dy: 4)
      sheetClose.frame = NSRect(x: sheetHost.frame.maxX - 30, y: sheetHost.frame.maxY - 30, width: 26, height: 26)
    }
    flowScroll.isHidden = !flowShown || sheetOn; flowClose.isHidden = !flowShown || sheetOn
    if flowShown {
      flowScroll.frame = scroll.frame
      flowView.frame = NSRect(x: 0, y: 0, width: scroll.frame.width, height: max(flowH, scroll.frame.height))
      flowClose.frame = NSRect(x: scroll.frame.maxX - 26, y: scroll.frame.maxY - 26, width: 22, height: 22)
    }
    log.frame.size.width = scroll.contentSize.width
    positionShareCard()
  }
}

// ── The screen-edge glow (opt-in: KINGMAKER_EDGE_GLOW=1) ──────────────────────────────────────────────

/// One look of the outline: how much of the edge strip it fills, how bright, how fast the colours turn, and
/// whether it breathes (pulse > 0 = seconds per breath).
// ── THE FIRST-RUN TOUR (lib/first-run.mjs: @@ghost tour) ─────────────────────────────────────────────────────────────
// The bar with everything dimmed but one control, lit with a ring in the bar's accent, and a card beside the bar: what
// it's for, in one or two sentences, and Next or Skip. The lit control still works (the dim lets clicks through only
// there). Three steps: permissions (each with its live state and its own Turn on), the wake word (ticks itself when
// Kingmaker hears it), three things to ask (one click puts one in the box).

/// The dim over the bar, with a hole where the lit control is.
final class TourDim: NSView {
  var hole: NSRect? { didSet { if hole != oldValue { needsDisplay = true } } }
  var accent: NSColor = KingmakerBar.gold
  override func draw(_ dirtyRect: NSRect) {
    let path = NSBezierPath(rect: bounds)
    if let h = hole { path.append(NSBezierPath(roundedRect: h, xRadius: 10, yRadius: 10)); path.windingRule = .evenOdd }
    NSColor.black.withAlphaComponent(0.62).setFill(); path.fill()
    if let h = hole { let ring = NSBezierPath(roundedRect: h, xRadius: 10, yRadius: 10); ring.lineWidth = 2; accent.setStroke(); ring.stroke() }
  }
  /// Clicks inside the hole reach the lit control; everywhere else on the bar they stop here.
  override func hitTest(_ point: NSPoint) -> NSView? {
    let p = convert(point, from: superview)
    if let h = hole, h.contains(p) { return nil }
    return bounds.contains(p) ? self : nil
  }
  override func mouseDown(with event: NSEvent) {}
  override func scrollWheel(with event: NSEvent) {}
}

final class TourController: NSObject {
  private let steps: [[String: Any]]
  private weak var panel: NSPanel?
  private let dim = TourDim()
  private var card: NSPanel?
  private var timer: Timer?
  private var index = 0
  private var heard = false
  private var lastPerms: [Bool?] = []
  private let accent: NSColor, look: String, size: CGFloat
  var target: (String) -> NSView? = { _ in nil }
  weak var permissionTarget: KingmakerBar?
  var send: (String) -> Void = { _ in }
  var fill: (String) -> Void = { _ in }
  var ended: () -> Void = {}

  init(steps: [[String: Any]], panel: NSPanel, accent: NSColor, look: String, size: CGFloat) {
    self.steps = steps; self.panel = panel; self.accent = accent; self.look = look; self.size = min(max(size, 12), 18)
  }
  private var step: [String: Any] { steps[index] }
  private var stepId: String { (step["id"] as? String) ?? "" }

  func start(at first: Int = 0) {
    guard let host = panel?.contentView else { return }
    dim.accent = accent; dim.frame = host.bounds; dim.autoresizingMask = [.width, .height]
    dim.setAccessibilityElement(false)
    host.addSubview(dim, positioned: .above, relativeTo: nil)
    show(min(max(first, 0), steps.count - 1))
    // The lit control can move (the bar resizes, the sidebar folds) and permissions change in System Settings: both are
    // looked at twice a second while the tour shows.
    timer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in self?.tick() }
  }
  private func tick() {
    dim.hole = holeRect(); placeCard()
    if stepId == "access" { let now = perms().map { $0.2 }; if now != lastPerms { buildCard() } }
  }
  private func show(_ i: Int) {
    index = i; heard = false
    dim.hole = holeRect(); buildCard()
  }
  private func holeRect() -> NSRect? {
    guard let id = step["target"] as? String, let v = target(id), !v.isHidden, v.window === panel else { return nil }
    return v.convert(v.bounds, to: dim).insetBy(dx: -6, dy: -6)
  }
  /// The three permissions the tour asks for, as Customize → Permissions shows them: (name, what for, on?, pane).
  private func perms() -> [(String, String, Bool?, String)] {
    let want = (step["permissions"] as? [String]) ?? []
    return KingmakerBar.permissionRows().filter { want.contains($0.0) }
  }
  /// The engine says Kingmaker heard its name: the wake step ticks itself and moves on.
  func state(_ s: String) {
    guard stepId == "wake", !heard, (step["waitFor"] as? String) == "awake", ["awake", "hearing"].contains(s) else { return }
    heard = true; buildCard()
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) { [weak self] in if self?.stepId == "wake" { self?.next() } }
  }
  @objc private func next() { if index + 1 < steps.count { show(index + 1) } else { finish("done") } }
  @objc private func back() { if index > 0 { show(index - 1) } }
  @objc private func skip() { finish("skipped") }
  @objc private func example(_ b: NSButton) { fill(b.identifier?.rawValue ?? ""); finish("done") }
  private func finish(_ how: String) { send("tour-done \(how) \(stepId)"); close() }
  /// Takes the tour down (the bar closing does this too, and then it shows again next time: it wasn't finished).
  func close() {
    timer?.invalidate(); timer = nil
    dim.removeFromSuperview()
    if let c = card { panel?.removeChildWindow(c); c.orderOut(nil) }
    card = nil
    ended()
  }

  private func buildCard() {
    guard let panel else { return }
    let systemLook = look == "system"
    let ink: NSColor = systemLook ? .labelColor : .white
    let soft: NSColor = systemLook ? .secondaryLabelColor : NSColor.white.withAlphaComponent(0.7)
    let w: CGFloat = 400, inset: CGFloat = 18, tw = w - inset * 2
    let root = FlippedView(frame: NSRect(x: 0, y: 0, width: w, height: 10))
    root.wantsLayer = true
    root.layer?.backgroundColor = systemLook ? NSColor.windowBackgroundColor.cgColor : NSColor.black.withAlphaComponent(0.97).cgColor
    root.layer?.cornerRadius = 14; root.layer?.borderWidth = 1; root.layer?.borderColor = accent.withAlphaComponent(0.6).cgColor
    root.setAccessibilityRole(.group); root.setAccessibilityLabel("Kingmaker tour, step \(index + 1) of \(steps.count)")
    var y: CGFloat = inset
    func text(_ s: String, _ font: NSFont, _ color: NSColor, gap: CGFloat = 8) {
      let l = NSTextField(wrappingLabelWithString: s); l.font = font; l.textColor = color; l.isSelectable = false
      l.preferredMaxLayoutWidth = tw
      let h = ceil(l.attributedStringValue.boundingRect(with: NSSize(width: tw, height: 2000), options: [.usesLineFragmentOrigin, .usesFontLeading]).height) + 2
      l.frame = NSRect(x: inset, y: y, width: tw, height: h); root.addSubview(l); y += h + gap
    }
    func linkButton(_ title: String, _ action: Selector, color: NSColor, id: String? = nil) -> NSButton {
      let b = NSButton(title: "", target: self, action: action); b.isBordered = false
      b.attributedTitle = NSAttributedString(string: title, attributes: [.font: NSFont.systemFont(ofSize: size - 1), .foregroundColor: color])
      if let id { b.identifier = NSUserInterfaceItemIdentifier(id) }
      b.sizeToFit(); return b
    }
    text("STEP \(index + 1) OF \(steps.count)", .systemFont(ofSize: size - 3, weight: .semibold), soft, gap: 4)
    text((step["title"] as? String) ?? "", .systemFont(ofSize: size + 3, weight: .semibold), accent)
    text((step["body"] as? String) ?? "", .systemFont(ofSize: size), ink, gap: 12)

    switch stepId {
    case "access":
      let rows = perms(); lastPerms = rows.map { $0.2 }
      for (name, why, on, pane) in rows {
        let mark = NSTextField(labelWithString: on == true ? "✓" : "○"); mark.font = .systemFont(ofSize: size, weight: .bold)
        mark.textColor = on == true ? accent : soft; mark.frame = NSRect(x: inset, y: y + 4, width: 18, height: size + 6)
        let label = NSTextField(labelWithString: "\(name) — \(why)"); label.font = .systemFont(ofSize: size - 1); label.textColor = ink
        label.frame = NSRect(x: inset + 22, y: y + 5, width: tw - (on == true ? 60 : 110), height: size + 6); label.lineBreakMode = .byTruncatingTail
        root.addSubview(mark); root.addSubview(label)
        if on != true, let t = permissionTarget {
          // In the accent, outlined: a system bezel reads as nothing on the black card.
          let b = NSButton(title: "", target: t, action: #selector(KingmakerBar.openPermission(_:)))
          b.isBordered = false; b.wantsLayer = true; b.layer?.cornerRadius = 6; b.layer?.borderWidth = 1; b.layer?.borderColor = accent.cgColor
          b.attributedTitle = NSAttributedString(string: "  Turn on  ", attributes: [.font: NSFont.systemFont(ofSize: size - 2, weight: .semibold), .foregroundColor: accent])
          b.identifier = NSUserInterfaceItemIdentifier(pane); b.setAccessibilityLabel("Turn on \(name)"); b.sizeToFit()
          b.frame = NSRect(x: w - inset - b.frame.width - 6, y: y + 1, width: b.frame.width + 6, height: 24); root.addSubview(b)
        } else if on == true {
          let ok = NSTextField(labelWithString: "On"); ok.font = .systemFont(ofSize: size - 1, weight: .semibold); ok.textColor = accent; ok.sizeToFit()
          ok.frame.origin = NSPoint(x: w - inset - ok.frame.width, y: y + 5); root.addSubview(ok)
        }
        y += 32
      }
      if rows.allSatisfy({ $0.2 == true }) { text("All three are on.", .systemFont(ofSize: size - 1, weight: .semibold), accent) }
      y += 4
    case "wake":
      text(heard ? "✓ Heard you." : "Listening for it…", .systemFont(ofSize: size, weight: .semibold), heard ? accent : soft, gap: 12)
    case "first":
      for e in (step["examples"] as? [String]) ?? [] {
        let b = linkButton("→ \(e)", #selector(example(_:)), color: accent, id: e)
        b.setAccessibilityLabel("Put “\(e)” in the box")
        b.frame = NSRect(x: inset, y: y, width: min(tw, b.frame.width), height: size + 10); root.addSubview(b); y += size + 12
      }
      y += 6
    default: break
    }

    // The footer: Skip on the left; Back and Next (Done on the last step) on the right.
    let last = index + 1 == steps.count
    let primary = NSButton(title: "", target: self, action: #selector(next)); primary.isBordered = false; primary.wantsLayer = true
    primary.layer?.cornerRadius = 7; primary.layer?.backgroundColor = accent.cgColor
    var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
    (accent.usingColorSpace(.sRGB) ?? accent).getRed(&r, green: &g, blue: &b, alpha: &a)
    let onAccent: NSColor = (0.299 * r + 0.587 * g + 0.114 * b) > 0.6 ? .black : .white
    let nextTitle = last ? "Done" : (stepId == "wake" && !heard ? "Skip this step" : "Next")
    primary.attributedTitle = NSAttributedString(string: "  \(nextTitle)  ", attributes: [.font: NSFont.systemFont(ofSize: size - 1, weight: .semibold), .foregroundColor: onAccent])
    primary.keyEquivalent = "\r"; primary.sizeToFit()
    let bh = max(28, size + 14)
    primary.frame = NSRect(x: w - inset - primary.frame.width - 8, y: y, width: primary.frame.width + 8, height: bh)
    root.addSubview(primary)
    if index > 0 {
      let backB = linkButton("Back", #selector(back), color: soft)
      backB.frame = NSRect(x: primary.frame.minX - 14 - backB.frame.width, y: y + (bh - backB.frame.height) / 2, width: backB.frame.width, height: backB.frame.height)
      root.addSubview(backB)
    }
    let skipB = linkButton("Skip the tour", #selector(skip), color: soft); skipB.keyEquivalent = "\u{1b}"
    skipB.frame = NSRect(x: inset, y: y + (bh - skipB.frame.height) / 2, width: skipB.frame.width, height: skipB.frame.height)
    root.addSubview(skipB)
    y += bh + inset
    root.frame.size.height = y

    let c = card ?? {
      let p = NSPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
      p.isOpaque = false; p.backgroundColor = .clear; p.hasShadow = true; p.level = panel.level
      p.isReleasedWhenClosed = false
      panel.addChildWindow(p, ordered: .above)
      card = p; return p
    }()
    let cardSize = root.frame.size        // read before it becomes the content view (that sizes it to the window)
    c.setContentSize(cardSize)
    c.contentView = root
    placeCard()
    c.orderFront(nil)
  }

  /// Beside the bar: under it when there's room, else above it, else at its right; lined up with the lit control.
  private func placeCard() {
    guard let panel, let c = card else { return }
    let pf = panel.frame, size = c.frame.size
    let vf = (panel.screen ?? NSScreen.main)?.visibleFrame ?? pf
    let holeX = dim.hole.map { panel.convertToScreen(dim.convert($0, to: nil)).midX } ?? pf.midX
    var x = holeX - size.width / 2, yPos: CGFloat
    if pf.minY - 12 - size.height >= vf.minY { yPos = pf.minY - 12 - size.height }
    else if pf.maxY + 12 + size.height <= vf.maxY { yPos = pf.maxY + 12 }
    else { x = min(pf.maxX + 12, vf.maxX - size.width); yPos = max(vf.minY, pf.midY - size.height / 2) }
    x = min(max(x, vf.minX + 8), vf.maxX - size.width - 8)
    let origin = NSPoint(x: x.rounded(), y: yPos.rounded())
    if c.frame.origin != origin { c.setFrameOrigin(origin) }
  }
}

struct GlowLook: Equatable {
  var thickness: CGFloat   // 0…1 of GhostGlow.maxThickness
  var opacity: Float
  var turnSeconds: Double  // one full turn of the colours around the screen
  var pulse: Double        // 0 = steady
  var comet: Bool = false  // a single travelling light instead of the full ring
  var red: Bool = false

  static let booting = GlowLook(thickness: 0.22, opacity: 0.95, turnSeconds: 2.2, pulse: 0, comet: true)
  static let awake = GlowLook(thickness: 0.22, opacity: 0.7, turnSeconds: 9, pulse: 0)
  static let hearing = GlowLook(thickness: 0.62, opacity: 1, turnSeconds: 3, pulse: 1.1)
  static let thinking = GlowLook(thickness: 0.42, opacity: 1, turnSeconds: 1.1, pulse: 0)
  static let speaking = GlowLook(thickness: 0.34, opacity: 0.85, turnSeconds: 4.5, pulse: 0)
  static let waiting = GlowLook(thickness: 0.34, opacity: 0.95, turnSeconds: 7, pulse: 1.6)
  static let down = GlowLook(thickness: 0.5, opacity: 1, turnSeconds: 0, pulse: 0.45, red: true)

  /// The look for a CLI state, or nil = no glow (asleep).
  static func forState(_ s: String) -> GlowLook? {
    switch s {
    case "awake": return .awake
    case "hearing": return .hearing
    case "thinking": return .thinking
    case "speaking": return .speaking
    case "waiting": return .waiting
    case "down": return .down
    case "starting": return .booting
    default: return nil // asleep, or anything unknown: dark
    }
  }
}

/// A click-through, borderless strip along one edge of one screen. Four per screen: only the edges are ever
/// drawn (a few hundred KB of layers), never a full-screen layer. The side strips run the full height, so
/// the glow turns each corner (the corner squares are drawn by both strips, like Siri's brighter corners).
///
/// The colour runs around the screen's PERIMETER, clockwise from the top-left corner (s = 0 … P). Each strip
/// holds a linear gradient laid over three palette periods, positioned by where the strip sits on the
/// perimeter; turning the ring slides every strip's gradient by exactly one perimeter, so the four strips
/// read as one ring and the loop is seamless.
final class GlowStrip {
  enum Edge { case top, bottom, left, right }
  let window: NSWindow
  let edge: Edge
  private let colours = CAGradientLayer()
  private let mask = CAGradientLayer()
  private let perimeter: CGFloat  // P
  private let sAtZero: CGFloat    // perimeter position at unit 0 of the strip's long axis
  private let sign: CGFloat       // +1 when the perimeter runs with the axis, -1 against it
  private let length: CGFloat     // the strip's long-axis length

  init(screen: NSScreen, edge: Edge, maxThickness t: CGFloat) {
    self.edge = edge
    let f = screen.frame
    let w = f.width, h = f.height
    perimeter = 2 * (w + h)
    let rect: CGRect
    switch edge {
    case .top: rect = CGRect(x: f.minX, y: f.maxY - t, width: w, height: t); sAtZero = 0; sign = 1; length = w
    case .right: rect = CGRect(x: f.maxX - t, y: f.minY, width: t, height: h); sAtZero = w + h; sign = -1; length = h
    case .bottom: rect = CGRect(x: f.minX, y: f.minY, width: w, height: t); sAtZero = 2 * w + h; sign = -1; length = w
    case .left: rect = CGRect(x: f.minX, y: f.minY, width: t, height: h); sAtZero = 2 * w + h; sign = 1; length = h
    }
    window = NSWindow(contentRect: rect, styleMask: .borderless, backing: .buffered, defer: false)
    window.isOpaque = false
    window.backgroundColor = .clear
    window.hasShadow = false
    window.ignoresMouseEvents = true
    window.isReleasedWhenClosed = false
    window.level = .screenSaver // above full-screen apps and the menu bar, like Siri's glow
    window.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
    window.animationBehavior = .none
    let view = NSView(frame: CGRect(origin: .zero, size: rect.size))
    view.wantsLayer = true
    view.layer?.backgroundColor = NSColor.clear.cgColor
    window.contentView = view

    colours.type = .axial
    colours.frame = view.bounds
    // Soft inward glow: opaque at the screen edge, fading toward the middle of the screen.
    mask.frame = view.bounds
    mask.colors = [NSColor.white.cgColor, NSColor.white.withAlphaComponent(0.55).cgColor, NSColor.clear.cgColor]
    switch edge {
    case .top: mask.startPoint = CGPoint(x: 0.5, y: 1); mask.endPoint = CGPoint(x: 0.5, y: 0)
    case .bottom: mask.startPoint = CGPoint(x: 0.5, y: 0); mask.endPoint = CGPoint(x: 0.5, y: 1)
    case .left: mask.startPoint = CGPoint(x: 0, y: 0.5); mask.endPoint = CGPoint(x: 1, y: 0.5)
    case .right: mask.startPoint = CGPoint(x: 1, y: 0.5); mask.endPoint = CGPoint(x: 0, y: 0.5)
    }
    colours.mask = mask
    view.layer?.addSublayer(colours)
    setPhase(0)
  }

  /// The strip's long-axis unit coordinate for a perimeter position s.
  private func unit(_ s: CGFloat) -> CGFloat { (s - sAtZero) / (sign * length) }
  private func point(_ u: CGFloat) -> CGPoint {
    switch edge {
    case .top, .bottom: return CGPoint(x: u, y: 0.5)
    case .left, .right: return CGPoint(x: 0.5, y: u)
    }
  }
  /// The gradient spans s ∈ [-P - φ, 2P - φ]: three palette periods, so every s in [0, P) is covered for any φ.
  private func ends(_ phi: CGFloat) -> (CGPoint, CGPoint) {
    (point(unit(-perimeter - phi)), point(unit(2 * perimeter - phi)))
  }
  private func setPhase(_ phi: CGFloat) { let (a, b) = ends(phi); colours.startPoint = a; colours.endPoint = b }

  func show() { window.orderFrontRegardless() }
  func close() {
    colours.removeAllAnimations(); mask.removeAllAnimations()
    window.orderOut(nil); window.close()
  }

  /// Apply a look. `startTime` is shared by every strip so the ring turns as one.
  func apply(_ look: GlowLook, startTime: CFTimeInterval, transition: Double, reduceMotion: Bool) {
    CATransaction.begin()
    CATransaction.setAnimationDuration(transition)
    let (stops, places) = GlowStrip.periods(look)
    colours.colors = stops
    colours.locations = places
    colours.opacity = look.opacity
    let k = max(0.02, min(1, look.thickness))
    mask.locations = [0, NSNumber(value: Double(k) * 0.35), NSNumber(value: Double(k))]
    CATransaction.commit()

    for key in ["turnStart", "turnEnd"] { colours.removeAnimation(forKey: key) }
    mask.removeAnimation(forKey: "breathe")
    colours.removeAnimation(forKey: "breathe")
    if look.turnSeconds > 0 && !reduceMotion {
      let (a0, b0) = ends(0)
      let (a1, b1) = ends(perimeter)
      for (key, from, to) in [("turnStart", a0, a1), ("turnEnd", b0, b1)] {
        let turn = CABasicAnimation(keyPath: key == "turnStart" ? "startPoint" : "endPoint")
        turn.fromValue = NSValue(point: from)
        turn.toValue = NSValue(point: to)
        turn.duration = look.turnSeconds
        turn.repeatCount = .infinity
        turn.beginTime = startTime
        if #available(macOS 12.0, *) { turn.preferredFrameRateRange = CAFrameRateRange(minimum: 15, maximum: 60, preferred: look.turnSeconds > 5 ? 30 : 60) }
        colours.add(turn, forKey: key)
      }
    }
    if look.pulse > 0 {
      let breathe = CABasicAnimation(keyPath: look.red ? "opacity" : "locations")
      if look.red {
        breathe.fromValue = 1.0; breathe.toValue = 0.15
        breathe.duration = look.pulse; breathe.autoreverses = true; breathe.repeatCount = .infinity
        colours.add(breathe, forKey: "breathe")
      } else {
        let lo = Double(k) * 0.55
        breathe.fromValue = [0, NSNumber(value: lo * 0.35), NSNumber(value: lo)]
        breathe.toValue = [0, NSNumber(value: Double(k) * 0.35), NSNumber(value: Double(k))]
        breathe.duration = look.pulse / 2; breathe.autoreverses = true; breathe.repeatCount = .infinity
        breathe.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        mask.add(breathe, forKey: "breathe")
      }
    }
  }

  /// Ready flourish: the ring sweeps in at full thickness and settles.
  func flourish(duration: Double) {
    let swell = CAKeyframeAnimation(keyPath: "locations")
    swell.values = [[0, 0.02, 0.06], [0, 0.35, 1.0], [0, 0.12, 0.34]].map { $0.map { NSNumber(value: $0) } }
    swell.keyTimes = [0, 0.4, 1]
    swell.duration = duration
    swell.timingFunction = CAMediaTimingFunction(name: .easeOut)
    mask.add(swell, forKey: "flourish")
  }

  /// One palette period (colours + their 0…1 places), for the look.
  static func period(_ look: GlowLook) -> ([NSColor], [Double]) {
    if look.red { return ([.systemRed, .systemRed], [0, 1]) }
    if look.comet { return ([.clear, .clear, .systemRed, .systemGreen, .systemBlue, .clear], [0, 0.78, 0.85, 0.91, 0.97, 1.0]) }
    let rgb: [NSColor] = [.systemRed, .systemPink, .systemPurple, .systemBlue, .systemTeal, .systemGreen, .systemYellow, .systemOrange, .systemRed]
    return (rgb, rgb.indices.map { Double($0) / Double(rgb.count - 1) })
  }

  /// The period laid three times over the gradient (the gradient spans three perimeters).
  static func periods(_ look: GlowLook) -> ([CGColor], [NSNumber]) {
    let (colours, places) = period(look)
    var outC: [CGColor] = []; var outL: [NSNumber] = []
    for k in 0..<3 {
      for (i, c) in colours.enumerated() {
        if k > 0 && i == 0 { continue } // each period's first stop equals the previous period's last
        outC.append(c.cgColor); outL.append(NSNumber(value: (Double(k) + places[i]) / 3))
      }
    }
    return (outC, outL)
  }
}

/// The outline on every screen. Windows exist only while a look is showing; going dark closes them all.
final class GhostGlow {
  static let maxThickness: CGFloat = 28
  private var strips: [GlowStrip] = []
  private(set) var look: GlowLook?
  private var startTime: CFTimeInterval = 0
  private var hideWork: DispatchWorkItem?
  private var reduceMotion: Bool { NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }

  init() {
    NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { [weak self] _ in
      guard let self, let look = self.look else { return }
      self.teardown(); self.build(); self.apply(look, transition: 0)
    }
  }

  private func build() {
    startTime = CACurrentMediaTime()
    for screen in NSScreen.screens {
      for edge in [GlowStrip.Edge.top, .bottom, .left, .right] {
        strips.append(GlowStrip(screen: screen, edge: edge, maxThickness: GhostGlow.maxThickness))
      }
    }
    strips.forEach { $0.show() }
  }

  private func teardown() { strips.forEach { $0.close() }; strips.removeAll() }

  /// Window numbers of the strips on screen (demo / proof: capture just the glow, never the screen behind it).
  var windowNumbers: [Int] { strips.map { $0.window.windowNumber } }

  private func apply(_ look: GlowLook, transition: Double) {
    for s in strips { s.apply(look, startTime: startTime, transition: transition, reduceMotion: reduceMotion) }
  }

  /// Show a look (nil = go dark: fade, then close every window).
  func show(_ next: GlowLook?) {
    hideWork?.cancel(); hideWork = nil
    guard let next else {
      guard look != nil else { return }
      look = nil
      for s in strips { s.apply(GlowLook(thickness: 0.02, opacity: 0, turnSeconds: 0, pulse: 0), startTime: startTime, transition: 0.45, reduceMotion: true) }
      let work = DispatchWorkItem { [weak self] in self?.teardown() }
      hideWork = work
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.5, execute: work)
      return
    }
    if strips.isEmpty { build() }
    let first = look == nil
    look = next
    apply(next, transition: first ? 0 : 0.35)
  }

  /// The engine is up: the RGB ring sweeps in over the boot light, then settles into `then` (nil = dark).
  func ready(then: GlowLook?) {
    show(GlowLook(thickness: 0.34, opacity: 1, turnSeconds: 1.6, pulse: 0))
    strips.forEach { $0.flourish(duration: 1.3) }
    let work = DispatchWorkItem { [weak self] in self?.show(then) }
    hideWork = work
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.4, execute: work)
  }
}

// ── The app ───────────────────────────────────────────────────────────────────────────────────────────

// ── The spoken-words line ────────────────────────────────────────────────────────────────────────────

/// Bottom-centre transcription of the owner's accepted spoken command (operator 2026-10-13): the words Kingmaker
/// heard, shown while it works on them, so a mishearing is visible at a glance. It never takes focus and never blocks
/// the page under it (a non-activating, click-through panel), honours Reduce Motion and Reduce Transparency, and is
/// announced to VoiceOver, and excluded from screen sharing and recording. It only shows text the voice loop accepted
/// while awake (the CLI's "heard" field) and writes nothing itself; gone after `visibleSeconds` or when Kingmaker sleeps.
final class TranscriptPanel {
  static let visibleSeconds: TimeInterval = 8
  static let maxChars = 280
  let panel: NSPanel
  private let label = NSTextField(wrappingLabelWithString: "")
  private let backdrop = NSVisualEffectView()
  private var hideWork: DispatchWorkItem?
  private var wanted = false

  init() {
    panel = NSPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = true
    panel.ignoresMouseEvents = true          // click-through: the page under it keeps every click and scroll
    panel.becomesKeyOnlyIfNeeded = true
    panel.hidesOnDeactivate = false
    panel.isReleasedWhenClosed = false
    panel.level = .statusBar                 // above app windows, below the menu bar's own menus
    panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
    panel.animationBehavior = .none
    panel.sharingType = .none                // never in a screen share or recording (the owner's calls)
    backdrop.material = .hudWindow
    backdrop.blendingMode = .behindWindow
    backdrop.state = .active
    backdrop.appearance = NSAppearance(named: .vibrantDark)
    backdrop.wantsLayer = true
    backdrop.layer?.cornerRadius = 14
    backdrop.layer?.masksToBounds = true
    label.font = .systemFont(ofSize: 22, weight: .medium)
    label.textColor = .white
    label.alignment = .center
    label.maximumNumberOfLines = 3
    label.lineBreakMode = .byWordWrapping    // show() already keeps the newest words when it trims
    label.isSelectable = false
    label.setAccessibilityRole(.staticText)
    backdrop.addSubview(label)
    panel.contentView = backdrop
  }

  /// Whether the line is meant to be on screen (true from show until hide/timeout, independent of the fade).
  var isShowing: Bool { wanted }
  var text: String { label.stringValue }

  func show(_ heard: String) {
    var clean = heard.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression).trimmingCharacters(in: .whitespaces)
    guard !clean.isEmpty else { return }
    if clean.count > Self.maxChars { clean = "…" + String(clean.suffix(Self.maxChars - 1)) }
    wanted = true
    label.stringValue = clean
    label.setAccessibilityLabel("You said: \(clean)")
    let ws = NSWorkspace.shared
    if ws.accessibilityDisplayShouldReduceTransparency {
      backdrop.state = .inactive
      backdrop.layer?.backgroundColor = NSColor.black.withAlphaComponent(0.92).cgColor
    } else {
      backdrop.state = .active
      backdrop.layer?.backgroundColor = nil
    }
    // The screen the owner is looking at: the one under the pointer (an agent app has no key window).
    let pointer = NSEvent.mouseLocation
    if let screen = NSScreen.screens.first(where: { NSMouseInRect(pointer, $0.frame, false) }) ?? NSScreen.main ?? NSScreen.screens.first { layout(on: screen) }
    if !panel.isVisible {
      if ws.accessibilityDisplayShouldReduceMotion {
        panel.alphaValue = 1
        panel.orderFrontRegardless()
      } else {
        panel.alphaValue = 0
        panel.orderFrontRegardless()
        NSAnimationContext.runAnimationGroup { $0.duration = 0.15; panel.animator().alphaValue = 1 }
      }
    } else {
      panel.alphaValue = 1
    }
    NSAccessibility.post(element: NSApp as Any, notification: .announcementRequested,
                         userInfo: [.announcement: "You said: \(clean)", .priority: NSAccessibilityPriorityLevel.medium.rawValue])
    hideWork?.cancel()
    let work = DispatchWorkItem { [weak self] in self?.hide() }
    hideWork = work
    DispatchQueue.main.asyncAfter(deadline: .now() + Self.visibleSeconds, execute: work)
  }

  func hide() {
    hideWork?.cancel(); hideWork = nil
    wanted = false
    // The visible window is transient, and its accessibility value must be equally transient. Clear it before the
    // visibility guard so an already-ordered-out panel cannot retain the owner's last spoken words for VoiceOver.
    label.setAccessibilityLabel(nil)
    guard panel.isVisible else { label.stringValue = ""; return }
    if NSWorkspace.shared.accessibilityDisplayShouldReduceMotion {
      panel.orderOut(nil)
    } else {
      // A show() during the fade wins: only order out if nothing new arrived meanwhile.
      NSAnimationContext.runAnimationGroup({ $0.duration = 0.2; panel.animator().alphaValue = 0 }, completionHandler: { [weak self] in
        guard let self, !self.wanted else { return }
        self.panel.orderOut(nil); self.label.stringValue = ""
      })
      return
    }
    label.stringValue = ""
  }

  /// Centred, just above the Dock (the screen's visible frame), at most 760 pt wide.
  private func layout(on screen: NSScreen) {
    let vf = screen.visibleFrame
    let maxW = min(760, vf.width - 80), pad: CGFloat = 20
    let fit = label.sizeThatFits(NSSize(width: maxW - 2 * pad, height: 400))
    let w = min(maxW, max(220, ceil(fit.width) + 2 * pad)), h = ceil(fit.height) + 24
    let rect = NSRect(x: vf.midX - w / 2, y: vf.minY + 48, width: w, height: h)
    panel.setFrame(rect, display: true)
    backdrop.frame = NSRect(origin: .zero, size: rect.size)
    label.frame = NSRect(x: pad, y: 12, width: w - 2 * pad, height: ceil(fit.height))
  }
}

final class GhostApp: NSObject, NSApplicationDelegate {
  private struct ActiveProfile: Decodable {
    let schema: Int
    let profile: String
    let state: String
    let runtime_home: String
    let port: Int
  }
  private var mark: MenuBarMark?
  private var proc: Process?
  private var stdinPipe: Pipe?
  private var buffer = Data()
  private var state = "starting"
  private var lastLine = ""
  private var ready = false
  private var quitting = false
  private var textOnly = false                    // TEXT ONLY (Customize → Voice): the engine runs no voice at all
  private var restartAttempts = 0
  private var restartWork: DispatchWorkItem?
  /// A kingmaker://wake that arrived before voice was up (the link launched the app): sent once voice is ready.
  private var pendingWake = false
  /// A kingmaker://pair that arrived before the CLI was up: sent once it reports any state.
  private var pendingPair = false
  /// A kingmaker://tour that arrived before the CLI was up: asked for once it reports any state.
  private var pendingTour = false
  /// ChatGPT/Codex owns one governed conversation at a time. Kingmaker never speaks into it or opens a competing mic.
  private var lastInteractionOwner = ""
  /// The old screen-edge ring, only with KINGMAKER_EDGE_GLOW=1 (it is four windows per screen; the default has none).
  private let glow: GhostGlow? = ProcessInfo.processInfo.environment["KINGMAKER_EDGE_GLOW"] == "1" ? GhostGlow() : nil
  /// The spoken-words line at the bottom centre of the screen: built on the first words, never before.
  private var transcriptPanel: TranscriptPanel?
  private var transcript: TranscriptPanel { if let t = transcriptPanel { return t }; let t = TranscriptPanel(); transcriptPanel = t; return t }
  private let stateItem = NSMenuItem(title: "Starting Kingmaker…", action: nil, keyEquivalent: "")
  private let lastItem = NSMenuItem(title: "", action: nil, keyEquivalent: "")
  private let hostItem = NSMenuItem(title: "", action: nil, keyEquivalent: "")
  private var commandEntry: CommandEntryView?
  /// The Kingmaker bar (click the logo, or ⌥Space): typed turns, mute, on/off, the model and the / programs.
  private lazy var bar: KingmakerBar = {
    let b = KingmakerBar()
    b.onTurn = { [weak self] line in
      if let d = Data(base64Encoded: line), let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any], let t = o["text"] as? String { self?.barTyped[t] = Date() }
      self?.toCli("typed-turn \(line)")
    }
    b.onCommand = { [weak self] line in self?.toCli(line) }
    b.onKeySeal = { [weak self] b64 in self?.toCli("key-seal \(b64)") }
    b.onWake = { [weak self] in self?.requestWake(source: "bar mic") }
    b.onQuit = { [weak self] in self?.quitGhost() }
    b.onPower = { [weak self] on in self?.mark?.show(on ? MarkLook.forState(self?.state ?? "asleep") : .dim) }
    return b
  }()
  /// Typed turns echo back as "heard": the bar already shows those, so only spoken words are added there.
  private var barTyped: [String: Date] = [:]   // typed turns, for 2 minutes: their echoes are never shown a second time
  private var appliedPrefs = false
  @discardableResult private func toCli(_ line: String) -> Bool {
    guard let pipe = stdinPipe, proc?.isRunning == true else { bar.said("Kingmaker is still starting; try again in a moment."); return false }
    pipe.fileHandleForWriting.write("\(line)\n".data(using: .utf8)!)
    return true
  }

  private var headlessHostMode: Bool { SMAppService.mainApp.status == .enabled }

  private let runtimeApp = ProcessInfo.processInfo.environment["KINGMAKER_RUNTIME_APP"] ?? "/Applications/Kingmaker.app"
  /// The Node runtime to run the CLI with: this bundle's own (no Solomon.app needed), else the installed app's.
  private var runtimeBinary: (path: String, bundled: Bool) {
    let own = Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS/Solomon").path
    let runtime = Bundle.main.bundleURL.appendingPathComponent("Contents/Resources/solomon-runtime").path
    if FileManager.default.isExecutableFile(atPath: own) && FileManager.default.fileExists(atPath: runtime) { return (own, true) }
    return ("\(runtimeApp)/Contents/MacOS/Solomon", false)
  }
  private lazy var activeProfile: ActiveProfile? = {
    let home = URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true)
    let support = home.appendingPathComponent("Library/Application Support", isDirectory: true).standardizedFileURL
    let pointer = support.appendingPathComponent("Kingmaker/active-profile.json")
    guard let data = try? Data(contentsOf: pointer), let profile = try? JSONDecoder().decode(ActiveProfile.self, from: data),
          profile.schema == 1, profile.profile == "ronininc", (1024...65535).contains(profile.port) else { return nil }
    let state = URL(fileURLWithPath: profile.state, isDirectory: true).standardizedFileURL
    let runtime = URL(fileURLWithPath: profile.runtime_home, isDirectory: true).standardizedFileURL
    let prefix = support.path + "/"
    guard state.path.hasPrefix(prefix), runtime.path.hasPrefix(prefix) else { return nil }
    return profile
  }()
  private var stateDir: URL {
    if let profile = activeProfile { return URL(fileURLWithPath: profile.state, isDirectory: true) }
    return URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support/sol-ghost", isDirectory: true)
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    buildEditMenu()
    watchFnKey()
    buildMenuBar()
    _ = barLinkKey()
    if ProcessInfo.processInfo.environment["SOL_GHOST_GLOW_DEMO"] == "1" { demo(); return }
    if ProcessInfo.processInfo.environment["SOL_GHOST_GLOW_ATTACH"] == "1" { attach(); return }
    // KINGMAKER_TOUR_DEMO=<{"tour":…} from lib/first-run.mjs tourMessage>: the bar and its tour, no engine (a look check).
    if let demo = ProcessInfo.processInfo.environment["KINGMAKER_TOUR_DEMO"], let d = demo.data(using: .utf8),
       let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any], let t = o["tour"] as? [String: Any] {
      bar.onCommand = { line in print("@@tour \(line)"); fflush(stdout) }
      bar.startTour(t); return
    }
    // ghost-os runs under this app, so macOS asks THIS app for Accessibility. Ask once per build, never at every launch:
    // an ad-hoc signed rebuild is a new app to macOS (the switch shown on is the old build's), so asking each launch nagged.
    // Customize > Permissions still shows it and opens the right page.
    if !AXIsProcessTrusted() {
      let exe = Bundle.main.executableURL.flatMap { try? FileManager.default.attributesOfItem(atPath: $0.path) }
      let build = "\((exe?[.size] as? NSNumber)?.intValue ?? 0)-\(Int((exe?[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0))"
      if UserDefaults.standard.string(forKey: "km.axAskedFor") != build {
        UserDefaults.standard.set(build, forKey: "km.axAskedFor")
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        _ = AXIsProcessTrustedWithOptions(options)
      }
    }
    glow?.show(.booting)
    render()
    launch()
    NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { [weak self] _ in
      self?.sendInteractionOwner()
    }
    // Auto-update on events, never a timer: once at launch and again whenever the Mac wakes from sleep.
    checkForUpdate(reason: "launch")
    NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in
      self?.checkForUpdate(reason: "wake")
    }
  }

  /// Asks the running Kingmaker to check for a newer published build. It never installs from here: a newer build is
  /// asked about aloud the next time Kingmaker is woken, and installs only on a spoken yes.
  private func checkForUpdate(reason: String) {
    guard let pipe = stdinPipe, proc?.isRunning == true else { return }
    log("update check (\(reason))")
    pipe.fileHandleForWriting.write("update-check\n".data(using: .utf8)!)
  }

  /// SOL_GHOST_GLOW_DEMO=1: every state in order, as the CLI would drive them, then quit. Prints each state, what the
  /// logo shows and how many windows the app has (0 unless KINGMAKER_EDGE_GLOW=1) on stdout.
  private func demo() {
    let steps: [(String, Double)] = [("starting", 3), ("asleep", 3), ("awake", 3), ("hearing", 4), ("thinking", 3), ("speaking", 3), ("waiting", 3), ("asleep", 2)]
    var at = 0.0
    for (s, secs) in steps {
      DispatchQueue.main.asyncAfter(deadline: .now() + at) { [weak self] in
        guard let self else { return }
        if s == "starting" { self.glow?.show(.booting); self.mark?.show(.dim) } else { self.transition(to: s) }
        if s == "thinking" { self.transcript.show("Open the pull request for the reminder fix and run its tests") }
        self.render()
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
          let item = self.mark?.item.button?.window
          print(self.transcriptReport()); fflush(stdout)
          print("demo state=\(s) logo=\(self.mark.map { "\($0.look)" } ?? "none") windows=\(NSApp.windows.filter { $0.isVisible && $0.className != "NSStatusBarWindow" }.count) item=\(item?.windowNumber ?? 0) frame=\(item.map { NSStringFromRect($0.frame) } ?? "-")"); fflush(stdout)
        }
      }
      at += secs
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + at) { NSApp.terminate(nil) }
  }

  /// One line describing the transcript panel, for the demo/attach self-checks (no words, only geometry and flags).
  private func transcriptReport() -> String {
    let p = transcript.panel
    let screen = (NSScreen.main ?? NSScreen.screens.first)?.visibleFrame ?? .zero
    return "@@transcript shown=\(transcript.isShowing) chars=\(transcript.text.count) frame=\(NSStringFromRect(p.frame)) centredX=\(abs(p.frame.midX - screen.midX) < 1) aboveDock=\(p.frame.minY >= screen.minY) clickThrough=\(p.ignoresMouseEvents) canBecomeKey=\(p.canBecomeKey) level=\(p.level.rawValue) sharing=\(p.sharingType == .none ? "none" : "visible")"
  }

  /// SOL_GHOST_GLOW_ATTACH=1: the indicator for a CLI-started Kingmaker. The CLI owns the engine; this only shows the
  /// logo. "@@glow ready" on stdout is the handshake the CLI waits for; when the CLI goes (stdin closes), the logo goes
  /// with it.
  private func attach() {
    ready = true
    glow?.ready(then: nil)
    mark?.show(.plain)
    print("@@glow ready windows=\(glow?.windowNumbers ?? [])"); fflush(stdout)
    let input = FileHandle.standardInput
    input.readabilityHandler = { [weak self] handle in
      let chunk = handle.availableData
      if chunk.isEmpty {
        handle.readabilityHandler = nil
        DispatchQueue.main.async { self?.quitting = true; self?.glow?.show(nil); NSApp.terminate(nil) }
        return
      }
      DispatchQueue.main.async { self?.consume(chunk) }
    }
  }

  /// A main menu with Edit (never shown: Kingmaker has no menu bar of its own), so every text box gets copy and paste.
  private func buildEditMenu() {
    let main = NSMenu(), appItem = NSMenuItem(), editItem = NSMenuItem()
    main.addItem(appItem); main.addItem(editItem)
    let appMenu = NSMenu(); appMenu.addItem(withTitle: UI.t("Quit Kingmaker"), action: #selector(quitGhost), keyEquivalent: "q").target = self
    appItem.submenu = appMenu
    let edit = NSMenu(title: "Edit")
    edit.addItem(withTitle: UI.t("Undo"), action: Selector(("undo:")), keyEquivalent: "z")
    let redo = edit.addItem(withTitle: UI.t("Redo"), action: Selector(("redo:")), keyEquivalent: "z"); redo.keyEquivalentModifierMask = [.command, .shift]
    edit.addItem(.separator())
    edit.addItem(withTitle: UI.t("Cut"), action: #selector(NSText.cut(_:)), keyEquivalent: "x")
    edit.addItem(withTitle: UI.t("Copy"), action: #selector(NSText.copy(_:)), keyEquivalent: "c")
    edit.addItem(withTitle: UI.t("Paste"), action: #selector(NSText.paste(_:)), keyEquivalent: "v")
    edit.addItem(withTitle: UI.t("Select All"), action: #selector(NSResponder.selectAll(_:)), keyEquivalent: "a")
    editItem.submenu = edit
    NSApp.mainMenu = main
  }

  /// The Ronin Inc logo in the menu bar, with one status line and Quit in its menu.
  private func buildMenuBar() {
    let menu = NSMenu()
    stateItem.isEnabled = false
    lastItem.isEnabled = false
    menu.addItem(stateItem)
    menu.addItem(lastItem)
    hostItem.isEnabled = false
    menu.addItem(hostItem)
    menu.addItem(.separator())
    let commandItem = NSMenuItem()
    let entry = CommandEntryView { [weak self] command in self?.submitTextCommand(command) }
    commandEntry = entry
    commandItem.view = entry
    menu.addItem(commandItem)
    menu.addItem(.separator())
    let tourItem = NSMenuItem(title: "Show the Tour", action: #selector(showTourAgain), keyEquivalent: "")
    tourItem.target = self
    menu.addItem(tourItem)
    let disableHost = NSMenuItem(title: "Disable Headless Host Mode", action: #selector(disableHeadlessHost), keyEquivalent: "")
    disableHost.target = self
    menu.addItem(disableHost)
    let quit = NSMenuItem(title: "Quit Kingmaker", action: #selector(quitGhost), keyEquivalent: "q")
    quit.target = self
    menu.addItem(quit)
    // A left click opens the Kingmaker bar (talking is its mic button, or the wake word); right-click is the menu.
    mark = MenuBarMark(menu: menu) { [weak self] in self?.bar.toggle() }
    kingmakerHotKeyAction = { [weak self] in self?.bar.toggle() }
    registerKingmakerHotKey()
    mark?.show(.dim)
  }

  /// Text typed in the dropdown is framed as one base64 payload, so embedded newlines can never impersonate the
  /// app's quit/wake/owner protocol. The CLI decodes it and runs one governed owner turn.
  private func submitTextCommand(_ command: String) {
    guard let pipe = stdinPipe, proc?.isRunning == true else {
      lastLine = "Kingmaker is still starting; try that command again in a moment."
      render()
      return
    }
    let payload = Data(command.utf8).base64EncodedString()
    pipe.fileHandleForWriting.write("typed-command \(payload)\n".data(using: .utf8)!)
    lastLine = "Typed command sent"
    render()
  }

  private func label(_ s: String) -> String {
    switch s {
    case "asleep": return "Asleep. Click the logo or say “Hey Siri, wake Kingmaker”"
    case "awake": return "Awake: I can hear you"
    case "hearing": return "Listening to you…"
    case "thinking": return "Working on it…"
    case "speaking": return "Speaking (talk over me to stop)"
    case "waiting": return "Waiting for your word"
    case "down": return "Not listening"
    case "text": return "Text only: click the logo or press ⌥Space to type"
    case "idle": return textOnly ? "Text only: click the logo or press ⌥Space to type" : "Ready"
    default: return "Starting Kingmaker…"
    }
  }

  private func render() {
    let text = label(state)
    mark?.item.button?.toolTip = "Kingmaker: \(text)"
    mark?.item.button?.setAccessibilityLabel("Kingmaker: \(text)")
    stateItem.title = text
    lastItem.isHidden = lastLine.isEmpty
    lastItem.title = lastLine.count > 90 ? String(lastLine.prefix(89)) + "…" : lastLine
    hostItem.title = headlessHostMode
      ? "Headless Host: on · power connected · lid open · display may sleep"
      : "Headless Host: off"
  }

  /// A new CLI state → the logo (and the edge ring when it is on). The first state after boot is "ready".
  private func transition(to next: String) {
    let previous = state
    state = next
    mark?.show(MarkLook.forState(next))
    if next == "asleep" || next == "down" || next == "text" { transcriptPanel?.hide() } // nothing lingers once it stops listening
    if next == "down" {
      glow?.show(.down)
      // The engine is not listening: the logo goes red, then the app follows it out.
      if !quitting && !headlessHostMode { DispatchQueue.main.asyncAfter(deadline: .now() + 2.4) { NSApp.terminate(nil) } }
      return
    }
    if !ready && next != "starting" {
      ready = true
      glow?.ready(then: GlowLook.forState(next))
      return
    }
    if previous != next { glow?.show(GlowLook.forState(next)) }
  }

  private func launch() {
    appliedPrefs = false // a fresh engine gets the owner's off/mute again
    let (binary, bundled) = runtimeBinary
    guard FileManager.default.isExecutableFile(atPath: binary), let resources = Bundle.main.resourceURL else {
      lastLine = bundled ? "This Kingmaker.app is missing its runtime. Reinstall it (Kingmaker Installer), or rebuild it (the engine build)." : "No engine runtime: this build carries none and there is none at \(runtimeApp)."
      log(lastLine)
      transition(to: "down"); render(); return
    }
    // lib/kingmaker.mjs checks the payload is whole before anything loads; an older payload has only lib/cli.mjs.
    let entry = resources.appendingPathComponent("sol-ghost/lib/kingmaker.mjs").path
    let cli = FileManager.default.fileExists(atPath: entry) ? entry : resources.appendingPathComponent("sol-ghost/lib/cli.mjs").path
    let extra = (ProcessInfo.processInfo.environment["SOL_GHOST_ARGS"] ?? "").split(separator: " ").map(String.init)
    let p = Process()
    p.executableURL = URL(fileURLWithPath: binary)
    // Customize → Voice: auto (text only on an 8 GB Mac, voice above), voice or text. The engine decides (lib/ring.mjs).
    let voiceMode = UserDefaults.standard.string(forKey: "km.voiceMode") ?? "auto"
    p.arguments = [cli, "start", "--agent", "--voice-mode", ["auto", "voice", "text"].contains(voiceMode) ? voiceMode : "auto"] + extra
    var env = ProcessInfo.processInfo.environment
    env["ELECTRON_RUN_AS_NODE"] = "1"
    env["KINGMAKER_HEADLESS_HOST_MODE"] = headlessHostMode ? "1" : "0"
    if let profile = activeProfile {
      env["SOL_GHOST_HOME"] = profile.state
      env["SOL_GHOST_RUNTIME_HOME"] = profile.runtime_home
      env["SOL_GHOST_PORT"] = String(profile.port)
    }
    p.environment = env
    let out = Pipe()
    let input = Pipe()
    p.standardOutput = out
    p.standardInput = input
    try? FileManager.default.createDirectory(at: stateDir.appendingPathComponent("logs"), withIntermediateDirectories: true)
    let logURL = stateDir.appendingPathComponent("logs/app.log")
    FileManager.default.createFile(atPath: logURL.path, contents: nil)
    p.standardError = (try? FileHandle(forWritingTo: logURL)) ?? FileHandle.nullDevice
    out.fileHandleForReading.readabilityHandler = { [weak self] handle in
      let chunk = handle.availableData
      // Empty = end of file (the CLI exited). Detach, or macOS calls this again at once, forever: measured
      // 2026-10-07 at ~95% of a core for over an hour after the backend died, with nothing left to read.
      if chunk.isEmpty { handle.readabilityHandler = nil; return }
      DispatchQueue.main.async { self?.consume(chunk) }
    }
    p.terminationHandler = { [weak self] proc in
      DispatchQueue.main.async {
        guard let self else { return }
        if self.quitting { return }
        if self.lastLine.isEmpty || proc.terminationStatus != 0 { self.lastLine = "The engine stopped (exit \(proc.terminationStatus)). Log: ~/Library/Application Support/sol-ghost/logs" }
        self.log(self.lastLine)
        if self.headlessHostMode && self.restartAttempts < 3 {
          let delays: [Double] = [1, 3, 9]
          let delay = delays[self.restartAttempts]
          self.restartAttempts += 1
          self.lastLine = "The engine stopped (exit \(proc.terminationStatus)); restarting in \(Int(delay))s (\(self.restartAttempts)/3)."
          self.transition(to: "starting")
          self.render()
          let work = DispatchWorkItem { [weak self] in self?.launch() }
          self.restartWork = work
          DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
        } else {
          self.transition(to: "down")
          self.render()
        }
      }
    }
    do { try p.run(); proc = p; stdinPipe = input; sendInteractionOwner(force: true); if restartAttempts > 0 { log("Engine process relaunched (attempt \(restartAttempts))") } } catch {
      lastLine = "Couldn't start the engine: \(error.localizedDescription)"
      log(lastLine)
      transition(to: "down"); render()
    }
  }

  private func consume(_ chunk: Data) {
    buffer.append(chunk)
    while let nl = buffer.firstIndex(of: 0x0A) {
      let lineData = buffer.subdata(in: buffer.startIndex..<nl)
      buffer.removeSubrange(buffer.startIndex...nl)
      guard let line = String(data: lineData, encoding: .utf8)?.trimmingCharacters(in: .whitespaces), !line.isEmpty else { continue }
      if line.hasPrefix("@@ghost "), let json = line.dropFirst(8).data(using: .utf8),
         let obj = try? JSONSerialization.jsonObject(with: json) as? [String: Any] {
        if let spoken = obj["line"] as? String { lastLine = spoken }
        if let line = obj["said"] as? String { bar.said(line) }
        if let next = obj["suggest"] as? String { bar.suggest(next) }
        if let src = obj["sources"] as? [[String: Any]] { bar.showSources(src) }
        if let cmds = obj["commands"] as? [[String: Any]] { bar.setCommands(cmds) }
        if let img = obj["image"] as? [String: Any], let path = img["path"] as? String { bar.showImage(path) }
        if let cal = obj["calibration"] as? [String: Any] { bar.showCalibration(cal) }
        if let flow = obj["flow"] as? [String: Any] { bar.showFlow(flow) }
        if let arts = obj["artifacts"] as? [[String: Any]] { bar.setArtifacts(arts) }
        if let stage = obj["stage"] as? Bool { bar.setStage(stage) } else if (obj["stage"] as? String) == "aside" { bar.stageAside() }
        if let box = obj["shareAsk"] as? [String: Any] { bar.showShareBox(box) }
        if let box = obj["approvalAsk"] as? [String: Any] { bar.showShareBox(box) }
        if obj["approvalAskClose"] != nil { bar.closeApprovalBox() }
        if let list = obj["extensions"] as? [[String: Any]] { bar.setExtensions(list) }
        if let p = obj["extInstall"] as? [String: Any] { bar.extInstalling(p) }
        if let b = obj["beside"] as? [String: Any], let u = b["url"] as? String { bar.showBeside(u, title: (b["title"] as? String) ?? "") }
        if obj.keys.contains("keyRequest"), obj["keyRequest"] is NSNull, obj["keyResult"] != nil { bar.endBeside() }
        if let sharing = obj["sharing"] as? Bool { bar.setSharing(sharing) }
        if let skills = obj["crmSkills"] as? [[String: Any]] { bar.setCrmSkills(skills, from: obj["crmSkillsFrom"] as? String, problem: obj["crmSkillsProblem"] as? String) }
        if obj.keys.contains("partial") { bar.partial(obj["partial"] as? String) }   // live dictation while fn is held
        if let list = obj["connectors"] as? [[String: Any]] { bar.setConnectors(list, result: obj["connectorResult"] as? [String: Any]) }
        if let screen = obj["screen"] as? [String: Any] { bar.showScreen(screen) }
        if let tour = obj["tour"] as? [String: Any] { bar.startTour(tour) }
        if let m = obj["muted"] as? Bool { bar.setMuted(m) }
        if let p = obj["power"] as? String { bar.setPower(p == "on") }
        if obj.keys.contains("keyRequest") { bar.keyRequested(obj["keyRequest"] as? [String: Any], result: obj["keyResult"] as? [String: Any]) }
        if let reason = obj["reason"] as? String { lastLine = reason }
        if let heard = obj["heard"] as? String {
          barTyped = barTyped.filter { Date().timeIntervalSince($0.value) < 120 }
          let typed = barTyped[heard] != nil
          // What was said always goes into the conversation (and bar.log), open bar or not: with the bar closed (fn to talk)
          // the words only reached the caption and were lost (owner, 2026-10-15: "there's no record of what I said").
          if !typed { bar.heard(heard) }
          // The caption overlay is for spoken words; with the bar open the words are already in it.
          if !typed && !bar.panel.isVisible { transcript.show(heard) }
          if ProcessInfo.processInfo.environment["SOL_GHOST_GLOW_ATTACH"] == "1" { print(transcriptReport()); fflush(stdout) }
        }
        if let t = obj["textOnly"] as? Bool { textOnly = t; bar.setTextOnly(t) }
        if let s = obj["state"] as? String {
          // The first state from a (re)started engine: put back what the owner set (off, muted) before anything is heard.
          if !appliedPrefs, s != "starting" {
            appliedPrefs = true
            if bar.wantsOff { toCli("power off") } else if bar.muted { toCli("voice-out off") }
            toCli("tour-check")   // the first-run tour, if this Mac hasn't seen it (lib/first-run.mjs)
          }
          if pendingTour { pendingTour = false; toCli("tour-start") }
          transition(to: s)
          if !bar.on { mark?.show(.dim) }
          bar.setState(s)
          if pendingPair, let pipe = stdinPipe {
            pendingPair = false
            pipe.fileHandleForWriting.write("pair\n".data(using: .utf8)!)
          }
          if let line = pendingCompanion, let pipe = stdinPipe {
            pendingCompanion = nil
            pipe.fileHandleForWriting.write("\(line)\n".data(using: .utf8)!)
          }
          if pendingWake, ["asleep", "awake"].contains(s), let pipe = stdinPipe {
            pendingWake = false
            pipe.fileHandleForWriting.write("wake\n".data(using: .utf8)!)
          }
          if ProcessInfo.processInfo.environment["SOL_GHOST_GLOW_ATTACH"] == "1", s == "asleep" {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { [weak self] in print("@@transcript after-sleep onScreen=\(self?.transcriptPanel?.panel.isVisible ?? false)"); fflush(stdout) }
          }
          if ProcessInfo.processInfo.environment["SOL_GHOST_GLOW_ATTACH"] == "1" { print("@@glow state=\(s) logo=\(mark.map { "\($0.look)" } ?? "none") windows=\(glow?.windowNumbers ?? []) transcript=\(transcriptPanel?.isShowing ?? false)"); fflush(stdout) }
        }
      } else if line.hasPrefix("✗") || line.hasPrefix("Rules:") || line.hasPrefix("Hands:") {
        lastLine = line
      }
      render()
    }
  }

  /// One line in the app log (stderr of the CLI goes to the same file).
  private func log(_ line: String) {
    let url = stateDir.appendingPathComponent("logs/app.log")
    guard let h = try? FileHandle(forWritingTo: url) else { return }
    h.seekToEndOfFile()
    h.write("[app] \(line)\n".data(using: .utf8)!)
    try? h.close()
  }

  @objc private func quitGhost() {
    stopEngine()
    NSApp.terminate(nil)
  }

  @objc private func disableHeadlessHost() {
    do {
      if SMAppService.mainApp.status == .enabled || SMAppService.mainApp.status == .requiresApproval { try SMAppService.mainApp.unregister() }
      render()
    } catch {
      lastLine = "Could not disable Headless Host Mode: \(error.localizedDescription)"
      render()
    }
  }

  func applicationWillTerminate(_ notification: Notification) { stopEngine() }

  /// kingmaker://wake (or the old solghost://wake): "Hey Siri, wake Kingmaker" (a Shortcut that opens this link) or
  /// `kingmaker wake`. macOS launches
  /// the app for it when it isn't running; once voice is up the CLI is told to wake, says "I'm here.", and takes the
  /// next words as a command. Waking never approves anything.
  func application(_ application: NSApplication, open urls: [URL]) {
    for url in urls where ["kingmaker", "solghost"].contains(url.scheme?.lowercased() ?? "") {
      switch (url.host ?? "").lowercased() {
      case "wake": requestWake(source: "link")
      // kingmaker://pair: the site's "Pair this Mac" link. The link carries nothing (no code, no key); the CLI asks the
      // CRM for a pairing and shows its code, and only the owner's tap on the site gives this Mac anything.
      case "pair": requestPair()
      // kingmaker://tour (`kingmaker tour`): the first-run tour again, in the bar.
      case "tour": if proc?.isRunning == true, stdinPipe != nil { toCli("tour-start") } else { pendingTour = true }
      // kingmaker://companion?op=start|stop|status: the Ronin launcher (`open -g`) asks for the iPhone companion, which
      // runs inside the engine (lib/phone-companion.mjs). Never shows the bar or takes focus.
      case "companion": if let line = companionControlLine(url) { requestCompanion(line) }
      // kingmaker://bar?text=…: the text goes in the bar's box for you to send. With &key=<the bar link key> (a random
      // secret in a 0600 file only this Mac's user can read) it's sent at once; a link from a web page can't know it.
      case "bar":
        let q = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let text = (q.first { $0.name == "text" || $0.name == "send" }?.value ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let key = q.first { $0.name == "key" }?.value ?? ""
        let send = !key.isEmpty && key == barLinkKey()
        if text.isEmpty { bar.show() } else { bar.fromLink(text, send: send) }
      default: break
      }
    }
  }

  // ── Hold fn to talk (Customize → Hold to talk; on by default) ──
  // fn down: Kingmaker stops talking (its voice to zero) and listens; everything said until fn comes up is one command.
  // fn used with another key (fn+F1, fn+arrow) is a shortcut, not talking: that hold is cancelled and nothing is sent.
  // Seeing fn outside Kingmaker needs Accessibility, which Kingmaker already asks for.
  private var fnHeld = false
  private var fnMonitors: [Any] = []
  private func watchFnKey() {
    let onFlags: (NSEvent) -> Void = { [weak self] e in
      guard let self, e.keyCode == 63, (UserDefaults.standard.string(forKey: "km.ptt") ?? "fn") == "fn", !self.textOnly, self.proc?.isRunning == true else { return }
      let down = e.modifierFlags.contains(.function)
      if down && !self.fnHeld { self.fnHeld = true; self.toCli("ptt down") }
      else if !down && self.fnHeld { self.fnHeld = false; self.toCli("ptt up") }
    }
    let onKey: (NSEvent) -> Void = { [weak self] _ in
      guard let self, self.fnHeld else { return }
      self.fnHeld = false; self.toCli("ptt cancel")
    }
    if let g = NSEvent.addGlobalMonitorForEvents(matching: .flagsChanged, handler: onFlags) { fnMonitors.append(g) }
    if let g = NSEvent.addGlobalMonitorForEvents(matching: .keyDown, handler: onKey) { fnMonitors.append(g) }
    if let l = NSEvent.addLocalMonitorForEvents(matching: .flagsChanged, handler: { onFlags($0); return $0 }) { fnMonitors.append(l) }
    if let l = NSEvent.addLocalMonitorForEvents(matching: .keyDown, handler: { onKey($0); return $0 }) { fnMonitors.append(l) }
  }

  /// The bar link key: made once, kept in the state folder, readable by this Mac's user only.
  private func barLinkKey() -> String {
    let url = stateDir.appendingPathComponent("bar-link.key")
    if let k = try? String(contentsOf: url, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines), k.count >= 32 { return k }
    var bytes = [UInt8](repeating: 0, count: 24)
    _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
    let k = bytes.map { String(format: "%02x", $0) }.joined()
    FileManager.default.createFile(atPath: url.path, contents: k.data(using: .utf8), attributes: [.posixPermissions: 0o600])
    return k
  }

  /// A kingmaker://companion that arrived before the CLI was up: sent once it reports any state (the latest one wins).
  private var pendingCompanion: String?
  private func requestCompanion(_ line: String) {
    log("companion \(line.split(separator: " ").last ?? "") requested by link")
    if let pipe = stdinPipe, proc?.isRunning == true {
      pipe.fileHandleForWriting.write("\(line)\n".data(using: .utf8)!)
    } else {
      pendingCompanion = line
    }
  }

  @objc private func showTourAgain() { toCli("tour-start") }

  private func requestPair() {
    log("pairing requested by link")
    if let pipe = stdinPipe, proc?.isRunning == true {
      pipe.fileHandleForWriting.write("pair\n".data(using: .utf8)!)
    } else {
      pendingPair = true
    }
  }

  /// The one wake path, for the link and a click on the menu bar logo: the CLI is told to wake (it says "I'm here." and
  /// takes the next words as a command, with no wake word). Only ever "wake": it can't approve, confirm or send.
  private func requestWake(source: String) {
    log("wake requested by \(source)")
    if let pipe = stdinPipe, ["asleep", "awake", "waiting"].contains(state) {
      pipe.fileHandleForWriting.write("wake\n".data(using: .utf8)!)
    } else {
      pendingWake = true
    }
  }

  /// The OpenAI desktop apps currently share a bundle id, so the visible application name is the identity boundary.
  /// A Kingmaker menu-bar activation does not release an existing lease; switching to any other app does.
  private func sendInteractionOwner(force: Bool = false) {
    guard let pipe = stdinPipe, proc?.isRunning == true else { return }
    let active = NSWorkspace.shared.frontmostApplication?.localizedName?.lowercased() ?? ""
    if active == "kingmaker" { return }
    let owner = active == "chatgpt" ? "chatgpt" : (active == "codex" ? "codex" : "none")
    if !force && owner == lastInteractionOwner { return }
    lastInteractionOwner = owner
    pipe.fileHandleForWriting.write("interaction-owner \(owner)\n".data(using: .utf8)!)
  }

  private func stopEngine() {
    quitting = true
    restartWork?.cancel()
    glow?.show(nil)
    guard let p = proc, p.isRunning else { return }
    stdinPipe?.fileHandleForWriting.write("quit\n".data(using: .utf8)!)
    // The engine gets up to 25 s to finish writing, then it is stopped.
    let deadline = Date().addingTimeInterval(25)
    while p.isRunning && Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.2)) }
    if p.isRunning { p.terminate() }
  }
}

// BEGIN commandLibraryFilter (test/command-list.test.mjs runs this function on its own)
/// The command library's search: every word typed must appear in an entry's title, its detail or its category's name, in
/// any case; a category with nothing left is left out. Nothing typed: everything.
func commandLibraryFilter(_ groups: [[String: Any]], _ query: String) -> [[String: Any]] {
  let words = query.lowercased().split(whereSeparator: { $0 == " " }).map(String.init)
  if words.isEmpty { return groups }
  return groups.compactMap { g in
    let cat = ((g["title"] as? String) ?? "").lowercased()
    let items = ((g["items"] as? [[String: Any]]) ?? []).filter { it in
      let hay = "\((it["title"] as? String) ?? "") \((it["detail"] as? String) ?? "") \(cat)".lowercased()
      return words.allSatisfy { hay.contains($0) }
    }
    if items.isEmpty { return nil }
    var kept = g; kept["items"] = items
    return kept
  }
}
// END commandLibraryFilter

/// One entry in the library: an icon tile, the entry, and (smaller) what it does or what to press. Hover lights it the
/// Ronin way; a click picks it.
final class CommandTile: NSView {
  var onPick: () -> Void = {}
  var picked = false { didSet { layer?.backgroundColor = NSColor.white.withAlphaComponent(picked ? 0.08 : 0).cgColor } }
  override var isFlipped: Bool { true }
  override init(frame: NSRect) { super.init(frame: frame); wantsLayer = true; layer?.cornerRadius = 6 }
  required init?(coder: NSCoder) { nil }
  override func updateTrackingAreas() {
    trackingAreas.forEach(removeTrackingArea)
    addTrackingArea(NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self))
  }
  override func mouseEntered(with e: NSEvent) { if !picked { layer?.backgroundColor = NSColor.white.withAlphaComponent(0.05).cgColor } }
  override func mouseExited(with e: NSEvent) { if !picked { layer?.backgroundColor = NSColor.clear.cgColor } }
  override func mouseDown(with e: NSEvent) { onPick() }
  override func resetCursorRects() { addCursorRect(bounds, cursor: .pointingHand) }
}

/// THE COMMAND LIBRARY: a glassy dark panel over the bar. The header (COMMAND LIBRARY and a count), a search bar that
/// filters as you type (↵ takes the first entry that fills the box, Esc closes), and every category as a column, the
/// way the Ronin Inc site's mega menu lays out its sections. Clicking outside closes it.
final class CommandLibrary: NSObject, NSWindowDelegate, NSSearchFieldDelegate {
  var onFill: (String) -> Void = { _ in }
  private let window: NSPanel
  private let glass = NSVisualEffectView()
  private let tint = NSView()
  private let heading = NSTextField(labelWithString: "")
  private let count = NSTextField(labelWithString: "")
  private let search = NSSearchField()
  private let scroll = NSScrollView()
  private let body = FlippedView()
  private let empty = NSTextField(labelWithString: "")
  private var groups: [[String: Any]] = []
  private var firstFill: String?

  private static let serif = NSFont(name: "BodoniSvtyTwoITCTT-Bold", size: 15) ?? NSFont(name: "Didot-Bold", size: 15) ?? .boldSystemFont(ofSize: 14)
  private static let mono = NSFont.monospacedSystemFont(ofSize: 10, weight: .medium)
  private static let ink = NSColor(srgbRed: 0.949, green: 0.941, blue: 0.918, alpha: 1)      // the site's --nv-ink, #f2f0ea
  private static let line = NSColor(srgbRed: 0.949, green: 0.941, blue: 0.918, alpha: 0.14)

  override init() {
    window = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 1040, height: 660), styleMask: [.titled, .closable, .resizable, .fullSizeContentView], backing: .buffered, defer: true)
    super.init()
    window.titleVisibility = .hidden; window.titlebarAppearsTransparent = true; window.isMovableByWindowBackground = true
    window.isReleasedWhenClosed = false; window.hidesOnDeactivate = false; window.appearance = NSAppearance(named: .darkAqua)
    window.minSize = NSSize(width: 560, height: 420); window.delegate = self; window.isOpaque = false; window.backgroundColor = .clear
    for b in [NSWindow.ButtonType.miniaturizeButton, .zoomButton] { window.standardWindowButton(b)?.isHidden = true }
    glass.material = .hudWindow; glass.blendingMode = .behindWindow; glass.state = .active
    glass.wantsLayer = true; glass.layer?.cornerRadius = 14; glass.layer?.masksToBounds = true
    glass.layer?.borderWidth = 1; glass.layer?.borderColor = Self.line.cgColor
    tint.wantsLayer = true; tint.layer?.backgroundColor = NSColor.black.withAlphaComponent(0.42).cgColor
    heading.attributedStringValue = NSAttributedString(string: "COMMAND LIBRARY", attributes: [.font: Self.mono, .kern: 3.0, .foregroundColor: Self.ink.withAlphaComponent(0.55)])
    count.font = Self.mono; count.textColor = Self.ink.withAlphaComponent(0.4); count.alignment = .right
    search.placeholderString = "What do you want to do? Try poster, approve, keys, mute, overnight…"
    search.font = .systemFont(ofSize: 15); search.delegate = self; search.focusRingType = .none
    search.sendsSearchStringImmediately = true; search.setAccessibilityLabel("Search commands")
    scroll.documentView = body; scroll.drawsBackground = false; scroll.hasVerticalScroller = true; scroll.autohidesScrollers = true
    scroll.scrollerStyle = .overlay; scroll.borderType = .noBorder
    empty.font = .systemFont(ofSize: 14); empty.textColor = Self.ink.withAlphaComponent(0.5); empty.alignment = .center; empty.isHidden = true
    let root = NSView()
    for v in [glass, tint, heading, count, search, scroll, empty] as [NSView] { root.addSubview(v) }
    window.contentView = root
  }

  /// Open it over the bar, centred on the bar's screen, the search bar ready for typing.
  func show(_ groups: [[String: Any]], over bar: NSWindow) {
    self.groups = groups
    window.level = NSWindow.Level(rawValue: bar.level.rawValue + 1)
    if !window.isVisible, let f = (bar.screen ?? NSScreen.main)?.visibleFrame {
      let w = min(1040, f.width - 80), h = min(660, f.height - 80)
      window.setFrame(NSRect(x: f.midX - w / 2, y: f.midY - h / 2, width: w, height: h), display: false)
    }
    search.stringValue = ""
    render()
    window.makeKeyAndOrderFront(nil)
    window.makeFirstResponder(search)
  }
  func close() { window.orderOut(nil) }

  func windowDidResignKey(_ n: Notification) { close() }          // a click outside closes it
  func windowDidResize(_ n: Notification) { render() }
  func controlTextDidChange(_ n: Notification) { render() }
  func control(_ control: NSControl, textView: NSTextView, doCommandBy sel: Selector) -> Bool {
    if sel == #selector(NSResponder.cancelOperation(_:)) { if search.stringValue.isEmpty { close() } else { search.stringValue = ""; render() }; return true }
    if sel == #selector(NSResponder.insertNewline(_:)) { if let f = firstFill { pick(f) }; return true }
    return false
  }
  private func pick(_ fill: String) { close(); onFill(fill) }

  private func render() {
    guard let root = window.contentView else { return }
    let W = root.bounds.width, H = root.bounds.height, pad: CGFloat = 26
    glass.frame = root.bounds; tint.frame = root.bounds
    heading.frame = NSRect(x: pad, y: H - 44, width: 300, height: 16)
    search.frame = NSRect(x: pad, y: H - 86, width: W - pad * 2, height: 32)
    scroll.frame = NSRect(x: 8, y: 8, width: W - 16, height: H - 100)
    let shown = commandLibraryFilter(groups, search.stringValue)
    let total = groups.reduce(0) { $0 + (($1["items"] as? [[String: Any]])?.count ?? 0) }
    let hits = shown.reduce(0) { $0 + (($1["items"] as? [[String: Any]])?.count ?? 0) }
    count.stringValue = search.stringValue.isEmpty ? "\(total) COMMANDS" : "\(hits) OF \(total)"
    count.frame = NSRect(x: W - pad - 200, y: H - 44, width: 200, height: 16)
    body.subviews.forEach { $0.removeFromSuperview() }
    firstFill = nil
    empty.isHidden = !shown.isEmpty
    if shown.isEmpty { empty.stringValue = "Nothing matches “\(search.stringValue)”."; empty.frame = NSRect(x: 0, y: H / 2 - 30, width: W, height: 22) }
    // Columns: one per category while each gets 230 pt or more; otherwise they flow, shortest column first.
    let inner = scroll.contentSize.width - 36
    let cols = max(1, min(shown.count, Int(inner / 230)))
    let colW = (inner - CGFloat(cols - 1) * 1) / CGFloat(cols)
    var heights = [CGFloat](repeating: 0, count: cols)
    for g in shown {
      let c = heights.firstIndex(of: heights.min() ?? 0) ?? 0
      let x = 18 + CGFloat(c) * (colW + 1)
      var y = heights[c] + (heights[c] == 0 ? 6 : 22)
      let icon = NSImageView(image: NSImage(systemSymbolName: (g["icon"] as? String) ?? "command", accessibilityDescription: nil)?.withSymbolConfiguration(.init(pointSize: 10, weight: .semibold)) ?? NSImage())
      icon.contentTintColor = Self.ink.withAlphaComponent(0.45); icon.frame = NSRect(x: x + 10, y: y + 1, width: 12, height: 12)
      // The category, in the site's spaced capitals; a long one wraps rather than being cut.
      let h = NSTextField(wrappingLabelWithString: "")
      h.attributedStringValue = NSAttributedString(string: ((g["title"] as? String) ?? "").uppercased(), attributes: [.font: Self.mono, .kern: 2.6, .foregroundColor: Self.ink.withAlphaComponent(0.45)])
      h.preferredMaxLayoutWidth = colW - 34; h.maximumNumberOfLines = 2
      let hh = ceil(h.sizeThatFits(NSSize(width: colW - 34, height: 100)).height)
      h.frame = NSRect(x: x + 28, y: y, width: colW - 34, height: hh)
      body.addSubview(icon); body.addSubview(h)
      y += hh + 10
      for it in (g["items"] as? [[String: Any]]) ?? [] {
        let tile = tileFor(it, width: colW - 4)
        tile.frame.origin = NSPoint(x: x, y: y); body.addSubview(tile)
        y += tile.frame.height + 2
        if firstFill == nil, let f = it["fill"] as? String, !f.isEmpty { firstFill = f }
      }
      heights[c] = y
      // the thin rule between columns, like the site's
      if c < cols - 1 { let rule = NSView(frame: NSRect(x: x + colW, y: 6, width: 1, height: 10_000)); rule.wantsLayer = true; rule.layer?.backgroundColor = Self.line.withAlphaComponent(0.07).cgColor; body.addSubview(rule, positioned: .below, relativeTo: nil) }
    }
    let docH = max((heights.max() ?? 0) + 24, scroll.contentSize.height)
    body.frame = NSRect(x: 0, y: 0, width: scroll.contentSize.width, height: docH)
    for v in body.subviews where v.frame.height == 10_000 { v.frame.size.height = docH - 12 }
  }

  private func tileFor(_ it: [String: Any], width: CGFloat) -> CommandTile {
    let tile = CommandTile(frame: NSRect(x: 0, y: 0, width: width, height: 50))
    let box = NSView(frame: NSRect(x: 10, y: 9, width: 32, height: 32)); box.wantsLayer = true
    box.layer?.cornerRadius = 6; box.layer?.borderWidth = 1; box.layer?.borderColor = Self.line.cgColor
    box.layer?.backgroundColor = Self.ink.withAlphaComponent(0.02).cgColor
    let sym = NSImageView(frame: NSRect(x: 7, y: 7, width: 18, height: 18))
    sym.image = NSImage(systemSymbolName: (it["icon"] as? String) ?? "command", accessibilityDescription: nil)?.withSymbolConfiguration(.init(pointSize: 13, weight: .regular))
    sym.contentTintColor = Self.ink.withAlphaComponent(0.8); box.addSubview(sym)
    // A shortcut leads with its keys (what you press), then what it does; a command or phrase leads with its words.
    let keys = (it["kind"] as? String) == "keys"
    let tw = width - 56
    let title = NSTextField(wrappingLabelWithString: ((keys ? it["detail"] : it["title"]) as? String) ?? "")
    title.font = keys ? .monospacedSystemFont(ofSize: 14, weight: .semibold) : Self.serif; title.textColor = Self.ink
    title.preferredMaxLayoutWidth = tw; title.maximumNumberOfLines = 2
    let detail = NSTextField(wrappingLabelWithString: ((keys ? it["title"] : it["detail"]) as? String) ?? "")
    detail.font = .systemFont(ofSize: 12); detail.textColor = Self.ink.withAlphaComponent(0.55)
    detail.preferredMaxLayoutWidth = tw; detail.maximumNumberOfLines = 4
    let th = ceil(title.sizeThatFits(NSSize(width: tw, height: 400)).height), dh = ceil(detail.sizeThatFits(NSSize(width: tw, height: 400)).height)
    title.frame = NSRect(x: 52, y: 8, width: tw, height: th)
    detail.frame = NSRect(x: 52, y: 8 + th + 1, width: tw, height: dh)
    for v in [box, title, detail] as [NSView] { tile.addSubview(v) }
    tile.frame.size.height = max(50, 8 + th + 1 + dh + 9)
    let fill = it["fill"] as? String
    tile.toolTip = fill != nil ? "Puts “\(fill!)” in the box" : (keys ? "Press it in the bar" : "Typed at the console")
    tile.onPick = { [weak self] in if let f = fill, !f.isEmpty { self?.pick(f) } else { tile.picked = true; DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { tile.picked = false } } }
    return tile
  }
}

// BEGIN inlineImage (test/image-inline.test.mjs runs this function on its own)
/// A picture Kingmaker made, as one line of the chat: scaled down to fit `maxWidth` (and never taller than `maxHeight`),
/// never scaled up, and a link to its file so a click opens it. nil for anything that isn't a readable PNG/JPEG/WebP/HEIC.
func inlineImage(path: String, maxWidth: CGFloat, maxHeight: CGFloat = 420) -> NSAttributedString? {
  let url = URL(fileURLWithPath: path)
  guard ["png", "jpg", "jpeg", "webp", "heic"].contains(url.pathExtension.lowercased()),
        let img = NSImage(contentsOf: url), img.size.width > 0, img.size.height > 0 else { return nil }
  let scale = min(1, maxWidth / img.size.width, maxHeight / img.size.height)
  let att = NSTextAttachment()
  att.image = img
  att.bounds = CGRect(x: 0, y: 0, width: (img.size.width * scale).rounded(), height: (img.size.height * scale).rounded())
  let s = NSMutableAttributedString(attachment: att)
  s.addAttributes([.link: url, .toolTip: url.lastPathComponent], range: NSRange(location: 0, length: s.length))
  return s
}
// END inlineImage

// BEGIN companionControlLine (test/phone-companion.test.mjs runs this function on its own)
/// kingmaker://companion?op=start|stop|status → the engine's control line `companion <op>`; anything else → nil.
func companionControlLine(_ url: URL) -> String? {
  guard ["kingmaker", "solghost"].contains(url.scheme?.lowercased() ?? ""), (url.host ?? "").lowercased() == "companion" else { return nil }
  let op = (URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "op" }?.value ?? "").lowercased()
  return ["start", "stop", "status"].contains(op) ? "companion \(op)" : nil
}
// END companionControlLine

/// `kingmaker background …` launches this signed app bundle with a command flag. SMAppService is Apple's supported login
/// item API: no copied LaunchAgent plist, no privileged helper, and the choice remains visible in System Settings.
/// It starts the app at login; it does not claim a local Mac can execute while macOS is in closed-lid system sleep.
func backgroundCommand() -> Int32? {
  let arguments = Array(CommandLine.arguments.dropFirst())
  let flags = Set(arguments)
  guard flags.contains("--background-status") || flags.contains("--background-enable") || flags.contains("--background-disable") else { return nil }
  let service = SMAppService.mainApp
  let resultFile: URL? = {
    guard let at = arguments.firstIndex(of: "--background-result-file"), arguments.indices.contains(at + 1) else { return nil }
    let candidate = URL(fileURLWithPath: arguments[at + 1]).standardizedFileURL
    let temporary = URL(fileURLWithPath: NSTemporaryDirectory()).standardizedFileURL.path
    guard candidate.path.hasPrefix(temporary + "/") else { return nil }
    return candidate
  }()
  func word(_ status: SMAppService.Status) -> String {
    switch status {
    case .enabled: return "enabled"
    case .requiresApproval: return "requires-approval"
    case .notRegistered: return "not-registered"
    case .notFound: return "not-found"
    @unknown default: return "unknown"
    }
  }
  func report(_ status: String, message: String = "") {
    if let resultFile,
       let data = try? JSONSerialization.data(withJSONObject: ["status": status, "message": message], options: []) {
      try? data.write(to: resultFile, options: .atomic)
    } else {
      print(status)
      if !message.isEmpty { fputs("Kingmaker background setting failed: \(message)\n", stderr) }
    }
  }
  do {
    if flags.contains("--background-enable") && service.status != .enabled && service.status != .requiresApproval {
      try service.register()
    } else if flags.contains("--background-disable") && (service.status == .enabled || service.status == .requiresApproval) {
      try service.unregister()
    }
    let status = service.status
    report(word(status))
    if flags.contains("--background-enable") && status == .requiresApproval { SMAppService.openSystemSettingsLoginItems() }
    // Apple's status can be .notFound before a main-app service has ever been registered; for status/disable,
    // that is the same user-visible state as not registered. `register()` above is what introduces it to macOS.
    return 0
  } catch {
    report(word(service.status), message: error.localizedDescription)
    return 1
  }
}

if let code = backgroundCommand() { exit(code) }

let app = NSApplication.shared
let delegate = GhostApp()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()

extension NSView {
  /// This view and every view inside it.
  var subviewsDeep: [NSView] { [self] + subviews.flatMap { $0.subviewsDeep } }
}

/// A stack that starts at the top inside a scroll view (an NSStackView isn't flipped, so a tall one opened scrolled to
/// its bottom: the Behavior tab showed its editors with the title and Language above the fold).
final class TopDownStack: NSStackView { override var isFlipped: Bool { true } }

/// Customize → Behavior: the owner teaching Kingmaker how to think and act ("How should Kingmaker behave?"), its hard rules
/// (Guardrails), and the language it answers in. Any language, plain words or code, up to ten million characters each.
/// Saved to the data folder (0600); the engine reads them once per save ("instructions reload"), never on every turn.
final class BehaviorEditor: NSObject, NSTextViewDelegate {
  static let limit = 10_000_000
  static let dir = URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support/sol-ghost")
  /// Languages by their own names; "auto" answers in whatever language the owner used (this Mac's when unclear).
  static let languages = ["English", "Español", "Français", "Deutsch", "Italiano", "Português", "Nederlands", "Polski", "Русский",
    "Українська", "Türkçe", "العربية", "עברית", "हिन्दी", "বাংলা", "中文", "日本語", "한국어", "Tiếng Việt", "ไทย", "Bahasa Indonesia", "Filipino", "Kiswahili"]
  private let guardText = NSTextView(), howText = NSTextView()
  private let guardCount = NSTextField(labelWithString: ""), howCount = NSTextField(labelWithString: ""), status = NSTextField(labelWithString: "")
  private var onSaved: () -> Void = {}
  private var dirty = false

  static var macLanguage: String {
    let code = Locale.preferredLanguages.first.map { Locale(identifier: $0) }
    return code.flatMap { $0.localizedString(forLanguageCode: $0.language.languageCode?.identifier ?? "en") }?.capitalized ?? "English"
  }
  private func file(_ name: String) -> URL { BehaviorEditor.dir.appendingPathComponent(name) }
  private func read(_ name: String) -> String { (try? String(contentsOf: file(name), encoding: .utf8)) ?? "" }
  private func write(_ name: String, _ text: String) throws {
    try FileManager.default.createDirectory(at: BehaviorEditor.dir, withIntermediateDirectories: true)
    let url = file(name), tmp = url.appendingPathExtension("tmp")
    try Data(text.utf8).write(to: tmp, options: .atomic)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: tmp.path)
    _ = try FileManager.default.replaceItemAt(url, withItemAt: tmp)
  }

  func view(onSaved: @escaping () -> Void) -> NSView {
    self.onSaved = onSaved
    func label(_ s: String, _ size: CGFloat = 12, _ w: NSFont.Weight = .semibold) -> NSTextField { let l = NSTextField(labelWithString: s); l.font = .systemFont(ofSize: size, weight: w); return l }
    func note(_ s: String) -> NSTextField { let n = NSTextField(wrappingLabelWithString: s); n.font = .systemFont(ofSize: 11.5); n.textColor = .secondaryLabelColor; n.preferredMaxLayoutWidth = 540; return n }
    func editor(_ tv: NSTextView, _ text: String, _ height: CGFloat) -> NSScrollView {
      let sv = NSScrollView(); sv.hasVerticalScroller = true; sv.borderType = .bezelBorder
      tv.isRichText = false; tv.allowsUndo = true; tv.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
      tv.isAutomaticQuoteSubstitutionEnabled = false; tv.isAutomaticDashSubstitutionEnabled = false; tv.isAutomaticTextReplacementEnabled = false
      tv.isAutomaticSpellingCorrectionEnabled = false; tv.textContainerInset = NSSize(width: 6, height: 6)
      tv.isVerticallyResizable = true; tv.autoresizingMask = [.width]; tv.textContainer?.widthTracksTextView = true
      tv.string = text; tv.delegate = self; sv.documentView = tv
      sv.translatesAutoresizingMaskIntoConstraints = false
      sv.heightAnchor.constraint(equalToConstant: height).isActive = true; sv.widthAnchor.constraint(equalToConstant: 540).isActive = true
      return sv
    }
    let title = label(UI.t("How should Kingmaker behave?"), 13)
    let intro = note("Teach it how to think, how to work, and what it must never do. Any language, plain words or code. Up to 10,000,000 characters in each box; Kingmaker reads them once each time you save, and every turn carries them, spoken or typed. Long ones: each turn gets the opening and the parts that bear on it. The approval gates stay underneath.")
    let lang = NSPopUpButton(frame: .zero, pullsDown: false); lang.font = .systemFont(ofSize: 12)
    lang.addItem(withTitle: "Auto: answer in the language I use (this Mac: \(BehaviorEditor.macLanguage))"); lang.lastItem?.representedObject = "auto"
    lang.menu?.addItem(.separator())
    for l in BehaviorEditor.languages { lang.addItem(withTitle: "Always \(l)"); lang.lastItem?.representedObject = l }
    let cur = read("language").trimmingCharacters(in: .whitespacesAndNewlines)
    if let i = lang.itemArray.firstIndex(where: { ($0.representedObject as? String) == (cur.isEmpty ? "auto" : cur) }) { lang.selectItem(at: i) }
    lang.target = self; lang.action = #selector(languageChanged(_:))
    let langRow = NSStackView(views: [label(UI.t("Language"), 12, .medium), lang]); langRow.spacing = 10
    let guardEd = editor(guardText, read("guardrails.md"), 150)
    let howEd = editor(howText, read("instructions.md"), 300)
    let save = NSButton(title: UI.t("Save"), target: self, action: #selector(saveNow)); save.bezelStyle = .rounded; save.keyEquivalent = "s"; save.keyEquivalentModifierMask = .command
    status.font = .systemFont(ofSize: 11.5); status.textColor = .secondaryLabelColor
    for c in [guardCount, howCount] { c.font = .monospacedDigitSystemFont(ofSize: 10.5, weight: .regular); c.textColor = .tertiaryLabelColor }
    let stack = TopDownStack(views: [title, intro, langRow,
      label(UI.t("Guardrails")), note("Hard rules it always keeps, whatever a turn asks. e.g. “Never send an email without showing me first.” or code: if client.vip { ask_me_first() }"), guardEd, guardCount,
      label(UI.t("How it should think and work")), note("How to reason, what to prioritise, your voice, your processes, what it should become for you. Use # headings for long ones."), howEd, howCount,
      NSStackView(views: [save, status])])
    stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 8
    stack.edgeInsets = NSEdgeInsets(top: 16, left: 16, bottom: 16, right: 16)
    for v in [guardEd, howEd] { stack.setCustomSpacing(2, after: v) }
    counts()
    let scroll = NSScrollView(); scroll.documentView = stack; scroll.hasVerticalScroller = true; scroll.drawsBackground = false
    stack.translatesAutoresizingMaskIntoConstraints = false
    stack.widthAnchor.constraint(equalTo: scroll.contentView.widthAnchor).isActive = true
    return scroll
  }
  private func counts() {
    let f = NumberFormatter(); f.numberStyle = .decimal
    let n = { (t: NSTextView) in f.string(from: NSNumber(value: (t.string as NSString).length)) ?? "0" }
    guardCount.stringValue = "\(n(guardText)) of 10,000,000 characters"; howCount.stringValue = "\(n(howText)) of 10,000,000 characters"
  }
  func textView(_ tv: NSTextView, shouldChangeTextIn range: NSRange, replacementString s: String?) -> Bool {
    let after = (tv.string as NSString).length - range.length + ((s ?? "") as NSString).length
    if after > BehaviorEditor.limit { NSSound.beep(); status.stringValue = "That would pass 10,000,000 characters."; return false }
    return true
  }
  func textDidChange(_ n: Notification) { dirty = true; counts(); status.stringValue = "Not saved yet (⌘S)" }
  @objc func saveNow() {
    do {
      try write("guardrails.md", guardText.string); try write("instructions.md", howText.string)
      dirty = false; onSaved()
      status.stringValue = "Saved. Kingmaker follows it from the next turn."
    } catch { status.stringValue = "Couldn't save: \(error.localizedDescription)" }
  }
  @objc private func languageChanged(_ p: NSPopUpButton) {
    let v = (p.selectedItem?.representedObject as? String) ?? "auto"
    do { try write("language", v); onSaved(); UI.reload(); status.stringValue = v == "auto" ? "It answers in the language you use, and switches when you do. The bar's own words follow this Mac's language (from the next start)." : "It answers in \(v) from the next turn, and the bar's own words switch the next time Kingmaker starts." }
    catch { status.stringValue = "Couldn't save: \(error.localizedDescription)" }
  }
}

/// The bar's own words in the owner's language (the owner, 2026-10-15: "adopting whatever language the host device uses
/// and having a toggle to change it"). The toggle is Customize → Behavior → Language: "Auto" follows this Mac's language;
/// a fixed language sets the bar's words and Kingmaker's answers. Display words only: what the bar logs ("You",
/// "Sources"…) stays as is, since the engine and the phone read it. A word with no translation stays English.
enum UI {
  static let codes: [String: String] = ["English": "en", "Español": "es", "Français": "fr", "Deutsch": "de", "Italiano": "it", "Português": "pt",
    "Nederlands": "nl", "Polski": "pl", "Русский": "ru", "Українська": "uk", "Türkçe": "tr", "العربية": "ar", "עברית": "he", "हिन्दी": "hi", "বাংলা": "bn",
    "中文": "zh", "日本語": "ja", "한국어": "ko", "Tiếng Việt": "vi", "ไทย": "th", "Bahasa Indonesia": "id", "Filipino": "fil", "Kiswahili": "sw"]
  /// The language the bar speaks: the fixed one from Customize → Behavior, else this Mac's.
  static var code: String = current()
  static func current() -> String {
    let fixed = ((try? String(contentsOf: BehaviorEditor.dir.appendingPathComponent("language"), encoding: .utf8)) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    if let c = codes[fixed] { return c }
    return Locale.preferredLanguages.first.map { Locale(identifier: $0).language.languageCode?.identifier ?? "en" } ?? "en"
  }
  static func reload() { code = current() }
  static func t(_ en: String) -> String { code == "en" ? en : (table[en]?[code] ?? en) }
  // en → [code: words]
  static let table: [String: [String: String]] = [
    " Customize": ["es": " Personalizar", "fr": " Personnaliser", "de": " Anpassen", "pt": " Personalizar", "it": " Personalizza", "ja": " カスタマイズ", "zh": " 自定义", "ko": " 사용자화"],
    " New chat": ["es": " Nuevo chat", "fr": " Nouvelle discussion", "de": " Neuer Chat", "pt": " Nova conversa", "it": " Nuova chat", "ja": " 新しいチャット", "zh": " 新对话", "ko": " 새 대화"],
    " New project": ["es": " Nuevo proyecto", "fr": " Nouveau projet", "de": " Neues Projekt", "pt": " Novo projeto", "it": " Nuovo progetto", "ja": " 新しいプロジェクト", "zh": " 新项目", "ko": " 새 프로젝트"],
    "Ask or tell Kingmaker anything — open, text, connect…   / for a program": [
      "es": "Pregúntale o pídele lo que sea a Kingmaker: abrir, escribir, conectar…   / para un programa",
      "fr": "Demandez ou dites n’importe quoi à Kingmaker : ouvrir, écrire, connecter…   / pour un programme",
      "de": "Frag Kingmaker oder sag ihm irgendwas: öffnen, schreiben, verbinden…   / für ein Programm",
      "pt": "Pergunte ou peça qualquer coisa ao Kingmaker: abrir, escrever, conectar…   / para um programa",
      "it": "Chiedi o di’ qualsiasi cosa a Kingmaker: apri, scrivi, collega…   / per un programma",
      "ja": "Kingmaker に何でも聞いたり頼んだり：開く、書く、つなぐ…   / でプログラム",
      "zh": "向 Kingmaker 提问或吩咐任何事：打开、写、连接…   / 选择程序",
      "ko": "Kingmaker에게 무엇이든 묻거나 맡기세요: 열기, 쓰기, 연결…   / 로 프로그램"],
    "Type a command…": ["es": "Escribe una orden…", "fr": "Tapez une commande…", "de": "Befehl eingeben…", "pt": "Digite um comando…", "it": "Scrivi un comando…", "ja": "コマンドを入力…", "zh": "输入命令…", "ko": "명령 입력…"],
    "Send": ["es": "Enviar", "fr": "Envoyer", "de": "Senden", "pt": "Enviar", "it": "Invia", "ja": "送信", "zh": "发送", "ko": "보내기"],
    "Working…": ["es": "Trabajando…", "fr": "Au travail…", "de": "Arbeitet…", "pt": "Trabalhando…", "it": "Al lavoro…", "ja": "作業中…", "zh": "处理中…", "ko": "작업 중…"],
    "Speaking…": ["es": "Hablando…", "fr": "Parle…", "de": "Spricht…", "pt": "Falando…", "it": "Parla…", "ja": "話しています…", "zh": "正在说话…", "ko": "말하는 중…"],
    "Listening…": ["es": "Escuchando…", "fr": "Écoute…", "de": "Hört zu…", "pt": "Ouvindo…", "it": "Ascolta…", "ja": "聞いています…", "zh": "正在聆听…", "ko": "듣는 중…"],
    "Waiting for your word": ["es": "Esperando tu respuesta", "fr": "En attente de votre accord", "de": "Wartet auf dein Wort", "pt": "Aguardando sua resposta", "it": "In attesa della tua parola", "ja": "あなたの返事を待っています", "zh": "等待你的答复", "ko": "답을 기다리는 중"],
    "Not running": ["es": "Detenido", "fr": "Arrêté", "de": "Läuft nicht", "pt": "Parado", "it": "Fermo", "ja": "停止中", "zh": "未运行", "ko": "꺼짐"],
    "Starting…": ["es": "Iniciando…", "fr": "Démarrage…", "de": "Startet…", "pt": "Iniciando…", "it": "Avvio…", "ja": "起動中…", "zh": "正在启动…", "ko": "시작 중…"],
    "No folder": ["es": "Sin carpeta", "fr": "Aucun dossier", "de": "Kein Ordner", "pt": "Sem pasta", "it": "Nessuna cartella", "ja": "フォルダなし", "zh": "无文件夹", "ko": "폴더 없음"],
    "On": ["es": "Encendido", "fr": "Activé", "de": "An", "pt": "Ligado", "it": "Acceso", "ja": "オン", "zh": "开", "ko": "켜짐"],
    "Off": ["es": "Apagado", "fr": "Désactivé", "de": "Aus", "pt": "Desligado", "it": "Spento", "ja": "オフ", "zh": "关", "ko": "꺼짐"],
    "Muted": ["es": "Silenciado", "fr": "Muet", "de": "Stumm", "pt": "Mudo", "it": "Muto", "ja": "ミュート", "zh": "静音", "ko": "음소거"],
    "Voice": ["es": "Voz", "fr": "Voix", "de": "Stimme", "pt": "Voz", "it": "Voce", "ja": "音声", "zh": "语音", "ko": "음성"],
    "Chats and projects": ["es": "Chats y proyectos", "fr": "Discussions et projets", "de": "Chats und Projekte", "pt": "Conversas e projetos", "it": "Chat e progetti", "ja": "チャットとプロジェクト", "zh": "对话和项目", "ko": "대화와 프로젝트"],
    "Artifacts: what Kingmaker made": ["es": "Creaciones: lo que hizo Kingmaker", "fr": "Créations : ce que Kingmaker a fait", "de": "Ergebnisse: was Kingmaker gemacht hat", "pt": "Criações: o que o Kingmaker fez", "it": "Creazioni: ciò che ha fatto Kingmaker", "ja": "成果物：Kingmaker が作ったもの", "zh": "成果：Kingmaker 做的东西", "ko": "결과물: Kingmaker가 만든 것"],
    "Skills": ["es": "Habilidades", "fr": "Compétences", "de": "Fähigkeiten", "pt": "Habilidades", "it": "Abilità", "ja": "スキル", "zh": "技能", "ko": "스킬"],
    "Plugins and connectors": ["es": "Complementos y conectores", "fr": "Extensions et connecteurs", "de": "Plugins und Verbindungen", "pt": "Plugins e conectores", "it": "Plugin e connettori", "ja": "プラグインとコネクタ", "zh": "插件和连接器", "ko": "플러그인과 커넥터"],
    "Show or hide your chats": ["es": "Mostrar u ocultar tus chats", "fr": "Afficher ou masquer vos discussions", "de": "Chats ein- oder ausblenden", "pt": "Mostrar ou ocultar suas conversas", "it": "Mostra o nascondi le chat", "ja": "チャットの表示／非表示", "zh": "显示或隐藏对话", "ko": "대화 보이기/숨기기"],
    "Select several to delete, move or pin at once": ["es": "Selecciona varios para borrar, mover o fijar a la vez", "fr": "Sélectionnez-en plusieurs pour supprimer, déplacer ou épingler", "de": "Mehrere auswählen zum Löschen, Verschieben oder Anheften", "pt": "Selecione vários para apagar, mover ou fixar de uma vez", "it": "Selezionane diversi per eliminare, spostare o fissare", "ja": "複数選んで削除・移動・ピン留め", "zh": "多选以一次删除、移动或置顶", "ko": "여러 개를 골라 한 번에 삭제·이동·고정"],
    "Interaction": ["es": "Interacción", "fr": "Interaction", "de": "Interaktion", "pt": "Interação", "it": "Interazione", "ja": "操作", "zh": "交互", "ko": "상호작용"],
    "Functions": ["es": "Funciones", "fr": "Fonctions", "de": "Funktionen", "pt": "Funções", "it": "Funzioni", "ja": "機能", "zh": "功能", "ko": "기능"],
    "Behavior": ["es": "Comportamiento", "fr": "Comportement", "de": "Verhalten", "pt": "Comportamento", "it": "Comportamento", "ja": "ふるまい", "zh": "行为", "ko": "행동"],
    "Save": ["es": "Guardar", "fr": "Enregistrer", "de": "Sichern", "pt": "Salvar", "it": "Salva", "ja": "保存", "zh": "保存", "ko": "저장"],
    "Cancel": ["es": "Cancelar", "fr": "Annuler", "de": "Abbrechen", "pt": "Cancelar", "it": "Annulla", "ja": "キャンセル", "zh": "取消", "ko": "취소"],
    "Defaults": ["es": "Valores por defecto", "fr": "Par défaut", "de": "Standard", "pt": "Padrões", "it": "Predefiniti", "ja": "既定に戻す", "zh": "默认值", "ko": "기본값"],
    "Create skill": ["es": "Crear habilidad", "fr": "Créer la compétence", "de": "Fähigkeit erstellen", "pt": "Criar habilidade", "it": "Crea abilità", "ja": "スキルを作成", "zh": "创建技能", "ko": "스킬 만들기"],
    "Quit Kingmaker": ["es": "Salir de Kingmaker", "fr": "Quitter Kingmaker", "de": "Kingmaker beenden", "pt": "Sair do Kingmaker", "it": "Esci da Kingmaker", "ja": "Kingmaker を終了", "zh": "退出 Kingmaker", "ko": "Kingmaker 종료"],
    "Undo": ["es": "Deshacer", "fr": "Annuler", "de": "Widerrufen", "pt": "Desfazer", "it": "Annulla", "ja": "取り消す", "zh": "撤销", "ko": "실행 취소"],
    "Redo": ["es": "Rehacer", "fr": "Rétablir", "de": "Wiederholen", "pt": "Refazer", "it": "Ripeti", "ja": "やり直す", "zh": "重做", "ko": "다시 실행"],
    "Cut": ["es": "Cortar", "fr": "Couper", "de": "Ausschneiden", "pt": "Cortar", "it": "Taglia", "ja": "カット", "zh": "剪切", "ko": "오려두기"],
    "Copy": ["es": "Copiar", "fr": "Copier", "de": "Kopieren", "pt": "Copiar", "it": "Copia", "ja": "コピー", "zh": "拷贝", "ko": "복사"],
    "Paste": ["es": "Pegar", "fr": "Coller", "de": "Einsetzen", "pt": "Colar", "it": "Incolla", "ja": "ペースト", "zh": "粘贴", "ko": "붙여넣기"],
    "Select All": ["es": "Seleccionar todo", "fr": "Tout sélectionner", "de": "Alles auswählen", "pt": "Selecionar tudo", "it": "Seleziona tutto", "ja": "すべてを選択", "zh": "全选", "ko": "모두 선택"],
    "How should Kingmaker behave?": ["es": "¿Cómo debe comportarse Kingmaker?", "fr": "Comment Kingmaker doit-il se comporter ?", "de": "Wie soll sich Kingmaker verhalten?", "pt": "Como o Kingmaker deve se comportar?", "it": "Come deve comportarsi Kingmaker?", "ja": "Kingmaker にどうふるまってほしいですか？", "zh": "Kingmaker 应该怎么做？", "ko": "Kingmaker가 어떻게 행동해야 하나요?"],
    "Guardrails": ["es": "Límites", "fr": "Garde-fous", "de": "Leitplanken", "pt": "Limites", "it": "Limiti", "ja": "ガードレール", "zh": "护栏", "ko": "가드레일"],
    "How it should think and work": ["es": "Cómo debe pensar y trabajar", "fr": "Comment il doit penser et travailler", "de": "Wie es denken und arbeiten soll", "pt": "Como deve pensar e trabalhar", "it": "Come deve pensare e lavorare", "ja": "考え方と働き方", "zh": "它应如何思考和工作", "ko": "생각하고 일하는 방식"],
    "Language": ["es": "Idioma", "fr": "Langue", "de": "Sprache", "pt": "Idioma", "it": "Lingua", "ja": "言語", "zh": "语言", "ko": "언어"],
    "How Kingmaker looks, sounds and talks with you": ["es": "Cómo se ve, suena y te habla Kingmaker", "fr": "L’apparence, la voix et le ton de Kingmaker", "de": "Wie Kingmaker aussieht, klingt und mit dir spricht", "pt": "Como o Kingmaker aparece, soa e fala com você", "it": "Come appare, suona e ti parla Kingmaker", "ja": "Kingmaker の見た目・声・話し方", "zh": "Kingmaker 的外观、声音和说话方式", "ko": "Kingmaker의 모습, 목소리, 말투"],
  ]
}
