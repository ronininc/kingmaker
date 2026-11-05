import Foundation

final class FakeContext: KeyAuthenticationContext {
  var isAvailable = true
  var callback: ((Bool) -> Void)?
  var invalidations = 0
  func available() -> Bool { isAvailable }
  func evaluate(reason: String, completion: @escaping (Bool) -> Void) { callback = completion }
  func invalidate() { invalidations += 1 }
  func answer(_ result: Bool) { callback?(result) }
}

@main struct NativeAuthorizationProof {
  static func main() {
    var time: TimeInterval = 100
    var contexts: [FakeContext] = []
    let gate = LocalKeyAuthorization(testContext: { let c = FakeContext(); contexts.append(c); return c }, clock: { time })
    var ticket: AuthorizedKeyAction?
    var failure: LocalKeyAuthorizationError?
    func ask(_ action: LocalKeyAction = .rotate, _ revision: String = "revision-1") {
      ticket = nil; failure = nil
      gate.authorize(action, revision: revision) { result in
        switch result { case .success(let value): ticket = value; case .failure(let error): failure = error }
      }
    }
    ask(); contexts.last!.answer(false)
    guard case .denied? = failure else { fatalError("denial must issue no grant") }
    assert(ticket == nil)
    ask(); contexts.last!.answer(true); let valid = ticket!
    assert(gate.consume(valid, action: .rotate, revision: "revision-1"))
    assert(!gate.consume(valid, action: .rotate, revision: "revision-1"))
    contexts.last!.answer(true)
    guard case .superseded? = failure else { fatalError("repeated authentication callback must not mint another grant") }
    ask(); contexts.last!.answer(true); let wrongAction = ticket!
    assert(!gate.consume(wrongAction, action: .inspectMetadata, revision: "revision-1"))
    assert(!gate.consume(wrongAction, action: .rotate, revision: "revision-1"))
    ask(); contexts.last!.answer(true); let stale = ticket!
    assert(!gate.consume(stale, action: .rotate, revision: "revision-2"))
    ask(); contexts.last!.answer(true); let expired = ticket!; time = 115
    assert(!gate.consume(expired, action: .rotate, revision: "revision-1"))
    ask(); let old = contexts.last!; ask(); old.answer(true)
    guard case .superseded? = failure else { fatalError("older OS callback must be superseded") }
    contexts.last!.answer(true); let current = ticket!
    assert(gate.consume(current, action: .rotate, revision: "revision-1"))
    assert(old.invalidations > 0)
    ask(); contexts.last!.answer(true); let cancelled = ticket!; gate.invalidate()
    assert(!gate.consume(cancelled, action: .rotate, revision: "revision-1"))
    ask(); let pending = contexts.last!; gate.invalidate(); pending.answer(true)
    guard case .superseded? = failure else { fatalError("invalidation must cancel an OS callback") }
    time = .nan; ask(); contexts.last!.answer(true)
    guard case .denied? = failure else { fatalError("invalid monotonic clock must fail closed") }
    let unavailable = FakeContext(); unavailable.isAvailable = false
    let absent = LocalKeyAuthorization(testContext: { unavailable }, clock: { 1 })
    absent.authorize(.rotate, revision: "r") { result in
      guard case .failure(.unavailable) = result else { fatalError("unavailable authentication must fail closed") }
    }
    print("PASS native authorization: denial, one shot, action/revision binding, expiry, superseded callback, lifecycle invalidation, unavailable authentication and invalid clock")
  }
}
