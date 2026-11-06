# AIMOC Dispatch Planning — MARINE/LAND Visibility Fix

Date: 2026-11-06
Branch: refactor/phase1-design-system-extraction
Status: local UI FIXED; legacy-to-staging Driver assignment NOT INTEGRATED.

## Issue
Unplanned queue showed only TR-00001 LAND while TR-00002 MARINE was already
PLANNED. Local database revision 5 confirms DSP-00001 and 3 queued trips
RIT-00001 (truck-1 / DT-001), RIT-00002 (truck-2 / DT-002),
RIT-00003 (truck-3 / DT-003).

## Changes
- Planning Queue remains limited to unplanned requests.
- Planned Dispatches · Legacy shows planned records, mode, linked trips.
- Trip & Truck Allocation · Legacy shows exact stored trip and truck ID
  matches, material, origin, volumes, weights, and status.
- Legacy Driver remains explicitly unverified, not guessed from truck ID.
- Existing Verified Driver Assignment · V1 Staging panel moved from Trip
  Monitoring to Dispatch Planning. Staging identities stay separate from
  legacy trips; missing staging APIs show informative error.

## Browser verification
- Authenticated localhost Chrome at /admin/dispatch/planning.
- Desktop width 1440px and mobile width 390px.
- Planning Queue: TR-00001 LAND.
- Planned Dispatches: DSP-00001 / TR-00002 MARINE / 3 trips.
- Trips: RIT-00001 DT-001 28m3/42t; RIT-00002 DT-002 30m3/45t;
  RIT-00003 DT-003 8.67m3/13t.
- No browser JS errors; no page horizontal overflow.
- Evidence: qa/dispatch-planning/screenshots/desktop-planning.png,
  qa/dispatch-planning/screenshots/mobile-planning.png.

## Regression
npm test: 173/173 passed.
npm run build: passed (Node 22).
git diff --check: passed.
Legacy database not modified; no push or deployment.

## Pending
Existing MARINE legacy trip rows do not have a verified Driver identity
mapping. Staging Driver assignment requires separate normalized execution
trips and authenticated source identities. This UI fix does not create
such mappings, real TARE evidence, or production integration.
