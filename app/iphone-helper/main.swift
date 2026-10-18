// kingmaker-iphone-helper — the native half of the iPhone bridge (lib/iphone-bridge.mjs is the other half).
//
// One small command-line tool, Apple frameworks only, no network: every command reads argv/stdin and prints ONE
// JSON object on stdout. It never decides anything; the policy gate lives in lib/iphone-policy.mjs.
//
//   status                    permissions (Screen Recording, Accessibility, Contacts) and the iPhone Mirroring window
//   window                    the iPhone Mirroring window: id, bounds (global points, top-left origin), pid
//   activate                  bring iPhone Mirroring to the front (input goes to the frontmost window)
//   ocr <png>                 Apple Vision text recognition: [{text, conf, x, y, w, h}] as fractions of the image
//   click <x> <y>             one left click at global point (x, y)
//   drag <x1> <y1> <x2> <y2> [ms]   press, move, release (a swipe on the phone)
//   key <combo>               e.g. cmd+1 (Home), cmd+2 (App Switcher), cmd+3 (Spotlight), return, delete, escape
//   type                      types the UTF-8 text on stdin as keystrokes
//   contacts <handle|name>    looks the phone number, email or name up in the Mac's Contacts (at most 5 cards)
//   auth <reason> [seconds]   Touch ID / login password via LocalAuthentication: the owner's presence, per action
//   policy-get                the outbound policy kept in the login Keychain ({} when none)
//   policy-set <reason>       replaces it with the JSON on stdin, only after `auth` succeeds in this same process
//
// Input injection uses CGEvent (needs Accessibility); capture is /usr/sbin/screencapture -l (needs Screen
// Recording), run by the Node side. Both permissions are granted by the owner in System Settings, never here.

import AppKit
import ApplicationServices
import Contacts
import CoreGraphics
import Foundation
import LocalAuthentication
import Security
import Vision

let MIRRORING_OWNER = "iPhone Mirroring"
let MIRRORING_BUNDLE = "com.apple.ScreenContinuity"
let POLICY_SERVICE = "Kingmaker iPhone Bridge"
let POLICY_ACCOUNT = "outbound-policy"

func emit(_ obj: [String: Any]) -> Never {
  let data = (try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys])) ?? Data("{\"ok\":false}".utf8)
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data("\n".utf8))
  exit((obj["ok"] as? Bool) == false ? 1 : 0)
}
func fail(_ message: String, _ extra: [String: Any] = [:]) -> Never { emit(["ok": false, "error": message].merging(extra) { a, _ in a }) }
func readStdin() -> String { String(decoding: FileHandle.standardInput.readDataToEndOfFile(), as: UTF8.self) }

// MARK: window

func mirroringWindow() -> [String: Any]? {
  guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return nil }
  var best: (area: CGFloat, info: [String: Any])?
  for w in list where (w[kCGWindowOwnerName as String] as? String) == MIRRORING_OWNER && (w[kCGWindowLayer as String] as? Int) == 0 {
    guard let b = w[kCGWindowBounds as String] as? NSDictionary, let r = CGRect(dictionaryRepresentation: b) else { continue }
    if r.width < 100 || r.height < 100 { continue }
    let info: [String: Any] = [
      "id": w[kCGWindowNumber as String] as? Int ?? 0, "pid": w[kCGWindowOwnerPID as String] as? Int ?? 0,
      "x": r.origin.x, "y": r.origin.y, "w": r.width, "h": r.height,
    ]
    if best == nil || r.width * r.height > best!.area { best = (r.width * r.height, info) }
  }
  return best?.info
}

// MARK: input

func post(_ e: CGEvent?) { e?.post(tap: .cghidEventTap) }
func pause(_ ms: Int) { usleep(useconds_t(ms * 1000)) }

func click(_ p: CGPoint) {
  post(CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left)); pause(40)
  post(CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: p, mouseButton: .left)); pause(60)
  post(CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: p, mouseButton: .left))
}

func drag(_ a: CGPoint, _ b: CGPoint, _ ms: Int) {
  let steps = max(8, ms / 16)
  post(CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: a, mouseButton: .left)); pause(30)
  post(CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: a, mouseButton: .left)); pause(30)
  for i in 1...steps {
    let t = CGFloat(i) / CGFloat(steps)
    post(CGEvent(mouseEventSource: nil, mouseType: .leftMouseDragged, mouseCursorPosition: CGPoint(x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t), mouseButton: .left))
    pause(max(1, ms / steps))
  }
  post(CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: b, mouseButton: .left))
}

let KEYCODES: [String: CGKeyCode] = [
  "return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51, "backspace": 51, "escape": 53, "esc": 53,
  "left": 123, "right": 124, "down": 125, "up": 126,
  "1": 18, "2": 19, "3": 20, "4": 21, "5": 23, "6": 22, "7": 26, "8": 28, "9": 25, "0": 29,
  "a": 0, "c": 8, "f": 3, "h": 4, "v": 9, "z": 6,
]

func key(_ combo: String) -> Bool {
  var flags: CGEventFlags = []
  var code: CGKeyCode?
  for part in combo.lowercased().split(separator: "+").map(String.init) {
    switch part {
    case "cmd", "command": flags.insert(.maskCommand)
    case "shift": flags.insert(.maskShift)
    case "opt", "option", "alt": flags.insert(.maskAlternate)
    case "ctrl", "control": flags.insert(.maskControl)
    default: code = KEYCODES[part]
    }
  }
  guard let c = code else { return false }
  let down = CGEvent(keyboardEventSource: nil, virtualKey: c, keyDown: true); down?.flags = flags
  let up = CGEvent(keyboardEventSource: nil, virtualKey: c, keyDown: false); up?.flags = flags
  post(down); pause(30); post(up)
  return true
}

// iPhone Mirroring reads the physical key code, not a CGEvent's attached Unicode string, so text is typed as real
// US-keyboard keystrokes (with Shift where needed). Characters with no key here are refused before anything is typed.
let US_KEYS: [Character: (CGKeyCode, Bool)] = {
  var m: [Character: (CGKeyCode, Bool)] = [:]
  let plain: [(String, CGKeyCode)] = [
    ("a", 0), ("s", 1), ("d", 2), ("f", 3), ("h", 4), ("g", 5), ("z", 6), ("x", 7), ("c", 8), ("v", 9), ("b", 11), ("q", 12),
    ("w", 13), ("e", 14), ("r", 15), ("y", 16), ("t", 17), ("1", 18), ("2", 19), ("3", 20), ("4", 21), ("6", 22), ("5", 23),
    ("=", 24), ("9", 25), ("7", 26), ("-", 27), ("8", 28), ("0", 29), ("]", 30), ("o", 31), ("u", 32), ("[", 33), ("i", 34),
    ("p", 35), ("l", 37), ("j", 38), ("'", 39), ("k", 40), (";", 41), ("\\", 42), (",", 43), ("/", 44), ("n", 45), ("m", 46),
    (".", 47), ("`", 50), (" ", 49), ("\n", 36), ("\t", 48),
  ]
  for (ch, code) in plain { m[Character(ch)] = (code, false) }
  for ch in "abcdefghijklmnopqrstuvwxyz" { if let (code, _) = m[ch] { m[Character(ch.uppercased())] = (code, true) } }
  let shifted: [(Character, Character)] = [("!", "1"), ("@", "2"), ("#", "3"), ("$", "4"), ("%", "5"), ("^", "6"), ("&", "7"), ("*", "8"), ("(", "9"), (")", "0"),
    ("_", "-"), ("+", "="), ("{", "["), ("}", "]"), ("|", "\\"), (":", ";"), ("\"", "'"), ("<", ","), (">", "."), ("?", "/"), ("~", "`")]
  for (s, base) in shifted { if let (code, _) = m[base] { m[s] = (code, true) } }
  return m
}()

func typeText(_ text: String) -> Character? {
  if let bad = text.first(where: { US_KEYS[$0] == nil }) { return bad }
  for ch in text {
    let (code, shift) = US_KEYS[ch]!
    let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true)
    let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false)
    if shift { down?.flags = .maskShift; up?.flags = .maskShift }
    post(down); pause(12); post(up); pause(22)
  }
  return nil
}

// MARK: OCR

func ocr(_ path: String) -> [[String: Any]] {
  guard let img = NSImage(contentsOfFile: path), let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else { fail("cannot read image \(path)") }
  let req = VNRecognizeTextRequest()
  req.recognitionLevel = .accurate
  req.usesLanguageCorrection = true
  do { try VNImageRequestHandler(cgImage: cg, options: [:]).perform([req]) } catch { fail("vision failed: \(error.localizedDescription)") }
  return (req.results ?? []).compactMap { obs in
    guard let top = obs.topCandidates(1).first else { return nil }
    let b = obs.boundingBox // normalized, origin bottom-left
    return ["text": top.string, "conf": Double(top.confidence), "x": Double(b.minX), "y": Double(1 - b.maxY), "w": Double(b.width), "h": Double(b.height)]
  }
}

// MARK: contacts

func digits(_ s: String) -> String { s.filter(\.isNumber) }

func contactsAccess() -> String {
  switch CNContactStore.authorizationStatus(for: .contacts) {
  case .authorized: return "granted"
  case .denied: return "denied"
  case .restricted: return "restricted"
  case .notDetermined: return "not-determined"
  default: return "limited"
  }
}

func lookup(_ query: String) -> [[String: Any]] {
  let store = CNContactStore()
  if CNContactStore.authorizationStatus(for: .contacts) == .notDetermined {
    let sem = DispatchSemaphore(value: 0)
    store.requestAccess(for: .contacts) { _, _ in sem.signal() }
    _ = sem.wait(timeout: .now() + 60)
  }
  guard CNContactStore.authorizationStatus(for: .contacts) == .authorized else { fail("contacts access not granted", ["access": contactsAccess()]) }
  let keys: [CNKeyDescriptor] = [CNContactGivenNameKey, CNContactFamilyNameKey, CNContactOrganizationNameKey, CNContactPhoneNumbersKey, CNContactEmailAddressesKey, CNContactIdentifierKey].map { $0 as CNKeyDescriptor }
  let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
  let predicate: NSPredicate
  if q.contains("@") { predicate = CNContact.predicateForContacts(matchingEmailAddress: q) }
  else if digits(q).count >= 7 && q.allSatisfy({ $0.isNumber || "+()-. ".contains($0) }) { predicate = CNContact.predicateForContacts(matching: CNPhoneNumber(stringValue: q)) }
  else { predicate = CNContact.predicateForContacts(matchingName: q) }
  let found = (try? store.unifiedContacts(matching: predicate, keysToFetch: keys)) ?? []
  return found.prefix(5).map { c in
    let name = [c.givenName, c.familyName].filter { !$0.isEmpty }.joined(separator: " ")
    return [
      "id": c.identifier, "name": name.isEmpty ? c.organizationName : name,
      "phones": c.phoneNumbers.map { $0.value.stringValue }, "emails": c.emailAddresses.map { String($0.value) },
    ]
  }
}

// MARK: owner presence

func authenticate(_ reason: String, _ seconds: Double) -> (Bool, String?) {
  let ctx = LAContext()
  var err: NSError?
  guard ctx.canEvaluatePolicy(.deviceOwnerAuthentication, error: &err) else { return (false, err?.localizedDescription ?? "owner authentication unavailable") }
  let sem = DispatchSemaphore(value: 0)
  var approved = false; var why: String?
  ctx.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { ok, e in approved = ok; why = e?.localizedDescription; sem.signal() }
  if sem.wait(timeout: .now() + seconds) == .timedOut { ctx.invalidate(); _ = sem.wait(timeout: .now() + 2); return (false, "timed out") }
  return (approved, why)
}

// MARK: keychain policy

func policyGet() -> String? {
  let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: POLICY_SERVICE, kSecAttrAccount as String: POLICY_ACCOUNT, kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
  var item: CFTypeRef?
  guard SecItemCopyMatching(q as CFDictionary, &item) == errSecSuccess, let d = item as? Data else { return nil }
  return String(decoding: d, as: UTF8.self)
}

func policySet(_ json: String) -> OSStatus {
  let base: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: POLICY_SERVICE, kSecAttrAccount as String: POLICY_ACCOUNT]
  let data = Data(json.utf8)
  let st = SecItemUpdate(base as CFDictionary, [kSecValueData as String: data] as CFDictionary)
  if st != errSecItemNotFound { return st }
  var add = base; add[kSecValueData as String] = data; add[kSecAttrLabel as String] = POLICY_SERVICE
  return SecItemAdd(add as CFDictionary, nil)
}

// MARK: main

let args = Array(CommandLine.arguments.dropFirst())
func num(_ i: Int) -> CGFloat { guard i < args.count, let d = Double(args[i]), d.isFinite else { fail("argument \(i) must be a number") }; return CGFloat(d) }

switch args.first ?? "" {
case "status":
  var o: [String: Any] = ["ok": true, "screenRecording": CGPreflightScreenCaptureAccess(), "accessibility": AXIsProcessTrusted(), "contacts": contactsAccess()]
  o["mirroringRunning"] = !NSRunningApplication.runningApplications(withBundleIdentifier: MIRRORING_BUNDLE).isEmpty
  if let w = mirroringWindow() { o["window"] = w }
  emit(o)
case "window":
  guard let w = mirroringWindow() else { fail("iPhone Mirroring window not found: open iPhone Mirroring and unlock it") }
  emit(["ok": true, "window": w])
case "activate":
  guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: MIRRORING_BUNDLE).first else { fail("iPhone Mirroring is not running") }
  app.activate()
  pause(250)
  emit(["ok": true, "frontmost": NSWorkspace.shared.frontmostApplication?.bundleIdentifier == MIRRORING_BUNDLE])
case "ocr":
  guard args.count > 1 else { fail("usage: ocr <png>") }
  emit(["ok": true, "items": ocr(args[1])])
case "click":
  guard AXIsProcessTrusted() else { fail("Accessibility not granted") }
  click(CGPoint(x: num(1), y: num(2))); emit(["ok": true])
case "drag":
  guard AXIsProcessTrusted() else { fail("Accessibility not granted") }
  drag(CGPoint(x: num(1), y: num(2)), CGPoint(x: num(3), y: num(4)), args.count > 5 ? Int(num(5)) : 300); emit(["ok": true])
case "key":
  guard AXIsProcessTrusted() else { fail("Accessibility not granted") }
  guard args.count > 1, key(args[1]) else { fail("unknown key combo") }
  emit(["ok": true])
case "type":
  guard AXIsProcessTrusted() else { fail("Accessibility not granted") }
  let t = readStdin()
  guard t.count <= 2000 else { fail("text too long (2000 characters max)") }
  if let bad = typeText(t) { fail("cannot type \"\(bad)\" on the iPhone keyboard yet (US keys only); nothing was typed") }
  emit(["ok": true, "chars": t.count])
case "contacts":
  guard args.count > 1, !args[1].trimmingCharacters(in: .whitespaces).isEmpty else { fail("usage: contacts <phone|email|name>") }
  emit(["ok": true, "contacts": lookup(args[1])])
case "auth":
  guard args.count > 1 else { fail("usage: auth <reason> [seconds]") }
  let (approved, why) = authenticate(args[1], args.count > 2 ? Double(num(2)) : 90)
  emit(["ok": true, "approved": approved, "error": why ?? NSNull()])
case "policy-get":
  emit(["ok": true, "policy": policyGet() ?? "{}"])
case "policy-set":
  guard args.count > 1 else { fail("usage: policy-set <reason> < policy.json") }
  let json = readStdin()
  guard (try? JSONSerialization.jsonObject(with: Data(json.utf8))) is [String: Any] else { fail("policy must be a JSON object") }
  let (approved, why) = authenticate(args[1], 90)
  guard approved else { emit(["ok": true, "approved": false, "error": why ?? NSNull()]) }
  let st = policySet(json)
  guard st == errSecSuccess else { fail("keychain write failed (\(st))") }
  emit(["ok": true, "approved": true])
default:
  fail("unknown command; see the header of app/iphone-helper/main.swift")
}
