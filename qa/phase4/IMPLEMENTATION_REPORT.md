# AIMOC Phase 4 — Backend API Integration & Domain Service Alignment
Version: Phase 4 foundation / integration staging, 2026-11-06.

## Critical distinction
**This is an additive implementation, not a production deployment of the full target backend.**
- Existing /api/state, /api/action, account/session and password flows remain intact.
- The current production/legacy operation domain still uses JSON state + serial queue per **truck**, not the Marine Option B per-dispatch transactional gate.
- New /api/v1 **GET** endpoints are connected to authenticated/scoped legacy read models.
- New /api/v1 **mutation** endpoints are intentionally blocked with HTTP 501, code V1_COMMAND_NOT_INTEGRATED. They are not silently mapped to legacy actions.
- Marine/land transactional command services exist ONLY as a staging/test module on isolated aimoc_execution_v1 relational tables. There is NO route from the public API handler to these staging mutation functions.
- No code was run against the user's local persisted .local/database or a production database during the tests. All staging integration tests used newly constructed, ephemeral PGlite databases.

## Implemented
1. server/v1/read-model.mjs: authenticated API v1 read-model projection.
2. server/handler.mjs: v1 GET dispatch + explicit 501 unsupported mutation guard.
3. server/v1/dispatch-policy.mjs: pure Marine Opsi B eligibility, final unload, truck return and Land parallel dispatch policy.
4. server/v1/execution-staging.sql: isolated target transaction tables/constraints, never included in server/schema.sql or startup migration.
5. server/v1/execution-staging.mjs: atomic startMarineTrip, finalizeMarineUnload, verifyMarineTripReturn, startLandTrip and idempotency receipts, staging only.
6. src/services/v1-read-client.js: fail-closed same-origin API v1 read client, deliberately not yet substituted into legacy operational UI.
7. Comprehensive new API/security, domain policy, relational transaction, and client tests.

## Actual API v1 compatibility read endpoints

| Endpoint | Authorization | Output status |
| --- | --- | --- |
| GET /api/v1/session | Valid user session | Role & legacy location scopes |
| GET /api/v1/operations/overview | Admin | Legacy counts; verified actuals NULL |
| GET /api/v1/inventory | Admin/Stockpile | Scoped legacy stockpile quantities in m3; tonnes NULL |
| GET /api/v1/inventory/movements | Admin/Stockpile | Scoped legacy ledger, NOT verified weighing |
| GET /api/v1/transfer-requests | Admin/Stockpile | Legacy request DTO; mode/allocation NULL |
| GET /api/v1/dispatches | Admin/Stockpile | Legacy dispatch DTO; mode/sequence evidence NULL |
| GET /api/v1/dispatches/{id} | Admin/Stockpile | Scoped dispatch + trips, no inferred verified events |
| GET /api/v1/dispatches/{id}/trips | Admin/Stockpile | Scoped trips |
| GET /api/v1/stockpile/me/pickups | Stockpile | Scoped legacy pickups |
| GET /api/v1/stockpile/me/receipts | Stockpile | NOT_INTEGRATED (independent receiving unavailable) |
| GET /api/v1/master-data | Admin | Legacy masters; Driver/Voyage target data NULL |
| GET /api/v1/operational-events | Admin | Legacy audit |
| GET /api/v1/exceptions | Admin | NOT_INTEGRATED (target exception lifecycle unavailable) |

The response envelope includes schema_version, resource, source, data_status, as_of, data.
A known numerical zero remains 0. Unknown/unverified is NULL or data_status=NOT_INTEGRATED.
A v1 GET does not make the v1 write side available.
Endpoints currently are compatibility projections, and do not exactly replace the planned final OpenAPI 3.1 DTO contracts.

## Marine Option B transaction tests
- Start Trip N+1 only after Trip N's verified final settlement, receipt, and persisted sequence release.
- Trip N may still have an active truck resource claim while Trip N+1 starts with a different truck.
- HOLD retains occupied sequence gate.
- A duplicate start or unload idempotency key does not mutate twice.
- A truck or driver can only have one open resource claim; partial unique DB indexes enforce it.
- An independent return verification releases truck/driver occupancy without changing earlier sequence release.
- Two dispatches belonging to the same voyage have independent serial gates.
- Inventory reservation existence is validated before start.
- Land distinct physical trips may start in parallel, without voyage/Marine gate.

**Staging evidence caveat:** The tests insert simulated, isolated verified receipts and return records to exercise transaction conditions. These are *not real weighing/receiving proofs*; their trusted ingestion and actor permission workflow is NOT built.

## Tests
- npm run build: PASS.
- npm test: 71 tests passing, 0 failing (including prior frontend, API, and business-domain regressions).
- Browser UI was not redesigned in this phase; the existing role navigation and pages remain unchanged.
- Tests run under Node 26 on the user's Mac, while package.json specifies Node 22. Re-run for Node 22 before a production cutover.

## Mandatory production blockers (P0)
1. Schema migration reconciliation: the existing JSONB operation is not the normalized v1 schema; define staged backfill, rollback, and reconcile historical inventory/dispatch/trip/receipts.
2. Implement real identity, safe role-based Admin/Stockpile/Driver authorization and location scopes. Existing legacy Jetty role remains supported for current workflows.
3. Implement signed M2M Weighbridge QR/TARE/GROSS event ingestion, source idempotency, event ordering, evidence provenance, and valid gross-tare net.
4. Implement transactionally enforced inventory reserve/consume/release, physical departure, in-transit custody, final receiving, voyage capacity, and discrepancy accounting with append-only ledger.
5. Implement independently authorized receipt/return evidence capture; staging fixture cannot prove real operations.
6. Implement hold/recovery/cancellation and ship/jetty resource scheduling, plus permission and security tests.
7. Provide /api/v1 mutation endpoints with CSRF or M2M signature as appropriate, idempotency keys, rate limits, and durable audit/outbox.
8. Integrate frontend feature modules with final v1 DTOs, SSE revalidation, and operational UI error/loading/stale states.
9. Full concurrent PostgreSQL staging tests including row-level locks on the actual deployment PostgreSQL version; current PGlite tests verify transaction semantics but do not substitute for real multi-connection load tests.
10. Verify offline/mobile UX, accessibility, origin security, secrets, Node 22 environment, and production rollback readiness.

## Deployment status
No SQL migration run against the existing local/remote operations database; no Git commit/push; no Vercel deployment. Changes exist on the local branch refactor/phase1-design-system-extraction.
