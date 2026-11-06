-- Phase 4D transaction hardening: explicit operational HOLD and recovery.
-- Staging ONLY, never included in default startup.
ALTER TABLE aimoc_execution_v1.trips ADD COLUMN IF NOT EXISTS pre_hold_status text;
ALTER TABLE aimoc_execution_v1.trips ADD COLUMN IF NOT EXISTS hold_reason text;
CREATE TABLE IF NOT EXISTS aimoc_execution_v1.trip_holds (
 id text PRIMARY KEY,
 trip_id text NOT NULL REFERENCES aimoc_execution_v1.trips(id),
 opened_by text NOT NULL,
 reason text NOT NULL,
 previous_status text NOT NULL,
 opened_at timestamptz NOT NULL DEFAULT now(),
 resolved_at timestamptz,
 resolved_by text,
 resolution_note text,
 CHECK ((resolved_at IS NULL AND resolved_by IS NULL)
   OR (resolved_at IS NOT NULL AND resolved_by IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS trip_single_active_hold
 ON aimoc_execution_v1.trip_holds(trip_id) WHERE resolved_at IS NULL;


-- Physical voyage capacity is shared across separate dispatch sequence gates.
CREATE TABLE IF NOT EXISTS aimoc_execution_v1.voyage_capacity (
 voyage_id text PRIMARY KEY,
 capacity_t numeric(18,6) NOT NULL CHECK(capacity_t>0),
 reserved_t numeric(18,6) NOT NULL DEFAULT 0 CHECK(reserved_t>=0 AND reserved_t<=capacity_t),
 status text NOT NULL CHECK(status IN ('PLANNED','READY','ON_HOLD','CLOSED'))
);
CREATE TABLE IF NOT EXISTS aimoc_execution_v1.jetty_windows (
 id text PRIMARY KEY,
 voyage_id text NOT NULL REFERENCES aimoc_execution_v1.voyage_capacity(voyage_id),
 jetty_id text NOT NULL,
 starts_at timestamptz NOT NULL,
 ends_at timestamptz NOT NULL,
 status text NOT NULL CHECK(status IN ('PLANNED','READY','ON_HOLD','CLOSED')),
 CHECK(ends_at>starts_at)
);
ALTER TABLE aimoc_execution_v1.dispatches ADD COLUMN IF NOT EXISTS jetty_window_id text REFERENCES aimoc_execution_v1.jetty_windows(id);
CREATE TABLE IF NOT EXISTS aimoc_execution_v1.voyage_dispatch_allocations (
 dispatch_id text PRIMARY KEY REFERENCES aimoc_execution_v1.dispatches(id),
 voyage_id text NOT NULL REFERENCES aimoc_execution_v1.voyage_capacity(voyage_id),
 allocated_t numeric(18,6) NOT NULL CHECK(allocated_t>0),
 allocated_at timestamptz NOT NULL DEFAULT now()
);
