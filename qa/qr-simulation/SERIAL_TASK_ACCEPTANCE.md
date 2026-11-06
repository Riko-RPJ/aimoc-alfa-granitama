# AIMOC — Truck QR UAT Serial Task Execution
Date: 2026-11-06

## Goal
After one Admin simulated QR for a truck, show its entire allocated serial task queue. Driver enters truck code (no username/password) and may press Mulai on only the first incomplete task. Selesai releases the next task.

## Implemented
- server/truck-qr-uat.mjs: separate local-only `truck_task_uat_progress` table keyed by trip with IN_PROGRESS / COMPLETED and timestamps. Does not modify physical legacy operational state.
- server/handler.mjs: after any valid QR marker for that truck, reveal all open queued ritases in sequence order; expose backend-derived `uatCanStart`, `uatCanComplete`, `uatTaskStatus`. POST `/api/driver/truck-task-action` allows START and COMPLETE only in local UAT and serializes simultaneous actions under DB transaction lock on operational row. Rejects wrong truck, absent QR, later trip start, complete-before-start; supports idempotent replay.
- src/layouts/TruckCodeWorkspace.jsx: read-only truck-code entry, Mulai/Selesai UAT buttons on task cards, distinct labels and next-trip lock; polls updated data.
- src/features/pages/admin-final/AdminFinalPage.jsx: QR status for a truck applies to whole truck queue.
- UAT start/complete does not imply actual trip start, WIM/TARE, cargo transfer or production identity.

## Actual local validation
- 177/177 npm tests PASS.
- npm run build PASS and git diff --check PASS.
- Two-trip acceptance: QR unlocks both; second cannot start before first completes; wrong truck fails; repeated START/COMPLETE idempotent; completion unlocks next.
- Chrome browser at http://127.0.0.1:4196/driver: entered DT-001, saw RIT-00001, button 'Mulai', badge 'SIAP DIMULAI' (browser PASS).
- User data unchanged by QA: legacy revision 5; 1 QR UAT marker exists; 0 UAT task progress events before user initiates Mulai.
- QR remains simulated. Physical scanning not connected.
