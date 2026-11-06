# AIMOC Dispatch Fleet Allocation — 2026-11-06

## Scope and source
- Preserved the existing Transfer Request -> Dispatch allocation flow for MARINE.
- Restored the original Fleet Board in Admin Dispatch Planning (same reusable component as previous Dispatch page).
- Corrected backend fleet status projection to distinguish queued allocation from an executing trip.
- Queued does NOT mean actively moving, and it does NOT mean available/idle.
- UI Fleet Board filters: All, Idle, Allocated, In Operation.
- Removed staging-only independent Create Dispatch form from the primary operator path. Its isolated UAT controls remain collapsible and explicitly separate.
- LAND request dispatch remains gated; no verified tonne conversion or legacy/staging reconciliation was invented.

## Verified actual local legacy data
- Revision 5, requests 2, dispatches 1, trips 3.
- TR-00001 LAND Requested, TR-00002 MARINE Planned.
- DSP-00001 and RIT-00001..00003 associated with DT-001..003.
- Fleet: AVAILABLE 9, ALLOCATED 3, IN_OPERATION 0.
- No source data modifications.
- Live localhost:4196 restarted using npm run dev:staging; HTTP 200.

## Test evidence
- Domain status regression checks allocated -> busy -> available on real milestone transition.
- npm test: 176/176 PASS.
- npm run build: PASS.
- git diff --check: PASS.

## Deployment boundary
- Local repository and localhost ONLY.
- https://aimoc-alfa-granitama.vercel.app/ remains a separate deployment and data store.
- No push, migration of production data, or Vercel deploy.
- No claim of verified production Drivers, live WIM, or operational GPS.
