import Foundation

struct CommittedProtectedRotation {
  let anchor: ProtectedGenerationAnchor
  let transition: Data
  let authoritySignature: Data
}

// Called only by the native host. There is no serializable approval token,
// WebView handler, URL scheme, HTTP listener, CLI or remote rotation operation.
// The runtime must supply a fully validated/quiesced snapshot before calling.
final class NativeKeyRotation {
  private let authorization: LocalKeyAuthorization
  private let vault: ProtectedIdentityVault
  private let store: ProtectedGenerationStore
  private let lock = NSLock()
  private var busy = false

  init(directory: URL, authorization: LocalKeyAuthorization) throws {
    self.authorization = authorization
    let vault = try ProtectedIdentityVault(authorization:authorization)
    self.vault = vault
    self.store = try ProtectedGenerationStore(directory:directory,
      checkpoint:NativeGenerationCheckpoint(),verifyEnvelope:vault.verifyEnvelope)
  }
  #if ARMOR_AUTH_TESTS
  init(testAuthorization: LocalKeyAuthorization, vault: ProtectedIdentityVault, store: ProtectedGenerationStore) {
    self.authorization = testAuthorization; self.vault = vault; self.store = store
  }
  #endif

  func rotate(snapshot: Data, transition: Data, revision: String,
              completion: @escaping (Result<CommittedProtectedRotation,Error>) -> Void) {
    lock.lock()
    guard !busy else { lock.unlock(); completion(.failure(ProtectedGenerationError.stale)); return }
    busy = true; lock.unlock()
    let expected: ProtectedGenerationAnchor
    do {
      guard let current = try store.current(),current.0.epoch < Int.max else { throw ProtectedGenerationError.unavailable }
      expected = current.0
    } catch { finish(.failure(error),completion); return }
    let epoch = expected.epoch + 1
    let binding = ProtectedIdentityVault.rotationBinding(snapshot,transition:transition,revision:revision,epoch:epoch)
    authorization.authorize(.rotate,revision:binding) { [self] result in
      switch result {
      case .failure(let error): finish(.failure(error),completion)
      case .success(let grant):
        // No model or scanner process is involved. Queue one bounded encryption
        // and commit after local authentication, at low CPU priority.
        DispatchQueue.global(qos:.utility).async { [self] in
          do {
            let prepared = try vault.prepareRotation(snapshot,transition:transition,previous:expected.revision,
              revision:revision,epoch:epoch,grant:grant)
            let next = try store.commit(prepared.envelope,revision:revision,expected:expected)
            // A peer transition is released only after its encrypted generation
            // is current. Interrupted commits never announce an uncommitted key.
            finish(.success(CommittedProtectedRotation(anchor:next,transition:transition,
              authoritySignature:prepared.authoritySignature)),completion)
          } catch { finish(.failure(error),completion) }
        }
      }
    }
  }
  func invalidate() { authorization.invalidate() }
  private func finish(_ result: Result<CommittedProtectedRotation,Error>,
                      _ completion: (Result<CommittedProtectedRotation,Error>) -> Void) {
    lock.lock(); busy = false; lock.unlock(); completion(result)
  }
}
