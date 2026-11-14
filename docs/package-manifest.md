# Kingmaker — Free Installable Package Manifest

## Package
**Kingmaker** — Free uncensored local AI agent for Mac.
License: Free for individual developers. Not for corporations.
Distribution: Ronin Inc launcher via ronininc.org/kingmaker/

## Cohorts (included components)

### Core
| Component | Status | Verified |
|---|---|---|
| Kingmaker Swift app (Customize panel, Interaction/Functions/Behavior tabs) | Shipping | Live on ronininc.org/kingmaker/ |
| Governance spine selector (Custom / Kingmaker x Heretic) | Code-complete | Node-verified (normalize, defaults, rejection) |

### Abliteration stack (kingmaker-os)
| Component | Status | Verified |
|---|---|---|
| `abliterate-model` method (subprocess-isolated heretic-llm) | Code-complete, UNTESTED live | Typecheck clean, 15/15 unit tests pass |
| Model pin registry (SHA256 content-addressed) | Code-complete | Typecheck clean, unit tests pass |
| Governance spine inheritance (Kingmaker-level cascades down) | Code-complete | Typecheck clean, unit tests pass |
| heretic-llm v1.4.0 (AGPL-3.0, tool-only, never vendored) | External tool | Verified on PyPI; Apple Silicon needs import guard patch (untested) |

### Hardening stack (kingmaker-os Phase 1)
| Component | Status | Verified |
|---|---|---|
| Audit chain (hash-chained, tamper-evident) | Code-complete | Typecheck clean, 29/29 tests pass |
| Ingestion guard (trust levels, injection detection, sanitization) | Code-complete | Typecheck clean, tests pass |
| Egress guard (allowlist + tor-only mode) | Code-complete | Typecheck clean, tests pass |

### Dark web search (kingmaker-os Phase 2)
| Component | Status | Verified |
|---|---|---|
| `darkweb-search` method (Tor-only, read-only, text-only) | Code-complete, UNTESTED live | Typecheck clean, 14/14 tests pass (offline) |
| CSAM auto-abort (no override path) | Code-complete | Logic verified, live test required |
| Kill switch | Code-complete | Logic verified |

## Installation
Via Ronin Inc launcher. Free download from ronininc.org/kingmaker/.

## What "verified" means
- **Typecheck clean**: `tsc --noEmit` passes on the full repo, zero errors.
- **Unit tests pass**: All assertions green in isolated test runs.
- **UNTESTED live**: Code is correct but has never executed against real
  infrastructure (GPU weights for abliteration, Tor network for dark web).
  Live dry runs require founder supervision.

## Gating rule
Components marked UNTESTED are included in the package but gated behind
explicit founder acknowledgment on first use. They are not enabled by default.
