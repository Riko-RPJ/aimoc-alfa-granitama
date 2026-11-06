# AIMOC Phase 4F — Source Evidence & Integration Contract Acceptance

Date: 2026-11-06
Branch: refactor/phase1-design-system-extraction
Decision: INTAKE PREPARED; FINAL API CONTRACT NOT ACCEPTED; frontend API stays legacy.

## Sources inspected
- Local code and staging services from Phase 4B–4E
- Target frontend page-data definitions and API v1 candidate
- Available indexed Project files (no real verified source packet found)
- Repository metadata and environment key NAMES only (no secrets opened)

No authoritative original stock measurement report, vendor hardware protocol/manual,
or trustworthy production Driver registry was authenticated. Synthetic UAT
fixtures and design specs do not qualify as production source evidence.

## Source evidence baseline
EVIDENCE_INTAKE_TEMPLATE.json contains 29 mandatory references:
- Inventory (8): stockpile/SKU mapping, physical mass measurement in tonnes,
  method, timestamp, SHA-256 digest, independent approval and ledger tie-out.
- Weighbridge (8): vendor protocol, device identity, actual redacted QR/TARE/GROSS
  capture, semantics, calibration, authentication, retries and vendor approval.
- Driver (6): authoritative IdP, driver roster, assignment source, role and
  location scope, lifecycle/revocation and independent approval.
- API (7): page endpoint matrix, DTO review, nullable/unit semantics, state
  and exception policy, security/idempotency, owners and integration UAT.

All 29 currently marked MISSING. Validator rejects UAT synthetic evidence and
self-approval. Even a fully self-declared APPROVED manifest is not proof of
actual provenance: independent manual verification remains required.

## API contract audit
CONTRACT_ACCEPTANCE_AUDIT.json reviews all 16 target frontend page contracts:
- 8 have only candidate GET route matches
- 8 do not have a matching GET route
- 10 published API v1 candidate gaps remain open
- Route name matches do NOT validate actual field-level DTO parity.

OpenAPI 1.0-candidate is not 1.0-final; no frontend endpoint substitution
is permitted at this stage.

## Acceptance ownership
Inventory: stockpile operations + inventory controller, signed source mass
baseline and independently approved opening and ledger reconciliation.
Weighbridge: hardware vendor, site engineering and IT, real protocol spec,
calibration, signed event capture and managed key provenance.
Driver: authorized HR/transport registry and IdP owner, pseudonymous user
bindings, assignment validity and independent role/scope approval.
API: operations owner, product/UI owner, backend integrator, DBA/security,
verified endpoint and DTO coverage, failure semantics and explicit signoff.

## Guardrails and tests
- src/contracts/source-evidence-acceptance.js: fail-closed source intake.
- tests/v1-phase4f-source-acceptance.test.mjs: unverified / fake approvals
  never unlock final DTO or migration.
- scripts/phase4f-evidence-audit.mjs: regenerate structured artifact audit.
- qa/phase4f/EVIDENCE_INTAKE_TEMPLATE.json: reference-only register.
- qa/phase4f/CONTRACT_ACCEPTANCE_AUDIT.json: per-page mismatch report.

## Final decision
Evidence status: INCOMPLETE.
Source authentication status: NOT VERIFIED.
Final DTO freeze: BLOCKED.
Frontend API migration and production cutover: NO-GO.

No code may infer that real stock volume in m3 equals validated mass in t.
No login/Driver production identity, real weighbridge event or vendor key
is assumed. No production database, live UI, Git remote or Vercel deployment
was changed.

Next step: acquire real source packages from accountable owners and verify
original provenance and approval, resolve unmatched pages and remaining API
gaps, then sign version 1.0-final explicitly.
