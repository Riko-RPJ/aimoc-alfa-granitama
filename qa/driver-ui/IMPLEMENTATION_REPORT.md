# AIMOC — Driver UI Completion & Staging Adapter UAT

Date: 2026-11-06
Scope: Local React UI, development-only simulated UAT, isolated driver staging adapter.
Status: Code and automated unit/SSR checks completed; physical device/browser pixel-acceptance pending.

## 1. Four distinct role-specific pages

- **Home:** navy/teal Driver hero, signed-in name, current assignment, vehicle, source/destination, quick links, and an explicit missing-integration/empty/error/loading state.
- **Tasks:** trip details, authoritative vs unverified weights, 6-step milestone timeline, 4 Driver checklist items, issue reporting, and return-start action available only when status is UNLOADED_VERIFIED.
- **History:** Driver-scoped completed trips or readable EMPTY/NOT_INTEGRATED/ERROR states.
- **Profile:** authenticated user details, role/scope disclosure, integration source, local UAT controls, logout.

All pages preserve AIMOC navy (#0B2632), teal (#098D8C), light page canvas (#F4F7F9), Lucide icons, rounded panels and bottom mobile navigation.

## 2. Simulated UAT source isolation

In **Vite development mode only** (npm run dev), a clearly visible "Coba UAT" control switches from STAGING to UAT_SIMULATION.

The source banner remains present: "UAT · SIMULATED DATA". Demo trip, locations, vehicle, timestamps and history have UAT prefixes and are **fabricated fixtures**. Self-reports are tagged UAT_SIMULATED_SELF_REPORT. The simulated adapter:
- runs exclusively in frontend memory,
- does NOT call the backend,
- does NOT persist to browser storage,
- does NOT change production/legacy inventory or trips,
- does NOT provide authoritative tare/gross, unloading, return readiness or production driver identity.

Switching scenarios resets in-memory checklist and return behavior, and reverts fully when returning to STAGING.

Scenarios:
1. Trip aktif: UAT-TRIP-0024, in transit, four checklist controls, return action intentionally disabled.
2. Tanpa trip: readable empty state, navigation still functional.
3. Unloaded: artificially verified UAT scenario to exercise report return-start; truck remains NOT available.

## 3. Dedicated staging adapter

File: src/services/driver-workspace-adapter.js

- GET /api/v1/driver/me/active-trip
- GET /api/v1/driver/me/trips
- GET /api/v1/trips/:tripId
- POST /api/v1/trips/:tripId/checklist
- POST /api/v1/trips/:tripId/return-start

Uses same-origin credentials, session CSRF and Idempotency-Key for writes, validates response envelopes, rejects unsafe trip identifiers and distinguishes NOT_INTEGRATED/EMPTY/FORBIDDEN/ERROR. Missing verified actual weight remains null and is shown as "Belum tersedia", never fabricated as zero.

**IMPORTANT:** Normal npm run dev server still uses legacy handler. Local Driver /api/v1 GET returns NOT_INTEGRATED; Driver writes are NOT available there. Adapter can use staging services **once an explicitly isolated staging API handler is actually mounted and an authoritative Driver identity is linked**. Do not claim there is a production data connection now.

## 4. Files changed

- src/layouts/DriverLayout.jsx — full four-page UI and local-only UAT selector.
- src/styles/role-layouts.css — Driver design system and responsive styles.
- src/services/driver-workspace-adapter.js — isolated staging + in-memory simulation clients.
- src/App.jsx — passes authenticated driver user/session CSRF into Driver shell.
- tests/driver-workspace-adapter.test.mjs — endpoint, error, security, simulation and return cases.
- tests/driver-workspace-render.test.mjs — real Vite SSR render of four pages.

No changes to server schema, production database, or legacy action handler for this task.

## 5. Manual UAT instructions

1. From repository root, run npm run dev.
2. Visit http://127.0.0.1:4196/ and login as driver1 or driver2; account passwords are stored in gitignored .local/driver-access.json.
3. Default STAGING screen should show no active operational trip and a clear NOT_INTEGRATED explanation, not a blank page.
4. Use **Coba UAT** (development localhost only), verify the amber simulated-data banner.
5. On Home, inspect assignment card and location source/destination. Select Tasks and toggle checklist DONE / ISSUE. Confirm no verified weighing is claimed.
6. Select History and Profile; check both have content and role appropriate information.
7. Select Tanpa trip to confirm explicit empty state in Home/Tasks; History remains simulation.
8. Select Unloaded; go to Tasks and click Laporkan mulai kembali. Confirm RETURNING, but vehicle remains unavailable and final return verification is absent.
9. Click Keluar UAT to restore staging data and NOT_INTEGRATED state.
10. Repeat at 320px, 375px, 390px, 768px and desktop viewport; confirm nav, cards, source banner and touch controls.

## 6. Testing gates

- Vite production compilation on Node 22.
- All npm test regression checks.
- Driver adapter tests using simulated backend responses.
- Vite SSR rendering of all four pages.
- Browser-based pixel screenshot and actual physical mobile acceptance are **not automatically confirmed**; manual steps remain.

Security: no auto-switch to demo, no production write, no production identity or signed weighing fabricated.
