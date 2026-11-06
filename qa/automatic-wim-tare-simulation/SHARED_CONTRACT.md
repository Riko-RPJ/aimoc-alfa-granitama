# Automatic WIM Tare Simulation — Shared Contract

Status: implementation contract for isolated UAT only

Production cutover: prohibited

Contract revision: `auto-tare-uat/2`

## 1. Business trigger and boundary

After Admin successfully saves a Dispatch with an assigned truck, the backend automatically creates and attempts delivery of a simulated WIM Tare event. Admin does not press another button and does not provide the tare value.

The assignment commit is authoritative. Simulation failure must not roll back a valid assignment. The assignment transaction writes a durable automatic-tare job; processing starts only after that transaction commits.

This feature extends only the isolated cross-role UAT store and `/api/uat/*`. It must not:

- write legacy `/api/action`, production inventory, ERP, or production databases;
- activate Phase 4B–4F schemas in normal startup;
- alter the signed M2M contract at `/api/v1/integrations/weighbridge/events`;
- claim simulated Tare is calibrated, signed, measured, or verified evidence.

Every simulated result remains `UAT_SIMULATED`, `weighbridgeVerified:false`, and `inventoryPosted:false`.

## 2. Ordering and pending reconciliation

Production-like ordering remains the safety reference:

```text
START_AUTHORIZED → QR → TARE → LOADING → GROSS → VERIFIED DEPARTURE
```

The existing isolated cross-role UAT state machine requires `DRIVER_ACCEPTED` before Tare and currently has no QR state. This implementation does not invent or bypass a QR event. The signed Phase 4B state machine remains unchanged and continues to require QR.

Automatic delivery may occur before UAT trip prerequisites are ready. In that case:

- trip workflow status remains unchanged (`ASSIGNED`, `START_AUTHORIZED`, or another legitimate state);
- `tareSimulation.status` is `TARE_PENDING`;
- the correlated event/job remains durable;
- reconciliation runs after prerequisite transitions and applies Tare only when trip status is `DRIVER_ACCEPTED`.

Valid UAT application transition:

```text
DRIVER_ACCEPTED + eligible correlated event
→ TARE_SIMULATED
```

Tare receipt must never jump directly from `ASSIGNED` or `START_AUTHORIZED` to `TARE_SIMULATED`.

## 3. Explicit UAT truck profile

Automatic Tare has no random or default value. The assigned truck must have an enabled UAT profile configured explicitly in the isolated UAT store.

| Field | Type | Rule |
|---|---|---|
| `truck_id` | string | Exact assigned `UAT-*` truck ID |
| `simulated_tare_t` | decimal string | Positive, maximum 6 decimals |
| `approved_gvw_t` | decimal string | Positive, maximum 6 decimals |
| `approved_payload_t` | decimal string | Positive, maximum 6 decimals |
| `revision` | positive integer | Correlated into job/event/result |
| `enabled` | boolean | Must be `true` |
| `scenario` | enum | `SUCCESS`, `DELAYED`, `DUPLICATE`, `INVALID`, or `FAILURE` |
| `delay_ms` | non-negative integer | Used only by `DELAYED`; bounded by backend policy |
| `authority` | constant | `UAT_SIMULATED_CONFIG` |

Profiles are synthetic UAT configuration, never production calibration/master evidence. No runtime profile is silently seeded by this contract. Tests insert explicit profiles into ephemeral fixtures. Interactive UAT remains `UAT_TARE_PROFILE_MISSING` until an explicitly approved synthetic profile set or separately reviewed Admin-only UAT provisioning path exists.

## 4. Assignment correlation and durable job

Assignment identity is immutable for one automatic-tare attempt:

```json
{
  "assignmentId": "uat-<uuid>",
  "assignmentRevision": 1,
  "tripId": "uat-<uuid>",
  "truckId": "UAT-TRUCK-01",
  "profileRevision": 3,
  "correlationId": "auto-tare:<tripId>:<assignmentRevision>"
}
```

Required invariants:

- The assignment row and automatic-tare job are inserted in the same transaction.
- A unique constraint covers `(trip_id, assignment_revision)` and `correlation_id`.
- Processing occurs after commit and may be retried.
- Reassignment increments `assignment_revision` and creates a new correlation.
- An event is stale when its truck ID or assignment revision no longer matches the locked trip.
- Stale events are rejected as `TARE_INVALID` with reason `STALE_ASSIGNMENT`; they never modify the trip.
- Duplicate event ID with identical correlation/payload replays safely; a conflicting duplicate is invalid.

## 5. Tare processing states

`tareSimulation.status` is orthogonal to the trip workflow status:

| Status | Meaning |
|---|---|
| `TARE_PENDING` | Job/event exists but is delayed or trip prerequisites are not ready |
| `TARE_RECEIVED` | Valid correlated Tare was applied and trip is now `TARE_SIMULATED` |
| `TARE_INVALID` | Profile/event/correlation is invalid or stale; no trip transition |
| `TARE_FAILED` | Delivery/processing failed; retry metadata retained |

`TARE_FAILED` may be retried only under the same correlation while the assignment remains current. A successful retry becomes `TARE_PENDING` or `TARE_RECEIVED`. `TARE_INVALID` requires corrected explicit configuration or reassignment; it is not silently retried with invented values.

## 6. WIM simulator module contract

The simulator is deterministic and side-effect free. Required interface:

```js
createAutomaticTareEvent({assignment,profile,attempt,requestedAt})
```

It returns one of:

```json
{
  "kind": "EVENT",
  "event": {
    "externalEventId": "<deterministic correlation event id>",
    "eventType": "TARE_RECORDED",
    "tripId": "uat-<uuid>",
    "truckId": "UAT-TRUCK-01",
    "assignmentRevision": 1,
    "profileRevision": 3,
    "weightT": "12.000000",
    "occurredAt": "2026-11-06T00:00:00.000Z",
    "source": "UAT_SIMULATED",
    "verified": false
  }
}
```

or a deterministic outcome describing `DELAYED`, `INVALID`, or `FAILURE` without side effects.

Scenario rules:

- `SUCCESS`: one valid event.
- `DELAYED`: no event before the explicit delay expires; same input later yields the same event identity.
- `DUPLICATE`: emits the same event identity/payload for duplicate-delivery testing.
- `INVALID`: emits a deterministic invalid outcome; it never substitutes a valid tare.
- `FAILURE`: emits a deterministic retryable failure outcome and no weight.

No random generator, browser input, environment secret, database, or production endpoint is allowed.

## 7. Loading capacity calculation contract

The calculation service is pure and uses scaled integers at exactly 6 decimal places.

Required interface:

```js
calculateLoadingCapacity({approvedGvwT,tareT,approvedPayloadT,remainingPlannedT})
```

Canonical result:

```json
{
  "gvwAvailableT": "48.000000",
  "loadingLimitT": "40.000000",
  "limitedBy": "REMAINING_PLANNED"
}
```

Formula:

```text
gvwAvailable = approvedGvw - tare
loadingLimit = min(gvwAvailable, approvedPayload, remainingPlanned)
```

Rules:

- `approvedGvwT`, `tareT`, and `approvedPayloadT` must be positive canonical decimal strings.
- `remainingPlannedT` may be zero but not negative.
- Missing capacity master or missing/invalid Tare is rejected.
- Tare greater than or equal to approved GVW is rejected.
- Exponent, locale formatting, non-finite values, negatives, and precision above 6 decimals are rejected.
- Output is a canonical six-decimal string with deterministic `limitedBy` tie-breaking: `GVW`, then `PAYLOAD`, then `REMAINING_PLANNED`.
- No floating-point arithmetic, density conversion, inventory mutation, or rounding beyond exact scaled-integer conversion.

## 8. Backend trigger and internal test action

Primary path:

1. Admin creates/saves assignment using existing authenticated `POST /api/uat/dispatches`.
2. Assignment and `TARE_PENDING` job commit atomically.
3. Post-commit processor attempts automatic event delivery.
4. If prerequisites are not ready, event/job stays `TARE_PENDING`.
5. After `start`/`accept`, reconciliation applies the pending event automatically when legal.

The internal action below may exist for deterministic tests/retry administration, but it is not the business trigger and must not be exposed as the primary UI control:

```text
POST /api/uat/trips/{tripId}/actions
{"action":"tare_auto"}
```

It uses the existing authenticated Admin session, same-origin check, CSRF token, JSON boundary, and `Idempotency-Key`. Client-supplied tare, truck, role, location, profile revision, assignment revision, or authority is rejected/ignored.

## 9. Idempotency and transactions

- Dispatch creation retains the existing per-actor command receipt.
- Automatic job uniqueness is independent of HTTP retries.
- Processing locks the job and trip before correlation/state checks.
- Same external event ID and same payload/correlation is a replay with no second transition/event.
- Same ID with a different payload/correlation becomes `TARE_INVALID`.
- One assignment revision can produce at most one applied Tare event.
- Failure never writes `simulated_tare_t`, changes trip workflow status, posts inventory, or claims verified evidence.
- Assignment success remains committed if post-commit simulation fails.
- Retry count, next-attempt time, last error code, and processing timestamps are persisted without secrets.

Request-level errors continue to use the existing UAT JSON error shape. Expected codes include:

| HTTP | Code | Condition |
|---|---|---|
| 400 | `IDEMPOTENCY_REQUIRED` | Missing/invalid command key |
| 403 | `ROLE_FORBIDDEN` | Unauthorized internal action |
| 404 | `TRIP_NOT_FOUND` | Trip unavailable to actor |
| 409 | `UAT_TARE_PROFILE_MISSING` | No enabled explicit profile |
| 409 | `INVALID_SEQUENCE` | Internal forced application before legal state |
| 409 | `IDEMPOTENCY_CONFLICT` | Command key reused differently |
| 409 | `STALE_ASSIGNMENT` | Event does not match current assignment |
| 422 | `UAT_TARE_PROFILE_INVALID` | Stored profile/capacity invalid |

## 10. Read DTO

Existing fields remain compatible. Add:

```json
{
  "status": "DRIVER_ACCEPTED",
  "simulatedTareT": null,
  "tareSimulation": {
    "status": "TARE_PENDING",
    "mode": "AUTOMATIC",
    "source": "UAT_SIMULATED",
    "correlationId": "auto-tare:<tripId>:1",
    "assignmentRevision": 1,
    "profileRevision": 3,
    "attempts": 1,
    "nextAttemptAt": null,
    "lastErrorCode": null,
    "completedAt": null,
    "verified": false
  },
  "loadingCapacity": null,
  "authority": "UAT_SIMULATED",
  "weighbridgeVerified": false,
  "inventoryPosted": false
}
```

After receipt, `simulatedTareT` is canonical, `tareSimulation.status` is `TARE_RECEIVED`, trip status is `TARE_SIMULATED`, and `loadingCapacity` contains the calculation result. Unknown values remain `null`, never zero.

## 11. Audit event contract

Automatic job creation:

```json
{"action":"TARE_AUTO_REQUESTED","source":"UAT_SIMULATED","payload":{"correlationId":"...","assignmentRevision":1,"verified":false}}
```

Pending, received, invalid, and failed outcomes use distinct actions:

```text
TARE_AUTO_PENDING
TARE_AUTO_RECEIVED
TARE_AUTO_INVALID
TARE_AUTO_FAILED
```

Event payload may include correlation, assignment/profile revision, scenario, canonical simulated tare, attempt, error code, and algorithm version. It must not include HMAC secrets, passwords, tokens, raw credentials, or claims of calibration/verification.

## 12. Required verification

- Assignment persists even when automatic processing fails.
- Exactly one durable job per assignment revision.
- Pending event cannot skip `START_AUTHORIZED` or `DRIVER_ACCEPTED`.
- Automatic reconciliation occurs after legal prerequisite transition without another Admin UI action.
- Delayed, duplicate, invalid, failure, retry, and stale reassignment scenarios.
- Exact scaled-integer capacity boundaries and deterministic ties.
- Authentication, CSRF, same-origin, role/scope, body limit, and HTTP idempotency.
- Legacy operation revision, production inventory, Phase 4B signed WIM path, Marine Option B, Driver, Admin, and Stockpile regressions remain unchanged.
- No source code or DTO contains real secrets or production evidence.

## 13. Explicit non-goals

- No production WIM/vendor integration or HMAC secret in browser/UAT DTO.
- No random/default Tare, automatic Gross, inventory/ERP posting, or production migration.
- No background infrastructure dependency; request-coupled post-commit processing and durable retry/reconciliation are sufficient for UAT.
- No Subagent 4/frontend implementation in this phase.
- No dependency installation, commit, push, or deployment.
