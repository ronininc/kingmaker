import Foundation
import Security
import Darwin

private final class FixtureContext: KeyAuthenticationContext {
  func available() -> Bool { true }
  func evaluate(reason: String, completion: @escaping (Bool) -> Void) { completion(true) }
  func invalidate() {}
}
private final class FixtureCheckpoint: ProtectedGenerationCheckpoint {
  var value: ProtectedGenerationAnchor?
  var rejectWrite = false
  var locked = false
  func read() throws -> ProtectedGenerationAnchor? {
    if locked { throw ProtectedGenerationError.unavailable }; return value
  }
  func replace(expected: ProtectedGenerationAnchor?, next: ProtectedGenerationAnchor) throws {
    guard !rejectWrite, !locked else { throw ProtectedGenerationError.unavailable }
    guard value == expected else { throw ProtectedGenerationError.stale }; value = next
  }
}
@main struct GenerationProof {
  static func main() throws {
    let fm = FileManager.default
    let root = fm.temporaryDirectory.appendingPathComponent(UUID().uuidString).resolvingSymlinksInPath()
    try fm.createDirectory(at:root,withIntermediateDirectories:false,attributes:[.posixPermissions:0o700])
    defer { try? fm.removeItem(at:root) }
    func refuses(_ operation: () throws -> Void) {
      do { try operation(); fatalError("expected refusal") } catch {}
    }
    func key() throws -> SecKey {
      var error: Unmanaged<CFError>?
      guard let key = SecKeyCreateRandomKey([kSecAttrKeyType:kSecAttrKeyTypeECSECPrimeRandom,kSecAttrKeySizeInBits:256] as CFDictionary,&error) else { throw ProtectedIdentityError.keyUnavailable }; return key
    }
    let gate = LocalKeyAuthorization(testContext:{ FixtureContext() },clock:{100})
    let vault = try ProtectedIdentityVault(testAuthorization:gate,encryption:key(),authority:key())
    func grant(_ action:LocalKeyAction,_ binding:String) -> AuthorizedKeyAction {
      var result:AuthorizedKeyAction?
      gate.authorize(action,revision:binding) { if case .success(let value) = $0 { result=value } }
      return result!
    }
    func sealed(_ revision:String,_ epoch:Int) throws -> Data {
      let clear=Data("inert fixture generation \(epoch)".utf8)
      return try vault.seal(clear,revision:revision,epoch:epoch,
        grant:grant(.rotate,ProtectedIdentityVault.sealingBinding(clear,revision:revision,epoch:epoch)))
    }
    let a=String(repeating:"a",count:64), b=String(repeating:"b",count:64), c=String(repeating:"c",count:64)
    let anchor=FixtureCheckpoint()
    let store=try ProtectedGenerationStore(directory:root,checkpoint:anchor,verifyEnvelope:vault.verifyEnvelope)
    let empty = try store.current(); assert(empty == nil)
    let first=try sealed(a,0), second=try sealed(b,1)
    let initial=try store.commit(first,revision:a,expected:nil)
    assert(initial.epoch == 0)
    let lock = Darwin.open(root.appendingPathComponent(".generation-lock").path, O_RDWR)
    assert(lock >= 0 && flock(lock, LOCK_EX | LOCK_NB) == 0)
    refuses { _ = try store.current() }
    flock(lock, LOCK_UN); Darwin.close(lock)
    let persistedFirst = try store.current(); assert(persistedFirst!.1 == first)
    refuses { _ = try store.commit(second,revision:b,expected:nil) }
    refuses { _ = try store.commit(first,revision:b,expected:initial) }
    let next=try store.commit(second,revision:b,expected:initial)
    assert(next.epoch == 1)
    let restarted=try ProtectedGenerationStore(directory:root,checkpoint:anchor,verifyEnvelope:vault.verifyEnvelope)
    let resumed = try restarted.current(); assert(resumed!.0 == next)
    // The old ciphertext remains encrypted, but cannot become current by replay.
    let nextURL=root.appendingPathComponent(next.digest+".sealed")
    try first.write(to:nextURL)
    refuses { _ = try restarted.current() }
    try second.write(to:nextURL)
    try fm.setAttributes([.posixPermissions:0o644],ofItemAtPath:nextURL.path)
    refuses { _ = try restarted.current() }
    try fm.setAttributes([.posixPermissions:0o600],ofItemAtPath:nextURL.path)
    // Lost/tampered anchors must never be treated as a new installation.
    anchor.value=nil
    refuses { _ = try restarted.current() }
    refuses { _ = try restarted.commit(first,revision:a,expected:nil) }
    anchor.value=next; anchor.locked=true
    refuses { _ = try restarted.current() }; anchor.locked=false
    // Fail after the new encrypted file has been persisted, before checkpoint.
    anchor.rejectWrite=true
    refuses { _ = try restarted.commit(sealed(c,2),revision:c,expected:next) }
    assert(anchor.value == next)
    let afterFailure = try restarted.current(); assert(afterFailure!.1 == second)
    anchor.rejectWrite=false
    // Neither aliases nor multiply linked ciphertext are accepted.
    let alias=root.appendingPathComponent("alias")
    try fm.createSymbolicLink(at:alias,withDestinationURL:root)
    refuses { _ = try ProtectedGenerationStore(directory:alias,checkpoint:anchor,verifyEnvelope:vault.verifyEnvelope) }
    let hard=root.appendingPathComponent("hard")
    try fm.linkItem(at:nextURL,to:hard)
    refuses { _ = try restarted.current() }; try fm.removeItem(at:hard)
    try fm.removeItem(at:nextURL)
    refuses { _ = try restarted.current() } // never fall back to the old valid envelope
    try fm.createSymbolicLink(at:nextURL,withDestinationURL:root.appendingPathComponent(initial.digest+".sealed"))
    refuses { _ = try restarted.current() }
    print("PASS native protected generations: real signed encrypted envelopes, restart, stale writer, rollback, missing/locked checkpoint, interrupted commit, writer lock, private modes, missing current file, symlink and hardlink refusal; disposable keys, no Keychain writes")
  }
}
