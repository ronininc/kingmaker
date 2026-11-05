import Foundation
import LocalAuthentication

enum LocalKeyAction { case inspectMetadata, protectKeys, unlockKeys, rotate }
enum LocalKeyAuthorizationError: Error { case unavailable, denied, superseded }
struct AuthorizedKeyAction {
  fileprivate let id: UUID
  fileprivate init(id: UUID) { self.id = id }
}

protocol KeyAuthenticationContext: AnyObject {
  func available() -> Bool
  func evaluate(reason: String, completion: @escaping (Bool) -> Void)
  func invalidate()
}
private final class DeviceKeyAuthenticationContext: KeyAuthenticationContext {
  private let context = LAContext()
  init() { context.touchIDAuthenticationAllowableReuseDuration = 0 }
  func available() -> Bool { var error: NSError?; return context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) }
  func evaluate(reason: String, completion: @escaping (Bool) -> Void) {
    context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { accepted, _ in completion(accepted) }
  }
  func invalidate() { context.invalidate() }
}

// Native-only, one-shot authorization. This type has no Codable/Objective-C,
// WebView, URL, HTTP or MCP interface. It is not a key storage implementation.
final class LocalKeyAuthorization {
  private let lock = NSLock()
  private var generation = UUID()
  private var grant: (id: UUID, action: LocalKeyAction, revision: String, deadline: TimeInterval)?
  private var pendingContext: KeyAuthenticationContext?
  private let contextFactory: () -> KeyAuthenticationContext
  private let clock: () -> TimeInterval

  init() {
    contextFactory = { DeviceKeyAuthenticationContext() }
    clock = { ProcessInfo.processInfo.systemUptime }
  }
  #if ARMOR_AUTH_TESTS
  // Compiled only in the disposable native test executable. Production has
  // no injected authentication result, clock, or context constructor.
  init(testContext: @escaping () -> KeyAuthenticationContext, clock: @escaping () -> TimeInterval) {
    self.contextFactory = testContext; self.clock = clock
  }
  #endif

  func invalidate() {
    lock.lock()
    generation = UUID(); grant = nil
    let context = pendingContext; pendingContext = nil
    lock.unlock()
    context?.invalidate()
  }

  func authorize(_ action: LocalKeyAction, revision: String,
                 completion: @escaping (Result<AuthorizedKeyAction, LocalKeyAuthorizationError>) -> Void) {
    let request = UUID(), context = contextFactory()
    lock.lock()
    let previous = pendingContext
    generation = request; grant = nil; pendingContext = context
    lock.unlock()
    previous?.invalidate()
    guard context.available() else {
      lock.lock(); if generation == request { pendingContext = nil }; lock.unlock()
      context.invalidate()
      completion(.failure(.unavailable)); return
    }
    let reason: String
    switch action {
    case .rotate: reason = "Authorize Scripture Armor key rotation"
    case .protectKeys: reason = "Protect Scripture Armor keys on this device"
    case .unlockKeys: reason = "Unlock Scripture Armor protected keys"
    case .inspectMetadata: reason = "Unlock Scripture Armor key management"
    }
    context.evaluate(reason: reason) { [weak self] accepted in
      defer { context.invalidate() }
      guard let self else { return }
      self.lock.lock()
      let result: Result<AuthorizedKeyAction, LocalKeyAuthorizationError>
      if self.generation != request || self.pendingContext !== context { result = .failure(.superseded) }
      else if !accepted || !self.clock().isFinite { self.grant = nil; self.pendingContext = nil; result = .failure(.denied) }
      else {
        let id = UUID()
        self.grant = (id, action, revision, self.clock() + 15)
        self.pendingContext = nil
        result = .success(AuthorizedKeyAction(id: id))
      }
      self.lock.unlock()
      completion(result)
    }
  }

  func consume(_ authorization: AuthorizedKeyAction, action: LocalKeyAction, revision: String) -> Bool {
    lock.lock(); defer { lock.unlock() }
    guard let current = grant else { return false }
    grant = nil
    return current.id == authorization.id && current.action == action && current.revision == revision
      && clock().isFinite && clock() < current.deadline
  }
}
