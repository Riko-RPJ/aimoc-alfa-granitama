# AIMOC Local Execution Staging — Setup Evidence (2026-11-06)

## Scope
Local-only, explicitly isolated staging PostgreSQL. NOT production and
NOT an implicit import of existing legacy business transactions.

## Step 1 — Database
- PostgreSQL 14 listening on 127.0.0.1:5432.
- New DB name: aimoc_execution_staging_uat.
- Legacy remains embedded under .local/database, never migrated into staging.
- Staging connection settings in ignored .local/staging.env (0600).

## Step 2 — Schema
- Applied isolated base, phase 4B, phase 4D, phase 4G, phase 4E.
- Exactly 34 tables were confirmed in aimoc_execution_v1.
- No migrations to the legacy database or production.
- The schema includes driver identity approvals, inventory opening evidence,
  authoritative fleet refs, role gates and WIM inbox; no WIM source active.

## Step 3 — Localhost connection
- Normal server PID 93761 was gracefully shut down with SIGINT.
- Localhost:4196 restarted under server PID 95614 with the staging URL
  taken from .local/staging.env.
- Future explicit local startup: npm run dev:staging.
- No remote deployment or production cutover.

## Step 4 — UAT fixtures
- Source inventory account: crusher-1 / split-12 (SP-12).
- Opening = 100.000000 tonnes, clearly synthetic. Prepared by local UAT
  Stockpile account, independently approved by local UAT Admin account.
  Hash explicitly derives from UAT_SIMULATED_NOT_PHYSICAL_STOCK.
- 2 synthetic fleet vehicle refs: uat-truck-001 payload 45t,
  uat-truck-002 payload 40t. NOT the legacy DT-001/DT-002 records.
- uat-crusher-1 and uat-loading-1 created without real GPS coordinates;
  loading point is UNVERIFIED.
- Driver1 local login ID linked to staging profile named
  "UAT_SIMULATED · Driver 1". Credential authority is UAT_SIMULATED_IDP.
  It is ACTIVE for the isolated UAT test after separate mock roles
  uat-provisioner and uat-independent-reviewer processed the fixture.
  This does NOT verify real-world identity.
- Driver2 local login ID linked to profile UAT_SIMULATED · Driver 2,
  but remains PENDING and is intentionally excluded from assignable Driver.
- No WIM vendor source, secret, signed event, live TARE, live weight
  or vendor calibration was fabricated.

## Verified runtime checks
- GET planning-options via stagingV1 for an Admin actor returned
  source=V1_STAGING, data_status=READY.
- Inventory: 100t available, source crusher-1, SKU split-12.
- Eligible trucks: uat-truck-001 and uat-truck-002.
- Assignable Driver: "UAT_SIMULATED · Driver 1" only.
- requirements.operational_wim_connected = false.
- requirements.legacy_request_crosswalk_approved = false.
- HTTP GET /admin/dispatch/planning returned 200.
- Legacy database untouched: revision 5, 2 transfer requests,
  1 dispatch and 3 trips.
- This does not claim a validated physical site, production identities,
  authentic UAT WIM feed, or completion of any legacy->staging conversion.

## Next user-visible check
- Refresh http://localhost:4196/admin/dispatch/planning
- Under "Execute Dispatch · V1 Staging" select:
  LAND; inventory crusher-1 / split-12; uat-crusher-1;
  uat-loading-1; destination UAT ID (e.g. uat-destination-1);
  amount in tonnes <= 45; uat-truck-001; UAT_SIMULATED Driver 1.
- Create / Reserve / Authorize Start are live staging commands.
- Do NOT treat this dispatch as TR-00001 or DSP-00001 from legacy.
