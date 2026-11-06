# AIMOC — Role-Based Page Data Contracts v1.0

**Status:** Implementation candidate; *not* proof that the new API or database schema has been deployed.
**Scope:** Admin Desktop, Stockpile Mobile, Driver Mobile, current legacy Jetty compatibility.
**Implementation:** `src/contracts/page-contracts.js` and `tests/page-data-contracts.test.mjs`.
**Business baseline:** Marine Option B — next trip sequence becomes eligible only after previous trip's **final, independently verified unloading**, while previous truck stays busy until verified return. Land dispatch may run physically distinct truck trips in parallel.

## 1. Presentation contract

Every data-bound page needs the following separation:

| Layer | Responsibility |
| --- | --- |
| Source | Existing `GET /api/state` snapshot versus target `/api/v1/*`; never silently mix sources |
| Data DTO | Explicit type, unit, timestamp, provenance, record identity |
| View model | Derived presentation-only values with known calculation scope |
| UI state | `LOADING`, `READY`, `EMPTY`, `STALE`, `ERROR`, `FORBIDDEN`, `NOT_INTEGRATED` |
| Permissions | Backend enforces role + location scopes; frontend hides unavailable actions but isn't an authorization boundary |
| Events | A committed outbox event triggers targeted re-fetch; SSE notification alone is not a new authoritative state |

`0` signifies a **known zero**. `null` signifies missing/unverified/not integrated. The interface must display an em dash and an explanatory status for the latter.

**Known limitation:** Page components remain visually bound to existing `/api/state` fields to ensure zero functional drift in Phase 3. The new data contract is created and passed to page components as an additive integration seam, but its target DTOs are *not yet substituted* into the legacy UI. This is intentional, not an omitted acceptance test.

## 2. Admin Desktop target

| Page | Source endpoint (target) | Required data | Important validation |
| --- | --- | --- | --- |
| Operations Overview | `GET /api/v1/operations/overview` | as_of, active_dispatches, active_trips, needs_attention, inventory_summary, fleet_summary | KPI counts trace to same filtered trip population |
| Transfer Requests | `GET /api/v1/transfer-requests` | request lines, destination allocations, approval state | One request can have multiple SKU/destinations |
| Dispatch Planning | `GET /api/v1/dispatches` | transport mode, allocation, source, planned quantity, voyage if marine | Planned is not actual; LAND has no voyage |
| Live Dispatch Monitoring | `GET /api/v1/dispatches` + trip resources | verified unloaded milestone, sequence gate, truck/driver claim | Gate eligible is not a started trip; unload does not release truck |
| Inventory | `GET /api/v1/inventory` | on_hand_t, reserved_t, available_t, source, as_of | Reservation not physical departure |
| Exceptions | `GET /api/v1/exceptions` | blocking state, severity, actor, recovery action | HOLD retains marine gate |
| Master Data | `GET /api/v1/master-data` | SKUs, locations, stockpiles, trucks, drivers, vessels, voyages | Referential and location scope consistency |
| Audit & Integration | `GET /api/v1/operational-events` | immutable events, provenance, correlation | Outbox intent ≠ ERP acknowledgement |

## 3. Stockpile Mobile target

| Page | Target endpoint | Required data | Scope |
| --- | --- | --- | --- |
| Home | `GET /api/v1/stockpile/me/pickups` | location, expected pickups, current stock summary | Assigned locations only |
| Inventory | `GET /api/v1/inventory` | stockpile/SKU, on-hand, reserved, available, freshness | Server-scoped stockpiles |
| Pickups | `GET /api/v1/stockpile/me/pickups` | trip, truck, SKU, planned quantity, state | Do not count queued trips as physically arrived |
| Activity/Receiving | `GET /api/v1/stockpile/me/receipts` | receipts, quantity, receiving scope, verification | Driver report ≠ independently verified receipt |

Current Stockpile bottom navigation still points at appropriate **legacy** screens until new endpoints and role-scoped pages exist.

## 4. Driver Mobile target

| Page | Target endpoint | Required data |
| --- | --- | --- |
| Home | `GET /api/v1/driver/me/active-trip` | self-owned assignment, current state, next action |
| Tasks | `GET /api/v1/driver/trips/{tripId}/checklist` | checklist with response evidence |
| History | `GET /api/v1/driver/me/trips` | own past trips, verified completion evidence |
| Profile | `GET /api/v1/session` | authenticated driver user, scopes |

**Driver API and permissions are NOT implemented in the current backend.** The Driver shell uses `NOT_INTEGRATED` and must not display fake trips, weighing, return evidence, or coordinates.

## 5. Legacy adapters & migration

`legacyPageDataContract({role,page,state,connected})`:
- Enforces the expected visible page set client-side for presentation, without replacing server permission checks.
- Preserves `onHandM3`, `reservedM3`, `availableM3` as m³ values. It **does not** convert to actual verified tonnes.
- Returns null for marine sequence eligibility, unload evidence, current resource claims, and other fields unavailable in the legacy snapshot.
- Distinguishes loading, empty and stale.
- Returns NOT_INTEGRATED for Driver (even if given arbitrary legacy records).
- Marks legacy jetty role distinctly until permissions are migrated.

The legacy bridge should be retired only after field-level mapping and integration tests succeed against the target API.

## 6. Error / mutation contract

All operational writes must use committed command responses and idempotency keys. On 409 conflict, re-fetch the canonical state; on 403, show forbidden; on integration unavailable, do not invent success. The frontend must never optimistically mark stock deducted, unloading verified, return complete, or trip start authorized.

## 7. Acceptance gates

- Existing UI screenshot and functional regression remain stable for Admin and Stockpile.
- Data source and unit are explicitly traceable for every KPI/quantity.
- Unknown is not shown as zero; planned never shown as actual.
- The target Option B sequence transition cannot be made operative without backend gate & verified receiving evidence.
- Role and location scope enforced in backend (not only route).
- Driver data only after server-side authorization and /api/v1 service are ready.
- Future direct route loading, responsive accessibility, Safari/Android device checks, 401/403/409/error and reconnect tests must pass before production rollout.
