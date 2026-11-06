# AIMOC — Cross-Role Backend & Data Integration (UAT)

Date: 2026-11-06
Branch: refactor/phase1-design-system-extraction
Status: ISOLATED CROSS-ROLE UAT; NOT production integration.

## Architecture
- Start explicitly with `npm run dev:uat` at http://127.0.0.1:4296.
- Stop normal `npm run dev` on port 4196 first. Both share the existing local login identity PGlite, and cannot open it in separate processes concurrently.
- UAT workflow data is stored only in `.local/cross-role-uat` (separate, persistent embedded database).
- Uses the existing local Admin, Stockpile and Driver credentials.
- HTTP /api/uat requires authenticated session, CSRF, same-origin and Idempotency-Key; role and location scopes are checked by backend.
- UAT frontend is activated only in the explicitly selected dev:uat mode; the normal application uses legacy UI unchanged.
- No writes to legacy operations, production inventory, ERP, real Driver registry or Weighbridge devices.

## User walkthrough
Open separate browser profiles, or log out between roles. Every role sees the SAME UAT dispatch and event timeline, refreshed every 2.5 seconds.

1. Admin (admin): create dispatch crusher-1 → crusher-2, Driver driver1, UAT-TRUCK-01, Batu Split UAT, planned 40.000000 t. Select Create & Assign.
2. Admin: Authorize Trip.
3. Driver (driver1): Accept Assignment. Optionally Submit Checklist.
4. Admin: Simulate Tare 12.000000 t (synthetic; NOT a real Weighbridge event).
5. Source Stockpile (stock1): Confirm Loading.
6. Admin: Simulate Gross 52.000000 t (synthetic net 40.000000 t).
7. Source Stockpile (stock1): Confirm Departure.
8. Destination Stockpile (stock2): Confirm Arrival, then Verify UAT Receipt.
9. Driver (driver1): Report Return Start.
10. Source Stockpile (stock1): Verify Return Independently.
11. Admin: monitor status RETURNED_AVAILABLE and review the shared event timeline.

Login passwords: .local/access.json (Admin and Stockpile); .local/driver-access.json (Driver). Never commit or paste credentials.

## Controls verified
- Role/assignment/location-scoped GET and POST operations.
- Second Driver cannot read or accept another Driver's trip.
- Origin/destination stock operators cannot impersonate one another.
- Only Admin authorizes dispatch and simulates software tare/gross.
- Driver self-report is not independent receiving or return verification.
- Invalid state ordering rejected; duplicate command keys replay without double mutation.
- Active truck and Driver cannot be claimed by two open UAT trips.
- Isolated UAT state and audit survive server restart.
- The main legacy database operation revision stays unchanged in HTTP E2E tests.

## Tests
- `tests/cross-role-uat-http.test.mjs`: real HTTP cross-role flow, 5 nested scenarios.
- `tests/cross-role-uat-persistence.test.mjs`: durable UAT DB reload.
- `qa/cross-role-uat/browser-smoke.mjs`: static UAT build browser QA with four roles and shared Admin-created dispatch; screenshots in screenshots/.
- `npm run build` and `npm test`: normal production-style UI regression.

## Strict limitations
This is a working shared-data UAT simulation, NOT production transaction integration.
All weights, receipts and tonnage are clearly UAT_SIMULATED, do not post inventory,
do not call Weighbridge hardware or ERP, and are not signed verified evidence.
It does not activate normalized v1 DTOs on production UI.
No Git commit/push, Vercel deployment, or production DB migration performed.

Production cutover: NO-GO. Cross-role manual UAT: READY.
