# AIMOC Stockpile Role Alignment — Implementation Report

Date: 2026-11-06 (Asia/Jakarta)

## Result

Stockpile now has exactly four shared desktop/mobile navigation items and routes:

- Home — `/stockpile/home`
- Inventory — `/stockpile/inventory`
- Pickups — `/stockpile/pickups`
- Activity — `/stockpile/activity`

Legacy Stockpile Dispatch and Transfer Requests navigation and routes are removed. Invalid Stockpile and Admin URLs under a Stockpile session redirect to `/stockpile/home` without rendering Admin data.

## Files changed

- `src/app/navigation.js`
- `src/App.jsx`
- `src/layouts/StockpileLayout.jsx`
- `src/layouts/StockpileMobileNav.jsx`
- `src/features/pages/stockpile/index.jsx`
- `src/features/dispatch/index.jsx`
- `src/contracts/role-permissions.js`
- `src/contracts/page-contracts.js`
- `server/role-permissions.mjs`
- `server/domain.mjs`
- `server/v1/read-model.mjs`
- `tests/frontend-navigation.test.mjs`
- `tests/page-data-contracts.test.mjs`
- `tests/admin-access-enforcement.test.mjs`
- `tests/domain.test.mjs`
- `tests/v1-api.test.mjs`
- `qa/stockpile-role-alignment/IMPLEMENTATION_REPORT.md`

`server/handler.mjs` was inspected. Its existing authenticated session, CSRF, permission, idempotency, transaction, and audit path is retained and now consumes the narrowed permission contract.

## Permission changes

Removed from Stockpile:

- `operations.read.scoped`
- `inventory.read.scoped`
- `inventory.measure.create`
- `transfer.read.scoped`
- `dispatch.read.scoped`
- `trip.read.scoped`
- `trip.start.scoped`
- `trip.depart.scoped`
- `trip.return.scoped`

Added for Stockpile:

- `stockpile.home.read`
- `stockpile.inventory.read`
- `stockpile.inventory.activity.record`
- `stockpile.pickups.read`
- `stockpile.pickups.loading.confirm`
- `stockpile.pickups.return.confirm`
- `stockpile.activity.read`

`request.create`, `request.plan`, master saves, and unknown commands default-deny for Stockpile. Loading start and scoped return remain authorized. Legacy `trip.depart` is not granted to Stockpile because it can deduct physical stock without an integrated trusted QR/TARE/GROSS source.

## UI pages implemented

- Home: assigned-location inventory and pickup overview, assigned locations, recent scoped activity.
- Inventory: existing AIMOC inventory/measurement components in a Stockpile-specific page entry.
- Pickups: scoped trip assignments, relevant truck/source/destination details, permitted loading action, and explicit `NOT_INTEGRATED` status for Driver identity and verified weighing.
- Activity: scoped audit events and inventory ledger, with explicit integration status for independent receipt/ERP acknowledgement.

Global loading, stale, and error states are preserved. Each page provides meaningful empty content. No production measurement, assignment, or weighing data is fabricated.

## API and authorization changes

- `GET /api/state`: Stockpile response now contains only assigned crushers/stockpiles, assigned trips, related products/trucks/jetties/vessels, scoped measurements, ledger, events, and outbox rows. Transfer requests and dispatch plans are not returned.
- `GET /api/v1/inventory`: remains server-scoped by authenticated session location; client-supplied out-of-scope `stockpile_id` returns no rows.
- `GET /api/v1/stockpile/me/pickups`: returns only the already session-scoped pickup population.
- `GET /api/v1/transfer-requests`: Stockpile now receives `403 Forbidden`.
- `GET /api/v1/dispatches` and dispatch detail/trip reads: Stockpile now receives `403 Forbidden`.
- `POST /api/action`: role permission is checked before the locked transaction; location scope is revalidated against the server-side actor and domain record.

The handler continues to enforce authenticated server session role/scope, same-origin JSON requests, CSRF, idempotency keys, expected revision checks, row locking, audit, and transactional persistence.

## Security vulnerabilities resolved

1. Stockpile menu and direct routes exposed legacy Dispatch and Transfer Requests.
2. Stockpile permissions conflated pickup visibility with transfer/dispatch reads.
3. v1 transfer and dispatch reads accepted the Stockpile role.
4. `/api/state` exposed global fleet/destination masters and scoped dispatch/request planning records.
5. Derived truck metrics could reveal an active trip ID from another location when a truck had assignments across locations.
6. Legacy physical departure could be offered to Stockpile without a trusted weighing evidence integration.

## Verification results

- `npm run build` — PASS; 1,705 modules transformed, production bundle generated.
- `npm test` — PASS; 128 tests passed, 0 failed.
- `git diff --check` — PASS.
- Focused navigation/security/domain/v1 tests — PASS.

Automated HTTP coverage verifies:

- Stockpile transfer creation, dispatch planning, and master mutation return `403` without revision changes.
- Cross-location inventory query returns no rows.
- Cross-location measurement mutation returns `403`.
- Own-location measurement recording succeeds.
- Own-location pickup loading start succeeds.
- Stockpile `/api/state` omits requests, dispatches, and unrelated operational masters.
- Admin, Driver, legacy Jetty, Marine Option B, CSRF, idempotency, audit, and transaction regressions remain green.

Chrome headless UAT used an isolated in-memory database:

- 1440px, 390px, 320px: all four pages rendered with correct titles, menu items, selected states, and no horizontal overflow.
- `/stockpile/dispatch`, `/stockpile/transfers`, `/admin/dispatch`, `/admin/transfers`, `/admin/master-data`: all redirected to `/stockpile/home`; no Admin content rendered.
- Authenticated navigation across all Stockpile pages produced no console errors.
- Browser back/forward routing uses the existing History API and `popstate` handler; automated route navigation confirmed stable target paths.

## Remaining integration limitations

- Trusted Driver identity, QR, TARE, GROSS, verified net weight, and independent receipt data are not integrated into the legacy production UI/API.
- Stockpile physical departure is therefore intentionally not enabled through legacy `/api/action`; it must use the accepted signed-weighing execution service after production cutover approval.
- Independent Stockpile receipt and ERP acknowledgement remain `NOT_INTEGRATED`.
- Phase 4B–4F staging services were not activated against the legacy database.
