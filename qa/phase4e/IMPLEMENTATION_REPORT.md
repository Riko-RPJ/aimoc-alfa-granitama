# AIMOC Phase 4E — Operational Integrity Closure Preparation

Date: 2026-11-06
Source: local repository branch refactor/phase1-design-system-extraction
Scope: inventory reconciliation, Driver identity binding, Weighbridge vendor readiness, and API v1 DTO candidate
Decision: STAGING CONTROLS IMPLEMENTED / PRODUCTION NO-GO / FRONTEND LEGACY_ONLY

## 1. Overall result

Four critical production blockers have received code-level guardrails, audited staging workflows and tests. However, their external evidence dependencies cannot be closed using fabricated user, material or equipment data. No new migration or production API path is enabled.

## 2. Inventory reconciliation

New files:
- server/v1/execution-phase4e.sql
- server/v1/phase4e-schema.mjs
- server/v1/phase4e-inventory-reconciliation.mjs

Implemented:
- Prepare opening balance only from explicit location/SKU, exact measured tonnes as a decimal string, external measurement reference, timestamp and SHA-256 digest.
- Proposer must have source-location permission.
- Independent approver must have separate permission and cannot be the proposer.
- No opening can overwrite nonzero on-hand or existing reservations / movements.
- Approved stock opening becomes the starting balance, with transactional outbox evidence.
- Audit compares initial independently approved quantity + append-only journal movements with on-hand and checks reservations.
- Under Phase 4E schema, dispatch reservation refuses an unapproved opening or journal mismatch.

Important: the evidence SHA-256 and external reference are user supplied; these cannot prove by themselves that a physical stockpile was weighed accurately. Opening proof is test-only until a signed actual site survey/measurement is furnished and independently validated. Existing stockpile m3 figures are never automatically converted into verified tonnes.

## 3. Driver identity and permissions

New:
- server/v1/phase4e-driver-identity.mjs
- driver_identity_bindings table with PENDING / ACTIVE / REVOKED lifecycle.

Implemented:
- Unique user-to-driver binding with identity authority and evidence reference.
- Independent verifier checks the reference before activation.
- Staging Driver own-trip read, Driver self-commands, Marine/Land start and detailed trip read reject unverified binding when Phase 4E schema is enabled.
- Revocation invalidates Driver access and disables corresponding profile; outbox emits an identity-revoked event.
- DB trigger prohibits modifying ACTIVE identity evidence except moving to REVOKED, and protects REVOKED state.

Important: there is no connection to an authoritative production IdP or real employment/driver registry. Test fixtures are not actual identity verification. The legacy localhost Driver accounts still permit only the data-free shell.

## 4. Weighbridge integration readiness

New:
- server/v1/phase4e-weighbridge-config.mjs
- integration_source_config table with DRAFT / APPROVED / REVOKED state, credential reference and vendor contract reference.

Implemented:
- The configured integration source must be active and the HMAC must verify.
- When Phase 4E schema exists, even valid signed events are refused until the device has an independently approved integration-source contract.
- Vendor-source approval must be by a different actor from provisioning.
- Approved vendor configuration fields cannot be rewritten in-place; follow-on credential rotation/revocation requires a separately approved workflow.
- Original raw-body signature validation, event source identity, duplicate-ID handling, event-order state checks and QR/TARE/GROSS rules from Phase 4B remain in effect.

Important: there is no real weighbridge vendor payload specification, real device secret, secret-manager integration, production webhook endpoint, calibration certificate or site E2E capture. The custom AIMOC_WIM_EVENT_V1 protocol is a proposed adapter, not an agreed vendor-native protocol. This is NOT a live hardware integration.

## 5. Final API DTO preparation

New:
- src/contracts/api-v1-candidate.js
- scripts/generate-phase4e-openapi.mjs
- qa/phase4e/AIMOC_OpenAPI_v1_candidate.json

OpenAPI 3.1 candidate covers 21 staged or compatible operations with roles, provenance envelope, time/mass representations, defined command payloads, signed M2M headers and idempotency requirements. Includes 10 explicit unresolved contract gaps, and an acceptance evaluator whose result is always NOT ACCEPTED while those dependencies remain open.

The known target frontend page contract is NOT mapped in full to this implemented API. Multi-destination allocations, exceptions, Driver checklist GET, stockpile receiving DTO and final voyage custody still differ. Never silently substitute the candidate for the previously agreed final API specification.

Frontend still uses the legacy state and action API. No read/write canary has been enabled.

## 6. UAT validation

- New Phase 4E unit and strict-integration tests assert PENDING evidence blocks writes and reads before independent approval.
- A read-only inventory integrity audit flags unverified openings and discrepancies.
- Real local PostgreSQL 14 rehearsal initializes isolated schemas, records a synthetic 100.000000 t opening balance and two independent approvals, verifies protected evidence triggers and lifecycle tables, and removes the disposable database.
- Phase 4D PostgreSQL concurrency, backup/restore and idempotency rehearsal remains available.
- Run Node 22 build and all tests before any change review.

The test measurement, device signature and driver identity strings are synthetic UAT evidence only.

## 7. External acceptance needed — no fabricated proofs

1. Inventory: SKU/location master mapping, signed survey or physical measurement in tonnes, measurement date/method, count/reconciliation, independent approval, verified adjustment policy.
2. Driver: authoritative identity-provider setup, approved driver registry, assignment roster, lifecycle/revocation policy and permissions by location.
3. Weighbridge: vendor technical protocol specification, real examples of signed QR/TARE/GROSS events, weighing device IDs, weighbridge-specific tare/gross meaning, calibration and error codes, secret management/rotation, offline/replay behavior, connection and field acceptance.
4. API: approve final OpenAPI DTOs with Admin/Stockpile/Driver teams, endpoint roles, missing-data semantics, exception/custody workflows, outbox and SSE, callback/backoff security and versioning.

## 8. Cutover decision

NO-GO production migration; NO-GO frontend API substitution.

There is no permission to execute the new schema against the active local AIMOC database or hosted database. All new schema loaders require explicit staging/test invocation. Existing repository changes remain uncommitted, with no Git push or Vercel deployment.

Next allowed action: source-verified integration tests and contract sign-off, then production-like migration rehearsal and controlled read canary.
