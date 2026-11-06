# AIMOC — Phase 4G Unified Operational Data Contract

Date: 2026-11-06
Scope: isolated v1 execution staging only
Branch: refactor/phase1-design-system-extraction
Acceptance: STAGING CONTRACT / CROSS-ROLE HTTP UAT PASSED
Production API/Frontend Cutover: NO-GO

## 1. Decision

Dispatch, Trip, Inventory Reservation, Driver Assignment, Crusher and Loading
Point now have a **normalized staging relational contract** and one common
transaction-derived DTO projection. The ordinary localhost/legacy backend
still uses its existing state/action routes and has not been migrated.

No real stock, physical GPS, Driver HR identity, road network or Weighbridge
evidence was invented to make the UAT pass.

## 2. Canonical ID graph

- dispatches.id -> trips.dispatch_id (1:n).
- dispatches.source_stockpile_id + dispatches.sku_id -> inventory_accounts(location_id,sku_id)
  (composite FK). Stockpile ID is NOT assumed to equal Crusher ID.
- inventory_reservations.dispatch_id -> dispatches.id; reservation source/sku
  composite FK to inventory_accounts; trip_reservation_allocations.trip_id
  -> trips.id and reservation_id -> inventory_reservations.id.
- trips.driver_id -> driver_profiles.id and trips.truck_id -> fleet_vehicle_specs.truck_id.
- driver_profiles.external_user_id is a separate identity-provider subject.
  Its authority and employment validity still require Phase 4E IdP approval.
- trip_driver_assignments.assignment_id is unique. It binds trip_id +
  driver_id + truck_id, enforced by composite FK to the exact trio in trips.
- crusher_location_refs.crusher_id -> loading_point_refs.crusher_id (1:n).
  crusher_location_refs also explicitly binds crusher_id to source_stockpile_id.
- dispatch_loading_assignments binds dispatch_id -> crusher_id +
  loading_point_id + source_stockpile_id, with composite FKs enforcing:
  point belongs to crusher; crusher belongs to source stockpile; source
  stockpile matches dispatch source.
- The assigned loading point version is captured. A later source-master
  revision marks the projection STALE_MASTER until revalidated.
- The per-trip DTO is looked up using trip_id; the per-dispatch DTO is built
  from the exact same linked trip projection, not a second count population.

## 3. Schema and API

New staging-only:
- server/v1/execution-phase4g.sql
- server/v1/phase4g-schema.mjs
- server/v1/unified-operational-contract.mjs

Schema is explicitly installed after Phase 4B on a fresh or approved staging
database. It adds composite FKs and requires a data-reconciliation migration
for any existing records. NEVER run this file automatically on production or
on the existing localhost operation JSON.

Staging HTTP operations:
- POST /api/v1/dispatches/{dispatchId}/assign-loading-point: Admin only,
  requires crusher_id + loading_point_id; planned/unreserved dispatch;
  validates explicit crusher-stockpile association.
- POST /api/v1/trips/{tripId}/assign-driver: Admin only,
  requires assignment_id; verifies active Driver and Truck; queued trip.
- GET /api/v1/dispatches/{dispatchId}/operational-context: Admin or
  scoped Stockpile only; shared dispatch+inventory+trips projection.
- GET /api/v1/trips/{tripId}: existing authorized scoped route, enriched
  when Phase 4G schema is installed.
- GET /api/v1/driver/me/active-trip and /trips: existing self-owned,
  identity-scoped routes, enriched with the exact same linked IDs.

POST commands require idempotency key, authenticated session,
same-origin request and CSRF in the staging HTTP handler. Retried identical
keys replay the receipt. Key reuse with a changed payload returns conflict.

Inventory reservation in a Phase 4G staging DB now refuses dispatches
without a valid loading-point link or complete Driver+Truck assignments.
Earlier Phase4B/4C test schemas (without Phase 4G) retain prior behavior.

## 4. Unified Trip DTO contract 1.0-CANDIDATE

Required identifiers:
trip_id, dispatch_id, assignment_id, driver_id, truck_id,
source_stockpile_id, destination_location_id, sku_id,
crusher_destination.crusher_id, crusher_destination.loading_point.id.

Inventory:
inventory.location_id + inventory.sku_id are linked to the source account;
inventory.reservation_id + trip_reserved_t + consumed_t derive from
the per-trip allocation and reservation, not invented quantities.
Actual tare_t/gross_t/actual_net_t are NULL until independently measured.
Quantities in numeric tonnes are serialized as decimal strings.

Location:
crusher_destination.loading_point.version,
crusher_destination.location_status and nullable latitude/longitude.
UNVERIFIED and STALE_MASTER never expose GPS coordinates in the read DTO;
location_verified=false, navigation_enabled=false.

Role-level redaction:
Admin/scoped Stockpile may see source stockpile on_hand_t/reserved_t/available_t.
Driver sees only his assigned trip allocation and stable linked IDs;
global stockpile totals are NULL with stock_balance_visibility=REDACTED_FOR_DRIVER.

Error/empty:
TRIP_NOT_FOUND, FORBIDDEN_SCOPE, UNIFIED_CONTRACT_NOT_INSTALLED,
CRUSHER_STOCKPILE_MISMATCH, LOADING_POINT_CRUSHER_MISMATCH,
DRIVER_ASSIGNMENT_CONFLICT, LOCATION_ASSIGNMENT_INVALID, IDEMPOTENCY_KEY_REUSED.
Missing assignment is a nullable/invalid contract state, never a fabricated
"verified" location or zero stock.

## 5. Verification

- tests/v1-phase4g-unified-operational-contract.test.mjs:
  FK rejection, wrong ID/location rejection, missing assignment preconditions,
  idempotency replay and conflict, 3-role same-ID projection, other-Driver 403,
  stale master rev blocks integrity.
- tests/v1-phase4g-http-cross-role.test.mjs:
  real HTTP through separate legacy-identity and execution-staging DBs:
  Admin assigns both references -> reserves 40t -> starts LAND trip.
  Admin, scoped Stockpile and owning Driver read the same persistent trip,
  dispatch, assignment, source SKU, crusher and loading point IDs.
  Stockpile2 and Driver2 get 403; legacy revision stays unchanged.
- scripts/phase4g-pg-contract-rehearsal.sh:
  real local PostgreSQL 14 temporary database; FK mismatch rejected,
  reservation verified as 40.000000t, integrity PASS; automatic cleanup.
- qa/phase4e/AIMOC_OpenAPI_v1_candidate.json regenerated with Phase 4G routes.
  Candidate remains NOT final-accepted.

## 6. Still NOT integrated

1. Admin local Crusher Location Master is in the legacy local-only schema,
   whereas the new refs are in isolated v1 execution staging. An explicit,
   independently verified source-ID crosswalk and migration are still needed;
   no automatic mirror/copy of Admin draft coordinates exists.
2. Real production Driver IdP and Driver/truck dispatch assignment lifecycle
   are not connected to staging login in production.
3. Authoritative inventory tonnage, vendor WIM/QR/TARE/GROSS and final
   source evidence remain pending real-site signoff.
4. No verified internal haul-road network, GPS routing, geofence or live nav.
5. Full Admin dispatch creation API, client-side endpoint replacement and
   production schema migration are NOT activated.
6. Real MARINE/jetty physical custody and final DTO owner acceptance are
   separate remaining gates.
7. UAT fixture with location UNVERIFIED can exercise a synthetic LAND trip
   in isolated staging for contract checks; that is NOT permission to
   dispatch trucks to unverified loading points in the field.

## 7. Operational decision

Ready: staging UAT for shared IDs / referential integrity / role-scoped DTO.
Not ready: production source authentication, master synchronization, live
routing, automatic frontend cutover or deployment.

No production DB mutation, Git commit/push or Vercel deployment performed.
