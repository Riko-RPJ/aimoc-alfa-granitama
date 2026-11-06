# LAND/MARINE Transfer Request Alignment — Local UI + Legacy Request Contract

Date: 2026-11-06

## Completed
- Admin Create Transfer Request modal now offers LAND and MARINE.
- LAND: destination_id + destination name + 1–6 SKU lines and per-SKU source unit (m3 or t); no jetty/vessel required.
- MARINE: existing jetty + vessel + receiving destination, capacity check and marine planning remain unchanged.
- Both modes now persist transferMode explicitly. Requests without transferMode from historical records are interpreted as MARINE in display.
- LAND persists as REQUESTED in existing local operation document with planningStatus NOT_INTEGRATED and tonnageT / volumeM3 NULL. No automatic density conversion, inventory reservation, trips or dispatch are created.
- LAND legacy request.plan fails closed with LAND_DISPATCH_NOT_INTEGRATED.
- Request list and detail distinguish LAND vs MARINE and block the old marine-only planning button for LAND.
- LAND is Admin-only, destinationId is an explicit nonempty reference string; this is not proof that a production receiving-location master exists.
- Driver assignments, Marine Option B rules and backend v1 staging were not cut over.

## Verification
- 3 new targeted tests for LAND, MARINE compatibility and fail-closed planning.
- Full local regression 170/170 passed; build passed; git diff --check passed.
- No production migration or deployment performed.
- Existing uncommitted branch changes preserved.

## Remaining acceptance
- Final authoritative receiving location master and destination allocation DTO, real source proof, stable request_id->dispatch_id mapping and full LAND dispatch API cutover are still pending.
- Separate route/approval and return sequence for production LAND must be tested before activating Dispatch Planning.
