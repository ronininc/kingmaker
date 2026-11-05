import AppKit
import WebKit

#if ARMOR_REVIEW_UI_TESTS
private final class DisposableDragSource: NSView, NSDraggingSource {
  let sourceURL:URL
  let caption:String
  let observe:(String)->Void
  init(frame:NSRect,url:URL,caption:String,observe:@escaping(String)->Void){self.sourceURL=url;self.caption=caption;self.observe=observe;super.init(frame:frame);setAccessibilityElement(true);setAccessibilityLabel(caption)}
  required init?(coder:NSCoder){nil}
  override func acceptsFirstMouse(for event:NSEvent?)->Bool {true}
  override func draw(_ dirtyRect:NSRect){
    NSColor(calibratedWhite:0.12,alpha:1).setFill();bounds.fill()
    NSImage(named:sourceURL.isFileURL ? NSImage.multipleDocumentsName : NSImage.networkName)?.draw(in:NSRect(x:52,y:bounds.midY,width:44,height:44))
    (caption as NSString).draw(in:NSRect(x:8,y:bounds.midY-65,width:134,height:56),withAttributes:[.font:NSFont.systemFont(ofSize:12),.foregroundColor:NSColor.white])
  }
  override func mouseDown(with event:NSEvent){}
  override func mouseDragged(with event:NSEvent){
    observe(sourceURL.isFileURL ? "source-file" : "source-link")
    let item=NSDraggingItem(pasteboardWriter:sourceURL as NSURL)
    item.setDraggingFrame(NSRect(x:52,y:bounds.midY,width:44,height:44),contents:NSImage(named:NSImage.multipleDocumentsName))
    beginDraggingSession(with:[item],event:event,source:self)
  }
  func draggingSession(_ session:NSDraggingSession,sourceOperationMaskFor context:NSDraggingContext)->NSDragOperation{.copy}
  func draggingSession(_ session:NSDraggingSession,endedAt point:NSPoint,operation:NSDragOperation){observe("ended-"+String(operation.rawValue)+"-"+NSStringFromPoint(point))}
}
#endif

private final class ReviewDropView: NSView {
  var chooseFile: (() -> Void)?
  override func mouseDown(with event:NSEvent){chooseFile?()}
  var reviewFile: ((URL) -> Void)?
  var reviewLink: ((URL) -> Void)?
  #if ARMOR_REVIEW_UI_TESTS
  var dragObserved: ((String) -> Void)?
  #endif
  func enableArmorDropRouting() { registerForDraggedTypes([.fileURL,.URL,.string]) }
  private func droppedURL(_ sender:NSDraggingInfo)->URL? {
    if let items=sender.draggingPasteboard.readObjects(forClasses:[NSURL.self]) as? [URL],items.count==1 { return items[0] }
    if let value=sender.draggingPasteboard.string(forType:.string),value.count<=4096,!value.contains("\n"),let url=URL(string:value.trimmingCharacters(in:.whitespacesAndNewlines)),url.scheme?.lowercased()=="https" {return url}
    return nil
  }
  override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
    #if ARMOR_REVIEW_UI_TESTS
    dragObserved?("entered")
    #endif
    if let url=droppedURL(sender),url.isFileURL||url.scheme?.lowercased()=="https" {return .copy}
    return []
  }
  override func draggingUpdated(_ sender:NSDraggingInfo)->NSDragOperation {draggingEntered(sender)}
  override func prepareForDragOperation(_ sender:NSDraggingInfo)->Bool {
    if let url=droppedURL(sender),url.isFileURL||url.scheme?.lowercased()=="https" {return true}
    return false
  }
  override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
    if let url=droppedURL(sender) {
      #if ARMOR_REVIEW_UI_TESTS
      dragObserved?(url.isFileURL ? "perform-file" : "perform-link")
      #endif
      if url.isFileURL {reviewFile?(url);return true}
      if url.scheme?.lowercased()=="https" {reviewLink?(url);return true}
    }
    return false
  }
}
private final class ArmorApp: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
  private var window: NSWindow!
  private var webView: WKWebView!
  private var dropView: ReviewDropView!
  private var dashboard: Process?
  private var stdoutHandle: FileHandle?
  private var pending = Data()
  private var dashboardURL: URL?
  private var nativeReviewToken = (UUID().uuidString + UUID().uuidString).replacingOccurrences(of: "-", with: "").lowercased()
  private var nativeReviewBusy = false
  private var originalReviewReceipts: [String:String] = [:]
  #if ARMOR_REVIEW_UI_TESTS
  private var proofDirectory: URL?
  #endif

  func applicationDidFinishLaunching(_ notification: Notification) {
    if let iconURL = Bundle.main.url(forResource: "ScriptureArmor", withExtension: "icns"),
       let icon = NSImage(contentsOf: iconURL) {
      NSApp.applicationIconImage = icon
    }
    installMenus()
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = .nonPersistent()
    configuration.preferences.setValue(false, forKey: "developerExtrasEnabled")
    configuration.userContentController.add(self, name: "armorFileEjection")
    configuration.userContentController.add(self, name: "armorDeviceReview")
    configuration.userContentController.add(self, name: "armorRetainText")
    configuration.userContentController.add(self, name: "armorSaveReport")
    configuration.userContentController.add(self, name: "armorSaveFindingReport")
    configuration.userContentController.add(self, name: "armorDropGeometry")
    let reviewView = ReviewDropView(frame: .zero)
    reviewView.isHidden=true;reviewView.setAccessibilityElement(false)
    reviewView.chooseFile={ [weak self] in self?.chooseNativeReviewFile() }
    dropView=reviewView
    reviewView.enableArmorDropRouting()
    reviewView.reviewFile = { [weak self] url in self?.reviewNativeFile(url) }
    reviewView.reviewLink = { [weak self] url in self?.nativeReviewRequest("/api/review/native-link",body:["url":url.absoluteString]) }
    webView = WKWebView(frame:.zero,configuration:configuration)
    webView.navigationDelegate = self
    webView.uiDelegate = self
    window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 1180, height: 820),
      styleMask: [.titled, .closable, .miniaturizable, .resizable],
      backing: .buffered,
      defer: false
    )
    window.title = "Scripture Armor"
    window.center()
    let root=NSView(frame:window.contentView!.bounds)
    window.contentView=root
    webView.frame=root.bounds;webView.autoresizingMask=[.width,.height]
    root.addSubview(webView);root.addSubview(reviewView)
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
    webView.loadHTMLString("<style>body{background:#050506;color:#efbd3f;font:18px -apple-system;padding:48px}</style><h1>Scripture Armor</h1><p>Preparing the local protection runtime…</p>", baseURL: nil)
    #if ARMOR_REVIEW_UI_TESTS
    // This route does not exist in production builds. No live account store,
    // identity, vault daemon or release app is started by the UI proof.
    guard let configURL=Bundle.main.url(forResource:"review-fixture",withExtension:"json"),
          let data=try? Data(contentsOf:configURL),
          let config=(try? JSONSerialization.jsonObject(with:data)) as? [String:String],
          let address=config["url"],let base=URL(string:address),base.scheme=="http",base.host=="127.0.0.1",base.port != nil,
          let fixtureToken=config["token"],fixtureToken.range(of:"^[a-f0-9]{64}$",options:.regularExpression) != nil else {
      showFatal("Disposable UI fixture configuration is missing or invalid.");return
    }
    nativeReviewToken=fixtureToken;dashboardURL=base;window.title="Armor Review Proof — DISPOSABLE FILES ONLY"
    var observe:((String)->Void)?
    if let trace=config["trace"],trace.hasPrefix("/private/var/folders/"),trace.contains("/armor-ui-fixture-"),trace.hasSuffix("/drag-events.jsonl") {
      let traceURL=URL(fileURLWithPath:trace)
      try? Data(("registered:"+reviewView.registeredDraggedTypes.map(\.rawValue).joined(separator:",")+"\n").utf8).write(to:traceURL,options:.atomic)
      reviewView.dragObserved={event in
        let previous=(try? Data(contentsOf:traceURL)) ?? Data();if previous.count>16384{return}
        var next=previous;next.append(Data((event+"\n").utf8));try? next.write(to:traceURL,options:.atomic)
      }
      observe=reviewView.dragObserved
    }
    if let file=config["file"],file.hasPrefix("/private/var/folders/"),file.contains("/armor-ui-fixture-"),file.hasSuffix("/scope/flagged-inert.js") {proofDirectory=URL(fileURLWithPath:file).deletingLastPathComponent()}
    if let screen=NSScreen.main?.visibleFrame {window.setFrame(NSRect(x:screen.midX,y:screen.minY+30,width:screen.width/2-20,height:min(820,screen.height-60)),display:true)}
    if config["dragProof"]=="side-source",let file=config["file"],let observer=observe,file.contains("/armor-ui-fixture-"),file.hasSuffix("/scope/flagged-inert.js"),let screen=NSScreen.main?.visibleFrame {
      window.title="Native drop acceptance — disposable source at left"
      window.setFrame(NSRect(x:0,y:screen.maxY-760,width:min(1180,screen.width),height:760),display:true)
      let frame=window.contentView!.bounds,container=NSView(frame:window.contentView!.bounds)
      window.contentView=container
      webView.frame=NSRect(x:150,y:0,width:frame.width-150,height:frame.height);webView.autoresizingMask=[.width,.height];container.addSubview(webView);container.addSubview(reviewView)
      container.addSubview(DisposableDragSource(frame:NSRect(x:0,y:frame.height/2,width:150,height:frame.height/2),url:URL(fileURLWithPath:file),caption:"Disposable file\nDrag right →",observe:observer))
      container.addSubview(DisposableDragSource(frame:NSRect(x:0,y:0,width:150,height:frame.height/2),url:URL(string:"https://example.com/")!,caption:"Public link\nDrag right →",observe:observer))
    }
    var components=URLComponents(url:base,resolvingAgainstBaseURL:false)!;components.queryItems=[URLQueryItem(name:"native",value:"1")]
    webView.load(URLRequest(url:components.url!,cachePolicy:.reloadIgnoringLocalAndRemoteCacheData));return
    #else
    do { try startDashboard() } catch { showFatal(error.localizedDescription) }
    #endif
  }

  private func installMenus() {
    let main = NSMenu()
    let appItem = NSMenuItem()
    let appMenu = NSMenu(title: "Scripture Armor")
    appMenu.addItem(withTitle: "Quit Scripture Armor", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    appItem.submenu = appMenu
    main.addItem(appItem)

    let editItem = NSMenuItem()
    let edit = NSMenu(title: "Edit")
    edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
    edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
    edit.addItem(.separator())
    edit.addItem(withTitle: "Cut", action: Selector(("cut:")), keyEquivalent: "x")
    edit.addItem(withTitle: "Copy", action: Selector(("copy:")), keyEquivalent: "c")
    edit.addItem(withTitle: "Paste", action: Selector(("paste:")), keyEquivalent: "v")
    edit.addItem(withTitle: "Select All", action: Selector(("selectAll:")), keyEquivalent: "a")
    for item in edit.items { item.target = nil }
    editItem.submenu = edit
    main.addItem(editItem)
    NSApp.mainMenu = main
  }

  func applicationWillTerminate(_ notification: Notification) { stopDashboard() }
  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

  private func bundled(_ relative: String) throws -> URL {
    guard let resources = Bundle.main.resourceURL else { throw NSError(domain: "ScriptureArmor", code: 1, userInfo: [NSLocalizedDescriptionKey: "Application resources are missing."]) }
    let url = resources.appendingPathComponent(relative)
    guard FileManager.default.fileExists(atPath: url.path) else { throw NSError(domain: "ScriptureArmor", code: 2, userInfo: [NSLocalizedDescriptionKey: "Required Armor component is missing: \(relative)"]) }
    return url
  }

  private func nodeExecutable() throws -> String {
    let candidates = [
      ProcessInfo.processInfo.environment["SCRIPTURE_NODE"],
      "/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"
    ].compactMap { $0 }
    if let node = candidates.first(where: { FileManager.default.isExecutableFile(atPath: $0) }) { return node }
    throw NSError(domain: "ScriptureArmor", code: 3, userInfo: [NSLocalizedDescriptionKey: "Node 24 or newer is required. Install Node, then reopen Scripture Armor."])
  }

  private func startDashboard() throws {
    let script = try bundled("armor/dashboard.mjs")
    let pipe = Pipe()
    let process = Process()
    process.qualityOfService = .utility
    process.executableURL = URL(fileURLWithPath: try nodeExecutable())
    process.arguments = [script.path, "--port", "0"]
    process.currentDirectoryURL = script.deletingLastPathComponent()
    process.standardOutput = pipe
    process.standardError = pipe
    process.environment = ProcessInfo.processInfo.environment.merging([
      "SCRIPTURE_ARMOR_NATIVE_REVIEW_TOKEN": nativeReviewToken,
      "SCRIPTURE_GHIDRA_HOME": Bundle.main.resourceURL!.appendingPathComponent("armor/tools/ghidra").path,
      "GHIDRA_HEADLESS_MAXMEM": "512M",
      "_JAVA_OPTIONS": "-Xmx512m -XX:ActiveProcessorCount=1 -XX:ParallelGCThreads=1 -XX:ConcGCThreads=1",
      "GHIDRA_HEADLESS_JAVA_OPTIONS": "-XX:ActiveProcessorCount=1 -XX:ParallelGCThreads=1",
      "JAVA_HOME": Bundle.main.resourceURL!.appendingPathComponent("armor/tools/jdk").path
    ]) { _, bundled in bundled }
    process.terminationHandler = { [weak self] task in
      DispatchQueue.main.async {
        guard let self, NSApp.isRunning else { return }
        self.showFatal("The local Armor service stopped (exit \(task.terminationStatus)).")
      }
    }
    stdoutHandle = pipe.fileHandleForReading
    stdoutHandle?.readabilityHandler = { [weak self] handle in self?.consume(handle.availableData) }
    try process.run()
    dashboard = process
  }

  private func consume(_ data: Data) {
    guard !data.isEmpty else { return }
    pending.append(data)
    while let newline = pending.firstIndex(of: 10) {
      let line = String(decoding: pending[..<newline], as: UTF8.self)
      pending.removeSubrange(...newline)
      guard let match = line.range(of: #"http://127\.0\.0\.1:[0-9]+/"#, options: .regularExpression) else { continue }
      let value = String(line[match])
      DispatchQueue.main.async { [weak self] in
        guard let self, self.dashboardURL == nil, let url = URL(string: value) else { return }
        self.dashboardURL = url
        var components = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "native", value: "1")]
        self.webView.load(URLRequest(url: components.url!, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData))
      }
    }
  }

  private func stopDashboard() {
    stdoutHandle?.readabilityHandler = nil
    if let dashboard, dashboard.isRunning { dashboard.terminate() }
    dashboard = nil
  }

  private func showFatal(_ message: String) {
    stopDashboard()
    dashboardURL = nil
    let escaped = message.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: ">", with: "&gt;")
    webView.loadHTMLString("<style>body{background:#000;color:#eee;font:16px -apple-system;padding:48px}h1{color:#efbd3f}</style><h1>Scripture Armor could not start</h1><p>\(escaped)</p>", baseURL: nil)
  }

  private func localFrame(_ frame: WKFrameInfo) -> Bool {
    guard let base = dashboardURL else { return false }
    return frame.isMainFrame && frame.securityOrigin.protocol == "http"
      && frame.securityOrigin.host == "127.0.0.1" && frame.securityOrigin.port == base.port
  }

  private func reviewNativeFile(_ url: URL) {
    guard url.isFileURL, !nativeReviewBusy,
          let values = try? url.resourceValues(forKeys: [.isRegularFileKey,.isSymbolicLinkKey,.isAliasFileKey]),
          values.isRegularFile == true, values.isSymbolicLink != true, values.isAliasFile != true else { return }
    nativeReviewRequest("/api/review/native-file", body: ["path":url.path])
  }

  private func nativeReviewRequest(_ route: String, body: [String: String]) {
    guard !nativeReviewBusy, let base = dashboardURL,
          ["/api/review/native-file","/api/review/native-finding","/api/review/native-retain","/api/review/native-link","/api/review/eject-original"].contains(route),
          let endpoint = URL(string: route, relativeTo: base)?.absoluteURL else { return }
    nativeReviewBusy = true
    var request = URLRequest(url:endpoint, cachePolicy:.reloadIgnoringLocalAndRemoteCacheData, timeoutInterval:45)
    request.httpMethod = "POST"
    request.setValue(base.absoluteString.trimmingCharacters(in:CharacterSet(charactersIn:"/")), forHTTPHeaderField:"Origin")
    request.setValue("application/json", forHTTPHeaderField:"Content-Type")
    request.setValue(nativeReviewToken, forHTTPHeaderField:"x-armor-native-review-token")
    request.httpBody = try? JSONSerialization.data(withJSONObject:body)
    let session = URLSession(configuration:.ephemeral)
    session.dataTask(with:request) { [weak self] data, response, error in
      session.finishTasksAndInvalidate()
      DispatchQueue.main.async {
        guard let self else { return }; self.nativeReviewBusy = false
        guard let data, error == nil, data.count <= 1024*1024,
              var result = (try? JSONSerialization.jsonObject(with:data)) as? [String:Any] else {
          let alert=NSAlert(); alert.messageText="Review did not finish"; alert.informativeText="No removal receipt was received. The file is not reported as removed."; alert.runModal(); return
        }
        if route == "/api/review/native-retain" {
          guard result["ok"] as? Bool == true,let text=result["retainedText"] as? String,text.utf8.count<=131072 else{
            let alert=NSAlert();alert.messageText="Text was not retained";alert.informativeText=result["error"] as? String ?? "Text review did not finish. The original is unchanged.";alert.beginSheetModal(for:self.window);return
          }
          let panel=NSSavePanel();panel.title="Save reviewed portions as plain text";panel.nameFieldStringValue="Armor retained notes.txt";panel.allowedFileTypes=["txt"];panel.allowsOtherFileTypes=false
          panel.beginSheetModal(for:self.window){response in
            guard response == .OK,let url=panel.url,url.pathExtension.lowercased()=="txt" else{return}
            do{try text.write(to:url,atomically:true,encoding:.utf8)}catch{let alert=NSAlert();alert.messageText="Could not save retained text";alert.informativeText="The original file has not been removed.";alert.beginSheetModal(for:self.window)}
          };return
        }
        self.originalReviewReceipts.removeAll()
        if let id = result["sourceEjectionId"] as? String, let sourcePath = result["nativeSourcePath"] as? String ?? body["path"] { self.originalReviewReceipts[id] = sourcePath }
        result.removeValue(forKey:"nativeSourcePath")
        let script = result["repositoryJob"] != nil ? "if(typeof showRepositoryProgress==='function')showRepositoryProgress(result.repositoryJob)" : result["review"] != nil ? "if(typeof showReview==='function')showReview(result)" : "if(typeof showEjection==='function')showEjection(result)"
        self.webView.callAsyncJavaScript(script, arguments:["result":result], in:nil, in:.page, completionHandler:nil)
      }
    }.resume()
  }

  private func saveRepositoryReport(_ id:String,title:String){
    guard let base=dashboardURL,let endpoint=URL(string:"/api/review/native-report",relativeTo:base) else{return}
    let panel=NSSavePanel();
    #if ARMOR_REVIEW_UI_TESTS
    panel.directoryURL=proofDirectory
    #endif
    panel.title="Save repository security report";panel.allowedFileTypes=["jsonl"];panel.allowsOtherFileTypes=false
    let safe=title.replacingOccurrences(of:"[^A-Za-z0-9._ -]",with:"-",options:.regularExpression)
    panel.nameFieldStringValue=String(safe.prefix(120))+".jsonl"
    panel.beginSheetModal(for:window){[weak self] response in
      guard let self,response == .OK,let destination=panel.url,destination.pathExtension=="jsonl" else{return}
      var request=URLRequest(url:endpoint,timeoutInterval:60);request.httpMethod="POST";request.setValue(base.absoluteString.trimmingCharacters(in:CharacterSet(charactersIn:"/")),forHTTPHeaderField:"Origin");request.setValue("application/json",forHTTPHeaderField:"Content-Type");request.setValue(self.nativeReviewToken,forHTTPHeaderField:"x-armor-native-review-token");request.httpBody=try? JSONSerialization.data(withJSONObject:["id":id])
      let session=URLSession(configuration:.ephemeral)
      session.downloadTask(with:request){file,response,error in
        defer{session.finishTasksAndInvalidate()}
        var failure=error != nil || (response as? HTTPURLResponse)?.statusCode != 200
        if !failure,let file{do{try FileManager.default.copyItem(at:file,to:destination)}catch{failure=true}}
        DispatchQueue.main.async{let alert=NSAlert();alert.messageText=failure ? "Report was not saved" : "Report saved";alert.informativeText=failure ? "Choose a new filename and try again. Existing files were not overwritten." : "This is a static-analysis snapshot. Findings are potential vectors, not proof of a breach. A running job may still have uninspected files.";alert.beginSheetModal(for:self.window)}
      }.resume()
    }
  }

  private func chooseNativeReviewFile(){
    guard !nativeReviewBusy else{return}
      let panel=NSOpenPanel(); panel.title="Choose one file for native sandbox review"; panel.canChooseFiles=true; panel.canChooseDirectories=false; panel.allowsMultipleSelection=false; panel.resolvesAliases=false
      #if ARMOR_REVIEW_UI_TESTS
      panel.directoryURL=proofDirectory
      #endif
      panel.beginSheetModal(for:window) { [weak self] response in
        guard response == .OK, let file=panel.url else { return }; self?.reviewNativeFile(file)
      }
  }

  func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
    if message.name == "armorSaveFindingReport" {
      guard localFrame(message.frameInfo),let body=message.body as? [String:String],body.count==2,
        let title=body["title"],title.count<=200,let text=body["text"],text.utf8.count<=524288,
        let data=text.data(using:.utf8),let report=(try? JSONSerialization.jsonObject(with:data)) as? [String:Any],report["schema"] as? String == "scripture-armor.review-report/1" else{return}
      let panel=NSSavePanel();panel.title="Save security findings report";panel.allowedFileTypes=["json"];panel.allowsOtherFileTypes=false
      panel.nameFieldStringValue=String(title.replacingOccurrences(of:"[^A-Za-z0-9._ -]",with:"-",options:.regularExpression).prefix(120))+".json"
      panel.beginSheetModal(for:window){response in
        guard response == .OK,let destination=panel.url,destination.pathExtension=="json" else{return}
        do{try data.write(to:destination,options:.atomic)}catch{let alert=NSAlert();alert.messageText="Report was not saved";alert.informativeText="Choose another location and try again.";alert.beginSheetModal(for:self.window)}
      };return
    }
    if message.name == "armorSaveReport" {
      guard localFrame(message.frameInfo),let body=message.body as? [String:String],body.count==2,
        let id=body["id"],UUID(uuidString:id) != nil,let title=body["title"],title.count<=160 else{return}
      saveRepositoryReport(id,title:title);return
    }
    if message.name == "armorRetainText" {
      guard localFrame(message.frameInfo),let body=message.body as? [String:String],body.count==1,
        let text=body["text"],!text.isEmpty,text.count<=32768 else{return}
      nativeReviewRequest("/api/review/native-retain",body:["text":text]);return
    }
    if message.name == "armorDeviceReview" {
      guard localFrame(message.frameInfo),let body=message.body as? [String:String],body.count==1,
        let id=body["id"],UUID(uuidString:id) != nil else{return}
      nativeReviewRequest("/api/review/native-finding",body:["id":id]);return
    }
    if message.name == "armorDropGeometry" {
      guard localFrame(message.frameInfo),let body=message.body as? [String:Double],body.count==4,
        let x=body["x"],let y=body["y"],let w=body["width"],let h=body["height"],
        [x,y,w,h].allSatisfy({$0.isFinite && abs($0)<100000}),w>=0,h>=0 else{return}
      let rect=NSRect(x:x,y:webView.isFlipped ? y : webView.bounds.height-y-h,width:w,height:h).intersection(webView.bounds)
      dropView.isHidden=rect.isEmpty
      if !rect.isEmpty {dropView.frame=webView.convert(rect,to:dropView.superview)}
      #if ARMOR_REVIEW_UI_TESTS
      dropView.dragObserved?("geometry-"+NSStringFromRect(dropView.frame))
      #endif
      return
    }
    guard message.name == "armorFileEjection", localFrame(message.frameInfo), !nativeReviewBusy,
          let body = message.body as? [String:Any], body.count == 1,
          let id = body["id"] as? String, UUID(uuidString:id) != nil,
          let sourcePath = originalReviewReceipts[id] else { return }
    nativeReviewBusy = true
    let alert = NSAlert(); alert.alertStyle = .critical
    alert.messageText = "Permanently remove the flagged original file?"
    alert.informativeText = "File: \(sourcePath)\n\nThis removes only the exact unchanged file tied to this review. It bypasses Trash and cannot guarantee SSD forensic erasure, remove unknown copies, or undo prior activity. Cancel preserves the original. No administrator credentials are requested."
    alert.addButton(withTitle:"Cancel"); alert.addButton(withTitle:"Permanently Remove")
    alert.beginSheetModal(for:window) { [weak self] response in
      self?.nativeReviewBusy = false
      guard response == .alertSecondButtonReturn else { return }
      self?.nativeReviewRequest("/api/review/eject-original", body:["id":id,"confirm":"PERMANENTLY_REMOVE_REVIEWED_FILE"])
    }
  }

  func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
               initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
    guard localFrame(frame) else { completionHandler(); return }
    let alert = NSAlert(); alert.messageText = "Scripture Armor"; alert.informativeText = message
    alert.addButton(withTitle: "OK")
    alert.beginSheetModal(for: window) { _ in completionHandler() }
  }

  func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
               initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
    guard localFrame(frame) else { completionHandler(false); return }
    let alert = NSAlert(); alert.messageText = "Confirm Scripture Armor action"; alert.informativeText = message
    alert.addButton(withTitle: "Cancel"); alert.addButton(withTitle: "Continue")
    alert.beginSheetModal(for: window) { response in completionHandler(response == .alertSecondButtonReturn) }
  }

  func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
               initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
    guard localFrame(frame) else { completionHandler(nil); return }
    let panel = NSOpenPanel()
    panel.title = "Choose one file for isolated review"
    panel.canChooseFiles = true; panel.canChooseDirectories = false
    panel.allowsMultipleSelection = false; panel.resolvesAliases = false
    panel.beginSheetModal(for:window) { response in
      guard response == .OK,let file = panel.url,
            let values = try? file.resourceValues(forKeys:[.isRegularFileKey,.isSymbolicLinkKey,.isAliasFileKey]),
            values.isRegularFile == true,values.isSymbolicLink != true,values.isAliasFile != true else { completionHandler(nil); return }
      let resolved = file.resolvingSymlinksInPath().path
      let home = FileManager.default.homeDirectoryForCurrentUser
      let protected = [".scripture-armor",".scripture-armor.installation",".kingmaker",".ssh",".codex",".aws"].map { home.appendingPathComponent($0).path }
      guard !protected.contains(where:{ resolved == $0 || resolved.hasPrefix($0 + "/") }) else { completionHandler(nil); return }
      completionHandler([file])
    }
  }

  func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
    if url.absoluteString == "about:blank" && dashboardURL == nil { decisionHandler(.allow); return }
    if url.scheme == "scripture-armor" && url.host == "review-file" {
      decisionHandler(.cancel)
      guard navigationAction.navigationType == .linkActivated, localFrame(navigationAction.sourceFrame) else { return }
      chooseNativeReviewFile()
      return
    }
    if url.scheme == "scripture-armor" && url.host == "choose-file" {
      decisionHandler(.cancel)
      guard navigationAction.navigationType == .linkActivated,
            navigationAction.sourceFrame.isMainFrame,
            let dashboardURL, let current = webView.url,
            current.host == dashboardURL.host, current.port == dashboardURL.port,
            current.scheme == "http" else { return }
      let panel = NSOpenPanel()
      panel.title = "Choose a file for Armor and Ghidra analysis"
      panel.canChooseFiles = true
      panel.canChooseDirectories = false
      panel.allowsMultipleSelection = false
      panel.beginSheetModal(for: window) { [weak self] response in
        guard response == .OK, let selected = panel.url,
              let self, let base = self.dashboardURL,
              var components = URLComponents(url: base, resolvingAgainstBaseURL: false) else { return }
        components.queryItems = [URLQueryItem(name: "native", value: "1"), URLQueryItem(name: "selectedFile", value: selected.path)]
        guard let selectedURL = components.url else { return }
        self.webView.load(URLRequest(url: selectedURL, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData))
      }
      return
    }
    if url.host == "127.0.0.1" && url.scheme == "http" && url.port == dashboardURL?.port { decisionHandler(.allow); return }
    if url.scheme == "https" && url.host == "www.ronininc.org" && url.path == "/armor/checkout" && navigationAction.navigationType == .linkActivated && localFrame(navigationAction.sourceFrame) {
      NSWorkspace.shared.open(url)
    }
    decisionHandler(.cancel)
  }
}

@main
private struct ArmorMain {
  static func main() {
    let app = NSApplication.shared
    let delegate = ArmorApp()
    app.setActivationPolicy(.regular)
    app.delegate = delegate
    withExtendedLifetime(delegate) { app.run() }
  }
}
