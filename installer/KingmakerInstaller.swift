// Kingmaker Installer.app — the only window Kingmaker ever shows (operator 2026-10-08: "downloading it opens a small UI
// … with a download button — they can only download the entire thing, never just
// some of it … after that there's no UI. Only installer UI exists").
//
// One field (the wake word: empty, "Give me a name", cemented at install), the profile packs, and one button (Download &
// Install). The packs (owner 2026-10-15: "a launcher with profiles and recommended one for selections … like install
// packs and dlc in a game") are lib/mac-profiles.mjs PACKS, carried in the release manifest: each is the model set and
// limits for one Mac class, this Mac's own pre-selected and marked Recommended. Kingmaker itself is still everything or
// nothing (no component checkboxes); the pack only picks the models. The engine (Resources/engine.sh --pack) installs
// it, and this window shows its "@@km {json}" progress lines as one bar, then quits once Kingmaker has launched.
//
// The look is Kingmaker's own (owner 2026-10-15: the installer gets "the same overhaul … the same customizability that
// Kingmaker has"): black (or dark glass, or the Mac's), the Bodoni wordmark, Ronin gold, and the accent the owner picked
// for Kingmaker's replies. Look, accent, text size, where it opens and the language are the SAME settings as
// Kingmaker's Customize (its defaults, com.ronininc.solghost, and its language file), changed from the gear here or
// there. The window moves (drag anywhere), resizes, goes full screen, and comes back where it was left.

import AppKit
import SwiftUI

// ── Kingmaker's settings, shared with the bar ───────────────────────────────────────────────────────────────────
final class Look: ObservableObject {
  static let shared = Look()
  private let d = UserDefaults(suiteName: "com.ronininc.solghost") ?? .standard
  static let dataDir = URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support/sol-ghost")
  @Published var look: String
  @Published var accentName: String
  @Published var textSize: Double
  @Published var position: String
  @Published var language: String
  init() {
    look = d.string(forKey: "km.look") ?? "black"; accentName = d.string(forKey: "km.replyColor") ?? "green"
    textSize = d.object(forKey: "km.textSize") as? Double ?? 14; position = d.string(forKey: "km.position") ?? "middle"
    let fixed = ((try? String(contentsOf: Look.dataDir.appendingPathComponent("language"), encoding: .utf8)) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    language = fixed.isEmpty ? "auto" : fixed
  }
  func set(_ key: String, _ value: Any) {
    switch key {
    case "km.look": look = value as? String ?? look
    case "km.replyColor": accentName = value as? String ?? accentName
    case "km.textSize": textSize = value as? Double ?? textSize
    case "km.position": position = value as? String ?? position
    default: break
    }
    d.set(value, forKey: key)
  }
  func setLanguage(_ v: String) {
    language = v
    try? FileManager.default.createDirectory(at: Look.dataDir, withIntermediateDirectories: true)
    let f = Look.dataDir.appendingPathComponent("language")
    try? Data(v.utf8).write(to: f, options: .atomic); try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: f.path)
  }
  var scale: CGFloat { CGFloat(textSize) / 14 }
  var accent: Color {
    switch accentName {
    case "white": return .white
    case "blue": return Color(red: 0.45, green: 0.72, blue: 1)
    case "amber": return Color(red: 1, green: 0.75, blue: 0.3)
    default: return Color(red: 0.29, green: 0.87, blue: 0.5)
    }
  }
  var background: Color { look == "system" ? Color(nsColor: .windowBackgroundColor) : look == "glass" ? .clear : .black }
}

// ── the tokens (Kingmaker's look) ───────────────────────────────────────────────────────────────────────────────
enum Machine {
  static var void: Color { Look.shared.background }
  static let field = Color(red: 0x15 / 255, green: 0x19 / 255, blue: 0x1d / 255)
  static var paper: Color { Look.shared.accent }   // the primary button and the progress fill: the owner's accent
  static let gold = Color(red: 0.91, green: 0.73, blue: 0.27)
  static let ink = Color(red: 0xf4 / 255, green: 0xf5 / 255, blue: 0xf6 / 255)
  static let inkDim = Color(red: 0x9a / 255, green: 0xa1 / 255, blue: 0xa8 / 255)
  static let inkFaint = Color(red: 0x5d / 255, green: 0x65 / 255, blue: 0x6d / 255)
  static let line = Color(red: 0xf4 / 255, green: 0xf5 / 255, blue: 0xf6 / 255).opacity(0.55)
  static let lineFaint = Color(red: 0xf4 / 255, green: 0xf5 / 255, blue: 0xf6 / 255).opacity(0.16)
  static let alert = Color(red: 0xe3 / 255, green: 0x17 / 255, blue: 0x1f / 255)
  static let amber = Color(red: 1, green: 0x9a / 255, blue: 0x2e / 255)
  static let ok = Color(red: 0x9b / 255, green: 0xe7 / 255, blue: 0xa6 / 255)
  static func mono(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font { .system(size: size * Look.shared.scale, weight: weight, design: .monospaced) }
  static func bodoni(_ size: CGFloat) -> Font { .custom("BodoniSvtyTwoITCTT-Bold", size: size * Look.shared.scale) }
}

// ── the installer's words in the owner's language (Customize → Language; Auto = this Mac's) ─────────────────────
enum L {
  static let codes: [String: String] = ["English": "en", "Español": "es", "Français": "fr", "Deutsch": "de", "Italiano": "it", "Português": "pt", "中文": "zh", "日本語": "ja", "한국어": "ko"]
  static var code: String {
    if let c = codes[Look.shared.language] { return c }
    return Locale.preferredLanguages.first.map { Locale(identifier: $0).language.languageCode?.identifier ?? "en" } ?? "en"
  }
  static func t(_ en: String) -> String { code == "en" ? en : (table[en]?[code] ?? en) }
  static let table: [String: [String: String]] = [
    "Choose your pack": ["es": "Elige tu paquete", "fr": "Choisissez votre pack", "de": "Paket wählen", "pt": "Escolha seu pacote", "it": "Scegli il pacchetto", "ja": "パックを選択", "zh": "选择你的套件", "ko": "팩 선택"],
    "This Mac": ["es": "Este Mac", "fr": "Ce Mac", "de": "Dieser Mac", "pt": "Este Mac", "it": "Questo Mac", "ja": "このMac", "zh": "这台 Mac", "ko": "이 Mac"],
    "GB of models": ["es": "GB de modelos", "fr": "Go de modèles", "de": "GB Modelle", "pt": "GB de modelos", "it": "GB di modelli", "ja": "GBのモデル", "zh": "GB 模型", "ko": "GB 모델"],
    "Voice": ["es": "Voz", "fr": "Voix", "de": "Stimme", "pt": "Voz", "it": "Voce", "ja": "音声", "zh": "语音", "ko": "음성"],
    "Text only": ["es": "Solo texto", "fr": "Texte seul", "de": "Nur Text", "pt": "Só texto", "it": "Solo testo", "ja": "テキストのみ", "zh": "仅文字", "ko": "텍스트만"],
    "pictures on": ["es": "imágenes sí", "fr": "images oui", "de": "Bilder an", "pt": "imagens sim", "it": "immagini sì", "ja": "画像オン", "zh": "图片开", "ko": "이미지 켬"],
    "pictures off": ["es": "imágenes no", "fr": "images non", "de": "Bilder aus", "pt": "imagens não", "it": "immagini no", "ja": "画像オフ", "zh": "图片关", "ko": "이미지 끔"],
    "at once": ["es": "a la vez", "fr": "à la fois", "de": "gleichzeitig", "pt": "ao mesmo tempo", "it": "insieme", "ja": "同時", "zh": "同时", "ko": "동시"],
    "Recommended": ["es": "Recomendado", "fr": "Recommandé", "de": "Empfohlen", "pt": "Recomendado", "it": "Consigliato", "ja": "おすすめ", "zh": "推荐", "ko": "추천"],
    "May swap": ["es": "Puede usar swap", "fr": "Peut swapper", "de": "Kann auslagern", "pt": "Pode usar swap", "it": "Può usare swap", "ja": "スワップの可能性", "zh": "可能交换内存", "ko": "스왑 가능"],
    "Wake word": ["es": "Palabra de activación", "fr": "Mot d’éveil", "de": "Aktivierungswort", "pt": "Palavra de ativação", "it": "Parola di attivazione", "ja": "ウェイクワード", "zh": "唤醒词", "ko": "호출어"],
    "Give me a name": ["es": "Dame un nombre", "fr": "Donnez-moi un nom", "de": "Gib mir einen Namen", "pt": "Dê-me um nome", "it": "Dammi un nome", "ja": "名前をつけて", "zh": "给我起个名字", "ko": "이름을 지어 주세요"],
    "Download & Install": ["es": "Descargar e instalar", "fr": "Télécharger et installer", "de": "Laden & installieren", "pt": "Baixar e instalar", "it": "Scarica e installa", "ja": "ダウンロードしてインストール", "zh": "下载并安装", "ko": "다운로드 및 설치"],
    "Download & Update": ["es": "Descargar y actualizar", "fr": "Télécharger et mettre à jour", "de": "Laden & aktualisieren", "pt": "Baixar e atualizar", "it": "Scarica e aggiorna", "ja": "ダウンロードして更新", "zh": "下载并更新", "ko": "다운로드 및 업데이트"],
    "Try again": ["es": "Reintentar", "fr": "Réessayer", "de": "Erneut versuchen", "pt": "Tentar de novo", "it": "Riprova", "ja": "再試行", "zh": "重试", "ko": "다시 시도"],
    "Cancel": ["es": "Cancelar", "fr": "Annuler", "de": "Abbrechen", "pt": "Cancelar", "it": "Annulla", "ja": "キャンセル", "zh": "取消", "ko": "취소"],
    "Done": ["es": "Listo", "fr": "Terminé", "de": "Fertig", "pt": "Pronto", "it": "Fatto", "ja": "完了", "zh": "完成", "ko": "완료"],
    "Read the terms": ["es": "Leer los términos", "fr": "Lire les conditions", "de": "Bedingungen lesen", "pt": "Ler os termos", "it": "Leggi i termini", "ja": "規約を読む", "zh": "阅读条款", "ko": "약관 읽기"],
    "Close": ["es": "Cerrar", "fr": "Fermer", "de": "Schließen", "pt": "Fechar", "it": "Chiudi", "ja": "閉じる", "zh": "关闭", "ko": "닫기"],
    "Accept": ["es": "Aceptar", "fr": "Accepter", "de": "Akzeptieren", "pt": "Aceitar", "it": "Accetta", "ja": "同意する", "zh": "接受", "ko": "동의"],
    "Customize": ["es": "Personalizar", "fr": "Personnaliser", "de": "Anpassen", "pt": "Personalizar", "it": "Personalizza", "ja": "カスタマイズ", "zh": "自定义", "ko": "사용자화"],
    "Look": ["es": "Aspecto", "fr": "Apparence", "de": "Aussehen", "pt": "Aparência", "it": "Aspetto", "ja": "見た目", "zh": "外观", "ko": "모양"],
    "Accent": ["es": "Acento", "fr": "Accent", "de": "Akzent", "pt": "Destaque", "it": "Accento", "ja": "アクセント", "zh": "强调色", "ko": "강조색"],
    "Text size": ["es": "Tamaño del texto", "fr": "Taille du texte", "de": "Textgröße", "pt": "Tamanho do texto", "it": "Dimensione testo", "ja": "文字サイズ", "zh": "文字大小", "ko": "글자 크기"],
    "Opens at": ["es": "Se abre en", "fr": "S’ouvre en", "de": "Öffnet", "pt": "Abre em", "it": "Si apre", "ja": "表示位置", "zh": "打开位置", "ko": "열리는 위치"],
    "Language": ["es": "Idioma", "fr": "Langue", "de": "Sprache", "pt": "Idioma", "it": "Lingua", "ja": "言語", "zh": "语言", "ko": "언어"],
    "Kingmaker, plus the pack you pick.": ["es": "Kingmaker, más el paquete que elijas.", "fr": "Kingmaker, plus le pack de votre choix.", "de": "Kingmaker, plus das Paket deiner Wahl.", "pt": "Kingmaker, mais o pacote que escolher.", "it": "Kingmaker, più il pacchetto che scegli.", "ja": "Kingmaker と、選んだパック。", "zh": "Kingmaker，加上你选的套件。", "ko": "Kingmaker와 선택한 팩."],
    "One download: everything, or nothing.": ["es": "Una descarga: todo o nada.", "fr": "Un seul téléchargement : tout ou rien.", "de": "Ein Download: alles oder nichts.", "pt": "Um download: tudo ou nada.", "it": "Un download: tutto o niente.", "ja": "ダウンロードは一度：すべてか、何もなしか。", "zh": "一次下载：全部，或什么都不装。", "ko": "한 번의 다운로드: 전부 아니면 아무것도."],
    "1 to 3 words, letters only. Cemented at install: to change it later, delete Kingmaker and install it again.": ["es": "De 1 a 3 palabras, solo letras. Queda fijada al instalar: para cambiarla, borra Kingmaker e instálalo de nuevo.", "fr": "1 à 3 mots, lettres seulement. Fixé à l’installation : pour le changer, supprimez Kingmaker et réinstallez-le.", "de": "1 bis 3 Wörter, nur Buchstaben. Wird bei der Installation festgelegt: zum Ändern Kingmaker löschen und neu installieren.", "pt": "De 1 a 3 palavras, só letras. Fica fixa na instalação: para mudar, apague o Kingmaker e instale de novo.", "it": "Da 1 a 3 parole, solo lettere. Fissata all’installazione: per cambiarla, elimina Kingmaker e reinstallalo.", "ja": "1〜3語、文字のみ。インストール時に固定されます。変えるには Kingmaker を削除して再インストールしてください。", "zh": "1 到 3 个词，仅限字母。安装时固定：要更改，请删除 Kingmaker 后重新安装。", "ko": "1~3단어, 글자만. 설치 시 고정됩니다. 바꾸려면 Kingmaker를 삭제하고 다시 설치하세요."],
  ]
}

/// The wake word rule (the same as lib/install-config.mjs validateWakeWord and engine.sh validate_wake).
enum WakeWord {
  static let reserved: Set<String> = ["yes", "no", "cancel", "stop", "quit", "exit", "ok", "okay", "hey", "hi", "sleep", "wake", "wake up", "mute", "go", "go ahead", "confirm"]
  static func check(_ raw: String) -> (word: String?, problem: String?) {
    let word = raw.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
    if word.isEmpty { return (nil, "Give me a name: the word you'll say to wake me.") }
    if word.count > 32 { return (nil, "Keep it under 32 letters.") }
    let words = word.split(separator: " ")
    if words.count > 3 { return (nil, "Use 1 to 3 words.") }
    let letters = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ")
    if !words.allSatisfy({ $0.unicodeScalars.allSatisfy { letters.contains($0) } }) { return (nil, "Letters only: no digits, punctuation or accents.") }
    if words.contains(where: { $0.count < 2 || $0.count > 20 }) { return (nil, "Each word needs 2 to 20 letters.") }
    if reserved.contains(word.lowercased()) { return (nil, "“\(word)” is a command word; pick a name.") }
    return (word, nil)
  }
}

// ── the terms (a hook: the wording waits for the operator's legal decision, branch legal/terms-review) ────────────
/// "I accept the terms" next to Download & Install: a checkbox the button requires, with TERMS.md readable in the
/// window. The text shown is the TERMS.md this installer carries (scripts/build-installer.sh copies it in); the label
/// below is a placeholder until the legal review settles the words. Info.plist KingmakerTermsRequired = false turns
/// the requirement off without removing the hook. The engine records the accepted text's sha256 in install.json.
enum TermsHook {
  static let checkboxLabel = "I accept the Kingmaker terms" // PLACEHOLDER wording: pending the operator's legal decision
  static let readLabel = "Read the terms"
  static var required: Bool { (Bundle.main.object(forInfoDictionaryKey: "KingmakerTermsRequired") as? Bool) ?? true }
  static var url: URL? { Bundle.main.url(forResource: "TERMS", withExtension: "md") }
  static var text: String { url.flatMap { try? String(contentsOf: $0, encoding: .utf8) } ?? "This installer carries no TERMS.md." }
  /// sha256 of the exact text shown, so install.json says which terms were accepted.
  static var sha256: String? {
    guard let url else { return nil }
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/shasum")
    p.arguments = ["-a", "256", url.path]
    let out = Pipe()
    p.standardOutput = out
    guard (try? p.run()) != nil else { return nil }
    p.waitUntilExit()
    return String(data: out.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?.split(separator: " ").first.map(String.init)
  }
}

// ── the profile packs (engine.sh --inspect → the manifest's packs) ──────────────────────────────────────────────────
struct Pack: Identifiable, Equatable {
  let id: String, name: String, label: String, downloadGb: Double
  let voice: Bool, pictures: Bool, concurrent: Int, contextK: Int
  let models: [(name: String, roles: String)]
  static func == (a: Pack, b: Pack) -> Bool { a.id == b.id }
  init?(_ d: [String: Any]) {
    guard let id = d["id"] as? String, let name = d["name"] as? String else { return nil }
    self.id = id; self.name = name; label = (d["label"] as? String) ?? ""
    downloadGb = (d["downloadGb"] as? Double) ?? Double((d["downloadGb"] as? Int) ?? 0)
    let f = (d["features"] as? [String: Any]) ?? [:]
    voice = (f["voice"] as? Bool) ?? false; pictures = (f["pictures"] as? Bool) ?? false
    concurrent = (f["concurrent"] as? Int) ?? 1; contextK = (f["contextK"] as? Int) ?? 4
    models = ((d["models"] as? [[String: Any]]) ?? []).compactMap { m in
      guard let n = m["name"] as? String else { return nil }
      return (n.replacingOccurrences(of: "huihui_ai/", with: "").replacingOccurrences(of: "hf.co/", with: ""), ((m["roles"] as? [String]) ?? []).joined(separator: ", "))
    }
  }
  var ram: Int { Int(id) ?? 8 }
}

// ── the engine ────────────────────────────────────────────────────────────────────────────────────────────────────
final class Installer: ObservableObject {
  enum Phase: Equatable { case ready, installing, failed(String), done }
  @Published var wakeWord = ""  // the person names it (owner 2026-10-15: "the template should say give me a name")
  @Published var cementedWord: String? = nil
  @Published var phase: Phase = .ready
  @Published var pct: Double = 0
  @Published var label = ""
  @Published var detail = ""
  @Published var release = ""
  @Published var hasManifest = true
  @Published var termsAccepted = false
  @Published var packs: [Pack] = []
  @Published var recommendedPack = ""
  @Published var selectedPack = ""
  @Published var memGb = 0
  @Published var chip = ""
  @Published var showingTerms = false
  @Published var customizing = false   // the Customize popover
  /// What still stands between the person and the button (nil = it can be pressed).
  var blocker: String? {
    if !hasManifest { return "no manifest" }
    if validation != nil { return validation }
    if TermsHook.required && !termsAccepted { return "terms" }
    return nil
  }
  private var process: Process?
  private var buffer = Data()

  private var engine: URL? { Bundle.main.url(forResource: "engine", withExtension: "sh") }
  /// Development only: KINGMAKER_INSTALLER_ARGS="--prefix|/tmp/km|--source|dist/release/v0.2.0" runs the same window
  /// against a dry-run prefix ("|"-separated, so paths may hold spaces); KINGMAKER_INSTALLER_AUTOSTART=1 presses the
  /// button once the window is up. A Finder launch never carries either.
  static let devArgs: [String] = (ProcessInfo.processInfo.environment["KINGMAKER_INSTALLER_ARGS"] ?? "").split(separator: "|").map(String.init).filter { !$0.isEmpty }
  var validation: String? { cementedWord != nil ? nil : WakeWord.check(wakeWord).problem }

  /// What is installed already: an installed Kingmaker keeps its cemented word, so the field is locked to it.
  func inspect() {
    hasManifest = Bundle.main.url(forResource: "kingmaker-manifest", withExtension: "json") != nil
    guard let engine else { return }
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/bin/bash")
    var prefix: [String] = []
    if let i = Installer.devArgs.firstIndex(of: "--prefix"), i + 1 < Installer.devArgs.count { prefix = ["--prefix", Installer.devArgs[i + 1]] }
    p.arguments = [engine.path, "--inspect"] + prefix
    let out = Pipe()
    p.standardOutput = out
    p.standardError = FileHandle.nullDevice
    p.terminationHandler = { [weak self] _ in
      let data = out.fileHandleForReading.readDataToEndOfFile()
      guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
      DispatchQueue.main.async {
        self?.release = (obj["release"] as? String) ?? ""
        self?.packs = ((obj["packs"] as? [[String: Any]]) ?? []).compactMap(Pack.init)
        self?.memGb = (obj["memGb"] as? Int) ?? 0
        self?.chip = (obj["chip"] as? String) ?? ""
        let rec = (obj["recommendedPack"] as? String) ?? ""
        self?.recommendedPack = rec
        if self?.selectedPack.isEmpty ?? false { self?.selectedPack = rec }
        if obj["cemented"] as? Bool == true, let word = obj["wakeWord"] as? String, !word.isEmpty {
          self?.cementedWord = word
          self?.wakeWord = word
        }
      }
    }
    try? p.run()
  }

  func start() {
    guard let engine, phase != .installing else { return }
    let word = cementedWord ?? WakeWord.check(wakeWord).word
    guard let word, blocker == nil else { return }
    let terms: [String] = TermsHook.required ? (TermsHook.sha256.map { ["--terms-accepted", $0] } ?? []) : []
    phase = .installing
    pct = 0; label = "Starting"; detail = ""
    buffer = Data()
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/bin/bash")
    let pack: [String] = packs.isEmpty || selectedPack.isEmpty ? [] : ["--pack", selectedPack]
    p.arguments = [engine.path, "--wake-word", word] + terms + pack + Installer.devArgs
    let out = Pipe()
    p.standardOutput = out
    p.standardError = FileHandle.nullDevice
    out.fileHandleForReading.readabilityHandler = { [weak self] handle in
      let chunk = handle.availableData
      if chunk.isEmpty { handle.readabilityHandler = nil; return }
      DispatchQueue.main.async { self?.consume(chunk) }
    }
    p.terminationHandler = { [weak self] proc in
      DispatchQueue.main.async {
        guard let self else { return }
        if case .installing = self.phase {
          self.phase = .failed(proc.terminationStatus == 0 ? "The installer stopped without saying it finished." : "The installer stopped (exit \(proc.terminationStatus)). Nothing was left half-installed; press Try Again to resume.")
        }
        self.process = nil
      }
    }
    do { try p.run(); process = p } catch { phase = .failed("Could not start the installer: \(error.localizedDescription)") }
  }

  func cancel() { process?.terminate() } // the engine traps it, puts anything moved back, and reports "Cancelled."

  private func consume(_ chunk: Data) {
    buffer.append(chunk)
    while let nl = buffer.firstIndex(of: 0x0A) {
      let line = buffer.subdata(in: buffer.startIndex..<nl)
      buffer.removeSubrange(buffer.startIndex...nl)
      guard let text = String(data: line, encoding: .utf8), text.hasPrefix("@@km "),
            let json = text.dropFirst(5).data(using: .utf8),
            let obj = try? JSONSerialization.jsonObject(with: json) as? [String: Any] else { continue }
      switch obj["t"] as? String {
      case "progress":
        if let v = obj["pct"] as? Double { pct = max(pct, v) } else if let v = obj["pct"] as? Int { pct = max(pct, Double(v)) }
        let next = (obj["detail"] as? String) ?? ""
        if let l = obj["label"] as? String, l != label { label = l; detail = next } // a new step clears the last one's line
        else if !next.isEmpty { detail = next }                                       // a bare tick keeps the last note
      case "note":
        if let t = obj["text"] as? String { detail = t }
      case "failed":
        phase = .failed((obj["message"] as? String) ?? "The install failed.")
      case "done":
        pct = 100
        phase = .done
        label = (obj["launched"] as? Bool) == true ? "Kingmaker is installed and starting" : "Kingmaker is installed"
        // Kingmaker is up (the engine opened it): the installer's job is over, and so is the only window.
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) { NSApp.terminate(nil) }
      default: break
      }
    }
  }
}

// ── the window ────────────────────────────────────────────────────────────────────────────────────────────────────
struct Grid: View {
  var body: some View {
    Canvas { ctx, size in
      var path = Path()
      var x: CGFloat = 0
      while x <= size.width { path.move(to: CGPoint(x: x, y: 0)); path.addLine(to: CGPoint(x: x, y: size.height)); x += 64 }
      var y: CGFloat = 0
      while y <= size.height { path.move(to: CGPoint(x: 0, y: y)); path.addLine(to: CGPoint(x: size.width, y: y)); y += 64 }
      ctx.stroke(path, with: .color(Machine.ink.opacity(0.05)), lineWidth: 1)
    }
  }
}

struct CornerTicks: View {
  var body: some View {
    GeometryReader { g in
      Path { p in
        p.move(to: CGPoint(x: 8, y: 26)); p.addLine(to: CGPoint(x: 8, y: 8)); p.addLine(to: CGPoint(x: 26, y: 8))
        p.move(to: CGPoint(x: g.size.width - 26, y: g.size.height - 8)); p.addLine(to: CGPoint(x: g.size.width - 8, y: g.size.height - 8)); p.addLine(to: CGPoint(x: g.size.width - 8, y: g.size.height - 26))
      }.stroke(Machine.line, lineWidth: 1)
    }
  }
}

struct Caps: View {
  let text: String
  var size: CGFloat = 11
  var color: Color = Machine.ink
  var body: some View { Text(text.uppercased()).font(.system(size: size * Look.shared.scale, weight: .semibold)).tracking(size * 0.14).foregroundColor(color) }
}

/// The community's own count, shown on the welcome screen: how many people have downloaded Kingmaker (and finished
/// installing it), from ronininc.org's public, aggregate-only endpoint. One plain GET with nothing about this Mac in it;
/// offline or unreachable, the line simply isn't shown.
final class Community: ObservableObject {
  static let url = URL(string: "https://www.ronininc.org/api/kingmaker/community")!
  @Published var line: String?
  func load() {
    var req = URLRequest(url: Community.url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 6)
    req.setValue("application/json", forHTTPHeaderField: "Accept")
    URLSession.shared.dataTask(with: req) { [weak self] data, response, _ in
      guard (response as? HTTPURLResponse)?.statusCode == 200, let data,
            let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let downloads = (obj["downloads"] as? NSNumber)?.intValue, downloads > 0 else { return }
      let n = NumberFormatter(); n.numberStyle = .decimal
      var text = "\(n.string(from: NSNumber(value: downloads)) ?? String(downloads)) \(L.t(downloads == 1 ? "download" : "downloads"))"
      if let installs = (obj["installs"] as? NSNumber)?.intValue, installs > 0 {
        text += " · \(n.string(from: NSNumber(value: installs)) ?? String(installs)) \(L.t(installs == 1 ? "Mac running Kingmaker" : "Macs running Kingmaker"))"
      }
      DispatchQueue.main.async { self?.line = text }
    }.resume()
  }
}

struct InstallerView: View {
  @ObservedObject var installer: Installer
  @ObservedObject var look = Look.shared
  @StateObject private var community = Community()

  var body: some View {
    ZStack {
      if look.look == "glass" { Glass().ignoresSafeArea() }
      Machine.void.ignoresSafeArea()
      ScrollView {
        VStack(spacing: 0) {
          HStack(alignment: .center) {
            Caps(text: installer.release.isEmpty ? "Installer" : "Installer \(installer.release)", size: 10, color: Machine.inkDim)
            Spacer()
            Button(action: { installer.customizing.toggle() }) {
              Label(L.t("Customize"), systemImage: "slider.horizontal.3").font(.system(size: 12 * look.scale, weight: .medium)).foregroundColor(Machine.ink.opacity(0.8))
                .padding(.horizontal, 10).padding(.vertical, 5).background(Color.white.opacity(0.07)).clipShape(RoundedRectangle(cornerRadius: 9))
            }
            .buttonStyle(.plain)
            .popover(isPresented: $installer.customizing, arrowEdge: .bottom) { CustomizePanel(look: look) }
          }
          .padding(.horizontal, 24).padding(.top, 34)
          crest.padding(.top, 10)
          Text("KINGMAKER").font(Machine.bodoni(34)).tracking(10).foregroundColor(Machine.ink).padding(.top, 14)
          Caps(text: "Ronin Inc", size: 11, color: Machine.gold).padding(.top, 6)
          if let line = community.line {
            Text(line).font(Machine.mono(10)).foregroundColor(Machine.inkDim).padding(.top, 8)
              .accessibilityLabel(line)
          }
          Text(L.t(installer.packs.isEmpty ? "One download: everything, or nothing." : "Kingmaker, plus the pack you pick."))
            .font(.system(size: 12 * look.scale)).foregroundColor(Machine.inkDim).padding(.top, 10)
          controls.padding(.horizontal, 40).padding(.top, 22)
          Rectangle().fill(Machine.lineFaint).frame(height: 1).padding(.top, 22)
          Text("Kingmaker.app · Ronin Launcher · the abliterated models · the knowledge library · SearXNG · Hands of Horus")
            .font(Machine.mono(9.5)).foregroundColor(Machine.inkFaint).multilineTextAlignment(.center).padding(.top, 10).padding(.horizontal, 20)
          Text(verbatim: "Free for personal, noncommercial use · PolyForm Noncommercial 1.0.0")
            .font(Machine.mono(9.5)).foregroundColor(Machine.inkFaint).padding(.top, 3).padding(.bottom, 16)
        }
        .frame(maxWidth: 760).frame(maxWidth: .infinity)
      }
    }
    .frame(minWidth: 520, idealWidth: installer.packs.isEmpty ? 560 : 680, minHeight: 560, idealHeight: installer.packs.isEmpty ? 720 : 880)
    .background(WindowSetup(look: look))
    .onAppear {
      installer.inspect()
      community.load()
      if ProcessInfo.processInfo.environment["KINGMAKER_INSTALLER_AUTOSTART"] == "1" {
        // Development only: ticks the terms box and presses the button, so a dry run can be watched end to end.
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { installer.termsAccepted = true; installer.start() }
      }
    }
  }

  private var crest: some View {
    Group {
      if let url = Bundle.main.url(forResource: "RoninCrest", withExtension: "png"), let image = NSImage(contentsOf: url) {
        Image(nsImage: image).resizable().interpolation(.high).aspectRatio(contentMode: .fit).frame(height: installer.packs.isEmpty ? 190 : 120)
          .shadow(color: Machine.ink.opacity(0.18), radius: 18)
      } else {
        Image(systemName: "shield.lefthalf.filled").font(.system(size: 120)).foregroundColor(Machine.paper)
      }
    }
  }

  @ViewBuilder private var controls: some View {
    switch installer.phase {
    case .ready, .failed:
      VStack(alignment: .leading, spacing: 8) {
        if !installer.packs.isEmpty { PackPicker(installer: installer).padding(.bottom, 10) }
        Caps(text: L.t("Wake word"), size: 10, color: Machine.inkDim)
        TextField(L.t("Give me a name"), text: $installer.wakeWord)
          .textFieldStyle(.plain)
          .font(Machine.mono(18))
          .foregroundColor(Machine.ink)
          .padding(.horizontal, 12).padding(.vertical, 10)
          .background(Color.black)
          .overlay(Rectangle().stroke(installer.validation == nil ? Machine.line : Machine.alert, lineWidth: 1))
          .disabled(installer.cementedWord != nil)
          // No onSubmit: on macOS a text field also "submits" when it loses focus, which would start the install
          // without the button. Return still presses the button (it is the default action).
        Group {
          if let word = installer.cementedWord {
            Text("Cemented when Kingmaker was installed: it stays “\(word)”. To change it, delete Kingmaker and install it again.")
          } else if let problem = installer.validation {
            Text(problem).foregroundColor(Machine.alert)
          } else {
            Text(L.t("1 to 3 words, letters only. Cemented at install: to change it later, delete Kingmaker and install it again."))
          }
        }
        .font(Machine.mono(10)).foregroundColor(Machine.inkDim).fixedSize(horizontal: false, vertical: true)
        if case .failed(let message) = installer.phase {
          Text(message).font(Machine.mono(11, .semibold)).foregroundColor(.white)
            .padding(.horizontal, 12).padding(.vertical, 8).frame(maxWidth: .infinity, alignment: .leading)
            .background(Machine.alert).padding(.top, 6)
        }
        if !installer.hasManifest {
          Text("This build carries no release manifest, so there is nothing to download.").font(Machine.mono(10)).foregroundColor(Machine.amber)
        }
        if TermsHook.required {
          // The terms hook: the button needs this box (wording pending the legal review).
          HStack(spacing: 10) {
            Toggle(isOn: $installer.termsAccepted) { Text(TermsHook.checkboxLabel).font(Machine.mono(11)).foregroundColor(Machine.ink) }
              .toggleStyle(.checkbox)
            Spacer()
            Button(action: { installer.showingTerms = true }) { Caps(text: L.t(TermsHook.readLabel), size: 10, color: Machine.inkDim).underline() }
              .buttonStyle(.plain)
          }
          .padding(.top, 8)
        }
        Button(action: { installer.start() }) {
          Caps(text: L.t({ if case .failed = installer.phase { return "Try again" } else { return installer.cementedWord == nil ? "Download & Install" : "Download & Update" } }()), size: 13, color: .black)
            .frame(maxWidth: .infinity).padding(.vertical, 13)
            .background(installer.blocker == nil ? Machine.paper : Machine.inkFaint)
            .clipShape(RoundedRectangle(cornerRadius: 12))
        }
        .buttonStyle(.plain)
        .disabled(installer.blocker != nil)
        .keyboardShortcut(.defaultAction)
        .padding(.top, 10)
        .sheet(isPresented: $installer.showingTerms) { TermsSheet(installer: installer) }
      }
    case .installing, .done:
      VStack(alignment: .leading, spacing: 10) {
        HStack {
          Caps(text: installer.label, size: 11)
          Spacer()
          Text(String(format: "%.0f%%", installer.pct)).font(Machine.mono(11)).foregroundColor(Machine.inkDim)
        }
        GeometryReader { g in
          ZStack(alignment: .leading) {
            Rectangle().fill(Color.black)
            Rectangle().fill(Machine.paper).frame(width: g.size.width * CGFloat(min(100, installer.pct) / 100))
              .animation(.easeOut(duration: 0.6), value: installer.pct)
          }
          .overlay(Rectangle().stroke(Machine.lineFaint, lineWidth: 1))
        }
        .frame(height: 16)
        Text(installer.detail.isEmpty ? " " : installer.detail).font(Machine.mono(10)).foregroundColor(Machine.inkDim).lineLimit(2)
        HStack {
          Caps(text: "\(L.t("Wake word")): \(installer.cementedWord ?? installer.wakeWord)", size: 10, color: Machine.inkFaint)
          Spacer()
          if installer.phase == .installing {
            Button(action: { installer.cancel() }) { Caps(text: L.t("Cancel"), size: 10, color: Machine.inkDim) }.buttonStyle(.plain)
          } else {
            Caps(text: L.t("Done"), size: 10, color: Machine.ok)
          }
        }
      }
    }
  }
}

/// The packs as cards, like a game's install packs: this Mac's own pre-selected and marked Recommended; a pack above
/// this Mac's memory still selectable, marked "May swap".
struct PackPicker: View {
  @ObservedObject var installer: Installer
  private let columns = [GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8)]
  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack {
        Caps(text: L.t("Choose your pack"), size: 10, color: Machine.inkDim)
        Spacer()
        Text(installer.memGb > 0 ? "\(L.t("This Mac")): \(installer.chip.replacingOccurrences(of: "Apple ", with: "")), \(installer.memGb) GB" : "")
          .font(Machine.mono(10)).foregroundColor(Machine.inkFaint)
      }
      LazyVGrid(columns: columns, spacing: 8) {
        ForEach(installer.packs) { pack in card(pack) }
      }
      if let p = installer.packs.first(where: { $0.id == installer.selectedPack }) {
        VStack(alignment: .leading, spacing: 2) {
          ForEach(Array(p.models.enumerated()), id: \.offset) { _, m in
            Text("· \(m.name)  \(m.roles)").font(Machine.mono(9.5)).foregroundColor(Machine.inkDim).lineLimit(1)
          }
        }.padding(.top, 2)
      }
    }
  }
  private func card(_ p: Pack) -> some View {
    let selected = installer.selectedPack == p.id
    let recommended = installer.recommendedPack == p.id
    let mine = Int(installer.recommendedPack) ?? 8
    return Button(action: { installer.selectedPack = p.id }) {
      VStack(alignment: .leading, spacing: 4) {
        HStack(spacing: 4) {
          Caps(text: p.name, size: 10, color: selected ? .black : Machine.ink)
          Spacer(minLength: 0)
        }
        Text(String(format: "%.1f \(L.t("GB of models"))", p.downloadGb)).font(Machine.mono(9.5)).foregroundColor(selected ? .black.opacity(0.75) : Machine.inkDim)
        Text("\(L.t(p.voice ? "Voice" : "Text only")) · \(L.t(p.pictures ? "pictures on" : "pictures off"))").font(Machine.mono(9.5)).foregroundColor(selected ? .black.opacity(0.75) : Machine.inkDim)
        Text("\(p.concurrent) \(L.t("at once")) · \(p.contextK)k").font(Machine.mono(9.5)).foregroundColor(selected ? .black.opacity(0.75) : Machine.inkDim)
        if recommended { Caps(text: L.t("Recommended"), size: 8.5, color: selected ? Color(red: 0.05, green: 0.4, blue: 0.12) : Machine.ok) }
        else if p.ram > mine { Caps(text: L.t("May swap"), size: 8.5, color: Machine.amber) }
        else { Caps(text: " ", size: 8.5) }
      }
      .padding(10).frame(maxWidth: .infinity, alignment: .leading)
      .background(selected ? Machine.paper : Color.black)
      .overlay(Rectangle().stroke(recommended ? Machine.ok : (selected ? Machine.paper : Machine.lineFaint), lineWidth: recommended || selected ? 1.5 : 1))
    }
    .buttonStyle(.plain)
  }
}

/// TERMS.md as the installer carries it, readable before the box is ticked.
struct TermsSheet: View {
  @ObservedObject var installer: Installer
  @ObservedObject var look = Look.shared
  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Caps(text: "Kingmaker terms", size: 12)
      ScrollView {
        Text(TermsHook.text).font(Machine.mono(11)).foregroundColor(Machine.paper).textSelection(.enabled)
          .frame(maxWidth: .infinity, alignment: .leading).padding(12)
      }
      .background(Color.black)
      .overlay(Rectangle().stroke(Machine.lineFaint, lineWidth: 1))
      HStack {
        Spacer()
        Button(action: { installer.showingTerms = false }) { Caps(text: L.t("Close"), size: 11, color: Machine.ink) }.buttonStyle(.plain)
          .keyboardShortcut(.cancelAction)
        Button(action: { installer.termsAccepted = true; installer.showingTerms = false }) {
          Caps(text: L.t("Accept"), size: 11, color: .black).padding(.horizontal, 14).padding(.vertical, 6).background(Machine.paper)
        }.buttonStyle(.plain)
      }
    }
    .padding(20)
    .frame(width: 520, height: 520)
    .background(look.look == "glass" ? Color.black : Machine.void)
  }
}

/// Kingmaker's Customize, here: the same settings (look, accent, text size, where it opens, language), written to
/// Kingmaker's own defaults, so changing them here changes Kingmaker too, and the other way round.
struct CustomizePanel: View {
  @ObservedObject var look: Look
  static let languages = ["English", "Español", "Français", "Deutsch", "Italiano", "Português", "中文", "日本語", "한국어"]
  var body: some View {
    Form {
      Picker(L.t("Look"), selection: Binding(get: { look.look }, set: { look.set("km.look", $0) })) {
        Text("Black").tag("black"); Text("Dark glass").tag("glass"); Text("Match the Mac").tag("system")
      }
      Picker(L.t("Accent"), selection: Binding(get: { look.accentName }, set: { look.set("km.replyColor", $0) })) {
        Text("Green").tag("green"); Text("White").tag("white"); Text("Blue").tag("blue"); Text("Amber").tag("amber")
      }
      Picker(L.t("Text size"), selection: Binding(get: { look.textSize }, set: { look.set("km.textSize", $0) })) {
        Text("Small").tag(13.0); Text("Medium").tag(14.0); Text("Large").tag(16.0)
      }
      Picker(L.t("Opens at"), selection: Binding(get: { look.position }, set: { look.set("km.position", $0) })) {
        Text("Top").tag("top"); Text("Middle").tag("middle"); Text("Bottom").tag("bottom")
      }
      Picker(L.t("Language"), selection: Binding(get: { look.language }, set: { look.setLanguage($0) })) {
        Text("Auto").tag("auto")
        ForEach(CustomizePanel.languages, id: \.self) { Text($0).tag($0) }
      }
    }
    .padding(16).frame(width: 320)
  }
}

/// The window, Kingmaker's way: movable by dragging anywhere, resizable, full screen, back where it was left (or, the
/// first time, at the top, middle or bottom of the screen, as Kingmaker opens), see-through for Dark glass.
struct WindowSetup: NSViewRepresentable {
  @ObservedObject var look: Look
  func makeNSView(context: Context) -> NSView {
    let v = NSView()
    DispatchQueue.main.async { if let w = v.window { WindowSetup.configure(w, look: look, first: true) } }
    return v
  }
  func updateNSView(_ v: NSView, context: Context) { if let w = v.window { WindowSetup.configure(w, look: look, first: false) } }
  static func configure(_ w: NSWindow, look: Look, first: Bool) {
    w.isMovableByWindowBackground = true
    w.styleMask.insert(.resizable)
    w.collectionBehavior.insert(.fullScreenPrimary)
    w.isOpaque = look.look != "glass"
    w.backgroundColor = look.look == "glass" ? .clear : look.look == "system" ? .windowBackgroundColor : .black
    w.appearance = NSAppearance(named: look.look == "system" ? (NSApp.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) ?? .darkAqua) : .darkAqua)
    guard first else { return }
    if !w.setFrameUsingName("KingmakerInstaller"), let screen = w.screen ?? NSScreen.main {
      let vf = screen.visibleFrame, size = w.frame.size
      let y: CGFloat = look.position == "top" ? vf.maxY - size.height - 24 : look.position == "bottom" ? vf.minY + 24 : vf.midY - size.height / 2
      w.setFrameOrigin(NSPoint(x: vf.midX - size.width / 2, y: y))
    }
    w.setFrameAutosaveName("KingmakerInstaller")
  }
}

/// Dark glass, as Kingmaker draws it.
struct Glass: NSViewRepresentable {
  func makeNSView(context: Context) -> NSVisualEffectView { let v = NSVisualEffectView(); v.material = .hudWindow; v.blendingMode = .behindWindow; v.state = .active; return v }
  func updateNSView(_ v: NSVisualEffectView, context: Context) {}
}

final class AppDelegate: NSObject, NSApplicationDelegate {
  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

@main
struct KingmakerInstallerApp: App {
  @NSApplicationDelegateAdaptor(AppDelegate.self) var delegate
  @StateObject private var installer = Installer()
  var body: some Scene {
    WindowGroup("Kingmaker Installer") {
      InstallerView(installer: installer)
        .preferredColorScheme(.dark)
    }
    .windowStyle(.hiddenTitleBar)
    .windowResizability(.contentMinSize)
    .commands { CommandGroup(replacing: .newItem) {} }
  }
}
