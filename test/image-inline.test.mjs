import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const at = (p) => new URL(`../${p}`, import.meta.url);

test('in the bar, a finished picture goes into the chat; only a terminal opens Preview', () => {
  const cli = readFileSync(at('lib/cli.mjs'), 'utf8');
  const lane = cli.slice(cli.indexOf("if (route.lane === 'image' && imageSetup.ready)"), cli.indexOf('const selfCheck = createHealthReporter'));
  assert.match(lane, /if \(r\.ok && agent\) \{ process\.stdout\.write\(`@@ghost \$\{JSON\.stringify\(\{ image: \{ path: r\.file \} \}\)\}\\n`\)/);
  assert.match(lane, /else if \(r\.ok\) \{ execFile\('\/usr\/bin\/open', \[r\.file\]/, 'Preview only without the bar');
  const swift = readFileSync(at('app/Kingmaker.swift'), 'utf8');
  assert.match(swift, /if let img = obj\["image"\] as\? \[String: Any\], let path = img\["path"\] as\? String \{ bar\.showImage\(path\) \}/);
  assert.match(swift, /else if l\[0\] == "Image" \{ appendImage\(l\[1\]\) \}/, 'a reopened chat shows its pictures again');
});

test('inlineImage: fits the chat, never grows, links its file, refuses what is not a picture', { timeout: 180_000 }, (t) => {
  const swift = readFileSync(at('app/Kingmaker.swift'), 'utf8');
  const fn = /\/\/ BEGIN inlineImage[^\n]*\n([\s\S]*?)\/\/ END inlineImage/.exec(swift)?.[1];
  assert.ok(fn, 'inlineImage is marked');
  const swiftBin = ['/usr/bin/swift', '/usr/local/bin/swift'].find((p) => existsSync(p));
  if (!swiftBin) { t.skip('no swift on this Mac'); return; }
  const dir = mkdtempSync(join(tmpdir(), 'km-inline-image-'));
  try {
    writeFileSync(join(dir, 'notes.txt'), 'not a picture');
    writeFileSync(join(dir, 'fake.png'), 'not a picture either');
    writeFileSync(join(dir, 'main.swift'), `import AppKit
${fn}
func png(_ w: Int, _ h: Int, _ name: String) -> String {
  let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: w, pixelsHigh: h, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
  let path = ${JSON.stringify(dir)} + "/" + name
  try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: path))
  return path
}
func show(_ s: NSAttributedString?) -> String {
  guard let s, let a = s.attribute(.attachment, at: 0, effectiveRange: nil) as? NSTextAttachment else { return "nil" }
  let link = (s.attribute(.link, at: 0, effectiveRange: nil) as? URL)?.lastPathComponent ?? "-"
  return "\\(Int(a.bounds.width))x\\(Int(a.bounds.height)) \\(link)"
}
print(show(inlineImage(path: png(1024, 1024, "square.png"), maxWidth: 500)))
print(show(inlineImage(path: png(2000, 1000, "wide.png"), maxWidth: 500)))
print(show(inlineImage(path: png(200, 100, "small.png"), maxWidth: 500)))
print(show(inlineImage(path: ${JSON.stringify(join(dir, 'notes.txt'))}, maxWidth: 500)))
print(show(inlineImage(path: ${JSON.stringify(join(dir, 'fake.png'))}, maxWidth: 500)))
print(show(inlineImage(path: ${JSON.stringify(join(dir, 'missing.png'))}, maxWidth: 500)))
`);
    const out = execFileSync(swiftBin, [join(dir, 'main.swift')], { encoding: 'utf8', timeout: 170_000 }).trim().split('\n');
    assert.deepEqual(out, ['420x420 square.png', '500x250 wide.png', '200x100 small.png', 'nil', 'nil', 'nil']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a lone apostrophe is not a request for lettering; a quoted phrase is', async () => {
  const { imagePrompt } = await import('../lib/image-lane.mjs');
  assert.doesNotMatch(imagePrompt('make a picture of a woman’s face'), /words spelled/);
  assert.match(imagePrompt('a poster that says “Taco Night”'), /words spelled/);
  assert.match(imagePrompt('a sign with ‘OPEN’ on it'), /words spelled/);
});
