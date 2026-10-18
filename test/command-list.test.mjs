import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { COMMAND_GROUPS, commandListMarkdown, commandMenu, withAddons } from '../lib/command-list.mjs';
import { isStopApproving } from '../lib/kill-switch.mjs';
import { ronin } from '../lib/addons.mjs';
import { learningWords } from '../lib/learning.mjs';
import { isAdRequest } from '../lib/ad-video.mjs';
import { classifyLine } from '../lib/session.mjs';

const at = (p) => new URL(`../${p}`, import.meta.url);
// The core list (the README's) and, on an owner's install, the Ronin add-on's entries with it (the bar's).
const all = withAddons(COMMAND_GROUPS).flatMap((g) => g.items);
const said = all.map((i) => i.say ?? '').join(' \n ');

test('the README\'s command list is the list (edit lib/command-list.mjs, then regenerate)', () => {
  const readme = readFileSync(at('README.md'), 'utf8');
  const m = /<!-- BEGIN command-list[^\n]*-->\n([\s\S]*?)\n<!-- END command-list -->/.exec(readme);
  assert.ok(m, 'README has the command-list markers');
  assert.equal(m[1], commandListMarkdown());
});

test('every / command the bar answers, and every console command, is on the list', () => {
  const swift = readFileSync(at('app/Kingmaker.swift'), 'utf8');
  const send = swift.slice(swift.indexOf('private func send(queue: Bool)'), swift.indexOf('// "/recall what did Ana say"'));
  const slash = [...send.matchAll(/case ((?:"\/[a-z]+",?\s*)+)/g)].map((c) => c[1].match(/\/[a-z]+/)[0]);
  assert.ok(slash.length >= 8);
  for (const c of slash) assert.ok(said.includes(c), `${c} is listed`);
  for (const c of [':help', ':quit', ':pending', ':key', ':craft', ':tools', ':scan', ...(ronin ? [':approvals', ':dms', ':nightly'] : [])]) assert.ok(said.includes(c), `${c} is listed`);
  assert.equal(classifyLine(':pending'), 'pending'); assert.equal(classifyLine(':help'), 'help');
});

test('the listed phrases are the ones the tools really answer', () => {
  assert.ok(isStopApproving('stop approving'));
  if (ronin) assert.ok(ronin.isStopForwarding('stop forwarding'));
  assert.equal(learningWords('learning on')?.op, 'on');
  assert.equal(learningWords('keep that')?.op, 'keep');
  assert.equal(learningWords('drop that')?.op, 'drop');
  assert.equal(learningWords('what have you learned about me')?.op, 'summary');
  assert.equal(learningWords('forget what you learned about tacos')?.op, 'forget');
  assert.equal(learningWords('where did you learn that')?.op, 'where');
  assert.ok(isAdRequest('make an ad about Kingmaker'));
  if (ronin) {
    assert.equal(ronin.workRequest('write a proposal for the taco shop')?.kind, 'write');
    assert.equal(ronin.workRequest('research merchant cash advances')?.kind, 'research');
    for (const c of [':nightly status', ':nightly show', ':nightly approve', ':nightly run', ':nightly brain claude']) assert.notEqual(ronin.nightlyCommand(c)?.op, 'help', c);
    assert.ok(said.includes('retire stale memories'));
  }
  for (const p of ['scan my Mac', 'what can you drive', 'find tools for my apps', 'put my keys in the vault', 'connect my CRM', 'new conversation'])
    assert.ok(said.includes(p), p);
});

test('the bar gets the list at launch, and :nightly typed in the bar reaches the loop, not a brain', () => {
  const cli = readFileSync(at('lib/cli.mjs'), 'utf8');
  assert.match(cli, /process\.stdout\.write\(`@@ghost \$\{JSON\.stringify\(\{ commands: commandMenu\(\) \}\)\}\\n`\)/);
  const typedTurn = cli.slice(cli.indexOf("else if (/^typed-turn\\s+/.test(said))"), cli.indexOf('const learnSaid = learning.handle(text, \'typed\');', cli.indexOf("else if (/^typed-turn\\s+/.test(said))")));
  assert.match(typedTurn, /if \(text\.startsWith\(':'\) && ronin\?\.nightlyCommand\(text\)\) \{/, 'the bar\'s own typed path handles :nightly before any brain');
  const swift = readFileSync(at('app/Kingmaker.swift'), 'utf8');
  assert.match(swift, /if let cmds = obj\["commands"\] as\? \[\[String: Any\]\] \{ bar\.setCommands\(cmds\) \}/);
  assert.match(swift, /pill\(commandsButton, "gamecontroller", ""\); commandsButton\.attributedTitle = NSAttributedString\(string: ""\); commandsButton\.imagePosition = \.imageOnly/, 'a small controller icon');
  assert.match(swift, /for b in \[folderButton, powerButton, muteButton, commandsButton\] where !b\.isHidden/, 'the pill has its place in the bottom row');
  const menu = commandMenu();
  assert.equal(menu.length, COMMAND_GROUPS.length);
  assert.deepEqual(menu[0].items[0], { title: COMMAND_GROUPS[0].items[0].does, detail: '⌥Space', kind: 'keys', icon: 'keyboard', key: 'space', mods: ['option'] });
  assert.ok(menu.every((g) => g.icon && g.items.every((i) => i.icon)), 'every category and entry has an icon');
});

test('the controller icon opens the library: a search that keeps every word, across titles, details and categories', { timeout: 180_000 }, (t) => {
  const swift = readFileSync(at('app/Kingmaker.swift'), 'utf8');
  assert.match(swift, /@objc private func commandsMenu\(_ sender: NSButton\) \{ library\.show\(commandGroups, over: panel\) \}/);
  assert.match(swift, /glass\.material = \.hudWindow; glass\.blendingMode = \.behindWindow/, 'glassy');
  assert.match(swift, /func windowDidResignKey\(_ n: Notification\) \{ close\(\) \}/, 'a click outside closes it');
  const fn = /\/\/ BEGIN commandLibraryFilter[^\n]*\n([\s\S]*?)\/\/ END commandLibraryFilter/.exec(swift)?.[1];
  assert.ok(fn, 'commandLibraryFilter is marked');
  const swiftBin = ['/usr/bin/swift', '/usr/local/bin/swift'].find((p) => existsSync(p));
  if (!swiftBin) { t.skip('no swift on this Mac'); return; }
  const dir = mkdtempSync(join(tmpdir(), 'km-command-library-'));
  try {
    const groups = commandMenu();
    writeFileSync(join(dir, 'groups.json'), JSON.stringify(groups));
    writeFileSync(join(dir, 'main.swift'), `import Foundation\n${fn}\nlet g = try! JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: ${JSON.stringify(join(dir, 'groups.json'))}))) as! [[String: Any]]
for q in ["", "poster", "APPROVE", "nightly brain", "shortcut tab", "zzz nothing"] {
  let r = commandLibraryFilter(g, q)
  print("\\(q)|\\(r.count)|\\(r.flatMap { ($0["items"] as! [[String: Any]]).map { $0["title"] as! String } }.prefix(3).joined(separator: ";"))")
}\n`);
    const out = execFileSync(swiftBin, [join(dir, 'main.swift')], { encoding: 'utf8', timeout: 170_000 }).trim().split('\n');
    assert.equal(out[0], `|${groups.length}|${groups[0].items.slice(0, 3).map((i) => i.title).join(';')}`, 'nothing typed: everything');
    assert.equal(out[1], 'poster|1|make a poster for …');
    if (ronin) {
      assert.match(out[2], /^APPROVE\|\d+\|.*:nightly approve <code> \[skip 2,3\]/, 'any case');
      assert.equal(out[3], 'nightly brain|1|:nightly brain claude | chatgpt', 'every word must match');
    } else {
      assert.match(out[2], /^APPROVE\|\d+\|/, 'any case');
      assert.equal(out[3], 'nightly brain|0|', 'every word must match');
    }
    assert.match(out[4], /^shortcut tab\|1\|Take the suggested next command/, 'the category\'s name counts');
    assert.equal(out[5], 'zzz nothing|0|');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
