import Foundation
import CryptoKit
import Security
import Darwin

enum ProtectedGenerationError: Error { case unsafeStore, corrupt, stale, unavailable, io }
struct ProtectedGenerationAnchor: Codable, Equatable {
  let epoch: Int
  let revision: String
  let digest: String
}
// The checkpoint lives outside the replaceable generation files. Implementations
// must persist synchronously and leave the previous value intact on failure.
protocol ProtectedGenerationCheckpoint: AnyObject {
  func read() throws -> ProtectedGenerationAnchor?
  func replace(expected: ProtectedGenerationAnchor?, next: ProtectedGenerationAnchor) throws
}

// App-only native storage; no HTTP, IPC, URL handler, or WebView entry point.
// This stores already encrypted, authenticated envelopes, never plaintext keys.
final class ProtectedGenerationStore {
  private let root: Int32
  private let checkpoint: ProtectedGenerationCheckpoint
  private let verify: (Data, String, Int) throws -> Void
  private static let maximum = 24 * 1024 * 1024

  init(directory: URL, checkpoint: ProtectedGenerationCheckpoint,
       verifyEnvelope: @escaping (Data, String, Int) throws -> Void) throws {
    var info = stat()
    guard directory.standardizedFileURL.path == directory.resolvingSymlinksInPath().standardizedFileURL.path,
          lstat(directory.path, &info) == 0,
          (info.st_mode & S_IFMT) == S_IFDIR, info.st_uid == getuid(),
          info.st_mode & 0o077 == 0 else { throw ProtectedGenerationError.unsafeStore }
    let descriptor = Darwin.open(directory.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
    guard descriptor >= 0 else { throw ProtectedGenerationError.unsafeStore }
    var opened = stat()
    guard fstat(descriptor, &opened) == 0, opened.st_dev == info.st_dev, opened.st_ino == info.st_ino else {
      Darwin.close(descriptor); throw ProtectedGenerationError.unsafeStore
    }
    root = descriptor; self.checkpoint = checkpoint; verify = verifyEnvelope
  }
  deinit { Darwin.close(root) }
  private static func digest(_ bytes: Data) -> String {
    SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
  }
  private static func valid(_ value: String) -> Bool {
    value.count == 64 && value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
  }
  private func locked<T>(_ action: () throws -> T) throws -> T {
    let fd = openat(root, ".generation-lock", O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0o600)
    guard fd >= 0 else { throw ProtectedGenerationError.unsafeStore }
    defer { Darwin.close(fd) }
    var info = stat()
    guard fstat(fd, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG,
          info.st_uid == getuid(), info.st_nlink == 1, info.st_mode & 0o077 == 0,
          flock(fd, LOCK_EX | LOCK_NB) == 0 else { throw ProtectedGenerationError.unsafeStore }
    defer { flock(fd, LOCK_UN) }
    return try action()
  }
  private func envelope(_ anchor: ProtectedGenerationAnchor) throws -> Data {
    guard anchor.epoch >= 0, Self.valid(anchor.revision), Self.valid(anchor.digest) else { throw ProtectedGenerationError.corrupt }
    let fd = openat(root, "\(anchor.digest).sealed", O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK)
    guard fd >= 0 else { throw ProtectedGenerationError.corrupt }
    defer { Darwin.close(fd) }
    var info = stat()
    guard fstat(fd, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG, info.st_uid == getuid(),
          info.st_nlink == 1, info.st_mode & 0o077 == 0,
          info.st_size > 0, info.st_size <= Self.maximum else { throw ProtectedGenerationError.unsafeStore }
    var data = Data(count: Int(info.st_size))
    try data.withUnsafeMutableBytes { buffer in
      var offset = 0
      while offset < buffer.count {
        let count = Darwin.read(fd, buffer.baseAddress!.advanced(by:offset), buffer.count-offset)
        if count < 0 && errno == EINTR { continue }
        guard count > 0 else { throw ProtectedGenerationError.io }
        offset += count
      }
      var extra: UInt8 = 0
      guard Darwin.read(fd, &extra, 1) == 0 else { throw ProtectedGenerationError.corrupt }
    }
    guard Self.digest(data) == anchor.digest else { throw ProtectedGenerationError.corrupt }
    try verify(data, anchor.revision, anchor.epoch)
    return data
  }
  private func hasGenerationFiles() throws -> Bool {
    let copy = openat(root, ".", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
    guard copy >= 0, let stream = fdopendir(copy) else {
      if copy >= 0 { Darwin.close(copy) }; throw ProtectedGenerationError.io
    }
    defer { closedir(stream) }
    while let entry = readdir(stream) {
      let name = withUnsafePointer(to: &entry.pointee.d_name) {
        $0.withMemoryRebound(to:CChar.self, capacity:Int(MAXNAMLEN)+1) { String(cString:$0) }
      }
      if name.hasSuffix(".sealed") { return true }
    }
    return false
  }
  func current() throws -> (ProtectedGenerationAnchor, Data)? {
    try locked {
      guard let anchor = try checkpoint.read() else {
        guard try !hasGenerationFiles() else { throw ProtectedGenerationError.unavailable }; return nil
      }
      return (anchor, try envelope(anchor))
    }
  }
  // A durable generation is written BEFORE the independent checkpoint changes.
  // A crash before checkpoint replacement leaves an unreferenced encrypted file;
  // a crash after it loads the complete new generation. Never pick "latest" from
  // filenames or restore an older generation if the checkpoint target is missing.
  func commit(_ encrypted: Data, revision: String, expected: ProtectedGenerationAnchor?) throws -> ProtectedGenerationAnchor {
    try locked {
      guard try checkpoint.read() == expected else { throw ProtectedGenerationError.stale }
      if let old = expected { _ = try envelope(old) }
      else if try hasGenerationFiles() { throw ProtectedGenerationError.unavailable }
      guard Self.valid(revision), !encrypted.isEmpty, encrypted.count <= Self.maximum,
            expected?.revision != revision, (expected?.epoch ?? -1) < Int.max else { throw ProtectedGenerationError.corrupt }
      let next = ProtectedGenerationAnchor(epoch:(expected?.epoch ?? -1)+1, revision:revision, digest:Self.digest(encrypted))
      try verify(encrypted, revision, next.epoch)
      let name = "\(next.digest).sealed"
      let fd = openat(root, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
      guard fd >= 0 else { throw ProtectedGenerationError.io }
      defer { Darwin.close(fd) }
      try encrypted.withUnsafeBytes { bytes in
        var offset = 0
        while offset < bytes.count {
          let count = Darwin.write(fd, bytes.baseAddress!.advanced(by:offset), bytes.count-offset)
          if count < 0 && errno == EINTR { continue }
          guard count > 0 else { throw ProtectedGenerationError.io }
          offset += count
        }
      }
      guard fsync(fd) == 0, fsync(root) == 0 else { throw ProtectedGenerationError.io }
      _ = try envelope(next) // verify the persisted bytes, not just the input
      try checkpoint.replace(expected:expected, next:next)
      guard try checkpoint.read() == next else { throw ProtectedGenerationError.unavailable }
      return next
    }
  }
}

// No checkpoint cache or file fallback. Missing checkpoint is distinct from a
// locked/denied Keychain. Production scope is fixed; tests never instantiate it.
final class NativeGenerationCheckpoint: ProtectedGenerationCheckpoint {
  private var query: [CFString: Any] {
    [kSecClass:kSecClassGenericPassword,kSecAttrService:"org.ronininc.scripture-armor.protected-generation.v1",
     kSecAttrAccount:"current",kSecUseDataProtectionKeychain:true]
  }
  func read() throws -> ProtectedGenerationAnchor? {
    var q = query; q[kSecReturnData] = true; q[kSecMatchLimit] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(q as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let data = result as? Data,
          let value = try? JSONDecoder().decode(ProtectedGenerationAnchor.self, from:data) else { throw ProtectedGenerationError.unavailable }
    return value
  }
  func replace(expected: ProtectedGenerationAnchor?, next: ProtectedGenerationAnchor) throws {
    guard try read() == expected else { throw ProtectedGenerationError.stale }
    let encoded = try JSONEncoder().encode(next)
    let status: OSStatus
    if expected == nil {
      var q = query
      q[kSecValueData] = encoded; q[kSecAttrAccessible] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
      status = SecItemAdd(q as CFDictionary, nil)
    } else { status = SecItemUpdate(query as CFDictionary, [kSecValueData:encoded] as CFDictionary) }
    guard status == errSecSuccess else { throw ProtectedGenerationError.unavailable }
  }
}
