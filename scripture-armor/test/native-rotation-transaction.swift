import Foundation
import Security
import CryptoKit

private final class RotationContext: KeyAuthenticationContext {
  var accepted = true
  func available() -> Bool { true }
  func evaluate(reason: String, completion: @escaping (Bool) -> Void) { completion(accepted) }
  func invalidate() {}
}
private final class RotationCheckpoint: ProtectedGenerationCheckpoint {
  var value: ProtectedGenerationAnchor?
  var reject = false
  func read() throws -> ProtectedGenerationAnchor? { value }
  func replace(expected: ProtectedGenerationAnchor?,next: ProtectedGenerationAnchor) throws {
    guard !reject else { throw ProtectedGenerationError.unavailable }
    guard value == expected else { throw ProtectedGenerationError.stale }; value = next
  }
}
@main struct NativeRotationProof {
  static func main() throws {
    let input = FileHandle.standardInput.readDataToEndOfFile()
    guard input.count <= 1024*1024,
          let doc = try JSONSerialization.jsonObject(with:input) as? [String:String],
          let a = doc["initial"],let initial = Data(base64Encoded:a),
          let b = doc["snapshot"],let snapshot = Data(base64Encoded:b),
          let t = doc["transition"],let transition = Data(base64Encoded:t),
          let previous = doc["previous"],let revision = doc["revision"] else { throw ProtectedIdentityError.invalidEnvelope }
    func key() throws -> SecKey {
      var error: Unmanaged<CFError>?
      guard let key = SecKeyCreateRandomKey([kSecAttrKeyType:kSecAttrKeyTypeECSECPrimeRandom,kSecAttrKeySizeInBits:256] as CFDictionary,&error) else { throw ProtectedIdentityError.keyUnavailable }; return key
    }
    let context = RotationContext()
    let gate = LocalKeyAuthorization(testContext:{context},clock:{100})
    let vault = try ProtectedIdentityVault(testAuthorization:gate,encryption:key(),authority:key())
    func grant(_ action:LocalKeyAction,_ binding:String) -> AuthorizedKeyAction {
      var result:AuthorizedKeyAction?
      gate.authorize(action,revision:binding) {if case .success(let ticket) = $0 {result=ticket}}
      return result!
    }
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString).resolvingSymlinksInPath()
    try FileManager.default.createDirectory(at:root,withIntermediateDirectories:false,attributes:[.posixPermissions:0o700])
    defer { try? FileManager.default.removeItem(at:root) }
    let checkpoint = RotationCheckpoint()
    let store = try ProtectedGenerationStore(directory:root,checkpoint:checkpoint,verifyEnvelope:vault.verifyEnvelope)
    let sealed = try vault.seal(initial,revision:previous,epoch:0,
      grant:grant(.rotate,ProtectedIdentityVault.sealingBinding(initial,revision:previous,epoch:0)))
    let first = try store.commit(sealed,revision:previous,expected:nil)
    let rotation = NativeKeyRotation(testAuthorization:gate,vault:vault,store:store)
    func run() throws -> CommittedProtectedRotation {
      let semaphore = DispatchSemaphore(value:0)
      var outcome:Result<CommittedProtectedRotation,Error>?
      rotation.rotate(snapshot:snapshot,transition:transition,revision:revision) { result in outcome=result; semaphore.signal() }
      guard semaphore.wait(timeout:.now()+10) == .success,let outcome else { throw ProtectedGenerationError.unavailable }
      return try outcome.get()
    }
    func refuses(_ action:() throws -> Void) {
      do {try action();fatalError("expected refusal")} catch {}
    }
    context.accepted=false
    refuses { _ = try run() }; assert(checkpoint.value == first)
    context.accepted=true
    let wrongBinding = grant(.rotate,ProtectedIdentityVault.rotationBinding(initial,transition:transition,revision:revision,epoch:1))
    refuses { _ = try vault.prepareRotation(snapshot,transition:transition,previous:previous,revision:revision,epoch:1,grant:wrongBinding) }
    checkpoint.reject=true
    refuses { _ = try run() }; assert(checkpoint.value == first)
    checkpoint.reject=false
    let receipt = try run()
    assert(receipt.anchor.epoch == 1 && checkpoint.value == receipt.anchor)
    refuses { _ = try run() }; assert(checkpoint.value == receipt.anchor)
    let reopened = try ProtectedGenerationStore(directory:root,checkpoint:checkpoint,verifyEnvelope:vault.verifyEnvelope)
    guard let current = try reopened.current() else { throw ProtectedGenerationError.unavailable }
    let clear = try vault.open(current.1,revision:revision,epoch:1,
      grant:grant(.unlockKeys,ProtectedIdentityVault.openingBinding(current.1,revision:revision,epoch:1)))
    let bundle = try JSONDecoder().decode(ProtectedRotationBundle.self,from:clear)
    assert(bundle.schema == "scripture-armor.protected-rotation/1" && bundle.snapshot == snapshot)
    assert(bundle.transition == transition && bundle.authoritySignature == receipt.authoritySignature)
    assert(current.1.range(of:snapshot) == nil)
    // Public result only. Neither the plaintext snapshot nor private keys leave
    // this fixture process through stdout or a plaintext generation file.
    let result:[String:Any] = ["authority":try vault.publicRotationAuthority().base64EncodedString(),
      "signature":receipt.authoritySignature.base64EncodedString(),"epoch":receipt.anchor.epoch,
      "revision":receipt.anchor.revision,"snapshotHash":SHA256.hash(data:bundle.snapshot).map {String(format:"%02x",$0)}.joined(),
      "checks":["cancelled authentication","snapshot binding","failed checkpoint","atomic commit","repeated transition refusal","reopen and decrypt","no plaintext generation"]]
    FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject:result,options:[.sortedKeys]))
  }
}
