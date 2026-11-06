# AIMOC — Start-to-Finish Cross-Role UAT Verification

Date: 2026-11-06 (Asia/Jakarta)
Branch: refactor/phase1-design-system-extraction
Evidence class: SYNTHETIC_UAT / NOT_PRODUCTION_VERIFIED
Decision: UAT software checks PASS; production and verified device evidence NO-GO.

## Executed checks

- `node --test --test-concurrency=1 tests/cross-role-uat-http.test.mjs tests/cross-role-uat-persistence.test.mjs tests/v1-phase4g-http-cross-role.test.mjs tests/v1-phase4h-cross-role-transaction-http.test.mjs tests/admin-access-enforcement.test.mjs`: PASS, 17/17. Real isolated HTTP with role-specific authorization and common IDs.
- `VITE_CROSS_ROLE_UAT=1 vite build --outDir .local/uat-web-dist`: PASS.
- `node qa/cross-role-uat/browser-smoke.mjs`: PASS. Admin-created dispatch visible in Stockpile 1, Stockpile 2 and Driver 1; all four role screens render, zero JS errors, zero viewport overflow.
- `npm run build`: PASS.
- `npm test`: PASS, 173/173, after synchronizing three obsolete test expectations to current contracts.
- `git diff --check`: PASS.

## Cross-role end-to-end software scenario

1. Admin creates and assigns dispatch; duplicate active truck or Driver is denied.
2. Assigned Driver sees own task; another Driver is blocked.
3. Automatic tare in isolated UAT requires simulated truck profile; QR and signed tare in Phase4H are synthetic vendor-event fixtures.
4. Only authorized source Stockpile accepts loading and departure; source and destination scopes are checked.
5. Admin monitoring, Stockpile pickup and Driver task share one dispatch-trip-assignment identity.
6. Gross event / payload checks and source inventory departure: Phase4H verifies 100 t opening, 40 t reserve and 60 t on-hand after 40 t departure in isolated staging (no production ledger).
7. Destination Stockpile records arrival and receipt within Cross-Role UAT simulator; Driver cannot self-verify receiving.
8. Driver reports return; independently scoped operator verifies return; status RETURNED_AVAILABLE.
9. Event timeline preserves source and actor role; data persists after UAT DB reopen.
10. Normal app on port 4196 was not stopped or mutated for this automated test.

## Differences between test environments

- Normal 4196 is **legacy** UI and source data. Its role/permission matrix is enforced, but it does not run the same UAT transactions as port 4296.
- Opt-in 4296 is the shared **UAT_SIMULATED** role workspace and separate data store.
- Phase4G/4H staging domain tests validate source reservation, identity, WIM fixture and departure through v1 staging API, NOT production physical readings.
- The complete shared UAT simulation from creation through receiving and return is tested via its own API; browser smoke validates role navigation and the shared Admin-created assignment, not every click of the entire receiving/return flow.
- No production GPS, Weighbridge hardware, measured inventory proof, official Driver IdP or real ERP acceptance.

## Regression updates made during this verification

- `tests/api.test.mjs`: an actively queued job keeps the truck BUSY even if the preceding trip returned.
- `tests/v1-api.test.mjs`: legacy transfer requests explicitly default to MARINE rather than unknown/null.
- `tests/v1-phase4e-strict-integration.test.mjs`: when Phase4G tables are deliberately absent, Driver detail must fail closed with NOT_INTEGRATED; Phase4G/4H tests cover successful Driver detail when assignment is provisioned.

## Manual UAT walkthrough

Do not open normal 4196 and dev:uat simultaneously with the shared local PGlite identity database. Stop npm run dev first.

Run `npm run dev:uat` and visit http://127.0.0.1:4296.

Use local credentials from .local/access.json and .local/driver-access.json (do not publish passwords):
- admin: create dispatch crusher-1 to crusher-2, UAT-TRUCK-01, driver1, 40.000000 simulated t; authorize.
- driver1: accept assignment, submit checklist.
- Stockpile stock1: loading after synthetic automatic tare is received.
- admin: software simulated gross 52 t for 12 t synthetic tare.
- stock1: depart.
- stock2: arrival and UAT receiving.
- driver1: return start.
- stock1: independent return verified.
- admin: monitor RETURNED_AVAILABLE and event timeline.

Port 4296 is **not currently started** by these automated checks; port 4196 was listening during inspection and intentionally left running.

## Production acceptance decision

Cross-role UAT software PASS. All real field evidence, signed vendor acceptance, real inventories and final DTO production cutover still NOT ACCEPTED.
