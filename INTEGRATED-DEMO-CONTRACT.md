# Integrated operations demo contract

This demonstrator uses **the existing `aimoc_alfa_ops.operation` JSON document**.
It is not a fourth state store, a driver-progress sidecar, or the normalized V1
production cutover. Request, dispatch, trip, stock ledger, vessel reservation,
receipt and Oracle NetSuite outbox refer to the same canonical entity IDs.
Every new request/dispatch/trip/event/ledger/outbox row has
`source: INTEGRATED_DEMO` and `synthetic: true`. No field measurement is verified
and no ERP record is posted by this engine. The outbox remains
`awaiting_configuration`.

## HTTP and atomicity

The normal local/Vercel handler mounts:

- `GET /api/v1/demo/context` -> `{state, drivers, revision, updatedAt, source}`.
- `POST /api/v1/demo/actions` -> same context plus `{result, replayed?}`.

POST body:

```json
{
  "requestId": "unique-client-command-id",
  "expectedRevision": 1,
  "action": "request.plan",
  "payload": {"requestId": "req-example"}
}
```

`requestId` at the top is a client command identity, not the transfer ID inside
the payload. A repeated command with the same actor and body returns its stored
receipt before revision validation. A different body with the same identity
conflicts. The HTTP adapter locks the operation row, validates the revision,
executes against a clone and commits state plus command receipt in one database
transaction. The domain also leaves the supplied state unchanged if validation
fails. No cloud database or production inventory is used by automated tests.

## Request and planning

MARINE creation accepts existing request fields:

```json
{
  "transferMode": "MARINE",
  "destinationLocationId": "stockpile-location-crusher-2",
  "jettyId": "jetty-1",
  "vesselId": "vessel-1",
  "lines": [{"skuId": "split-12", "quantity": 80, "unit": "t"}]
}
```

LAND creation:

```json
{
  "transferMode": "LAND",
  "destinationLocationId": "stockpile-location-crusher-2",
  "lines": [{"skuId": "split-12", "quantity": 80, "unit": "t"}]
}
```

New LAND and MARINE requests require `destinationLocationId` from Admin's
**Stockpile Locations** master. The location must be active and support the
selected transport mode. Its name/code/address and receiving-area mapping are
snapshotted onto the request, dispatch, trip and ERP outbox; free-text
`destination` cannot override that identity. Later display-name edits do not
rewrite historical snapshots. Deactivation, mapping changes and removal of a
transport mode are held while referenced work remains open. Referenced
locations cannot be deleted.

Location save accepts only `{id?, name, address, transportModes}`. Codes are
server-generated, unique `SPL-000001` sequences allocated under the operation
row lock, including historical codes; deletion never resets the sequence.
New locations default active. Existing code, status and receiving mapping are
preserved on edit; client overrides of these fields are rejected.

For a new LAND location the system provisions a dedicated logical receiving
inventory area, with zero-balance stockpiles for active SKUs. It is tagged
`kind: RECEIVING_AREA`, `production: false`, `sourceEligible: false` and does
not represent a physical crusher or dispatch source. Additional active SKUs
are provisioned at zero on authorized LAND request writes only; GETs remain
pure and inactive target rows are never reactivated automatically. Existing
physical receiving mappings are retained. The server derives `destinationId`
from the mapping and rejects a conflicting client override. That area must
have an active stockpile for each requested SKU.
An optional line `destinationStockpileId` selects a specific matching stockpile;
otherwise the first matching stockpile by code is selected. Sources exclude
the entire receiving area so a transfer cannot fulfil itself with its own
receiving stock. System-owned receiving rows cannot be removed separately;
unused zero-balance areas are removed through their parent location only,
with user-scope, balance and history guards. This is a bounded demo location model; a production Marunda
inventory-area expansion remains separate work. MARINE still binds the operational
delivery to the selected jetty and vessel; the stockpile location records its
intended onward destination.

Existing requests without a master ID retain their original destination text
on read. During planning an old LAND request can resolve a unique matching
receiving area, or Admin must explicitly choose a location if ambiguous. An
old MARINE request is not assigned a city/location by guessing. Existing
documents without the new master field project deterministic locations from
their actual crusher/inventory-area masters without mutating a GET. An explicit
empty master stays empty. No geographic city-to-crusher mapping is inferred.

Each request has one to six unique active SKUs. Units are `t` or `m3`; density is
captured from the SKU master. Derived cubic metres are a density conversion,
not camera-measured volume.

`request.plan` is admin-only:

```json
{
  "requestId": "req-example"
}
```

There is no assignment form. `assignments` and explicit truck/Driver selectors
are rejected with `MANUAL_ASSIGNMENT_NOT_ALLOWED`. The server chooses active,
available trucks and active, available authenticated Drivers automatically.
Any unfinished assigned trip claims its truck and Driver, including a queued
trip before start. A pair can hold several capacity-limited queued trips in
the **same dispatch**. It cannot hold unfinished trips in another dispatch.
Only the first unfinished trip can start, and the next waits for independently
verified return. The pair becomes available for a different dispatch after its
own last assigned trip is returned, even if other trucks still serve the first
dispatch. Missing eligible resources create waiting cargo instead of a manual task.

Planning reserves the full source SKU stock and safe MARINE vessel tonnage.
Multiple trucks and requests/dispatches may share a source stockpile as long as
unreserved stock remains. Remaining source/SKU cargo is represented by a
`waiting_truck` row with null `truckId` and `assignedDriverUserId` only when
there is no free pair or eligible pair already held by that dispatch. It can
represent several future physical loads. Planning splits cargo using bed
volume, payload and SKU density, and immediately assigns the serial queue
within the dispatch. Remaining unassigned cargo retains its reservation and
FIFO priority among eligible work; no inventory movement is posted by assignment
or splitting.

The allocator runs on planning and verified return; server hooks can also run
it when Driver/truck availability is enabled. `queueSequence` preserves FIFO
priority even when a split remainder receives a new display sequence/ID.
The response includes `assignedTripIds`/`autoAssignedTripIds`, `waitingTripIds`
and `autoDispatch` counters. Request and dispatch contexts carry these counters
as well. The maximum plan remains 2,000 physical trips, with 20,000 stored rows.

Fleet status is computed globally before scoped IDs are redacted: `available`
means no unfinished claims; `allocated` means assigned/pre-start serial work;
`busy` means actual execution has started; `unavailable` means inactive.
QR/tare recorded before Driver start do not make a truck busy. `dispatchId`,
`queuedTrips`, `serialTripsRemaining`, `activeTripId` and `nextTripId` expose the
binding and queue. References outside the actor's scope are not returned.

Every trip has `assignedDriverUserId`, `stockpileId`, `crusherId`, `skuId`,
`truckId`, `requestId`, `dispatchId`, `tonnageT`, `volumeM3`, `sequence`, plus
MARINE `jettyId/vesselId` or LAND
`destinationId/destinationStockpileId/destinationCrusherId`.

## Operational actions

All trip payloads contain `tripId`. Tare/gross also require `weightT` in tonnes.
An optional `externalEventId` (`eventId` alias) provides event-level replay
protection. Reuse with different action, trip, actor or payload is rejected.
The HTTP command identity remains required independently.

| Action | Authorized actor | Required status | Result |
| --- | --- | --- | --- |
| None | No actor can execute waiting cargo | waiting_truck | Automatic allocation creates a capacity-limited queued task when resources are available |
| `trip.qr` | Admin simulator | queued / start_pending / ready_to_load; no prior QR | Records synthetic QR; reconciles pending start |
| `trip.tare` | Admin / source Stock | queued / start_pending; no prior tare | Positive synthetic tare PENDING; reconciles if start + QR exist |
| `trip.start` | Assigned Driver only | queued; first unfinished task for both truck and driver | start_pending; becomes ready_to_load if QR + tare exist |
| `trip.loading` | Admin / source Stock | ready_to_load | loading |
| `trip.gross` | Admin / source Stock | loading with accepted tare | weighed after positive gross and valid net |
| `trip.depart` | Admin / source Stock | weighed; QR/tare/gross valid | in_transit; consumes source onHand/reservation; ledger + outbox |
| `trip.arrive` | Admin / destination Stock (LAND) or assigned Jetty (MARINE) | in_transit | arrived |
| `trip.receive` | Same destination operator | arrived; vessel must be loading for MARINE | unloaded; destination inventory or vessel cargo, receipt, ledger + outbox |
| `trip.return_start` | Assigned Driver only | unloaded | returning |
| `trip.return` | Admin / origin Stock | returning | returned; unlocks the next serial trip, or releases the pair after its last trip and allocates eligible waiting cargo |

QR, tare and start may arrive in any order. Reconciliation occurs inside each
relevant transaction; no separate manual replay/reconcile command is needed.
`queued` reserves the truck and driver for one dispatch. Multiple queued tasks
within that dispatch are allowed, while parallel execution or another open
dispatch claim is rejected. Different pairs may work in parallel. Drivers
cannot receive their own load or verify their
own return. Admins cannot impersonate the assigned Driver start/return-start.

For this deterministic demonstration, accepted net tonnes must match planned
tonnes within 0.00001 t and respect truck bed/payload limits. Underload and
overload are rejected with `WEIGHT_RECONCILIATION`; no shortfall is silently
marked complete. Partial-load amendment/cancellation/replanning is a separate
workflow, not an inferred production capability.

Receipt marks delivery, but does not release the truck. Requests/dispatches
have `deliveryStatus: pending|partial|received`; operational `status` becomes
`completed` only after **all** allocated trips are returned. Thus full delivery
with a returning driver remains `in_progress`, with nonzero `pendingTrips`.

## Scoped view and UI hints

The Admin Dispatch & Trips table separates dispatch, trip, truck, source,
destination and the SKU's planned trip quantity. Admin Details is read-only:
assignment QR values come from the request-detail endpoint and must match the
current request/trip/dispatch/truck tuple. Waiting cargo has no QR; historical
QRs are labelled, and stale or mismatching references are hidden. Driver and
location-operator workspaces retain their role-scoped operational actions.
The explicit Admin QR scan test is available under Audit & NetSuite, outside
Details; it retains the existing Admin-only command and simulation provenance.

`integratedView` returns canonical masters plus only integrated trips visible
to the actor. Drivers see their assigned trips, Stock sees source or LAND
destination trips for its crusher scope, Jetty sees its jetty trips, and Admin
sees all. Non-admin dispatch allocations, line quantities and trip IDs are
projected from the visible trips; ERP outbox is admin-only. Driver stockpile
masters omit onHand/reserved quantities.
Stock measurements retain existing crusher scoping for the camera/manual
measurement and Admin approval flow. Jetty and Driver cannot read them.
Unrelated vessel cargo and jetty operations are omitted from non-admin views.

`trucks` and alias `fleet` always derive occupancy from **all** canonical open
work before filtering. Out-of-scope assignment IDs are redacted, while busy /
allocated / available status remains true. Cancelled and returned trips are
not open. Shared fleet status does not grant mutation permission.

Visible trips include:

- `allowedActions` (full names such as `trip.start`), `canStart`, `blockReason`.
- `sourceStockpileCode`, `sourceCrusherCode`, `destinationStockpileCode`,
  `destinationCrusherCode`, `driverName` for safe labels of assigned work.
- `qrStatus: SCANNED|NOT_SCANNED`, `qrScannedAt`, `qrEventId`.
- `weighingEvents`: `{id,type:TARE|GROSS,weightT,status:PENDING|ACCEPTED,...}`.
- Accepted `tareT/tareEventId`, `grossT/grossEventId`, `netT`.
- `receivedAt`, `receiptCode`, `receivedBy`, `returnVerifiedBy` when applicable.

`allowedActions` is a UI hint for role/state/queue prerequisites. The mutation
handler revalidates current masters, target status, capacities and revision at
execution time. A live update may invalidate a previously rendered button.
`metrics` exposes scoped quantities and global fleet counts, `access` the user
scope, and `integratedDemo` explicitly identifies synthetic evidence and ERP
configuration status.

## Verification

Run `node --test tests/integrated-demo-domain.test.mjs` for isolated synthetic
domain checks. Coverage includes 80 t across two serial 40 t trips, LAND stock
conservation, all four representative QR/tare/start orderings, mandatory weights,
under/overload rejection, event replay, multi-SKU marine capacity, parallel
trucks, serial driver binding, receiving/return separation, location/identity
guards, scoped privacy, and global occupancy. HTTP/auth/transaction tests are
maintained separately by the application adapter owner.
Additional regressions cover tight-stock rounding without negative balances and
default selection of free fleet when other trucks have unfinished legacy work.
