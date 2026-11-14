"""Exercise production AppKit consumer/queue with synthetic @@ghost frames, no engine.
Run: python3 test/bar-correlation-native.py (macOS, swiftc).
"""
from pathlib import Path
import tempfile, subprocess, json
root=Path(__file__).resolve().parents[1]
evidence=json.loads((root/'test/fixtures/foreground-nightly-misassociation.json').read_text())
with tempfile.TemporaryDirectory(prefix='km-correlation-') as tmp:
 out=Path(tmp); home=out/'home'; home.mkdir()
 original=(root/'app/Kingmaker.swift').read_text()
 termination=original.split('    p.terminationHandler =')[1].split('    do { try p.run()')[0]
 assert termination.index('claimTermination(') < termination.index('if self.headlessHostMode'), 'headless automatic restart must clear the retained bar first'
 s=original.replace('NSHomeDirectory()',json.dumps(str(home))).replace('UserDefaults.standard','UserDefaults(suiteName: "test.km.correlation.'+out.name+'")!')
 s=s.replace('applyLook(); refreshFooter(); loadModels(); loadPrograms(); layout()','applyLook(); refreshFooter(); layout()')
 method=r'''
  var fixtureSent: [[String: Any]] = []
  func fixtureStart() {
    fixtureSent.removeAll()
    onTurn = { line in self.fixtureSent.append(try! JSONSerialization.jsonObject(with: Data(base64Encoded: line)!) as! [String: Any]) }
    onCommand = { _ in }
    sendTurn(["text":__EXACT_REQUEST__], shown:__EXACT_REQUEST__, queue:true)
    sendTurn(["text":"Second request"], shown:"Second request", queue:true)
    precondition(fixtureSent.count == 1 && queued.count == 1)
  }
  func fixtureNewPair() { fixtureStart() }
  func fixtureFailed() { precondition(!busy && activeRequestId == nil && queued.isEmpty && requestChats.isEmpty); precondition(log.string.contains("Interrupted:") && log.string.contains("Not sent:")) }
  func fixtureUnavailable() {
    let count = fixtureSent.count
    sendTurn(["text":"offline"], shown:"offline", queue:true)
    precondition(fixtureSent.count == count && !busy)
  }
  func fixtureRecovered() {
    transportStarted()
    sendTurn(["text":"after restart"], shown:"after restart", queue:true)
    precondition(busy && queued.isEmpty && fixtureSent.count == 2)
  }
  func fixtureNoStale() { precondition(!log.string.contains("stale bytes")) }
  func fixtureCancel() { stopTapped(); precondition(!busy && activeRequestId == nil && queued.isEmpty && requestChats.isEmpty) }
  func fixtureCheck(_ step: Int) {
    if step == 0 { precondition(busy && fixtureSent.count == 1 && !log.string.contains("Overnight list")); precondition(!chats[0].lines.contains { $0.contains("Overnight list for 2026-10-18 (open)") }) }
    if step == 1 { precondition(busy && fixtureSent.count == 1); setState("text"); precondition(busy && fixtureSent.count == 1) }
    if step == 2 {
      precondition(busy && fixtureSent.count == 2)
      let answers = chats[0].lines.filter { $0[0] == "Kingmaker" }.map { $0[1] }.joined(separator:"\n")
      precondition(answers.split(separator:"\n").count == 6 && answers.contains("KM-UI-20261018-A") && answers.contains("6. Memory recovery requires measurement."))
      newChat()
    }
    if step == 3 { precondition(chatIndex == nil && log.string.isEmpty); precondition(chats[0].lines.contains { $0.contains("Second answer") }) }
    if step == 4 { precondition(!busy && activeRequestId == nil && requestChats.isEmpty) }
    if step == 5 { precondition(log.string.isEmpty) }
  }
'''
 method=method.replace('__EXACT_REQUEST__',json.dumps(evidence['foregroundRequest']))
 s=s.replace('  var onWake: () -> Void = {}',method+'\n  var onWake: () -> Void = {}',1)
 method=r'''
  func fixtureValidate() {
    // Both event orders claim exactly one restart opportunity; teardown cannot consume it.
    for commandFirst in [true, false] {
      let generation = UUID()
      transportGeneration = generation; pendingTermination = generation
      var restartClaims = 0
      if commandFirst { precondition(!toCli("synthetic offline command")) }
      if claimTermination(generation, reason: "Synthetic termination") { restartClaims += 1 }
      if !commandFirst { precondition(!toCli("synthetic offline command")) }
      if claimTermination(generation, reason: "Duplicate termination") { restartClaims += 1 }
      precondition(restartClaims == 1 && transportGeneration != generation)
      let next = UUID(); transportGeneration = next; pendingTermination = next
      precondition(!claimTermination(generation, reason: "Old process callback"))
      precondition(pendingTermination == next && transportGeneration == next)
    }
    bar.transportStarted()
    print("PASS: command-before-termination and termination-before-command each permit exactly one restart; duplicate and superseded callbacks refused")
    bar.fixtureStart()
    let first = bar.fixtureSent[0]["requestId"] as! String
    func feed(_ obj: [String: Any]) {
      let json = try! JSONSerialization.data(withJSONObject:obj)
      var data = Data("@@ghost ".utf8); data.append(json); data.append(10)
      // Deliberately split within a frame: exercise the real stdout framing boundary.
      consume(data.prefix(11)); consume(data.dropFirst(11))
    }
    feed(["said":"Overnight list for 2026-10-18 (open)","requestId":NSNull()]); bar.fixtureCheck(0)
    feed(["said":"1. KM-UI-20261018-A: Zero local generated tokens fails.\n2. Zero completed local jobs fails.\n3. Missing telemetry is unknown.","requestId":first]); bar.fixtureCheck(1)
    feed(["said":"4. Truncated output fails.\n5. Cloud fallback is not a local completion.\n6. Memory recovery requires measurement.","requestId":first]); bar.fixtureCheck(1)
    feed(["turnComplete":true,"requestId":"wrong-id"]); bar.fixtureCheck(1)
    feed(["turnComplete":true,"requestId":first]); bar.fixtureCheck(2)
    let second = bar.fixtureSent[1]["requestId"] as! String
    feed(["said":"Second answer","requestId":second]); bar.fixtureCheck(3)
    feed(["turnComplete":true,"requestId":second]); bar.fixtureCheck(4)
    feed(["said":"Stale first answer","requestId":first]); bar.fixtureCheck(5)
    bar.fixtureNewPair()
    let dead = bar.fixtureSent[0]["requestId"] as! String, oldGeneration = transportGeneration
    transportDidStop("Synthetic engine death.")
    bar.fixtureFailed(); bar.fixtureUnavailable()
    bar.fixtureRecovered()
    let recovered = bar.fixtureSent[1]["requestId"] as! String
    let stale = Data(("@@ghost {\"said\":\"stale bytes\",\"requestId\":\"" + recovered + "\"}\n").utf8)
    consume(stale, generation: oldGeneration); bar.fixtureNoStale()
    feed(["turnComplete":true,"requestId":dead])
    feed(["said":"Recovered answer","requestId":recovered])
    feed(["turnComplete":true,"requestId":recovered]); bar.fixtureCheck(4)
    bar.fixtureNewPair(); bar.fixtureCancel()
    bar.transportStarted(); bar.fixtureStart()
    bar.fixtureCancel()
    print("PASS: engine death clears active/queued requests; offline send refused; restart accepts new work without replay; stale process bytes ignored; Stop clears correlation")
    print("PASS: actual AppKit consume + queue; overnight isolation, partial frames, multi-line answers, stale IDs, chat switching")
  }
'''
 s=s.replace('final class GhostApp: NSObject, NSApplicationDelegate {','final class GhostApp: NSObject, NSApplicationDelegate {\n'+method,1)
 a=s.index('let app = NSApplication.shared\nlet delegate = GhostApp()'); b=s.index('app.run()',a)+len('app.run()')
 s=s[:a]+'let app = NSApplication.shared\nlet delegate = GhostApp()\ndelegate.fixtureValidate()\n'+s[b:]
 (out/'Fixture.swift').write_text(s)
 subprocess.run(['swiftc',str(out/'Fixture.swift'),'-o',str(out/'fixture'),'-framework','AppKit','-framework','Carbon','-framework','Contacts','-framework','AVFoundation'],check=True)
 result=subprocess.run([str(out/'fixture')],capture_output=True,text=True,timeout=30)
 print(result.stdout); print(result.stderr[-2000:] if result.returncode else '')
 if result.returncode: raise SystemExit(result.returncode)
