# AIMOC Alfa Granitama — Phase 4B Implementation Report
**Weighbridge · Inventory Ledger · Driver Domain Integration**
**Date:** 2026-11-06
**Branch:** `refactor/phase1-design-system-extraction`
**Status:** Locally implemented and tested *staging-only services*. NOT deployed, no live integration.

## 1. Executive result

Phase 4B implements a self-contained PostgreSQL-compatible **execution staging domain** for:
- authenticated machine-source QR/TARE/GROSS event processing;
- verified material loading and departure;
- source stock reservation and actual cargo inventory movements;
- independent receiving, split/partial receipts, final settlement;
- Driver-specific assignment isolation, checklist reporting, and return reporting;
- independent return verification and release of the truck/driver resource claim;
- Marine Option B sequence released after verified unloading, **not** after truck return;
- durable transactional outbox and append-only source/receipt/audit evidence.

These services are deliberately **not wired to the production/legacy API mutation router**. They cannot be mistaken for activated business commands. The existing /api/action and /api/state paths are preserved for the live legacy application.

## 2. File inventory

| File | Responsibility |
| --- | --- |
| `server/v1/execution-phase4b.sql` | Extension of isolated `aimoc_execution_v1` schema |
| `server/v1/phase4b-schema.mjs` | Explicit staging-only DDL initialization and evidence immutability triggers |
| `server/v1/phase4b-weighbridge.mjs` | HMAC authentication, event idempotency, QR/TARE/GROSS processing and pending-event reconciliation |
| `server/v1/phase4b-inventory.mjs` | Reserve, loading, verified departure, custody arrival, partial/final receiving, journal and outbox |
| `server/v1/phase4b-driver.mjs` | Driver assignment-scope, checklist, trip history, return report, independently verified return evidence |
| `server/v1/execution-staging.mjs` | Phase 4 + Phase 4B guarded Marine/Land starts, unload release, return completion |
| `tests/v1-phase4b-integration.test.mjs` | Full staged business process and negative permission tests |
| `tests/v1-phase4b-safety.test.mjs` | Out-of-order evidence, capacity, immutable evidence, over-reservation checks |

## 3. M2M Weighbridge contract (staging)

The service requires `sourceSystem`, `timestamp`, `signature`, and **raw original JSON body**.

```text
signature = HMAC-SHA256(secret_for_source, timestamp + "\n" + raw_body)
```

- The source must be preprovisioned, active, and bound to an authorized weighbridge ID.
- A signed timestamp older/newer than 5 minutes is rejected.
- `source_system` in JSON must match the signed source identity.
- `(source_system,external_event_id)` is unique; equal duplicates replay without a second transition, conflicting duplicates fail.
- QR is an **identity event**, never a weight or stock mutation.
- TARE requires a valid, accepted QR and START_AUTHORIZED state.
- GROSS requires TARE_CONFIRMED followed by an independently authorized Stockpile LOADING action; gross > tare; verified net <= reserved planned quantity and approved truck payload.
- Out-of-order valid signed events are stored PENDING and do not advance a trip; explicit reconciliation may promote them when dependencies exist.
- Source fields of a recorded event are immutable, DELETE is prohibited; PENDING can transition only to ACCEPTED/REJECTED.
- **No real Weighbridge provider credentials have been provisioned**, and no external webhook is exposed yet.

## 4. Inventory movement contract

All stock quantities in these target transactions are `NUMERIC(18,6)` **tonnes**, not legacy m³ planned volumes.

1. `reserveDispatchInventory`: lock dispatch and source account; require sum of trip allocations = dispatch plan; atomically increase reserved, **do not** deduct on-hand; create trip-level reservation allocations.
2. `confirmTripLoading`: require verified tare and Stockpile permission on source; status LOADING; no stock movement.
3. `departVerifiedTrip`: require accepted gross/tare, source operator permission, unconsumed allocation; source on-hand -= verified net, source reserved -= allocated plan; create custody record IN_TRANSIT and append-only negative journal entry.
4. `confirmTripArrival`: require in-transit custody and destination receiving permission; trip ARRIVED.
5. `verifyDestinationReceipt`: independent scoped receiver, actual received quantity <= remaining custody; destination custody account credits only verified quantity; partial receipt leaves Marine gate closed; final full receipt creates verified settlement.
6. `finalizeMarineUnload`: require current gate owner, verified receipt/settlement, **fully reconciled cargo custody**, authorized receiving role; release sequence gate, keep truck resource claim open.
7. `reportDriverReturnStart`: driver may report RETURNING, **not** vehicle availability.
8. `recordIndependentReturnEvidence` + `verifyMarineTripReturn`: independently scoped return verifier and vehicle readiness required; then release truck/driver claim.

**Scope of receipt for marine:** receiving at jetty is a custody hand-off to the jetty location account, NOT final delivery to market/customer stockpile via barge. The voyage-to-final-destination process remains separate and pending.

**Known limitation:** Shortfall approvals/disputes are not yet implemented. Full unloading is finalized only when the received quantity equals shipped quantity. This is conservative by design.

## 5. Driver contract

- `driver_profiles.external_user_id` maps to an identity from an authenticated Driver authority supplied by the caller.
- Driver may read only own active assignment and completed trips, submit checklist/issue report, and report starting the return.
- A Driver self-report does not validate unloading, release stock, update gross/tare, or free the vehicle.
- Independent return verifier requires explicit permission for the source stockpile location and cannot be the same Driver identity.
- **Legacy authentication/role database still does not support Driver login**. This staging service assumes its `actor` argument has been securely authenticated; exposing it through the regular API would be unsafe until that identity infrastructure is complete.

## 6. Enforcement & evidence

- DB constraints: FK, unique per-trip reservation/claim, partial unique open truck/driver claim, nonnegative balances and custody quantities, source event uniqueness, source and destination allocation checks.
- Database immutability triggers reject UPDATE/DELETE for journal and operational audit; signed weighbridge payload fields immutable; verified receipts/settlements and return evidence protected.
- Atomic transactions and per-aggregate locking cover changes; idempotency receipts prevent repeated reservation/dispatch commands.
- Outbox records committed in the same transaction as actions, but **publisher delivery and SSE fanout are not yet implemented**.
- Location permissions maintained explicitly per stockpile/jetty for operator actions. A future authenticated permission administration service is necessary.
- Passwords, device secrets, access tokens, or real operator identities are NOT embedded in source files.

## 7. Validation

- All Phase 4B tests run on **fresh ephemeral PGlite** (PostgreSQL engine embedded), not the user's persistent or hosted PostgreSQL.
- End-to-end positive tests verify reserve → first Marine start → signed QR → signed tare → loading → signed gross → stock departure → arrival → partial receipt → verified final receipt → gate release → next trip start → Driver return report → independent return verification → truck released.
- Negative tests cover unauthorized operator, wrong role/assignment, signature mismatch/expiry, duplicate event conflict, overweight/invalid net, out-of-order pending evidence, partial unload, self-verification, same truck resource lock, double stock debit, illegal DB mutations.
- Tests use fabricated **QA-only events** for validation and do not claim to have received real field evidence.
- `npm run build`, `npm test`, and `git diff --check` used as final regression gates.

## 8. P0 blockers before production API v1 writes or frontend migration

1. Real Weighbridge provider event schema, source key management/rotation, M2M transport auth, device provisioning, reconciliation of historical/offline events, clock policies, operational fault handling.
2. Authenticated Driver login/profile lifecycle linked to real user identity and verified driver/truck/assignment management.
3. Standardized RBAC + location scopes in the production PostgreSQL role model; prevent direct application writes that bypass command handlers. Legacy Jetty authority must be mapped to receiving permission.
4. Production normalized schema v1.1 migration/backfill from existing JSONB state, source inventory and reservation reconciliation, safe rollback and data provenance.
5. Per-voyage capacity reservation, jetty unloading slot resource scheduler, and chain-of-custody from jetty onto barge to final destination stockpile/customer.
6. Hold/recovery/cancellation and approved discrepancy/shortfall, reversal workflow with evidence and segregation of duties.
7. Signed ingestion HTTP endpoint plus trusted operator command endpoints with idempotency, proper error envelopes and audited authorization.
8. Outbox publisher, SSE delivery and idempotent frontend revalidation; full API v1 final DTOs.
9. Real multi-connection PostgreSQL concurrency/load tests and migration exercise; embedded engine tests are not substitute.
10. Node 22.x repeat validation, accessibility and actual mobile/browser UAT, security review, explicit cutover approval.

## 9. Data safety and deployment

- No existing application startup import points to `execution-phase4b.sql` or `phase4b-schema.mjs`.
- Existing `server/schema.sql`, `server/database.mjs` and legacy domain logic are untouched by this phase.
- Existing /api/v1 writes remain intentionally unavailable.
- No SQL was executed on existing local persistent or hosted databases.
- No commit, push to GitHub, deployment to Vercel, or modification of production configurations.
