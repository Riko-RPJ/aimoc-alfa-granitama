# End-to-end repair validation

Base reviewed: `1e2ce0fb54fa557716b4ef6db3e34d537e557f7a` on
`feature/aimoc-alfa-integrated-demo-20261106`.

## Five blocking paths repaired

| Blocker | Result |
| --- | --- |
| Default app could not execute the target workflow | Authenticated default UI calls `/api/v1/demo/*` through the normal local/Vercel handler. Requests and dispatch planning are accessible. The optional staging router delegates this namespace to the same handler. |
| Driver/QR progress was a separate sidecar | Admin, Stockpile, Jetty and Driver now share canonical request/dispatch/trip IDs and persisted state. Inventory, capacity, receipts and outbox advance on those same trips. Anonymous truck-code progress cannot advance them. |
| Valid early QR/tare could remain pending | Start, QR and tare automatically reconcile when prerequisites exist. Normalized staging also recovers early signed QR/tare/gross and retries without manual internal calls. |
| Repeat assignments prevented serial trips | Queued future work can reuse a truck/Driver, including across dispatches. Active occupancy remains exclusive until independently verified return. |
| Departure could rely on planned quantity without weighing | Integrated loading/departure requires QR, authorized Driver start, tare and gross with matching net and truck limits. The compatibility domain also rejects departure without tare/gross. |

Additional corrections cover request/dispatch closure, Driver deep-link reload,
global fleet occupancy with scoped details, preservation of measurement/master
features, and event-replay receipt retention beyond the legacy history window.
Normalized Marine Option B and production verification gates are preserved.

## Executed checks

- Complete regression run: `node --test --test-concurrency=2 tests/*.test.mjs`
  — **203 passed, zero failed** before the final event-history retention fix.
- After that final fix, reran all affected domain/API suites:
  `node --test --test-concurrency=2 tests/api.test.mjs tests/domain.test.mjs tests/integrated-demo-domain.test.mjs tests/integrated-demo-http.test.mjs`
  — **51 passed, zero failed**, including the new retention regression.
- Latest normalized V1 repair HTTP suite: **8 passed**, including staging
  delegation, early event recovery, serial reuse, verified quantities and closure.
- Existing-database Driver-role migration fixture passed; repeated migration
  preserves accounts, hashes and the operation document/revision.
- `npm run build` passed after final frontend changes: 1,716 modules; main JS
  338.20 kB / 104.52 kB gzip.
- Actual Chromium UI clicks in separate authenticated role contexts:
  **36 checks passed, zero page runtime errors**. MARINE 80 t used two serial
  trips; LAND 20 t completed receipt and return. Tested early QR/tare, correct
  gross-minus-tare, dispatch closure after all returns, Driver route refresh,
  queue blocking, measurement-modal access, Driver-account selector, English,
  anonymous login protection, and mobile 390 px without document overflow.
- HTTP assertions separately prove 80 t on one 40 t truck over two trips,
  multi-SKU LAND source/destination inventory deltas, concurrent planning,
  idempotent retries, scopes, old-route bypass rejection, vessel activation,
  capacity reservation and no duplicate ledger/outbox entries.
- Whitespace check passed. Changed files were checked for common credential
  patterns; no real environment files, local credentials, evidence databases,
  node_modules or build output are included in the patch.

All execution used local synthetic fixtures. Browser checking is functional
UAT, not a load test, production concurrency benchmark or field commissioning.
Screenshots and UI trace are retained in the local review workspace.

## Release boundary

This is an integrated **demo/UAT**. QR and weight events retain
`INTEGRATED_DEMO`/synthetic provenance; they do not become `FIELD_VERIFIED`.
Oracle NetSuite remains an `awaiting_configuration` outbox, not an ERP ACK.
No production database migration, main-branch merge, VPS change or production
deployment was performed during implementation. Follow
[INTEGRATED-ROLLOUT.md](INTEGRATED-ROLLOUT.md) before cutover, especially the
Driver-role migration and reconciliation of pre-existing open legacy work.
