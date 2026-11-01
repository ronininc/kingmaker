// Kingmaker's icons, from the Ronin Inc crest (assets/ronin-inc-crest.png, the logo on ronininc.com).
//   swift scripts/make-icons.swift            → writes every icon below (commit the results)
//
//   app/Resources/AppIcon.icns                Kingmaker.app: the crest on the Machine's void (the engine's look)
//   app/Resources/MenuBarLogo.png (+@2x)      the menu bar mark: the crest's shield and eye, as a template image
//   app/Resources/MenuBarOutline.png (+@2x)   the same shield as a thin outline (the RGB ring while listening)
//   installer/Resources/InstallerIcon.icns    Kingmaker Installer.app: the app icon with a download badge
//   installer/Resources/RoninCrest.png        the crest for the installer window
//
// Only macOS's own frameworks and tools (CoreGraphics, ImageIO, iconutil): no Homebrew needed.

import AppKit
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let root = URL(fileURLWithPath: CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : FileManager.default.currentDirectoryPath)
let crestURL = root.appendingPathComponent("assets/ronin-inc-crest.png")
guard let crestSource = CGImageSourceCreateWithURL(crestURL as CFURL, nil), let crest = CGImageSourceCreateImageAtIndex(crestSource, 0, nil) else {
  FileHandle.standardError.write("no crest at \(crestURL.path)\n".data(using: .utf8)!); exit(1)
}

func rgba(_ r: CGFloat, _ g: CGFloat, _ b: CGFloat, _ a: CGFloat = 1) -> CGColor { CGColor(srgbRed: r / 255, green: g / 255, blue: b / 255, alpha: a) }
// The Machine's tokens (the engine's design tokens).
let void0 = rgba(0x07, 0x09, 0x0b), field = rgba(0x15, 0x19, 0x1d), ink = rgba(0xf4, 0xf5, 0xf6), paper = rgba(0xe8, 0xea, 0xec)

func context(_ w: Int, _ h: Int) -> CGContext {
  CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
}

func writePNG(_ image: CGImage, _ url: URL) {
  try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
  let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil)!
  CGImageDestinationAddImage(dest, image, nil)
  guard CGImageDestinationFinalize(dest) else { fatalError("could not write \(url.path)") }
}

/// The app icon at `size` px: a rounded square of the Machine's void with its faint grid and corner ticks, the crest on it.
func appIcon(_ size: Int, badge: Bool) -> CGImage {
  let s = CGFloat(size)
  let ctx = context(size, size)
  let inset = s * 100 / 1024, body = CGRect(x: inset, y: inset, width: s - 2 * inset, height: s - 2 * inset)
  let radius = body.width * 0.225
  let shape = CGPath(roundedRect: body, cornerWidth: radius, cornerHeight: radius, transform: nil)
  // Drop shadow under the tile, like every macOS icon.
  ctx.saveGState()
  ctx.setShadow(offset: CGSize(width: 0, height: -s * 0.01), blur: s * 0.025, color: rgba(0, 0, 0, 0.45))
  ctx.addPath(shape); ctx.setFillColor(void0); ctx.fillPath()
  ctx.restoreGState()
  ctx.saveGState()
  ctx.addPath(shape); ctx.clip()
  let gradient = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB)!, colors: [field, void0] as CFArray, locations: [0, 1])!
  ctx.drawRadialGradient(gradient, startCenter: CGPoint(x: s / 2, y: s * 0.58), startRadius: 0, endCenter: CGPoint(x: s / 2, y: s * 0.58), endRadius: body.width * 0.72, options: [.drawsAfterEndLocation])
  // The Machine's 64-px grid, scaled to the tile.
  ctx.setStrokeColor(rgba(0xf4, 0xf5, 0xf6, 0.05)); ctx.setLineWidth(max(1, s / 1024))
  let step = body.width / 12
  var x = body.minX + step
  while x < body.maxX { ctx.move(to: CGPoint(x: x, y: body.minY)); ctx.addLine(to: CGPoint(x: x, y: body.maxY)); x += step }
  var y = body.minY + step
  while y < body.maxY { ctx.move(to: CGPoint(x: body.minX, y: y)); ctx.addLine(to: CGPoint(x: body.maxX, y: y)); y += step }
  ctx.strokePath()
  // The crest, centred.
  let cw = body.width * 0.84, ch = cw * CGFloat(crest.height) / CGFloat(crest.width)
  ctx.setShadow(offset: .zero, blur: s * 0.03, color: rgba(0xf4, 0xf5, 0xf6, 0.18))
  ctx.draw(crest, in: CGRect(x: (s - cw) / 2, y: (s - ch) / 2 - s * 0.005, width: cw, height: ch))
  ctx.setShadow(offset: .zero, blur: 0, color: nil)
  // Corner ticks (the Machine frame's ::before / ::after).
  ctx.setStrokeColor(rgba(0xf4, 0xf5, 0xf6, 0.55)); ctx.setLineWidth(max(1, s * 2 / 1024))
  let t = body.width * 0.07, m = body.width * 0.075
  ctx.move(to: CGPoint(x: body.minX + m, y: body.maxY - m - t)); ctx.addLine(to: CGPoint(x: body.minX + m, y: body.maxY - m)); ctx.addLine(to: CGPoint(x: body.minX + m + t, y: body.maxY - m))
  ctx.move(to: CGPoint(x: body.maxX - m - t, y: body.minY + m)); ctx.addLine(to: CGPoint(x: body.maxX - m, y: body.minY + m)); ctx.addLine(to: CGPoint(x: body.maxX - m, y: body.minY + m + t))
  ctx.strokePath()
  ctx.restoreGState()
  // Hairline edge.
  ctx.addPath(shape); ctx.setStrokeColor(rgba(0xf4, 0xf5, 0xf6, 0.22)); ctx.setLineWidth(max(1, s * 2 / 1024)); ctx.strokePath()
  if badge {
    // The installer's badge: a paper disc with a black down arrow, bottom right.
    let r = body.width * 0.15, c = CGPoint(x: body.maxX - r * 0.9, y: body.minY + r * 0.9)
    ctx.setShadow(offset: CGSize(width: 0, height: -s * 0.006), blur: s * 0.02, color: rgba(0, 0, 0, 0.6))
    ctx.setFillColor(paper); ctx.fillEllipse(in: CGRect(x: c.x - r, y: c.y - r, width: 2 * r, height: 2 * r))
    ctx.setShadow(offset: .zero, blur: 0, color: nil)
    ctx.setStrokeColor(rgba(0, 0, 0)); ctx.setLineWidth(r * 0.2); ctx.setLineCap(.square); ctx.setLineJoin(.miter)
    ctx.move(to: CGPoint(x: c.x, y: c.y + r * 0.5)); ctx.addLine(to: CGPoint(x: c.x, y: c.y - r * 0.38))
    ctx.move(to: CGPoint(x: c.x - r * 0.42, y: c.y)); ctx.addLine(to: CGPoint(x: c.x, y: c.y - r * 0.42)); ctx.addLine(to: CGPoint(x: c.x + r * 0.42, y: c.y))
    ctx.strokePath()
  }
  return ctx.makeImage()!
}

/// The crest's heater shield in a unit box (0…1, y up): flat-ish top with rounded shoulders, sides curving to a point.
func shieldPath(in r: CGRect) -> CGPath {
  let p = CGMutablePath()
  func pt(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: r.minX + x * r.width, y: r.minY + y * r.height) }
  p.move(to: pt(0.5, 1.0))
  p.addCurve(to: pt(1.0, 0.90), control1: pt(0.70, 0.985), control2: pt(0.86, 0.96))
  p.addCurve(to: pt(0.5, 0.0), control1: pt(1.0, 0.45), control2: pt(0.80, 0.16))
  p.addCurve(to: pt(0.0, 0.90), control1: pt(0.20, 0.16), control2: pt(0.0, 0.45))
  p.addCurve(to: pt(0.5, 1.0), control1: pt(0.14, 0.96), control2: pt(0.30, 0.985))
  p.closeSubpath()
  return p
}

/// The menu bar mark at `px` px square: the filled shield with the crest's eye (and its chevron) knocked out.
func menuBarMark(_ px: Int) -> CGImage {
  let s = CGFloat(px)
  let ctx = context(px, px)
  let h = s * 0.94, w = h * 0.80
  let box = CGRect(x: (s - w) / 2, y: (s - h) / 2, width: w, height: h)
  ctx.addPath(shieldPath(in: box)); ctx.setFillColor(rgba(0, 0, 0)); ctx.fillPath()
  ctx.setBlendMode(.clear)
  // The eye: an almond, its iris and pupil left solid.
  let eye = CGMutablePath(), cy = box.minY + box.height * 0.60, ex = box.width * 0.36, ey = box.height * 0.15
  eye.move(to: CGPoint(x: box.midX - ex, y: cy))
  eye.addQuadCurve(to: CGPoint(x: box.midX + ex, y: cy), control: CGPoint(x: box.midX, y: cy + ey * 1.6))
  eye.addQuadCurve(to: CGPoint(x: box.midX - ex, y: cy), control: CGPoint(x: box.midX, y: cy - ey * 1.6))
  eye.closeSubpath()
  ctx.addPath(eye); ctx.fillPath()
  // The chevron under the eye (the crest's pyramid), as a knocked-out V.
  ctx.setLineWidth(max(1.2, s * 0.075)); ctx.setLineJoin(.miter); ctx.setLineCap(.butt)
  ctx.move(to: CGPoint(x: box.minX + box.width * 0.24, y: box.minY + box.height * 0.40))
  ctx.addLine(to: CGPoint(x: box.midX, y: box.minY + box.height * 0.20))
  ctx.addLine(to: CGPoint(x: box.minX + box.width * 0.76, y: box.minY + box.height * 0.40))
  ctx.strokePath()
  ctx.setBlendMode(.normal)
  let iris = box.width * 0.13
  ctx.setFillColor(rgba(0, 0, 0)); ctx.fillEllipse(in: CGRect(x: box.midX - iris, y: cy - iris, width: 2 * iris, height: 2 * iris))
  return ctx.makeImage()!
}

/// The same shield as a thin outline, a little outside the mark (the listening ring rides on it).
func menuBarOutline(_ px: Int) -> CGImage {
  let s = CGFloat(px)
  let ctx = context(px, px)
  let h = s * 0.94, w = h * 0.80
  let box = CGRect(x: (s - w) / 2, y: (s - h) / 2, width: w, height: h).insetBy(dx: s * 0.02, dy: s * 0.02)
  ctx.addPath(shieldPath(in: box)); ctx.setStrokeColor(rgba(0, 0, 0)); ctx.setLineWidth(max(1, s * 0.07)); ctx.strokePath()
  return ctx.makeImage()!
}

func scaled(_ image: CGImage, _ px: Int) -> CGImage {
  let ctx = context(px, px)
  ctx.interpolationQuality = .high
  ctx.draw(image, in: CGRect(x: 0, y: 0, width: px, height: px))
  return ctx.makeImage()!
}

func icns(_ master: CGImage, to url: URL) {
  let set = FileManager.default.temporaryDirectory.appendingPathComponent("kingmaker-\(UUID().uuidString).iconset")
  try! FileManager.default.createDirectory(at: set, withIntermediateDirectories: true)
  for base in [16, 32, 128, 256, 512] {
    writePNG(scaled(master, base), set.appendingPathComponent("icon_\(base)x\(base).png"))
    writePNG(scaled(master, base * 2), set.appendingPathComponent("icon_\(base)x\(base)@2x.png"))
  }
  let p = Process()
  p.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
  p.arguments = ["-c", "icns", "-o", url.path, set.path]
  try! p.run(); p.waitUntilExit()
  try? FileManager.default.removeItem(at: set)
  guard p.terminationStatus == 0 else { fatalError("iconutil failed for \(url.path)") }
}

icns(appIcon(1024, badge: false), to: root.appendingPathComponent("app/Resources/AppIcon.icns"))
icns(appIcon(1024, badge: true), to: root.appendingPathComponent("installer/Resources/InstallerIcon.icns"))
writePNG(menuBarMark(18), root.appendingPathComponent("app/Resources/MenuBarLogo.png"))
writePNG(menuBarMark(36), root.appendingPathComponent("app/Resources/MenuBarLogo@2x.png"))
writePNG(menuBarOutline(18), root.appendingPathComponent("app/Resources/MenuBarOutline.png"))
writePNG(menuBarOutline(36), root.appendingPathComponent("app/Resources/MenuBarOutline@2x.png"))
let crestPx = 512
let crestCtx = context(crestPx, Int(CGFloat(crestPx) * CGFloat(crest.height) / CGFloat(crest.width)))
crestCtx.interpolationQuality = .high
crestCtx.draw(crest, in: CGRect(x: 0, y: 0, width: crestCtx.width, height: crestCtx.height))
writePNG(crestCtx.makeImage()!, root.appendingPathComponent("installer/Resources/RoninCrest.png"))
// Previews for review only (not shipped): the mark large, and the app icon.
if ProcessInfo.processInfo.environment["KINGMAKER_ICON_PREVIEW"] == "1" {
  writePNG(menuBarMark(256), root.appendingPathComponent("dist/preview-menubar-256.png"))
  writePNG(menuBarOutline(256), root.appendingPathComponent("dist/preview-outline-256.png"))
  writePNG(appIcon(512, badge: true), root.appendingPathComponent("dist/preview-installer-512.png"))
  writePNG(appIcon(512, badge: false), root.appendingPathComponent("dist/preview-app-512.png"))
}
print("icons written under \(root.path)")
