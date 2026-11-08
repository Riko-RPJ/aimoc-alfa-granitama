# AIMOC Gandasari Alfa Granitama — Operations

A separate operational UAT application, not the WIM traffic simulator. Changes are authenticated, stored in PostgreSQL and shared across operator sessions. Initial equipment, stock quantities, payload limits and vessel names are editable example data, not records from the quarry.

Production URL: https://aimoc-alfa-granitama.vercel.app

Quarry Cilegon weighbridge demo: https://aimoc-quarry-cilegon.vercel.app

## Quarry Cilegon shared workflow

The Cilegon Vercel project uses this same source and the same existing database. Set the public build variable `VITE_APP_VARIANT=quarry-cilegon` for its operational interface. The original Alfa project retains its normal interface; `/quarry-cilegon` also opens the weighbridge workspace there. Accounts are unchanged, but each website has its own host-scoped login session. Visible workspaces refresh shared persisted data every three seconds.

Start as Admin in **Gate configuration**: select WIM + WIM, Static + WIM or Static + Static, set each of the two scales and the third QR-only lane to IN, OUT or BIDIRECTIONAL, then explicitly activate and save. Activation applies the Cilegon workflow to new MARINE requests from either app. Existing requests and historical trips keep their original workflow. Both scales may temporarily be IN or both OUT; scans requiring the unavailable direction must wait for a suitable configuration. Completed scans preserve their original lane/version snapshots.

For the demo: stock1/stock2 enters and Admin approves stock in Alfa; Admin creates a transfer request to a selected jetty/vessel and releases automatic dispatch; the assigned Driver receives a serial truck queue and a stable truck/dispatch QR. Source staff record first entry QR/tare, confirm loading, then record exit QR/gross. Jetty staff independently confirm arrival and unload. The source QR return verifies the empty truck's return and cannot manufacture a receipt. Subsequent trips of that same truck and dispatch may enter through lane 3 using the previously accepted tare only after the preceding trip has both a verified jetty receipt and return. The truck becomes available after its final serial return, unless another waiting dispatch claims it.

Weights are operator-entered demo readings, not field-verified IoT measurements. Net must equal the reserved trip quantity; under/overload is rejected atomically for reconciliation rather than silently changing inventory. Departure decreases source stock once; receipt loads the vessel once. Quarry NetSuite outbox intents carry immutable entry/exit gate versions, simulated weights and original tare provenance, and remain `awaiting_configuration`. There is no live device acknowledgement, physical lane-occupancy interlock, sandbox posting or GPS claim. `/quarry-engineering.html` preserves read-only 3D operations, civil/utilities, construction phases, camera controls, dimensions, canopy and PNG export; the dimensions are conceptual.

Focused checks: `node --test --test-concurrency=1 tests/quarry-cilegon.test.mjs tests/quarry-cilegon-http.test.mjs tests/quarry-cilegon-erp.test.mjs`.

Source repository: https://github.com/Riko-RPJ/aimoc-alfa-granitama

## Interface languages

Indonesian and English are available through the ID/EN controls on login, the dashboard header and modal headers. The browser remembers the selection under `aimoc.alfa.language`. Numbers and dates follow the selected locale. Switching languages preserves authentication, selected records and unsaved form drafts; it does not write operational data. Source-based UI translations are in `src/locales/en.json` and `src/i18n.js`. SKU names, codes, company names and operator-entered content remain unchanged. Structured audit events and known validation messages have localized display labels; their stored source records are preserved.

## Integrated demo and operating sequence

The default authenticated application now uses one shared `aimoc_alfa_ops.operation` document for requests, dispatches, Driver tasks, weigh events, inventory, receipt and return. Its authenticated HTTP endpoints are `GET /api/v1/demo/context` and `POST /api/v1/demo/actions`, mounted by the same handler used on Vercel. This is an **INTEGRATED_DEMO** workflow: QR scans and entered tare/gross are synthetic, not field-verified hardware events. They never grant normalized production verification or post to NetSuite.

Admin maintains SKU density/size, crushers (up to six active SKU assignments each), stockpiles, trucks, jetties, vessels and accounts. Active Driver accounts are required to execute assigned work; create them through Admin → Master data → Accounts. Stockpile operators have crusher scopes; jetty operators have jetty scopes. Drivers authenticate individually and see their own automatically allocated assignments. Shared fleet availability is computed globally, while transaction details are scoped.

1. Admin creates LAND or MARINE transfer requests with one or more SKU quantities in m³ or tonnes. The Description/destination dropdown requires an active **Master & users → Stockpile locations** entry supporting that mode. Admin supplies its name, address and transport modes; the server generates/protects the unique code and resolves the LAND receiving inventory area. Jetty operators can request MARINE transfers for their assigned jetty/vessel. The server resolves the selected ID and snapshots it; free text cannot override it. LAND uses matching-SKU receiving stockpiles. Name edits preserve existing transaction snapshots; open work protects mapping/mode/status, and historical references prevent deletion.
2. Admin clicks **Plan dispatch** once. There is no truck/Driver assignment form and no manual selection in the command. The server reserves available source SKU stock and safe vessel payload atomically, then automatically selects available trucks by effective bed/payload capacity and available active Drivers. Each pair can receive several serial queued trips within **one unfinished dispatch**, with no parallel execution or other open dispatch claim. Several trucks and dispatches can share one SKU stockpile while sufficient unreserved stock remains.
   Cargo is split to the actual truck's capacity and assigned to its serial queue immediately. Cargo stays `waiting_truck` only if no free pair or eligible same-dispatch pair exists. Planning still succeeds when resources are held by other dispatches. Fleet status changes from **Available → Allocated → Busy**, then back to **Allocated** while its queue remains, and **Available** after its own final return if no waiting dispatch takes it.
3. Admin records an explicit simulated QR event. The assigned Driver starts the task; the source Stockpile operator records tare. QR/tare can arrive early and automatically reconcile once start is authorized. All three are required before loading.
4. The source operator confirms loading, enters gross and confirms departure. Both tare and gross are mandatory; net must match the reserved demo quantity and truck limits. Source on-hand decreases once, at departure. Variance requires reconciliation/replanning and cannot silently close an underfilled request.
5. The destination operator confirms arrival, then receipt/unload. LAND adds destination stock; MARINE adds vessel cargo and releases its reservation. Arrival alone has no inventory effect. Vessel capacity includes all outstanding reservations.
6. The Driver starts the empty return. The source operator verifies return, unlocking that pair's next serial trip. After its own final assigned trip, the pair is released and the system can allocate eligible waiting cargo from another dispatch. Admin does not assign the returning truck again. Delivery and dispatch/request completion are separate: the overall request closes after all quantities are received and every assigned trip has returned.
7. Screens refresh shared data every three seconds, with immediate mutation responses, revision checks and idempotent retry receipts. Simulated event IDs reject conflicting reuse; retry cannot duplicate ledger or ERP outbox entries. No autonomous truck motion is generated.

The full payload/state contract and current limitations are in [INTEGRATED-DEMO-CONTRACT.md](INTEGRATED-DEMO-CONTRACT.md). The legacy truck-code START/COMPLETE sidecar is not used by this workspace and cannot advance integrated trips. The normalized target V1 execution adapter remains a separate, field-verification-gated staging interface; the demo namespace does not replace its production cutover gates.

For existing integrated demo queues, the offline `upgradeToAutomaticDispatch` helper preserves all execution evidence, historical assignment details, IDs, quantities and inventory/ERP balances. It detaches only unexecuted pre-booked tasks into the waiting queue and keeps any evidenced assignment occupied. Apply it only after a private backup, fresh fingerprint/revision review and isolated rehearsal inside a locked operation transaction. The application does not silently run this cutover at startup.

For an already upgraded automatic store, rehearse `allocateAutomaticDispatch` to expand eligible waiting cargo into same-dispatch serial assignments without detaching existing assigned rows. Verify cargo totals, recorded evidence, inventory/reservations and ERP journals against a fresh locked snapshot before applying this change.

## Stockpile measurement

Browser camera capture and JPEG/PNG upload store authenticated evidence up to 2 MiB per image in the separate application database. Camera access requires HTTPS and browser permission. Actual camera hardware is not supplied by this project.

An uncalibrated photo/video does not establish a metric 3D volume. Such evidence stays `needs_calibration`, has no volume and cannot change stock. Surveyed volume or a dimensioned geometric estimate (length × width × height × shape factor) remains pending until Admin approval. The geometric estimate is explicitly not AI photogrammetry. Approval preserves reservations and rejects evidence made stale by subsequent stock movement. Reliable automated camera volumetry requires a calibrated multi-view/depth/LiDAR pipeline, a surveyed base surface and field validation; that sensor integration remains to be commissioned.

## Persistence and integrity

The app uses its own PostgreSQL database `aimoc_alfa_granitama` on the existing Neon Free compute. It does not modify the previous weighbridge database or Brown Canyon. Authenticated actions use a locked state document, monotonic database revisions and per-user idempotency keys in one transaction. This is a bounded UAT implementation (2,000 trips/request, 20,000 trips overall), not a validated 250-ritase/hour production deployment. Production scaling should normalize the domain tables, benchmark peak concurrency, deploy the sensor ingestion/measurement services and implement retention/backup policies.

Passwords are scrypt hashes. Sessions use random database-backed tokens in HttpOnly/SameSite cookies (Secure on Vercel), 12-hour expiry, CSRF and origin checks. Login attempts are limited. Server credentials are never sent to the client. Evidence access follows its submitting user or visible measurement scope. UAT evidence storage is capped at 200 files/150 MB; records are not silently deleted.

## Oracle NetSuite

Departure, receipt and approved survey generate traceable outbox intents marked `awaiting_configuration`. There is no posting to NetSuite, inventory transaction ACK or claim of completed ERP integration. Sandbox credentials, approved location/item/unit mappings, account/cost decisions and reconciliation UAT are still required. Internal stock transfers must not be mapped as customer Sales Orders without the ERP team's approval.

## Local work

Run `npm ci --ignore-scripts`, `npm test`, `npm run dev`. Local preview listens on 127.0.0.1:4196 and uses a separate embedded PostgreSQL database in ignored `.local/database`. The local account file is `.local/access.json`; never commit or publish it. `npm run build` creates the Vite assets. `api/index.mjs` supplies the Vercel Node API. Cloud credentials live in Vercel environment configuration. User access instructions are delivered separately in a private local file, never in a public asset.

To opt the local preview into the existing v1 staging HTTP adapter, set `AIMOC_STAGING_DATABASE_URL` to a separate PostgreSQL database on this machine and run `npm run dev` without `DATABASE_URL`. The execution schema must already be provisioned in that isolated staging database; local startup does not run migrations or copy legacy trips. `AIMOC_STAGING_WIM_SOURCE` and `AIMOC_STAGING_WIM_SECRET` are optional and must be supplied together. Do not use production database or WIM credentials. Without this opt-in, normalized target V1 Driver operations remain `NOT_INTEGRATED`; the default authenticated `/api/v1/demo/*` workflow is available on the shared application database.

Use Node.js 22. The `.env.example` file is a configuration reference with no credentials. Configure the server environment directly, or pass a local environment file with Node's `--env-file` option when running a script. To initialize or migrate a separately configured PostgreSQL database, run `npm run db:setup` explicitly; setup adds the authenticated Driver role atomically and preserves existing records/accounts. Application startup on Vercel does not run this migration. Then create active Driver accounts via Admin → Master data → Accounts. Generated account credentials are written only to ignored `.local/access.json`. The public repository contains application source, synthetic seed data, tests and public brand assets. It does not include the live database, uploaded operator evidence, passwords, sessions or Vercel project credentials.

Official Gandasari and Alfa logos/photo sources are documented in `BRAND-SOURCES.json`; AIMOC comes from the user's approved existing artwork. No Decom logo is included. Company photos are illustrative, not live camera feeds.
