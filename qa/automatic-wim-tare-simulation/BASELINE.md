# Automatic WIM Tare Simulation — Preparation Baseline

Captured: 2026-11-06 (Asia/Jakarta)

## Repository

- Root: `/Users/gracia/Documents/Kerjaan/DFM/AIMOC WIM/Source code /aimoc-alfa-granitama`
- Branch: `refactor/phase1-design-system-extraction`
- HEAD: `adc06253c41ce26657ae58accfecb1e09f8a4414`
- Staged changes: none
- Tracked modified files: 7
- Untracked status entries: 46
- `git diff --check`: clean

## Protected backup

- Location: `/Users/gracia/Documents/Kerjaan/DFM/AIMOC WIM/Backups/aimoc-alfa-granitama-20261106-pre-wim`
- Size at capture: 7.2 MB
- Files copied: 210
- Directory permissions: `drwx------`, owner `gracia`
- Verification: checksum dry-run returned no differences.

The backup includes tracked modifications and untracked files present before this preparation document was created. It excludes `.git`, `node_modules`, `.local`, environment files other than `.env.example`, npm credentials, private keys/certificates, access files, and filename patterns indicating credentials or secrets. Two matching local sensitive files were deliberately left only at their original location; their names and contents were not recorded here.

## Baseline status

Tracked modified:

```text
package.json
scripts/local.mjs
server/domain.mjs
server/handler.mjs
src/App.jsx
src/styles.css
tests/domain.test.mjs
```

Untracked status entries as captured by Git (directories are recursive):

```text
qa/
scripts/generate-phase4e-openapi.mjs
scripts/local-driver-uat.mjs
scripts/local-uat.mjs
scripts/phase4d-rehearsal.sh
scripts/phase4e-rehearsal.sh
scripts/phase4f-evidence-audit.mjs
server/crusher-location-master.mjs
server/role-permissions.mjs
server/uat-cross-role-http.mjs
server/uat-cross-role.mjs
server/v1/
src/app/
src/components/
src/contracts/
src/domain/
src/features/
src/layouts/
src/services/
src/styles/
tests/admin-access-enforcement.test.mjs
tests/admin-final-workspace.test.mjs
tests/cross-role-uat-http.test.mjs
tests/cross-role-uat-persistence.test.mjs
tests/crusher-location-navigation.test.mjs
tests/driver-workspace-adapter.test.mjs
tests/driver-workspace-render.test.mjs
tests/frontend-navigation.test.mjs
tests/local-role-login-uat.test.mjs
tests/page-data-contracts.test.mjs
tests/v1-api.test.mjs
tests/v1-domain-policy.test.mjs
tests/v1-execution-staging.test.mjs
tests/v1-land-execution-staging.test.mjs
tests/v1-phase4b-integration.test.mjs
tests/v1-phase4b-safety.test.mjs
tests/v1-phase4c-http-uat.test.mjs
tests/v1-phase4c-migration-preflight.test.mjs
tests/v1-phase4d-cutover-gate.test.mjs
tests/v1-phase4d-hold.test.mjs
tests/v1-phase4d-voyage-capacity.test.mjs
tests/v1-phase4e-api-contract.test.mjs
tests/v1-phase4e-integrity-gates.test.mjs
tests/v1-phase4e-strict-integration.test.mjs
tests/v1-phase4f-source-acceptance.test.mjs
tests/v1-read-client.test.mjs
```

## Baseline verification

| Command | Result |
|---|---|
| `npm test` | PASS — 138 tests, 0 failures |
| `npm run build` | PASS — Vite transformed 1,709 modules |
| `git diff --check` | PASS |

Tests used their existing isolated/ephemeral UAT and staging stores. No production database command, commit, push, or deployment was performed.

## Baseline rule

This document describes the worktree before the three preparation documents in this directory were added. Future agents must compare the current file fingerprint/status against this baseline and stop if a file assigned to another owner changes unexpectedly.
