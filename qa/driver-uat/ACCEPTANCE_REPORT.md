# AIMOC Driver Workspace — Visual & Staging UAT Acceptance

Date: 2026-11-06
Status: DRIVER UI UAT PASSED, production Driver integration NOT ACCEPTED
Branch: refactor/phase1-design-system-extraction

## Delivery
Four mobile-first Driver pages:
- Home: greeting, active assignment, quick actions, clear empty/integration/error states.
- Tasks: vehicle, route, material, verified quantities, milestones, checklist and return report.
- History: Driver-owned completed trip history or explicit empty/integration/error states.
- Profile: account identity, role, UAT settings in development and logout.

Design system: AIMOC navy, teal, responsive rounded cards, four-tab bottom navigation.

## UAT separation
- Default = STAGING API; same-origin read endpoints and CSRF + idempotent writes through dedicated adapter.
- Current normal local API returns NOT_INTEGRATED to Driver; it is never silently populated with demo trip data.
- Development-only opt-in switch labeled Coba UAT uses browser memory only.
- Trip aktif, Tanpa trip and Unloaded scenarios; IDs and plate are visibly marked UAT.
- UAT checklist and return reports never write to database and do not mark truck available.
- Unknown gross/tare/actual net remains null and displays Belum tersedia.
- FORBIDDEN, EMPTY, ERROR and NOT_INTEGRATED have distinct informative states.

## Browser QA
Headless Chrome with CDP verified four pages, UAT switch, simulated trip, history, profile, empty and return-ready scenarios.
320x700, 390x844 and 768x900: document width equals viewport width.
Four bottom-navigation tabs verified.
No browser exceptions in final QA server with HMR disabled.
Screenshots: qa/driver-uat/screenshots/ (local Mac only).

## Automated regression
npm run build: PASS.
npm test: 124 of 124 tests pass. Five Driver adapter tests cover reads, unknown values, forbidden/missing integration, CSRF, checklist, return and in-memory isolation.

## How to review
1. Run npm run dev in repository.
2. Open http://127.0.0.1:4196.
3. Login driver1 or driver2; private passwords are in .local/driver-access.json.
4. See STAGING not-integrated state; choose Coba UAT to preview.
5. Test bottom navigation Home / Tasks / History / Profile.
6. Try Trip aktif, Tanpa trip, Unloaded scenarios.
7. Checklist and Return affect UAT only.
8. Select Keluar UAT to return to staging status.

Production Driver assignment, external weighbridge, real inventory and identity mapping remain NO-GO pending evidence and contract acceptance.
No Git commit/push or Vercel deployment performed.
