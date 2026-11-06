# AIMOC — Admin Simulasi Scan QR → Driver Truck Task List

Local acceptance 2026-11-06.

## Implemented
- Admin Dispatch Planning > Trip & Truck Allocation includes Simulasi Scan QR action per unclosed legacy ritase.
- Admin-only POST /api/uat/truck-qr validates authenticated session, same-origin, CSRF, existing trip and truck association; repeated scans are idempotent.
- Separate local-only SQL table aimoc_alfa_ops.truck_qr_uat_events stores a UAT event referencing trip_id + truck_id, actor_id and scanned_at.
- Driver POST /api/driver/truck-tasks returns only tasks whose trip_id+truck_id have a marker; before scan responds with awaitingQrCount.
- Driver screen shows Menunggu Scan QR before scan and refreshes in background every 15 seconds, as well as via manual refresh.
- No legacy state mutation; QR simulation DOES NOT start trips or create WIM/TARE data. No real scanner source claimed.
- Local server gated with AIMOC_LOCAL_TRUCK_CODE_UAT=1; production server remains off by default.

## Verified
- Isolated QR task endpoint test PASS including hidden tasks before marker, visible after marker and read-only protection.
- Full tests 177/177 PASS, npm run build PASS, git diff --check PASS.
- Local server 4196 reloaded and returns HTTP 200.
- Existing DT-001 is ALLOCATED; before clicking QR there are 0 visible trips and awaitingQrCount=1.
- Source Admin JSX from localhost contains Simulasi Scan QR.
- Legacy operation revision remains 5 and no QR UAT rows were inserted in the user's live local DB.
- Next operator action: Admin select RIT-00001 / DT-001 and click Simulasi Scan QR; DT-001 Driver screen will then show RIT-00001.

## Live device integration boundary
When an actual scanner is integrated, it must send an independently authenticated QR event for a valid truck+trip; the UAT-only Admin endpoint cannot be treated as physical verification. The production scanner adapter to this task visibility contract remains to be implemented.
