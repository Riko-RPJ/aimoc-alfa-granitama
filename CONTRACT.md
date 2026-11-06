# AIMOC Alfa Granitama operational domain

`server/domain.mjs` exports `applyAction(state, action, payload, actor)`, `publicState(state, actor)`, `DomainError`, and re-exports `createSeed()` from `server/seed.mjs`. No network, database, timers, credentials, or external model calls occur here. The API owner must clone state and commit a successful action atomically under a database lock; discard the clone if an exception occurs. `DomainError` carries `status`, `code`, and a safe Indonesian `message`. All quantities use six decimal places.

Actor: `{id, role: "admin" | "stock" | "jetty", name?, crusherIds?:[], jettyIds?:[]}`. Admin can operate all locations. Stock writes require the assigned crusher; jetty writes require the assigned jetty. `publicState` filters stock operational rows by crusher and jetty operational rows by jetty, while sharing product master data and fleet utilization. Reads have no side effects.

## Entities

- `products`: `{id,code,name,sizeMm,densityTPerM3,active}`. View adds `onHandM3,reservedM3`.
- `crushers`: `{id,code,name,active}`. Maximum six distinct active SKU assignments through stockpiles.
- `stockpiles`: `{id,code,crusherId,skuId,onHandM3,reservedM3,active}`. View adds `availableM3`. Reserved is still included in on-hand.
- `trucks`: `{id,code,plate,bedM3,payloadLimitT,cycleMinutes,active}`. View adds `status: available|busy|unavailable`, `activeTripId`, `queuedTrips`, `nextTripId`, `estimatedAvailableAt`.
- `jetties`: `{id,code,name,active}`.
- `vessels`: `{id,code,name,jettyId,payloadLimitT,loadedT,reservedT,status: loading|waiting|closed}`. View adds `remainingT`. `payloadLimitT` is an operator-approved safe cargo limit, not catalog DWT.
- `requests`: `{id,code,jettyId,vesselId,destination,lines:[{skuId,quantity,unit:m3|t,volumeM3,tonnageT,densityTPerM3}],status:requested|planned|in_progress|completed,createdAt,requestedBy,deliveredM3,deliveredT}`.
- `dispatches`: `{id,code,requestId,stockpileId,crusherId,skuId,jettyId,vesselId,volumeM3,tonnageT,tripIds,status:planned|in_progress|completed,completedTrips,deliveredM3,deliveredT,createdAt}`.
- `trips`: `{id,code,dispatchId,requestId,stockpileId,crusherId,skuId,truckId,jettyId,vesselId,volumeM3,tonnageT,densityTPerM3,status:queued|loading|in_transit|arrived|unloaded|returned,sequence,estimatedStartAt,estimatedReturnAt,createdAt}`. Actual transition timestamps appended. Unload adds `receiptCode,receivedBy`.
- `measurements`: `{id,code,stockpileId,crusherId,skuId,method,volumeM3,geometry,status:needs_calibration|pending|approved,evidenceId,evidenceName,notes,measurementLabel,createdAt,createdBy,approvedAt?,approvedBy?}`.
- `inventoryLedger`, `events`, `erpOutbox` are append-only domain evidence. ERP status is always `awaiting_configuration`; these are intents, not NetSuite business ACKs.

## Actions

| Action | Payload | Role |
|---|---|---|
| `master.product.save` | `{id?,code,name,sizeMm,densityTPerM3,active?}` | admin |
| `master.crusher.save` | `{id?,code,name,active?}` | admin |
| `master.stockpile.save` | `{id?,code,crusherId,skuId,onHandM3,active?}` | admin |
| `master.truck.save` | `{id?,code,plate,bedM3,payloadLimitT,cycleMinutes,active?}` | admin |
| `master.jetty.save` | `{id?,code,name,active?}` | admin |
| `master.vessel.save` | `{id?,code,name,jettyId,payloadLimitT,status,active?}` | admin |
| `request.create` | `{jettyId,vesselId,destination,lines:[{skuId,quantity,unit:"m3"|"t"}]}` | admin or assigned jetty |
| `request.plan` | `{requestId}` | admin |
| `trip.start` | `{tripId}` | admin or assigned stock |
| `trip.depart` | `{tripId,tareT?,grossT?}` | admin or assigned stock |
| `trip.arrive` | `{tripId,jettyId?,vesselId?,skuId?}` | admin or assigned jetty |
| `trip.unload` | `{tripId,jettyId?,vesselId?,skuId?}` | admin or assigned jetty |
| `trip.return` | `{tripId}` | admin, assigned stock, or assigned jetty |
| `measurement.create` | `{stockpileId,skuId?,method:"manual"|"calibrated_geometry"|"camera_pending",volumeM3?,geometry?,evidenceId?,evidenceName?,notes?}` | admin or assigned stock |
| `measurement.approve` | `{measurementId}` | admin |

Updates may omit unchanged master fields. Existing stock cannot be edited through master save: use a measurement approved by Admin. `geometry` is `{lengthM,widthM,heightM,shapeFactor}`; volume = product of the four values. This is an operator-dimensioned estimate requiring survey validation, not 3D AI reconstruction. A single camera image without scale produces `volumeM3:null`, `needs_calibration`, and cannot be approved. Uploaded photo provenance is linked by `evidenceId`; byte storage and authorization belong to the API.

Measurements capture the stockpile ledger sequence. If stock movements occur before approval, the old survey is rejected with `STALE_MEASUREMENT` rather than overwriting newer inventory; record a new reconciled survey.

Planning validates all line stocks, active fleet, vessel destination, and vessel remaining payload before reserving stock and vessel cargo. Availability is `onHandM3 - reservedM3`. Multiple sources produce separate dispatch records. Trips honor the lower of bed volume and payload/density, and are assigned to the earliest estimated truck queue using operator-specified cycle time. ETA is a planning estimate, not GPS prediction. One truck can hold multiple queued dispatches; only its earliest queue entry can start and it cannot start another until return is confirmed. Planning is bounded at 2,000 trips per request and 20,000 overall trips.

Departure subtracts physical stock and its reservation, and creates an in-transit ledger/ERP intent. Optional operator-entered tare/gross must reconcile to planned net within 0.001 t; any variance is rejected for separate Admin reconciliation, never silently changes reservation. Without weights the quantity source is explicitly `dispatch_plan_confirmed_by_operator`, not real weighbridge telemetry. Arrival alone does not load the vessel. Only jetty-confirmed unload increases loaded cargo and releases vessel reservation. Waiting vessels require Admin activation to `loading`. Unload is terminal for delivery completion, while truck remains busy through return. Duplicate/out-of-order transitions are rejected; API idempotency keys handle HTTP retries.

## Public metrics

`state.metrics`: `onHandM3,reservedM3,availableM3,inTransitM3,deliveredM3,deliveredT,availableTrucks,busyTrucks,activeTrips,queuedTrips,completedTrips,openRequests,pendingMeasurements,erpPending`. Scope follows the returned operational rows. `state.erpStatus` is `awaiting_configuration`; `state.access` reflects actor role/scopes.

Seed: six SKU, two crushers with six stockpiles each, 12 internal trucks of 28/30/32 m³, two jetties, three clearly named demo barges. No generated traffic, loading, measurements, or ERP posting is pre-populated.
