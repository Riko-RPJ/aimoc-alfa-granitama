# AIMOC Phase 4E — Integration & Acceptance Matrix

| Workstream | Code/staging test | Real evidence available | Production acceptance |
| --- | --- | --- | --- |
| Exact stock opening in tonnes | PASS (synthetic) | NO | NO-GO |
| Independent stock approval | PASS (role separation) | NO | NO-GO |
| Opening + journal account reconciliation | PASS (synthetic) | NO actual physical stock baseline | NO-GO |
| Driver identity binding and revocation | PASS (synthetic) | NO production IdP/driver registry | NO-GO |
| Driver trip read and start fail-closed | PASS | NO real assignments | NO-GO |
| Weighbridge signed event validation | PASS (synthetic) | NO vendor signing examples | NO-GO |
| Approved device protocol profile gate | PASS (synthetic) | NO vendor contract / key custody approval | NO-GO |
| API v1 candidate DTO generation | PASS | NO final cross-role sign-off | NO-GO |
| Marine Option B and inventory transaction engine | PASS in staging | NO production evidence | NO-GO |
| Real PostgreSQL Phase 4D concurrency and backup restore | PASS (disposable DB) | Not an actual production data rehearsal | NO-GO |
| Existing legacy UI preserved | YES | Local user can test | NOT MIGRATED |

## Required source package

Inventory: actual site stock opening report, stockpile IDs, SKU, quantity tonnes, measurement methods, date/time, signed authorizations, known m3 data mapping.

Driver: authoritative user IDs, truck-driver assignment sources, expected scope and employer lifecycle, permission review. Do not send passwords or personal ID scans in chat.

Weighbridge: protocol manual, redacted event JSON or payload captures, signed-event header specification, event correlation fields, device certificate/calibration metadata and sample error/retry flows. Do not send live HMAC secrets or private keys in chat.

API final: sign-off from operation owner, UI owner, integration owner, DBA/security team for schema and DTO, including mandatory/nullable semantics.

These requirements are blockers; missing real evidence cannot be replaced by seeded data or a unit-test success.
