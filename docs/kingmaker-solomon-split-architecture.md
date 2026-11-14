# Kingmaker / Solomon Split Architecture Doctrine

## Verdict

Kingmaker and Solomon must be separated into independent repos, independent release trains, and independent runtime identities.

Solomon is the customer product.

Kingmaker is the founder operating system that governs Ronin Inc, improves Solomon, builds patches, manages internal systems, and operates advanced founder-only capabilities.

The systems may interoperate, but neither should be structurally dependent on the other for baseline operation.

## Core Separation

### Solomon

Solomon is the customer-facing governed operating product.

Solomon includes:

- Customer Runtime
- CodaGen / CodeGen
- CRM
- Customer Runtime Research
- Governance Engine
- Connector Layer
- Plugin System
- Voice Runtime
- Orb Runtime
- Project / Build Queue Runtime
- Customer Executive Dashboard
- Local-first decision console

Solomon excludes:

- Fabrication Suite
- Penetration Testing Suite
- Ronin Inc internal CRM database
- Ronin Inc internal operations management
- Founder-only memory graph
- Kingmaker patch authority
- Internal revenue operations
- Internal deployment authority

Solomon must remain useful offline. Online access expands current information, but must not be required for baseline competence.

### Kingmaker

Kingmaker is the founder operating system.

Kingmaker includes everything Solomon includes, plus:

- Ronin Inc Operations Management System
- Founder Executive OS
- Founder Memory Graph
- Decision Ledger
- Opportunity Engine
- Product Portfolio Manager
- Patch Builder
- Patch Signing / Release System
- Solomon Capability Designer
- Solomon Patch Generator
- Repository Management
- Deployment Management
- Ronin Inc CRM Database Suite
- Fabrication Suite
- Penetration Testing Suite
- Security Workspace
- Vehicle Workspace
- Infrastructure Workspace
- Revenue Dashboard
- Internal Analytics
- Internal Connector Registry
- Voice Command Operations
- Full Kingmaker Runtime
- Advanced Plugin Runtime

Kingmaker may govern Solomon.

Kingmaker must not be required for Solomon to function.

## Relationship Model

Kingmaker does not directly mutate Solomon internals.

Kingmaker produces governed artifacts:

- Capability Proposals
- Patch Packages
- Migration Plans
- Rollback Plans
- Release Candidates
- Test Proofs
- Compatibility Manifests
- Founder Review Packets

Solomon consumes approved artifacts:

- Signed patches
- Capability manifests
- Plugin bundles
- Schema migrations
- UI registrations
- Runtime registrations

## Patch Philosophy

A Solomon patch should behave like a cog installed into an open circuit.

Before the patch:

- The surrounding infrastructure exists.
- The missing capability leaves a functional gap.
- The system remains operational but incomplete.

After the patch:

- The new capability registers itself.
- The manifest exposes what it can do.
- The database migration runs if needed.
- UI surfaces discover the feature.
- Runtime routers recognize the new capability.
- Governance policies bind to it.
- Audit logging begins immediately.

The patch should auto-mesh with the existing installed system, but only after compatibility and governance checks pass.

## Patch Package Contract

Every patch package must contain:

```json
{
  "patchId": "solomon.patch.example",
  "name": "Example Capability Patch",
  "version": "1.0.0",
  "target": "solomon",
  "minSolomonVersion": "1.0.0",
  "maxSolomonVersion": "1.x",
  "capabilitiesAdded": [],
  "capabilitiesModified": [],
  "databaseMigrations": [],
  "runtimeModules": [],
  "uiModules": [],
  "connectorScopes": [],
  "governancePolicies": [],
  "tests": [],
  "rollbackPlan": {},
  "proofs": []
}
```

## Installation Handshake

Patch install sequence:

1. Read installed Solomon manifest.
2. Read patch manifest.
3. Verify target product.
4. Verify version compatibility.
5. Verify required capabilities.
6. Verify governance policy bindings.
7. Verify migration dry-run.
8. Verify rollback path.
9. Stage patch.
10. Apply schema changes.
11. Register runtime modules.
12. Register UI modules.
13. Register connector scopes.
14. Register audit rules.
15. Run post-install tests.
16. Activate capability.
17. Emit installed proof.

If any step fails, installation must fail closed and preserve the previous working state.

## Offline Competence Rule

Solomon must never feel broken because it is offline.

Offline Solomon must still support:

- CRM access
- Local project management
- Local governance
- Local decision console
- Local voice command where available
- Local code generation where installed
- Local documents
- Local audit ledger
- Local build queues
- Local review packets

Online Solomon adds:

- Current research
- Current pricing
- Current supplier data
- Current market data
- External connector actions
- API integrations

Online mode is a capability multiplier, not a capability requirement.

## Authority Boundary

Solomon authority tiers:

- READ
- PLAN
- PREPARE
- REQUEST_APPROVAL
- EXECUTE_APPROVED

Kingmaker authority tiers:

- READ
- PLAN
- PREPARE
- REVIEW
- APPROVE_INTERNAL
- EXECUTE_INTERNAL
- GENERATE_PATCH
- RELEASE_CANDIDATE
- SIGN_RELEASE

Customer Solomon should not possess founder-level authority.

Kingmaker may possess founder authority, but it must still record proof, policy, and audit trail.

## Repository Layout

Recommended repositories:

```text
ronininc/solomon
ronininc/kingmaker
ronininc/solomon-patches
ronininc/solomon-plugin-registry
ronininc/ronin-infra
```

### Solomon repo

Contains:

- customer runtime
- customer CRM
- CodaGen
- governance
- connector layer
- plugin loader
- customer UI
- customer installer
- customer patch receiver

### Kingmaker repo

Contains:

- founder runtime
- Ronin Inc operations system
- advanced internal CRM
- project graph
- decision ledger
- fabrication workspace
- penetration testing workspace
- patch builder
- release manager
- deployment manager
- Solomon authority layer

### Solomon patches repo

Contains:

- versioned patch packages
- compatibility manifests
- migration scripts
- rollback plans
- proof reports

### Plugin registry repo

Contains:

- approved customer plugins
- internal plugins
- metadata
- scope declarations
- governance policy bindings

## Full Competence Appearance

The user interface must not expose missing infrastructure as incompetence.

Bad behavior:

```text
I cannot do that.
```

Better behavior:

```text
Local analysis is complete.
Current confidence: 81%.
Internet acquisition can raise confidence by checking live supplier data.
Would you like me to queue that research?
```

Bad behavior:

```text
Feature not available.
```

Better behavior:

```text
This system does not currently have the fabrication module installed.
I can prepare a fabrication-ready packet or request the patch if you have authority.
```

Bad behavior:

```text
I need Kingmaker.
```

Better behavior:

```text
This Solomon installation can complete the customer-safe portion locally.
Founder-only upgrade work requires Kingmaker authority.
```

## Final Operating Principle

Solomon is the reliable customer engine.

Kingmaker is the sovereign founder command system.

Patches are the bridge.

Governance is the lock.

Manifests are the language.

Proof is the trust layer.
