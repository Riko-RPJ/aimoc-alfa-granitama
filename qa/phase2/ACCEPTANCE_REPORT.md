# AIMOC — Phase 1 Visual Regression and Phase 2 Role Shell Acceptance

**Date:** 2026-11-06
**Branch:** `refactor/phase1-design-system-extraction`
**Status:** Local implementation; no Git commit, Git push, production database migration, or Vercel deployment.
**Source of fixture data:** `createSeed()` / `publicState()`, served through a temporary read-only QA HTTP server. Screenshots are not production data.

## Scope

1. Verify original visual foundation and Phase 1 component extraction.
2. Extract reusable application navigation and topbar.
3. Introduce role-specific navigation/layout architecture for Admin, Stockpile, and Driver.
4. Preserve legacy Jetty role *temporarily* for backend compatibility; do not imply Driver API is live.
5. Maintain existing request/dispatch/trip/inventory behavior while the target Marine Option B backend is not yet implemented.

## Visual regression findings

- Login, desktop **1440 × 900**: original and Phase 1 production screenshots have matching SHA-256 hashes (pixel-identical).
- Login, tablet **768 × 900**: original and Phase 1 production screenshots have matching SHA-256 hashes (pixel-identical).
- Initial 390px Chrome CLI screenshots had a **500px CSS viewport** and therefore must *not* be interpreted as true 390px layout tests. Genuine mobile verification below uses Chrome DevTools Protocol `Emulation.setDeviceMetricsOverride`.
- Authenticated Admin **1440 × 900**: 117 / 1,296,000 pixels above the per-pixel RGB threshold, approximately **0.009%**; the change is negligible and no intentional Admin visual redesign occurred.
- Authenticated Admin **768 × 900**: **0 / 691,200 pixels different** from original mock-data baseline.
- Old Stockpile mobile and Phase 2 Stockpile mobile are intentionally visually different: an accessible bottom navigation was added and KPI/filter layout adapted for mobile. Do not use an identical-image criterion for this change.

## Responsive acceptance (real CSS viewport)

| Role | Viewport | document.scrollWidth | Browser JS exceptions | Result |
| --- | --- | --- | --- | --- |
| Admin | 1440 × 900 | 1440 | 0 | PASS |
| Admin | 768 × 900 | 768 | 0 | PASS |
| Stockpile | 390 × 844 | 390 | 0 | PASS |
| Stockpile | 320 × 700 | 320 | 0 | PASS |
| Driver, QA identity | 390 × 844 | 390 | 0 | PASS (shell only) |

**Stockpile:** bottom navigation displays four authorized existing areas; the inventory filters fit within viewport, KPI cards stack vertically, and the data table retains its own horizontal scrolling container.

**Driver:** has Home / Tasks / History / Profile shell with a prominent **integration unavailable** message; the UI does not invent assignments, trips, weighing events, route coordinates, or loading confirmations.

## Architecture delivered

- `src/layouts/LegacyNavigation.jsx`: presentational sidebar with existing visual identity.
- `src/layouts/LegacyTopbar.jsx`: shared application header.
- `src/layouts/AdminLayout.jsx`: Admin shell navigation.
- `src/layouts/StockpileLayout.jsx`, `StockpileMobileNav.jsx`: Stockpile shell/navigation, mobile-first.
- `src/layouts/DriverLayout.jsx`: Driver shell with explicit unavailable-data state.
- `src/app/navigation.js`: existing role mapping and target route registry separated.
- `src/styles/role-layouts.css`: scoped role-specific responsive styles.
- `tests/frontend-navigation.test.mjs`: role page lists, route isolation, and Driver target route tests.
- Shared UI components and existing foundation tokens from Phase 1 remain unchanged.

## Production readiness caveats

- Browser QA is based on a controlled UAT fixture, not a live authenticated production browser.
- Full end-to-end UI command tests, accessibility audit, real-device testing (Safari/iOS, Android), and Driver authorization against a new backend API are **not yet complete**.
- Legacy Jetty role is temporarily retained because its backend permissions and operations cannot safely be removed in frontend-only Phase 2.
- Target Marine **Option B — serial until unloading verified** is a fixed business contract but **has not yet been implemented in the existing backend**. No frontend label should claim otherwise.
- The app uses Node 26 on this computer although package.json declares Node 22.x. Verify again under Node 22 before a production cutover.
- No claim is made that new database schema v1.1 or API v1.0 are deployed.

## Follow-on work

Phase 3: Feature modularization and role-specific page data contracts, followed by transactional backend/API integration and full end-to-end testing.
