# AIMOC Gandasari Alfa Granitama — Operations

A separate operational UAT application, not the WIM traffic simulator. Changes are authenticated, stored in PostgreSQL and shared across operator sessions. Initial equipment, stock quantities, payload limits and vessel names are editable example data, not records from the quarry.

Production URL: https://aimoc-alfa-granitama.vercel.app

Source repository: https://github.com/Riko-RPJ/aimoc-alfa-granitama

## Interface languages

Indonesian and English are available through the ID/EN controls on login, the dashboard header and modal headers. The browser remembers the selection under `aimoc.alfa.language`. Numbers and dates follow the selected locale. Switching languages preserves authentication, selected records and unsaved form drafts; it does not write operational data. Source-based UI translations are in `src/locales/en.json` and `src/i18n.js`. SKU names, codes, company names and operator-entered content remain unchanged. Structured audit events and known validation messages have localized display labels; their stored source records are preserved.

## Integrated demo and operating sequence

The default authenticated application now uses one shared `aimoc_alfa_ops.operation` document for requests, dispatches, Driver tasks, weigh events, inventory, receipt and return. Its authenticated HTTP endpoints are `GET /api/v1/demo/context` and `POST /api/v1/demo/actions`, mounted by the same handler used on Vercel. This is an **INTEGRATED_DEMO** workflow: QR scans and entered tare/gross are synthetic, not field-verified hardware events. They never grant normalized production verification or post to NetSuite.

Admin maintains SKU density/size, crushers (up to six active SKU assignments each), stockpiles, trucks, jetties, vessels and accounts. Create active Driver accounts through Admin → Master data → Accounts before planning. Stockpile operators have crusher scopes; jetty operators have jetty scopes. Drivers authenticate individually and see their own assignments. Shared fleet availability is computed globally, while transaction details are scoped.

1. Admin creates LAND or MARINE transfer requests with one or more SKU quantities in m³ or tonnes. The Description/destination dropdown requires an active **Master & users → Stockpile locations** entry supporting that mode. Admin manages its code, name, address, transport modes, status, and explicit LAND receiving inventory area. Jetty operators can request MARINE transfers for their assigned jetty/vessel. The server resolves the selected ID and snapshots it; free text cannot override it. LAND automatically uses that location's receiving-area mapping and requires matching-SKU stockpiles. Name edits preserve existing transaction snapshots; open work protects mapping/mode/status, and historical references prevent deletion.
2. Admin plans dispatches with truck/Driver pairs. Available source stock and safe vessel payload are reserved atomically. Repeated trips on one truck are queued, including across dispatches; one truck/Driver can have only one active trip.
3. Admin records an explicit simulated QR event. The assigned Driver starts the task; the source Stockpile operator records tare. QR/tare can arrive early and automatically reconcile once start is authorized. All three are required before loading.
4. The source operator confirms loading, enters gross and confirms departure. Both tare and gross are mandatory; net must match the reserved demo quantity and truck limits. Source on-hand decreases once, at departure. Variance requires reconciliation/replanning and cannot silently close an underfilled request.
5. The destination operator confirms arrival, then receipt/unload. LAND adds destination stock; MARINE adds vessel cargo and releases its reservation. Arrival alone has no inventory effect. Vessel capacity includes all outstanding reservations.
6. The Driver starts the empty return. The source operator verifies return before the next task may start. Delivery and dispatch/request completion are separate: the overall request closes after all quantities are received and every assigned trip has returned.
7. Screens refresh shared data every three seconds, with immediate mutation responses, revision checks and idempotent retry receipts. Simulated event IDs reject conflicting reuse; retry cannot duplicate ledger or ERP outbox entries. No autonomous truck motion is generated.

The full payload/state contract and current limitations are in [INTEGRATED-DEMO-CONTRACT.md](INTEGRATED-DEMO-CONTRACT.md). The legacy truck-code START/COMPLETE sidecar is not used by this workspace and cannot advance integrated trips. The normalized target V1 execution adapter remains a separate, field-verification-gated staging interface; the demo namespace does not replace its production cutover gates.

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
