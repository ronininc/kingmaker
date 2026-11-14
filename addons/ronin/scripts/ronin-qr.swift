// scripts/ronin-qr.swift — a QR in Ronin's look with macOS's own Core Image generator, and Kingmaker's Home Screen icon.
//   swift scripts/ronin-qr.swift <text> <qr.png> <icon.png> [crest.png]
// Scanners need dark on light, so the code sits on a cream card framed in gold on a black page; its modules are black
// rounded squares and its three finder eyes black and rounded. Error correction is High (up to 30% of the code can be
// covered), so the Ronin crest (ronininc.org/assets/ronin-logo-cut.png) can sit in the middle. Check it with a reader.
import AppKit
import CoreImage
let a = CommandLine.arguments
guard a.count >= 4 else { print("usage: ronin-qr <text> <qr.png> <icon.png> [crest.png]"); exit(2) }
let gold = NSColor(srgbRed: 0.91, green: 0.73, blue: 0.27, alpha: 1)
let cream = NSColor(srgbRed: 0.96, green: 0.94, blue: 0.90, alpha: 1)
let crest: NSImage? = a.count > 4 ? NSImage(contentsOfFile: a[4]) : nil
func png(_ size: NSSize, _ draw: () -> Void) -> Data {
  let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(size.width), pixelsHigh: Int(size.height), bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
  NSGraphicsContext.saveGraphicsState(); NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
  NSGraphicsContext.current?.imageInterpolation = .high; draw(); NSGraphicsContext.restoreGraphicsState()
  return rep.representation(using: .png, properties: [:])!
}
func bodoni(_ s: CGFloat) -> NSFont { NSFont(name: "BodoniSvtyTwoITCTT-Bold", size: s) ?? NSFont(name: "Didot-Bold", size: s) ?? .boldSystemFont(ofSize: s) }
func centered(_ t: String, _ f: NSFont, _ c: NSColor, _ y: CGFloat, _ w: CGFloat, kern: CGFloat = 0) {
  let p = NSMutableParagraphStyle(); p.alignment = .center
  NSAttributedString(string: t, attributes: [.font: f, .foregroundColor: c, .paragraphStyle: p, .kern: kern]).draw(in: NSRect(x: 0, y: y, width: w, height: f.pointSize * 1.5))
}

// The modules, one pixel each. The generator adds its own quiet border: find it and keep only the code.
let f = CIFilter(name: "CIQRCodeGenerator")!
f.setValue(a[1].data(using: .utf8), forKey: "inputMessage"); f.setValue("H", forKey: "inputCorrectionLevel")
let img = f.outputImage!, full = Int(img.extent.width)
let bits = NSBitmapImageRep(cgImage: CIContext().createCGImage(img, from: img.extent)!)
func darkAt(_ x: Int, _ y: Int) -> Bool { (bits.colorAt(x: x, y: y)?.brightnessComponent ?? 1) < 0.5 }
var m = 0; outer: for d in 0..<full { for i in 0..<full where darkAt(i, d) || darkAt(d, i) { m = d; break outer } }
let n = full - 2 * m
func dark(_ x: Int, _ y: Int) -> Bool { darkAt(x + m, y + m) }   // code coordinates, (0,0) = top-left module

let W: CGFloat = 900, H: CGFloat = 1180
let cell = (W - 300) / CGFloat(n), ox = (W - CGFloat(n) * cell) / 2, oy: CGFloat = 300
let qr = png(NSSize(width: W, height: H)) {
  NSColor.black.setFill(); NSRect(x: 0, y: 0, width: W, height: H).fill()
  centered("KINGMAKER", bodoni(46), .white, H - 118, W, kern: 14)
  centered("RONIN INC", .systemFont(ofSize: 15, weight: .semibold), gold, H - 156, W, kern: 6)
  // The card: a quiet zone of four modules, cream, framed in gold.
  let quiet = cell * 4, card = NSRect(x: ox - quiet, y: oy - quiet, width: CGFloat(n) * cell + 2 * quiet, height: CGFloat(n) * cell + 2 * quiet)
  gold.setFill(); NSBezierPath(roundedRect: card.insetBy(dx: -6, dy: -6), xRadius: 36, yRadius: 36).fill()
  cream.setFill(); NSBezierPath(roundedRect: card, xRadius: 32, yRadius: 32).fill()
  // The crest's badge in the middle: no module is drawn under it (High correction carries what it covers).
  let badgeModules = Int((Double(n) * 0.26).rounded()) | 1, b0 = (n - badgeModules) / 2
  func underBadge(_ x: Int, _ y: Int) -> Bool { crest != nil && x >= b0 - 1 && x < b0 + badgeModules + 1 && y >= b0 - 1 && y < b0 + badgeModules + 1 }
  func inEye(_ x: Int, _ y: Int) -> Bool { (x < 7 && y < 7) || (x >= n - 7 && y < 7) || (x < 7 && y >= n - 7) }
  let at = { (x: Int, y: Int) -> NSPoint in NSPoint(x: ox + CGFloat(x) * cell, y: oy + CGFloat(n - 1 - y) * cell) }
  NSColor.black.setFill()
  for y in 0..<n { for x in 0..<n where dark(x, y) && !inEye(x, y) && !underBadge(x, y) {
    let p = at(x, y)
    NSBezierPath(roundedRect: NSRect(x: p.x + cell * 0.06, y: p.y + cell * 0.06, width: cell * 0.88, height: cell * 0.88), xRadius: cell * 0.28, yRadius: cell * 0.28).fill()
  } }
  for (ex, ey) in [(0, 0), (n - 7, 0), (0, n - 7)] {
    let p = at(ex, ey + 6)   // bottom-left of the 7×7 eye
    let ring = NSBezierPath(roundedRect: NSRect(x: p.x, y: p.y, width: cell * 7, height: cell * 7), xRadius: cell * 1.8, yRadius: cell * 1.8)
    ring.append(NSBezierPath(roundedRect: NSRect(x: p.x + cell, y: p.y + cell, width: cell * 5, height: cell * 5), xRadius: cell * 1.2, yRadius: cell * 1.2).reversed)
    ring.fill()
    NSBezierPath(roundedRect: NSRect(x: p.x + cell * 2, y: p.y + cell * 2, width: cell * 3, height: cell * 3), xRadius: cell * 0.9, yRadius: cell * 0.9).fill()
  }
  if let crest {
    let side = CGFloat(badgeModules) * cell, c0 = at(b0, b0 + badgeModules - 1)
    let badge = NSRect(x: c0.x, y: c0.y, width: side, height: side)
    gold.setFill(); NSBezierPath(roundedRect: badge.insetBy(dx: -cell * 0.35, dy: -cell * 0.35), xRadius: side * 0.24, yRadius: side * 0.24).fill()
    NSColor.black.setFill(); NSBezierPath(roundedRect: badge, xRadius: side * 0.2, yRadius: side * 0.2).fill()
    let s = crest.size, k = min((side * 0.86) / s.width, (side * 0.86) / s.height)
    let w = s.width * k, h = s.height * k
    crest.draw(in: NSRect(x: badge.midX - w / 2, y: badge.midY - h / 2, width: w, height: h), from: .zero, operation: .sourceOver, fraction: 1)
  }
  centered("Scan with your iPhone camera", .systemFont(ofSize: 26, weight: .semibold), .white, 168, W)
  centered("Install the Ronin certificate, trust it, then Add to Home Screen.", .systemFont(ofSize: 18), NSColor(white: 1, alpha: 0.55), 126, W)
  centered("Same Wi-Fi as your Mac · one-time pairing code", .systemFont(ofSize: 15), gold, 78, W)
}
try! qr.write(to: URL(fileURLWithPath: a[2]))

// The Home Screen icon: the crest on black (a gold Bodoni K when there's no crest).
let S: CGFloat = 512
let icon = png(NSSize(width: S, height: S)) {
  NSColor.black.setFill(); NSRect(x: 0, y: 0, width: S, height: S).fill()
  if let crest {
    let s = crest.size, k = min(420 / s.width, 420 / s.height), w = s.width * k, h = s.height * k
    crest.draw(in: NSRect(x: (S - w) / 2, y: (S - h) / 2, width: w, height: h), from: .zero, operation: .sourceOver, fraction: 1)
  } else { centered("K", bodoni(300), gold, 70, S) }
}
try! icon.write(to: URL(fileURLWithPath: a[3]))
print("modules \(n)x\(n) (border \(m))")
