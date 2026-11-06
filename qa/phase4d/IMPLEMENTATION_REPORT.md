# AIMOC — Phase 4D Production Readiness Hardening & Migration Rehearsal

Date: 2026-11-06
Branch: refactor/phase1-design-system-extraction
Decision: STAGING HARDENING PASS; PRODUCTION CUTOVER NO-GO

## 1. Result and scope

Phase 4D introduces isolated transaction hardening, real PostgreSQL 14
concurrency rehearsal, repeatable backup/restore and a fail-closed frontend
read-only canary. It does not migrate actual legacy source data or enable
production v1 API writes.

## 2. New artifacts

| Path | Role |
| --- | --- |
| server/v1/execution-phase4d.sql | Trip HOLD history, voyage capacity and jetty receiving windows |
| server/v1/phase4d-schema.mjs | Explicit staging-only schema loader |
| server/v1/phase4d-hold.mjs | Transactional HOLD + independent recovery, with audit |
| server/v1/rehearsal-concurrency.mjs | Real multi-client PostgreSQL contention tests |
| scripts/phase4d-rehearsal.sh | Local disposable databases + pg_dump/pg_restore validation |
| src/services/v1-acceptance.js | Default-legacy, read-only canary eligibility guard |
| tests/v1-phase4d-hold.test.mjs | HOLD/recovery rules |
| tests/v1-phase4d-voyage-capacity.test.mjs | Cross-dispatch voyage capacity and held jetty slots |
| tests/v1-phase4d-cutover-gate.test.mjs | Prevents unapproved frontend API cutover |

Modified: existing Phase4B idempotency receipt services, Stage4C staging API,
and Phase4C HTTP UAT with independent second supervisor and jetty slot HOLD.

## 3. Real PostgreSQL 14 rehearsal evidence

Run: bash scripts/phase4d-rehearsal.sh

- Concurrent start of one Marine trip: 1 accepted / 1 rejected.
- Exactly 1 sequence gate owner, 1 open truck claim and 1 start audit event.
- Next Marine trip blocked until verified previous unload releases the gate.
- Two 80 t LAND reservations against 100 t available stock: one accepted,
  one rejected; on-hand 100 t and reserved 80 t.
- Two 40 t MARINE dispatch reservations for shared 70 t voyage:
  one accepted, one rejected; voyage reserved 40 t.
- Two concurrent retries using the same idempotency key:
  both replayed successfully without a new mutation.
- PostgreSQL pg_dump -Fc and pg_restore to a *second temporary database*:
  data checksums/counts match across trips, gates, accounts, inventory
  reservations, evidence and 7 non-internal triggers in 27 staging tables.
- Temporary databases and dump are automatically removed using shell EXIT trap.

This was a SYNTHETIC STAGING backup/restore, not a restore of any actual
AIMOC production database or a historical record backfill.

## 4. Domain controls

HOLD:
- Gate and truck/driver occupancy remain owned by the held trip.
- Recover requires a different actor from hold author.
- Resume returns to previous operational state; never bypasses unloading,
  weighing, return verification or gate sequence.
- Admin-only staging HTTP write commands; no production route activated.

Shared vessel and jetty:
- Voyage capacity is a locked numeric tonnes account for all dispatches
  referencing the same voyage.
- Per-dispatch marine sequence gates remain independent.
- Reservation and Trip Start require a voyage capacity allocation and
  designated active jetty slot.
- Arrival requires current valid jetty receiving window.
- Jetty window HOLD blocks arrival.
- Physical berth contention/overlapping windows and voyage capacity RELEASE
  lifecycle are NOT yet implemented.

Idempotency:
- Transactional actor/key lock rows now serialize simultaneous retries
  before looking up receipts.
- Same-key/same-payload retries replay; conflicting payload fails.
- Lock-row retention/purging policy remains to be defined.

## 5. Legacy migration preflight

Last verified read-only local snapshot in Phase 4C: revision 1,
6 products, 2 crushers, 2 jetties, 12 trucks, 12 stockpiles,
0 requests, 0 dispatches, 0 trips, 0 measurements.
No duplicate identities or broken master references were detected.
Five proof/mapping blocker classes remain.

Do not convert m3 to verified tonnes based on unapproved density or defaults,
do not invent QR/tare/gross, receiving/return or Driver assignment proofs.

## 6. Frontend canary readiness

src/services/v1-acceptance.js provides an additive acceptance guard and
read-only gateway. It is NOT imported into currently active React pages.
The active app remains on the legacy API for both reads and writes.

The future gateway requires every explicit readiness gate to pass. It cannot
send write commands. Unit tests can simulate an approved manifest to validate
behavior, but this is not a cryptographic production attestation; a server-side
rollout authority remains required.

Backend final contract acceptance has NOT occurred. Accordingly, no frontend
API substitution was enabled.

## 7. Remaining production P0 blockers

1. Approved legacy inventory balances, SKU/location mapping, signed verified
   tonne-based stock reconciliation and detailed migrator/backfill approval.
2. Actual device-vendor Weighbridge event source, key storage and rotation,
   replay/rejection operations and hardware site acceptance.
3. Real production Driver identity lifecycle and location scoped RBAC.
4. Vessel voyage closure, berth exclusivity/scheduling, jetty-to-final
   destination custody and verified customer receipt workflow.
5. Shortfall tolerance/approval, disputes, cancellation, authorized skip/
   override, compensation and recovery events.
6. Complete final target API DTOs, backend readiness attestation, outbox
   publisher, SSE and frontend feature-level integration.
7. Production-like database volume/load/fault/restart testing, migration of
   historical data into normalized schema, audit and backup/restore rehearsal
   on a realistic staging copy, and signed operational approvals.
8. Browser/mobile real-device E2E UAT following API cutover.

Decision is NO-GO until all authoritative data and sign-offs are available.
No SQL migration, Git commit/push or Vercel deployment occurred.
