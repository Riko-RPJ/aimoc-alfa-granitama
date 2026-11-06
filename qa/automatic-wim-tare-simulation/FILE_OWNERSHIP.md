# Automatic WIM Tare Simulation — File Ownership Matrix

Status: binding for the implementation phase. Agents may read any relevant file but may edit only owned paths. All agents share one filesystem; ownership is exclusive, not advisory.

## Primary-only central files

Only the primary agent may edit these files:

```text
src/App.jsx
server/handler.mjs
package.json
package-lock.json
scripts/local.mjs
src/app/navigation.js
src/contracts/api-v1-candidate.js
qa/automatic-wim-tare-simulation/*
```

The primary agent is the sole integrator. Subagents must request a primary change instead of editing a central file.

## Exclusive workstream ownership

| Owner | Editable files | Read-only references | Required output |
|---|---|---|---|
| Subagent 1 — WIM Simulator | `server/uat-wim-tare-simulator.mjs` (new), `tests/automatic-wim-tare-simulator.test.mjs` (new) | `server/v1/phase4b-weighbridge.mjs`, `server/uat-cross-role.mjs`, shared contract revision 2 | Deterministic `SUCCESS`, `DELAYED`, `DUPLICATE`, `INVALID`, and `FAILURE` event/outcome generator; no HTTP/database wiring |
| Subagent 2 — Loading Calculation | `server/uat-wim-tare-calculation.mjs` (new), `tests/automatic-wim-tare-calculation.test.mjs` (new) | Phase 4B weight validation and shared contract revision 2 | Pure scaled-integer GVW/Tare/payload/remaining-plan capacity service with boundary tests |
| Subagent 3 — Backend Integration | `server/uat-cross-role.mjs`, `server/uat-cross-role-http.mjs`, `tests/cross-role-uat-http.test.mjs`, `tests/cross-role-uat-persistence.test.mjs` | Simulator/calculation exports, `server/handler.mjs`, staging handlers, shared contract revision 2 | Post-assignment automatic job, pending reconciliation, profile persistence, correlation/stale rejection, authorization, atomic audit, DTO, HTTP/persistence coverage |
| Subagent 4 — Frontend UI | `src/features/uat/CrossRoleUatPage.jsx`, `src/features/uat/cross-role-uat.css`, `tests/automatic-wim-tare-ui.test.mjs` (new), `qa/automatic-wim-tare-simulation/browser-smoke.mjs` (new) | Shared contract and backend DTO fixtures | Automatic-tare UI states, provenance labels, render/responsive checks |

## Protected read-only areas for all subagents

Unless reassigned in writing by the primary agent, subagents must not edit:

```text
server/v1/**
server/domain.mjs
server/database.mjs
server/schema.sql
src/features/pages/stockpile/**
src/layouts/DriverLayout.jsx
src/services/driver-workspace-adapter.js
tests/v1-*.test.mjs
tests/domain.test.mjs
tests/admin-*.test.mjs
tests/frontend-navigation.test.mjs
```

These areas are production-like/staging references or existing regression surfaces, not implementation targets for the isolated simulator.

## Execution waves

The session supports three subagents plus the primary agent, not four simultaneous subagents.

1. Primary freezes shared contract revision 2 and records file fingerprints.
2. Subagents 1, 2, and 3 run simultaneously. Subagent 3 may prepare imports against the frozen module interfaces and must tolerate the new modules appearing during the shared run.
3. Primary monitors ownership boundaries and does not edit owned files while agents run.
4. After all three agents finish, primary reviews diffs, performs any central-file wiring, resolves integration, and runs the complete verification suite.
5. Subagent 4 is not started in this phase.

## Collision protocol

Before editing, every subagent must:

1. Re-read this matrix and the shared contract completely.
2. Record `git status --short` and the checksum of each owned existing file.
3. Stop and notify the primary if an owned existing file changed after assignment.
4. Never stash, reset, checkout, clean, commit, or delete another agent’s work.
5. Never edit a file outside ownership, even for formatting or test convenience.

After editing, every subagent must report:

- Files changed.
- Tests run and exact result.
- Any requested primary-only integration change.
- Known limitation or contract deviation.

## Database and secret rules

- Tests use PGlite ephemeral/temp databases or the existing explicitly isolated UAT database.
- No production/legacy database migration or record mutation.
- No secrets, real credentials, `.local` contents, access files, signing keys, or environment values in source, fixtures, logs, reports, screenshots, or messages.
- No commit, push, deploy, package installation, or dependency change by subagents.
