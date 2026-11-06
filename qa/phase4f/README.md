# Phase 4F: evidence source acceptance review

From the repository root:
node scripts/phase4f-evidence-audit.mjs
node --test tests/v1-phase4f-source-acceptance.test.mjs

Generated:
qa/phase4f/EVIDENCE_INTAKE_TEMPLATE.json
qa/phase4f/CONTRACT_ACCEPTANCE_AUDIT.json

Source intake must use external verified evidence references only.
Do not include passwords, device keys, unredacted driver IDs, API secrets
or other sensitive personal records in chat or source repository.
No automatic approval/final freeze is permitted from this manifest.

Actual inputs needed from operators:
- Inventory: location/SKU master, dated measured tonnage with method and
  independently signed opening/reconciliation evidence.
- Weighbridge: vendor protocol and redacted actual event captures,
  device identity/calibration, signing and offline/retry semantics.
- Driver: production identity provider and authorized driver registry,
  assignment and scope records with pseudonymized references.
- API: signed endpoint/field/nullable/role/exception matrix and UAT proof.
