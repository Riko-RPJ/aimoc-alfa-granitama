# AIMOC — Phase 4C Implementation and E2E UAT

Date: 2026-11-06
Branch: refactor/phase1-design-system-extraction
Status: Staging integration COMPLETE; production cutover NO-GO.

## A. Work performed

1. server/v1/migration-preflight.mjs: read-only legacy snapshot analysis; never infers verified tonnes, driver identities, voyage allocation or truck weighing evidence.
2. server/v1/staging-api.mjs: allowlisted v1 business commands and GET read models with role and location scope rules.
3. server/v1/staging-http.mjs: isolated HTTP handler, reusing existing authenticated login/session, CSRF/Origin, JSON and idempotency checks. Signed M2M device ingress is separated from user sessions.
4. server/v1/phase4b-driver.mjs: idempotency receipts added to Driver checklist and return-start commands when used through the new staging HTTP API.
5. tests/v1-phase4c-http-uat.test.mjs: real HTTP flow through Admin, Stockpile, legacy Jetty and Driver, plus signed QR/TARE/GROSS.
6. tests/v1-phase4c-migration-preflight.test.mjs: duplicate identity, broken reference, read-only and NO-GO checks.

## B. Read-only LOCAL legacy preflight baseline

On 2026-11-06, .local/database at revision 1:

| Source | Count |
| --- | ---: |
| Products/SKUs | 6 |
| Crushers | 2 |
| Jetties | 2 |
| Trucks | 12 |
| Stockpiles | 12 |
| Requests | 0 |
| Dispatches | 0 |
| Trips | 0 |
| Measurements | 0 |
| Audit events | 0 |
| Broken master references detected | 0 |
| Duplicate record IDs detected | 0 |

Production schema migration is BLOCKED by five unresolved evidence/mapping categories: MIG-001 source stock volume to verified mass, MIG-002 LAND/MARINE mode/allocations/voyages, MIG-003 Weighbridge + receiving proofs, MIG-004 Driver identity bindings, MIG-005 jetty and final destination custody. These are missing agreed production mappings, not corruption.

## C. Staging API write command routes

| Actor | HTTP action | Result |
| --- | --- | --- |
| Admin | POST /api/v1/dispatches/:id/reserve | Source inventory reservation |
| Admin | POST /api/v1/trips/:id/start | Start Land or Marine with transactional gate |
| Stockpile | POST /api/v1/trips/:id/loading | Loading only after accepted tare |
| Stockpile | POST /api/v1/trips/:id/depart | Verified net stock debit and in-transit custody |
| Receiver/Jetty | POST /api/v1/trips/:id/arrive | Cargo arrival |
| Receiver/Jetty | POST /api/v1/trips/:id/receive | Partial or final verified custody credit |
| Receiver/Jetty | POST /api/v1/trips/:id/finalize-unload | Release marine gate only when full custody settled |
| Driver | POST /api/v1/trips/:id/checklist | Self-report; no verified unload |
| Driver | POST /api/v1/trips/:id/return-start | RETURNING but truck still busy |
| Authorized operator | POST /api/v1/trips/:id/verify-return-evidence | Independent return evidence |
| Authorized operator | POST /api/v1/trips/:id/complete-return | Release truck and driver claim |
| Driver | GET /api/v1/driver/me/active-trip | Own assignment only |
| Driver | GET /api/v1/driver/me/trips | Own history |
| Scoped user | GET /api/v1/trips/:id | Verified trip fields if authorized |
| Signed Weighbridge device | POST /api/v1/integrations/weighbridge/events | Signed QR/TARE/GROSS event inbox |

All user POST commands require same-origin session, CSRF, JSON and Idempotency-Key. Signed M2M ingress uses a separately provisioned source secret. These are staging routes and not yet the final reconciled OpenAPI v1 specification.

## D. E2E evidence

A full test uses 7 authenticated UAT identities and two independent ephemeral embedded PostgreSQL databases (identity + execution). It tests reservation, Marine trip start, signed QR/TARE, scoped loading, signed GROSS, source stock departure, arrival, partial receipt, final receipt, unload release, next trip start while predecessor truck BUSY, Driver checklist/return and independent verification of truck availability.

Negative tests include missing auth, CSRF, scope, unknown command, incorrect Driver assignment, partial unloading and idempotency conflict/replay.

All signed device and stock evidence are constructed UAT fixtures, not real field events. Legacy revision remains unchanged throughout the test.

## E. Release runbook and rollback policy

1. Freeze a known commit (current changes uncommitted) and catalogue all endpoint/schema version changes.
2. Back up the actual PostgreSQL database and verify a complete restore on a fresh test environment before any migration.
3. Capture read-only inventory/master and event baseline; obtain independently signed actual stock tonnage and mapping approvals; prohibit m3 to t conversion by assumption.
4. Complete reviewed source-to-target mapping for every SKU, stockpile, vehicle, driver, voyage, location, dispatch and active trip; identify unresolvable records for manual decisions.
5. Run all DDL and backfill on a dedicated PostgreSQL staging clone using migration versioning; never execute Phase4B staging DDL directly against the legacy database.
6. Reconcile opening balances, inventory reservations, movements, event sources, custody, and in-flight trip/dispatch states; demand exact approved tolerances and evidence.
7. Run real PostgreSQL multi-client stress, restart, failover, partial error and rollback/replay tests.
8. Roll out v1 write traffic behind an explicit feature gate with single-writer ownership and no concurrent writes from legacy and new transaction pipelines. Do not enable dual-write automatically.
9. Cut over only following sign-off from operations, database owner and security; preserve ability to return to old read-only UI. Database rollback after accepting live v1 commands requires an approved compensating-ledger / restore strategy; unsafe SQL reversals are prohibited.

## F. Production blockers

- Device-vendor protocol, managed secret rotation, fault and discrepancy resolution.
- Approved destination custody and separate barge voyage/final delivery model.
- Vessel capacity, jetty scheduling, HOLD, recovery, skip/cancel and actual resource readiness logic.
- Full v1 Driver login and production permission administration.
- Final API OpenAPI DTO alignment, outbox publisher, SSE and frontend integrations.
- Real PostgreSQL multi-connection concurrency and production-like migration rehearsal.
- Browser E2E and physical mobile device UAT, Node 22 validation and security review.

NO production database migration was executed. No Git commit/push or Vercel deployment occurred. Existing localhost uses legacy business handlers and continues to refuse v1 writes.
