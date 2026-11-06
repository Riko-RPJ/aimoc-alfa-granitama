# AIMOC — Phase 4I Dispatch Execution & Verified Driver Assignment

Date: 2026-11-06
Branch: refactor/phase1-design-system-extraction
Status: STAGING API + BROWSER UAT PASS / LIVE LOCAL LEGACY-TO-STAGING DATA MIGRATION NO-GO

## Implemented in repository

- server/v1/staging-api.mjs: Admin-only GET /api/v1/dispatch/planning-options.
  Catalog references only inventory accounts with approved opening balance,
  active crusher/unsuspended loading points, free active truck profiles,
  Driver profiles with ACTIVE independently checked identity bindings,
  and READY voyage/jetty windows where schema exists.
  No synthetic identities/measurements are inserted into live data.
- POST /api/v1/dispatches (already implemented) now explicitly requires
  Driver identity binding schema and inventory opening reconciliation schema;
  no fallback acceptance of an active but unverified Driver.
- server/v1/phase4h-cross-role.mjs: validates both Driver and Truck for
  conflicting unclosed trip assignments, plus resource claims; locks truck
  master rows when creating dispatch to prevent concurrent double booking.
- server/v1/unified-operational-contract.mjs: locks truck row in Driver
  reassignment; preserves independent verification and pre-WIM requirements.
- src/features/pages/admin-final/StagingDispatchExecution.jsx:
  New staging-only Admin Dispatch Planning form with API-sourced references,
  LAND/MARINE selection, exact requested tonnes, approved stock location/SKU,
  Crusher and Loading Point, eligible Truck and independently verified Driver.
  Marine adds READY voyage/jetty window selection.
  Performs POST Create Dispatch, Reserve Inventory and Authorize Trip Start
  with CSRF, idempotency and guarded UI transitions.
  Retries preserve command keys and dispatch/trip/assignment IDs.
  No m3->t automatic conversion or legacy-to-stage silent migration.
  When staging is absent displays STAGING NOT READY, no false action.
- src/features/pages/admin-final/AdminFinalPage.jsx:
  New execution form on Dispatch Planning; staging assignment table refreshes
  after successful transaction; existing assigned Driver identity and
  assignment ID visible when verified; legacy MARINE trips remain separate.
- src/features/pages/admin-final/admin-final.css: responsive form styling.
- src/contracts/api-v1-candidate.js plus regenerated
  qa/phase4e/AIMOC_OpenAPI_v1_candidate.json: staging planning catalog
  and strict assignment request DTO described; remains CANDIDATE, NOT final.
- scripts/phase4i-browser-uat.mjs: repeatable Chrome UAT using entirely
  temporary synthetic embedded databases, explicit QA identity fixture
  and fake QA opening. Does not touch .local/database.
- tests/v1-phase4h-cross-role-transaction-http.test.mjs: catalog access/
  source filtering, double-truck denial, valid LAND with reassignment,
  TARE gating and actual shared state, plus MARINE READY voyage/window
  matching, dispatch creation and reservation.

## Browser + HTTP proof

Chrome headless at /admin/dispatch/planning, synthetic in-memory-only UAT:
- Real React form with catalog references loaded.
- Create Dispatch button activated with approved test data.
- One dispatch/trip persisted and linked to QA Driver and truck.
- Reserve Inventory button writes reservation, then Start authorizes trip.
- Final DB trip status START_AUTHORIZED.
- No browser Runtime.exceptionThrown errors after fixing isolated Vite
  websocket HMR collision.
- QA screenshot: qa/phase4i/screenshots/staging-dispatch-execution-uat.png
- All identities, quantities and evidence supplied in the browser script
  are labelled SYNTHETIC UAT, never real authorized production records.

Test suite: 175/175 PASS. Build: PASS (Node 22).
Real temporary local PostgreSQL 14 Phase4G rehearsal: PASS.
git diff --check: PASS.

Actual default local legacy DB unchanged:
- revision 5, requests 2, dispatches 1, trips 3.
- TR-00001 LAND Requested, TR-00002 MARINE Planned,
  DSP-00001, RIT-00001 .. RIT-00003 preserved.

## What remains blocked

- The default localhost 4196 runs the legacy handler unless explicitly
  configured with AIMOC_STAGING_DATABASE_URL pointing to an approved,
  LOCAL, separate execution staging DB. New execution controls truthfully
  show STAGING NOT READY without it.
- Existing MARINE legacy RITs are NOT registered as execution staging trips,
  and cannot be assigned to verified Drivers without approved crosswalk
  and verified source inventory/truck/Driver identities.
- No real authoritative identity roster, opening inventory evidence,
  real WIM hardware event or road network has been obtained.
- Frontend Stage Dispatch permits one explicit trip per transaction in this
  scope, not automatic heterogeneous multi-ritase planning.
- LAND legacy requests remain m3 and are NOT auto-linked to normalized
  tonnes execution. No unsupported density conversion.
- Actual site acceptance and production cutover remain NO-GO.
- No production migration, deployment, Git commit, or push performed.

## Reproduce isolated browser proof

From repo root on local Mac:
  node scripts/phase4i-browser-uat.mjs

The script creates in-memory QA-only databases, performs a browser-based
Admin staging dispatch, then closes/deletes all temporary state.
