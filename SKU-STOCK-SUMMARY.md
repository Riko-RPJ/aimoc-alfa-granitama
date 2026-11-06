# SKU inventory totals in transfer requests

Create transfer request shows the selected SKU's recorded physical stock,
reservations, unreserved stock and dispatch-eligible source stock separately
from the requested load. Totals come from the server, including for Jetty
users whose raw stockpile rows are deliberately restricted.

`GET /api/v1/demo/sku-stock?transferMode=MARINE` returns a read-only projection
with `items`, `revision`, `updatedAt` and `serverTime`. An Admin may request
`transferMode=LAND&destinationCrusherId=<active receiving area>`; LAND without
a selected destination still returns physical totals and marks source
eligibility `DESTINATION_REQUIRED`. Stock and Driver roles cannot access this
global projection. Jetty users need an assigned active jetty and may request
MARINE totals only.

For a matching SKU:

- Physical m³ = sum of recorded `onHandM3` across its stockpiles.
- Physical tonnes = total physical m³ × the SKU master's `densityTPerM3`.
- Reserved tonnes = summed reserved m³ × the same density.
- Unreserved tonnes = (physical m³ − reserved m³) × density.
- Dispatchable tonnes include active SKU/crusher/stockpile sources only,
  after reservations, and exclude the receiving crusher for LAND.

Inactive stock with a remaining balance is still physical inventory; it does
not become eligible for dispatch. Calculations use fixed-point quantities and
round tonnes only after summation. Example: 100 + 50 m³ at 1.5 t/m³ gives
225 t physical stock; 10 + 20 m³ reserved gives 45 t reserved and 180 t free.
Unrelated SKUs are never included.

Tonnes here are a density conversion of recorded inventory volume, not new
scale or camera evidence. Invalid density, ambiguous identities or malformed
balances produce explicit unavailable/warning states, never fabricated zero.
A known SKU with no stock legitimately displays zero. Changing requested
quantity does not change inventory totals.

The form refreshes its projection when shared operation revisions change and
when mode or LAND receiving area changes. Older in-flight responses are
aborted/ignored. Loading, stale, error and retry are visible in ID and EN.
This endpoint does not reserve stock or change transfer-request policy;
dispatch planning still validates the latest actual availability atomically.
The Vercel entry adapter preserves query parameters so LAND exclusions work
the same way as local HTTP tests.
