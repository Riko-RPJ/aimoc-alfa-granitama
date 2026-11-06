# AIMOC — Crusher Location Master + Driver Read-only Map

Date: 2026-11-06
Branch: refactor/phase1-design-system-extraction
Status: LOCAL UAT READY / LIVE NAVIGATION NO-GO

## Implemented

1. Admin → Master Data → Crusher Locations: new tab with list and create/edit draft. Each loading point belongs to an active Crusher master identity.
2. Local-only separate database table aimoc_alfa_ops.crusher_loading_points, initialized only when scripts/local.mjs runs without DATABASE_URL. Existing operation JSON revision is not modified; production has no automatic schema migration.
3. Admin-only GET/POST /api/crusher-loading-points with user session, CSRF, same-origin, server-side crusher membership checks, lat/lon bounds, nullable coordinate pair validation and UNVERIFIED status on each save.
4. Driver Tasks has CrusherDestinationCard, which receives destination details from the assigned trip DTO only. Driver cannot choose or change destination.
5. In development-only UAT mode, an explicitly fake Crusher 02 UAT / Loading Point 02 UAT assignment and purely schematic read-only diagram are shown. No true map coordinates or road network is invented.
6. In STAGING with no assignment, the Driver page shows NOT_INTEGRATED. Assigned trips without valid destination show an informative location empty state.
7. Start Navigation stays disabled because neither real loading point GPS nor verified hauling-road geometry is available.

## Data contract

Master: crusher_id, zone, loading_point_id, loading_point_name, nullable latitude/longitude, access_notes, evidence_ref, verification_status, revision.
Trip target: crusher_destination with crusher_id, crusher_name, zone, loading_point { id,name }, nullable latitude/longitude, location_status, verification_source.
No implicit stockpile -> crusher location conversion. Future production assignment read DTO must explicitly bind verified versioned location.

## Validation

- tests/crusher-location-navigation.test.mjs: access control, data validation, persistence, no legacy revision changes, UAT assignment and no choice of destination.
- Chrome CDP: Admin /admin/master-data (Crusher Locations tab) and Driver /driver/tasks staging/UAT.
- Desktop 1440 and mobile 390/320: no horizontal overflow, no browser exceptions.
- Screenshots: qa/crusher-location/screenshots/ (local Mac; not production evidence).

## Open gates

Site engineering/HSE must verify GPS, loading stop, vehicle-access restrictions, actual internal road geometry and source approval. Production migration needs independent versioned verification, routing service fit for industrial roads, assignment-scoped Driver read API and on-site device UAT.

No live routing, geofence, directions, real GPS, frontend v1 migration, commit, push or Vercel deployment was performed.

## Review

Run npm run dev, then localhost:4196.
Admin: Master Data -> Crusher Locations.
Driver: Tasks -> Coba UAT (simulation), then Keluar UAT (authentic STAGING status).
Credentials remain in private .local files.
