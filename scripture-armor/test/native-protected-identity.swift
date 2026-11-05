import Foundation
import Security

private final class ImmediateContext: KeyAuthenticationContext {
  func available() -> Bool { true }
  func evaluate(reason: String, completion: @escaping (Bool) -> Void) { completion(true) }
  func invalidate() {}
}
@main struct ProtectedIdentityProof {
  static func main() throws {
    func fixtureKey() throws -> SecKey {
      let attrs: [CFString:Any] = [kSecAttrKeyType:kSecAttrKeyTypeECSECPrimeRandom,kSecAttrKeySizeInBits:256]
      var error: Unmanaged<CFError>?
      guard let key = SecKeyCreateRandomKey(attrs as CFDictionary,&error) else { throw ProtectedIdentityError.keyUnavailable }
      return key
    }
    let gate = LocalKeyAuthorization(testContext:{ ImmediateContext() },clock:{100})
    let revision = String(repeating:"a",count:64)
    func grant(_ action: LocalKeyAction, _ binding: String) -> AuthorizedKeyAction {
      var ticket: AuthorizedKeyAction?
      gate.authorize(action,revision:binding) { if case .success(let t) = $0 { ticket = t } }
      return ticket!
    }
    func refuses(_ operation: () throws -> Void) {
      do { try operation(); fatalError("expected fail-closed refusal") } catch {}
    }
    let encryption = try fixtureKey(), authority = try fixtureKey()
    let vault = try ProtectedIdentityVault(testAuthorization:gate,encryption:encryption,authority:authority)
    let clear = Data("inert-private-identity-fixture-not-owner-data".utf8)
    let sealing = ProtectedIdentityVault.sealingBinding(clear,revision:revision,epoch:1)
    let sealed = try vault.seal(clear,revision:revision,epoch:1,grant:grant(.rotate,sealing))
    let opening = ProtectedIdentityVault.openingBinding(sealed,revision:revision,epoch:1)
    assert(sealed.range(of:clear) == nil)
    let opened = try vault.open(sealed,revision:revision,epoch:1,grant:grant(.unlockKeys,opening))
    assert(opened == clear)
    let consumed = grant(.unlockKeys,opening)
    _ = try vault.open(sealed,revision:revision,epoch:1,grant:consumed)
    refuses { _ = try vault.open(sealed,revision:revision,epoch:1,grant:consumed) }
    refuses { _ = try vault.open(sealed,revision:revision,epoch:0,grant:grant(.unlockKeys,opening)) }
    refuses { _ = try vault.open(sealed,revision:revision,epoch:1,grant:grant(.inspectMetadata,opening)) }
    refuses { _ = try vault.seal(clear,revision:revision,epoch:2,grant:grant(.unlockKeys,sealing)) }
    refuses { _ = try vault.seal(Data("substituted snapshot".utf8),revision:revision,epoch:1,grant:grant(.rotate,sealing)) }
    var altered = try JSONSerialization.jsonObject(with:sealed) as! [String:Any]
    var content = altered["content"] as! [String:Any]
    var ciphertext = Data(base64Encoded:content["ciphertext"] as! String)!
    ciphertext[ciphertext.startIndex] ^= 1
    content["ciphertext"] = ciphertext.base64EncodedString(); altered["content"] = content
    let corrupted = try JSONSerialization.data(withJSONObject:altered)
    refuses { _ = try vault.open(corrupted,revision:revision,epoch:1,grant:grant(.unlockKeys,ProtectedIdentityVault.openingBinding(corrupted,revision:revision,epoch:1))) }
    let otherAuthority = try ProtectedIdentityVault(testAuthorization:gate,encryption:encryption,authority:fixtureKey())
    refuses { _ = try otherAuthority.open(sealed,revision:revision,epoch:1,grant:grant(.unlockKeys,opening)) }
    let otherDevice = try ProtectedIdentityVault(testAuthorization:gate,encryption:fixtureKey(),authority:authority)
    refuses { _ = try otherDevice.open(sealed,revision:revision,epoch:1,grant:grant(.unlockKeys,opening)) }
    let publicAuthority = try vault.publicRotationAuthority()
    assert(publicAuthority.count == 65)
    print("PASS native encrypted storage fixture: signed envelope, encrypt/decrypt, action binding, one-shot grants, epoch mismatch, tampering, wrong authority and wrong device; no Keychain writes or owner keys")
  }
}
