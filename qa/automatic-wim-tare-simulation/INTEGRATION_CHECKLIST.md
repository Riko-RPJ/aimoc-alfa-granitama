# Automatic WIM Tare Simulation — Primary Integration Checklist

Contract: `auto-tare-uat/2`

Frozen contract SHA-256: `f8a39a8c40703214aa510740ea62a4647d82933d805af436eb296134de6684a6`

## Ownership and safety

- [ ] Each subagent changed only files assigned in `FILE_OWNERSHIP.md`.
- [ ] Primary-only central files were not changed by subagents.
- [ ] Existing user changes were not reset, stashed, deleted, or overwritten.
- [ ] No dependency, secret, credential, production DB, commit, push, or deployment change.
- [ ] `server/v1/**`, Marine Option B, production Stockpile, and Driver files remain untouched.

## Module contracts

- [ ] Simulator exports `createAutomaticTareEvent({assignment,profile,attempt,requestedAt})`.
- [ ] Simulator scenarios are deterministic: SUCCESS, DELAYED, DUPLICATE, INVALID, FAILURE.
- [ ] Simulator never generates random/default Tare or verified provenance.
- [ ] Calculation exports `calculateLoadingCapacity({approvedGvwT,tareT,approvedPayloadT,remainingPlannedT})`.
- [ ] Calculation uses exact six-decimal scaled integers and deterministic tie-breaking.
- [ ] Missing/invalid Tare and missing/invalid capacity are rejected.

## Backend behavior

- [ ] Assignment and automatic-tare job persist atomically.
- [ ] Processing starts only after assignment commit.
- [ ] Assignment remains committed when simulation processing fails.
- [ ] Early event remains orthogonal `TARE_PENDING`; trip state does not skip START/ACCEPT.
- [ ] Pending reconciliation applies automatically after `DRIVER_ACCEPTED` without an Admin UI action.
- [ ] Receipt results in `TARE_RECEIVED` and trip `TARE_SIMULATED` exactly once.
- [ ] INVALID and FAILED do not write Tare, move trip, or post inventory.
- [ ] Duplicate identical delivery replays; conflicting duplicate is invalid.
- [ ] Reassignment makes older correlation stale and unable to mutate the trip.
- [ ] Retry metadata contains no secret and respects current assignment correlation.
- [ ] Read DTO keeps unknown fields null and provenance explicitly simulated/unverified.

## Authorization and isolation

- [ ] Existing login, CSRF, same-origin, body limit, role, scope, and command idempotency remain enforced.
- [ ] Client-supplied role, truck, Tare, profile revision, or authority cannot override server data.
- [ ] UAT DB remains distinct from identity/legacy DB.
- [ ] Tare receipt does not change inventory ledger or physical stock.
- [ ] Legacy operation revision is unchanged in integration tests.

## Verification

- [ ] Simulator unit tests pass independently.
- [ ] Loading calculation unit/boundary tests pass independently.
- [ ] Cross-role HTTP and persistence tests pass.
- [ ] New combined automatic-trigger test proves no extra Admin action.
- [ ] `npm test` passes from baseline of 138 tests.
- [ ] `npm run build` passes.
- [ ] `git diff --check` and new-file whitespace checks pass.

## Frontend handoff gate

- [ ] DTO shape is stable and matches contract revision 2.
- [ ] Backend exposes WAITING/PENDING, RECEIVED, INVALID, FAILED without fabricated zeroes.
- [ ] Error/retry semantics are documented for UI.
- [ ] No blocker remains before Subagent 4 is started.
