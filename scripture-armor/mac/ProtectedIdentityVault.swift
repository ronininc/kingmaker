import Foundation
import Security
import CryptoKit

enum ProtectedIdentityError: Error {
  case authorizationRequired, invalidEnvelope, unsupportedProtection, keyUnavailable, cryptographyFailed
}

// Native in-process storage primitive. No CLI, URL handler, IPC listener,
// WebView bridge, plaintext output file, private-key export, or network call.
// Runtime integration must still quiesce writers and atomically migrate the
// existing authenticated stores. This class alone does not rotate that store.
struct PreparedProtectedRotation {
  let envelope: Data
  let authoritySignature: Data
}
struct ProtectedRotationBundle: Codable {
  let schema: String
  let snapshot: Data
  let transition: Data
  let authoritySignature: Data
}
final class ProtectedIdentityVault {
  private struct Content: Codable {
    let schema: String
    let revision: String
    let epoch: Int
    let wrappedKey: Data
    let ciphertext: Data
    var signatureSafeCiphertextSize: Bool { ciphertext.count >= 28 && ciphertext.count <= 16*1024*1024+28 }
  }
  private struct Envelope: Codable { let content: Content; let signature: Data }
  private let authorization: LocalKeyAuthorization
  private let encryptionKey: SecKey
  private let authorityKey: SecKey
  private let encryptionPublicKey: SecKey
  private let authorityPublicKey: SecKey
  private static let wrapping: SecKeyAlgorithm = .eciesEncryptionCofactorX963SHA256AESGCM
  private static let signing: SecKeyAlgorithm = .ecdsaSignatureMessageX962SHA256

  // Existing keys only. Missing or unavailable hardware never falls back to
  // a software private key, a file, or newly generated authority.
  init(authorization: LocalKeyAuthorization) throws {
    self.authorization = authorization
    self.encryptionKey = try Self.existingHardwareKey("identity-protection")
    self.authorityKey = try Self.existingHardwareKey("rotation-authority")
    guard let encryptionPublic = SecKeyCopyPublicKey(encryptionKey),
          let authorityPublic = SecKeyCopyPublicKey(authorityKey) else { throw ProtectedIdentityError.keyUnavailable }
    self.encryptionPublicKey = encryptionPublic; self.authorityPublicKey = authorityPublic
    try supported()
  }

  // Explicit provisioning is separate from rotation. It requires fresh local
  // authorization and cannot replace an existing key or silently re-enroll a
  // different authority. Peers must pin this authority out of band.
  static func provision(authorization: LocalKeyAuthorization, grant: AuthorizedKeyAction, revision: String) throws -> ProtectedIdentityVault {
    guard authorization.consume(grant, action: .protectKeys, revision: revision) else { throw ProtectedIdentityError.authorizationRequired }
    try createHardwareKey("identity-protection")
    try createHardwareKey("rotation-authority")
    return try ProtectedIdentityVault(authorization: authorization)
  }

  #if ARMOR_AUTH_TESTS
  // Disposable software fixtures exercise encoding and crypto without touching
  // Keychain or prompting the owner. This constructor is absent in production.
  init(testAuthorization: LocalKeyAuthorization, encryption: SecKey, authority: SecKey) throws {
    authorization = testAuthorization; encryptionKey = encryption; authorityKey = authority
    guard let e = SecKeyCopyPublicKey(encryption), let a = SecKeyCopyPublicKey(authority) else { throw ProtectedIdentityError.keyUnavailable }
    encryptionPublicKey = e; authorityPublicKey = a
    try supported()
  }
  #endif

  private static func tag(_ suffix: String) -> Data { Data("org.ronininc.scripture-armor.\(suffix).v1".utf8) }
  private static func existingHardwareKey(_ suffix: String) throws -> SecKey {
    var item: CFTypeRef?
    let query: [CFString: Any] = [kSecClass:kSecClassKey,kSecAttrApplicationTag:tag(suffix),
      kSecAttrKeyType:kSecAttrKeyTypeECSECPrimeRandom,kSecAttrKeyClass:kSecAttrKeyClassPrivate,
      kSecAttrTokenID:kSecAttrTokenIDSecureEnclave,kSecReturnRef:true,kSecUseDataProtectionKeychain:true]
    guard SecItemCopyMatching(query as CFDictionary,&item) == errSecSuccess, let item else { throw ProtectedIdentityError.keyUnavailable }
    return item as! SecKey
  }
  private static func createHardwareKey(_ suffix: String) throws {
    var found: CFTypeRef?
    let query: [CFString:Any] = [kSecClass:kSecClassKey,kSecAttrApplicationTag:tag(suffix),kSecAttrKeyType:kSecAttrKeyTypeECSECPrimeRandom,kSecUseDataProtectionKeychain:true,kSecReturnRef:true]
    // Any result other than unequivocal absence blocks creation, including a
    // locked keychain, denied access, or an existing partial provisioning.
    guard SecItemCopyMatching(query as CFDictionary,&found) == errSecItemNotFound else { throw ProtectedIdentityError.keyUnavailable }
    var error: Unmanaged<CFError>?
    guard let access = SecAccessControlCreateWithFlags(kCFAllocatorDefault,kSecAttrAccessibleWhenUnlockedThisDeviceOnly,[.privateKeyUsage,.userPresence],&error) else { throw ProtectedIdentityError.unsupportedProtection }
    let attributes: [CFString:Any] = [kSecAttrKeyType:kSecAttrKeyTypeECSECPrimeRandom,kSecAttrKeySizeInBits:256,
      kSecAttrTokenID:kSecAttrTokenIDSecureEnclave,kSecUseDataProtectionKeychain:true,
      kSecPrivateKeyAttrs:[kSecAttrIsPermanent:true,kSecAttrApplicationTag:tag(suffix),kSecAttrAccessControl:access]]
    guard SecKeyCreateRandomKey(attributes as CFDictionary,&error) != nil else { throw ProtectedIdentityError.keyUnavailable }
  }
  private func supported() throws {
    guard SecKeyIsAlgorithmSupported(encryptionPublicKey,.encrypt,Self.wrapping),
          SecKeyIsAlgorithmSupported(encryptionKey,.decrypt,Self.wrapping),
          SecKeyIsAlgorithmSupported(authorityKey,.sign,Self.signing),
          SecKeyIsAlgorithmSupported(authorityPublicKey,.verify,Self.signing) else { throw ProtectedIdentityError.unsupportedProtection }
  }
  private static func encode<T: Encodable>(_ value: T) throws -> Data {
    let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]; return try encoder.encode(value)
  }
  private static func valid(revision: String, epoch: Int) -> Bool {
    revision.count == 64 && revision.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) } && epoch >= 0
  }
  static func sealingBinding(_ snapshot: Data, revision: String, epoch: Int) -> String {
    binding("seal", data:snapshot,revision:revision,epoch:epoch)
  }
  static func openingBinding(_ envelope: Data, revision: String, epoch: Int) -> String {
    binding("open",data:envelope,revision:revision,epoch:epoch)
  }
  private static func binding(_ action: String, data: Data, revision: String, epoch: Int) -> String {
    var input = Data("scripture-armor.native-key-operation/1:\(action):\(epoch):\(revision):".utf8)
    input.append(contentsOf:SHA256.hash(data:data))
    return SHA256.hash(data:input).map { String(format:"%02x",$0) }.joined()
  }
  func publicRotationAuthority() throws -> Data {
    var error: Unmanaged<CFError>?
    guard let data = SecKeyCopyExternalRepresentation(authorityPublicKey,&error) else { throw ProtectedIdentityError.keyUnavailable }
    return data as Data
  }
  func seal(_ snapshot: Data, revision: String, epoch: Int, grant: AuthorizedKeyAction) throws -> Data {
    guard Self.valid(revision:revision,epoch:epoch), snapshot.count <= 16*1024*1024 else { throw ProtectedIdentityError.invalidEnvelope }
    guard authorization.consume(grant,action:.rotate,revision:Self.sealingBinding(snapshot,revision:revision,epoch:epoch)) else { throw ProtectedIdentityError.authorizationRequired }
    return try encryptSnapshot(snapshot,revision:revision,epoch:epoch)
  }
  private func encryptSnapshot(_ snapshot: Data, revision: String, epoch: Int) throws -> Data {
    guard Self.valid(revision:revision,epoch:epoch), snapshot.count <= 16*1024*1024 else { throw ProtectedIdentityError.invalidEnvelope }
    let key = SymmetricKey(size:.bits256)
    let aad = Data("scripture-armor.protected-generation/1:\(epoch):\(revision)".utf8)
    guard let ciphertext = try AES.GCM.seal(snapshot,using:key,authenticating:aad).combined else { throw ProtectedIdentityError.cryptographyFailed }
    var raw = key.withUnsafeBytes { Data($0) }; defer { raw.resetBytes(in:0..<raw.count) }
    var error: Unmanaged<CFError>?
    guard let wrapped = SecKeyCreateEncryptedData(encryptionPublicKey,Self.wrapping,raw as CFData,&error) else { throw ProtectedIdentityError.cryptographyFailed }
    let content = Content(schema:"scripture-armor.protected-generation/1",revision:revision,epoch:epoch,wrappedKey:wrapped as Data,ciphertext:ciphertext)
    let encoded = try Self.encode(content)
    guard let signature = SecKeyCreateSignature(authorityKey,Self.signing,encoded as CFData,&error) else { throw ProtectedIdentityError.cryptographyFailed }
    return try Self.encode(Envelope(content:content,signature:signature as Data))
  }
  static func rotationBinding(_ snapshot: Data, transition: Data, revision: String, epoch: Int) -> String {
    let transitionHash = SHA256.hash(data:transition).map { String(format:"%02x",$0) }.joined()
    return binding("rotate-transition:\(transitionHash)",data:snapshot,revision:revision,epoch:epoch)
  }
  // One native grant binds the exact new snapshot AND the exact public trust
  // transition. The signed transition is retained inside the encrypted generation
  // so a restart can resume propagation without exposing retired signing keys.
  func prepareRotation(_ snapshot: Data, transition: Data, previous: String,
                       revision: String, epoch: Int, grant: AuthorizedKeyAction) throws -> PreparedProtectedRotation {
    guard snapshot.count <= 11*1024*1024 else { throw ProtectedIdentityError.invalidEnvelope }
    try Self.validateTransition(transition,previous:previous,revision:revision,epoch:epoch)
    guard authorization.consume(grant,action:.rotate,revision:Self.rotationBinding(snapshot,transition:transition,revision:revision,epoch:epoch)) else { throw ProtectedIdentityError.authorizationRequired }
    var error: Unmanaged<CFError>?
    guard let signature = SecKeyCreateSignature(authorityKey,Self.signing,transition as CFData,&error) else { throw ProtectedIdentityError.cryptographyFailed }
    let bundle = ProtectedRotationBundle(schema:"scripture-armor.protected-rotation/1",snapshot:snapshot,
      transition:transition,authoritySignature:signature as Data)
    let encrypted = try encryptSnapshot(Self.encode(bundle),revision:revision,epoch:epoch)
    return PreparedProtectedRotation(envelope:encrypted,authoritySignature:signature as Data)
  }
  private static func validateTransition(_ data: Data, previous: String, revision: String, epoch: Int) throws {
    guard data.count <= 24000, epoch > 0, valid(revision:previous,epoch:0), valid(revision:revision,epoch:epoch),
          previous != revision,
          let fields = try JSONSerialization.jsonObject(with:data) as? [Any],fields.count == 8,
          fields[0] as? String == "scripture-armor.key-transition/1",
          let device = fields[1] as? String,valid(revision:device,epoch:0),
          let suppliedEpoch = integer(fields[2]),suppliedEpoch == epoch,
          fields[3] as? String == previous,
          let block = fields[4] as? String,block.count <= 16000,
          let nonce = fields[5] as? String,valid(revision:nonce,epoch:0),
          let issued = integer(fields[6]),let expires = integer(fields[7]),
          issued >= 0, expires > issued, expires-issued <= 86400,
          issued <= Int(Date().timeIntervalSince1970), expires > Int(Date().timeIntervalSince1970),
          try JSONSerialization.data(withJSONObject:fields,options:[.withoutEscapingSlashes]) == data,
          let raw = Data(base64Encoded:block),let identity = try JSONSerialization.jsonObject(with:raw) as? [String:Any],
          Set(identity.keys) == Set(["v","label","seal_pub","sign_pub","kem_pub","mldsa_pub"]),
          let version = identity["v"],integer(version) == 1, let label = identity["label"] as? String,label.count <= 256,
          let seal = identity["seal_pub"] as? String,let sign = identity["sign_pub"] as? String,
          let kem = identity["kem_pub"] as? String,let mldsa = identity["mldsa_pub"] as? String,
          !seal.isEmpty,!sign.isEmpty,!kem.isEmpty,!mldsa.isEmpty else { throw ProtectedIdentityError.invalidEnvelope }
    let keys = try JSONSerialization.data(withJSONObject:[seal,sign,kem,mldsa],options:[.withoutEscapingSlashes])
    let actual = SHA256.hash(data:keys).map { String(format:"%02x",$0) }.joined()
    guard actual == revision else { throw ProtectedIdentityError.invalidEnvelope }
  }
  private static func integer(_ value: Any) -> Int? {
    guard let number = value as? NSNumber,CFGetTypeID(number) != CFBooleanGetTypeID(),
          number.doubleValue.isFinite,abs(number.doubleValue) <= 9007199254740991,
          number.doubleValue.rounded(.towardZero) == number.doubleValue else { return nil }
    return number.intValue
  }
  // Public verification for durable encrypted storage; does not unlock or export keys.
  func verifyEnvelope(_ envelope: Data, revision: String, epoch: Int) throws {
    guard envelope.count <= 24*1024*1024, Self.valid(revision:revision,epoch:epoch) else { throw ProtectedIdentityError.invalidEnvelope }
    let decoded = try JSONDecoder().decode(Envelope.self,from:envelope), content = decoded.content
    guard content.schema == "scripture-armor.protected-generation/1", content.revision == revision, content.epoch == epoch,
          content.wrappedKey.count <= 4096, decoded.signature.count <= 80, content.signatureSafeCiphertextSize else { throw ProtectedIdentityError.invalidEnvelope }
    var error: Unmanaged<CFError>?
    guard SecKeyVerifySignature(authorityPublicKey,Self.signing,try Self.encode(content) as CFData,decoded.signature as CFData,&error) else { throw ProtectedIdentityError.cryptographyFailed }
  }
  func open(_ envelope: Data, revision: String, epoch: Int, grant: AuthorizedKeyAction) throws -> Data {
    guard envelope.count <= 24*1024*1024,Self.valid(revision:revision,epoch:epoch) else { throw ProtectedIdentityError.invalidEnvelope }
    guard authorization.consume(grant,action:.unlockKeys,revision:Self.openingBinding(envelope,revision:revision,epoch:epoch)) else { throw ProtectedIdentityError.authorizationRequired }
    let decoded = try JSONDecoder().decode(Envelope.self,from:envelope), content = decoded.content
    guard content.schema == "scripture-armor.protected-generation/1",content.revision == revision,content.epoch == epoch,
          content.wrappedKey.count <= 4096,decoded.signature.count <= 80,content.signatureSafeCiphertextSize else { throw ProtectedIdentityError.invalidEnvelope }
    var error: Unmanaged<CFError>?
    guard SecKeyVerifySignature(authorityPublicKey,Self.signing,try Self.encode(content) as CFData,decoded.signature as CFData,&error),
          let unwrapped = SecKeyCreateDecryptedData(encryptionKey,Self.wrapping,content.wrappedKey as CFData,&error) else { throw ProtectedIdentityError.cryptographyFailed }
    var raw = unwrapped as Data; defer { raw.resetBytes(in:0..<raw.count) }
    guard raw.count == 32 else { throw ProtectedIdentityError.invalidEnvelope }
    let aad = Data("scripture-armor.protected-generation/1:\(epoch):\(revision)".utf8)
    return try AES.GCM.open(AES.GCM.SealedBox(combined:content.ciphertext),using:SymmetricKey(data:raw),authenticating:aad)
  }
}
