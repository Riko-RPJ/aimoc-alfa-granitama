# Integrated demo rollout and data compatibility

This change provides an authenticated, persisted, multi-role **demo/UAT** on
the normal Vercel API handler. It does not activate a production weighbridge,
WIM source, normalized execution cutover or Oracle NetSuite posting.

## Before updating an existing environment

1. Review the fix branch against `feature/aimoc-alfa-integrated-demo-20261106`.
   Take the normal database backup and record the currently deployed version.
2. Inspect existing operation records and reconcile open legacy trips using
   the currently deployed legacy workflow before cutover. Existing rows are
   preserved, not reset or converted into verified/integrated evidence. The
   new workspace shows `INTEGRATED_DEMO` requests/trips. Legacy open work still
   occupies its truck and reserves stock/capacity, even when not displayed in
   that workspace. The default planner skips unassigned legacy-busy trucks;
   if all trucks are occupied, resolve that work before planning new trips.
   For an explicitly confirmed published UAT environment with no hardware and
   no execution evidence, `server/legacy-demo-reconciliation.mjs` provides an
   offline preview/apply helper. It requires an exact trip allowlist, expected
   document fingerprint, request ID, count, Admin actor and batch reason. Run
   it only inside a locked database transaction after a private backup and
   reservation/evidence audit. It cancels unexecuted queued/loading demo work,
   releases only its reservations, and retains all history. It never invents
   weighing, receiving, return or ERP evidence. Physical/partially executed
   work must be held for operator reconciliation. No reconciliation endpoint
   is exposed by the application and no automatic startup cancellation occurs.
3. Run the explicit application database setup/migration with the intended
   environment's server-side database configuration: `npm run db:setup`.
   This transaction adds `driver` to the existing user-role constraint and
   preserves existing accounts and the operation document. Do not run it
   against another AIMOC database. Vercel runtime startup does not migrate.
4. Create active Driver accounts through Admin → Master & users → Accounts.
   Assign individual identities and deliver credentials privately. Local
   fixture accounts are not production credentials or driver-profile evidence.
5. Validate the same complete LAND and MARINE workflow in an isolated preview
   before promoting an application release. Use the normal handler, not only
   the optional normalized V1 staging adapter. Check shared IDs, capacity,
   source/destination scopes, mandatory QR/tare/gross, serial return, ledger
   and `awaiting_configuration` ERP outbox entries.

Deploying source alone against the old user-role constraint cannot create
Driver accounts; the API reports `SCHEMA_MIGRATION_REQUIRED`. Do not grant
unverified identities normalized V1 production permissions to bypass this.

## Compatibility boundaries

- Legacy `/api/action` transaction commands cannot mutate integrated entities.
  While integrated work is open, other legacy trip/planning mutations are
  held to prevent competing state machines and fleet reservations. Master
  display edits and opening a waiting vessel for loading remain possible;
  changing active identities/physical limits or deleting referenced masters
  is blocked. Measurement approval retains its stock-reservation/staleness
  protections.
- The old local anonymous truck-code progress sidecar is not used by the
  integrated workspace and cannot start/complete an integrated trip.
- The optional local staging adapter delegates `/api/v1/demo/*` to the same
  canonical application database. Its normalized `/api/v1/*` execution paths
  retain their independent field-verification and source-readiness gates.
- LAND demo destinations use the existing crusher/location master and a
  matching-SKU receiving stockpile. Separate operational location masters,
  quantity amendment/cancellation, hardware commissioning and NetSuite
  sandbox ACK/reconciliation remain separate work.

## Recovery

Do not delete/reset the operation document or release reservations manually.
Pause new assignments and retain command receipts, events, ledger and outbox
when investigating a failure. A previous UI does not understand all integrated
statuses, so restoring old application code is not a complete data rollback.
Drain integrated work or use a reviewed forward repair; restore a backup only
through a reconciled recovery plan that accounts for transactions after it.
