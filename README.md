# AIMOC Gandasari Alfa Granitama — Operations

A separate operational UAT application, not the WIM traffic simulator. Changes are authenticated, stored in PostgreSQL and shared across operator sessions. Initial equipment, stock quantities, payload limits and vessel names are editable example data, not records from the quarry.

Production URL: https://aimoc-alfa-granitama.vercel.app

Source repository: https://github.com/Riko-RPJ/aimoc-alfa-granitama

## Interface languages

Indonesian and English are available through the ID/EN controls on login, the dashboard header and modal headers. The browser remembers the selection under `aimoc.alfa.language`. Numbers and dates follow the selected locale. Switching languages preserves authentication, selected records and unsaved form drafts; it does not write operational data. Source-based UI translations are in `src/locales/en.json` and `src/i18n.js`. SKU names, codes, company names and operator-entered content remain unchanged. Structured audit events and known validation messages have localized display labels; their stored source records are preserved.

## Roles and operating sequence

Admin maintains SKU size/density, crushers, at most six active SKU assignments per crusher, stockpile codes, truck bed/payload/cycle time, jetties, vessels and accounts. Stockpile operators see assigned crushers; jetty operators work on assigned jetties. Fleet occupancy and source stock availability needed for requesting transfers are shared.

1. Jetty operator requests one or more SKU quantities in m³ or tonnes against a specific jetty, vessel and destination.
2. Admin creates a dispatch plan. The transaction reserves available stock across crusher stockpiles and safe vessel payload. It generates truck loads within both bed volume and payload limits. When fleet capacity is insufficient, the same truck receives serial queued loads rather than simultaneous assignments.
3. Stockpile operator starts the eligible queued load and confirms departure. Physical stock decreases at departure and transit increases. Planned quantity is explicit unless actual matching tare/gross is entered; no real weighbridge telemetry is connected.
4. Jetty operator confirms arrival, then actual unload. Arrival alone does not increase vessel cargo. Unload releases vessel reservation, records received quantity and completes delivery of that trip. Ship limits include outstanding reservations from every dispatch.
5. Empty return is confirmed before another job can start on that truck. ETA uses configured cycle time, not real GPS tracking.
6. The dashboard refreshes every three seconds while visible; mutations return updated state immediately. Source disconnect and login expiry are shown. There are no autonomous fake movements or generated production counters.

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

Use Node.js 22. The `.env.example` file is a configuration reference with no credentials. Configure the server environment directly, or pass a local environment file with Node's `--env-file` option when running a script. To initialize a separately configured PostgreSQL database, run `npm run db:setup`; generated account credentials are written only to ignored `.local/access.json`. The public repository contains application source, synthetic seed data, tests and public brand assets. It does not include the live database, uploaded operator evidence, passwords, sessions or Vercel project credentials.

Official Gandasari and Alfa logos/photo sources are documented in `BRAND-SOURCES.json`; AIMOC comes from the user's approved existing artwork. No Decom logo is included. Company photos are illustrative, not live camera feeds.
