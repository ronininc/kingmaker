// Compile the production UI policy helpers; no engine or installed app launch.
import {readFileSync,writeFileSync,mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
const source=readFileSync(new URL('../app/Kingmaker.swift',import.meta.url),'utf8');
const helpers=source.slice(source.indexOf('func barActivityText'),source.indexOf('// ── The menu bar logo'));
const dir=mkdtempSync(join(tmpdir(),'km-ui-policy-'));
writeFileSync(join(dir,'test.swift'),`import AppKit\n${helpers}\n
assert(barActivityText("thinking", busy: true) == "Working…")
assert(barActivityText("thinking", busy: false) == "")
assert(barActivityText("speaking", busy: false) == "Speaking…")
assert(barActivityText("waiting", busy: false) == "Waiting for your word")
for width in [CGFloat(240), 480, 800] {
 for height in [CGFloat(200), 600] {
  let bounds = NSRect(x:0,y:0,width:width,height:height)
  let composer = NSRect(x:16,y:40,width:width-32,height:40)
  let frame = approvalViewportFrame(composer:composer,bounds:bounds,document:NSSize(width:600,height:700))
  assert(frame.minX >= 0 && frame.maxX <= bounds.maxX)
  assert(frame.minY >= composer.maxY && frame.maxY <= bounds.maxY)
 }
}
print("PASS: active/completed/speaking/waiting states and six viewport sizes")
`);
execFileSync('swiftc',[join(dir,'test.swift'),'-o',join(dir,'test'),'-framework','AppKit'],{stdio:'inherit'});
execFileSync(join(dir,'test'),[],{stdio:'inherit'});
