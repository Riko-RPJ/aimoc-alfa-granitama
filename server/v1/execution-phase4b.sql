-- Phase 4B schema extension, staging ONLY.
-- Must be applied after execution-staging.sql to ephemeral or explicitly approved staging database.
-- Never included in existing app startup migrations.
ALTER TABLE aimoc_execution_v1.dispatches ADD COLUMN IF NOT EXISTS destination_location_id text;
ALTER TABLE aimoc_execution_v1.trips ADD COLUMN IF NOT EXISTS tare_t numeric(18,6);
ALTER TABLE aimoc_execution_v1.trips ADD COLUMN IF NOT EXISTS gross_t numeric(18,6);
ALTER TABLE aimoc_execution_v1.trips ADD COLUMN IF NOT EXISTS actual_net_t numeric(18,6);
ALTER TABLE aimoc_execution_v1.trips ADD COLUMN IF NOT EXISTS qr_event_id text;
ALTER TABLE aimoc_execution_v1.trips ADD COLUMN IF NOT EXISTS departed_at timestamptz;
ALTER TABLE aimoc_execution_v1.trips ADD COLUMN IF NOT EXISTS arrived_at timestamptz;
ALTER TABLE aimoc_execution_v1.trips ADD COLUMN IF NOT EXISTS return_started_at timestamptz;
CREATE TABLE IF NOT EXISTS aimoc_execution_v1.weighbridge_sources (
 source_system text PRIMARY KEY,
 active boolean NOT NULL DEFAULT false,
 authorized_weighbridge_id text NOT NULL
);
CREATE TABLE IF NOT EXISTS aimoc_execution_v1.weighbridge_inbox (
 id text PRIMARY KEY,
 source_system text NOT NULL REFERENCES aimoc_execution_v1.weighbridge_sources(source_system),
 external_event_id text NOT NULL,
 event_type text NOT NULL CHECK(event_type IN ('QR_SCANNED','TARE_RECORDED','GROSS_RECORDED')),
 trip_id text NOT NULL REFERENCES aimoc_execution_v1.trips(id),
 truck_id text NOT NULL,
 weighbridge_id text NOT NULL,
 weight_t numeric(18,6),
 occurred_at timestamptz NOT NULL,
 authenticated_at timestamptz NOT NULL DEFAULT now(),
 payload_sha256 text NOT NULL,
 processing_status text NOT NULL CHECK(processing_status IN ('ACCEPTED','PENDING','REJECTED')),
 failure_code text,
 UNIQUE(source_system,external_event_id),
 CHECK ((event_type='QR_SCANNED' AND weight_t IS NULL) OR
        (event_type<>'QR_SCANNED' AND weight_t>=0))
);
CREATE INDEX IF NOT EXISTS wb_inbox_pending_idx ON aimoc_execution_v1.weighbridge_inbox(trip_id,processing_status,occurred_at);
CREATE TABLE IF NOT EXISTS aimoc_execution_v1.fleet_vehicle_specs (
 truck_id text PRIMARY KEY,
 payload_limit_t numeric(18,6) NOT NULL CHECK (payload_limit_t>0),
 active boolean NOT NULL DEFAULT true
);
CREATE TABLE IF NOT EXISTS aimoc_execution_v1.driver_profiles (
 id text PRIMARY KEY,
 external_user_id text NOT NULL UNIQUE,
 display_name text NOT NULL,
 active boolean NOT NULL DEFAULT true
);
CREATE TABLE IF NOT EXISTS aimoc_execution_v1.operator_permissions (
 actor_id text NOT NULL,
 location_id text NOT NULL,
 permission text NOT NULL CHECK(permission IN ('stockpile.loading.confirm','stockpile.departure.confirm','receiving.verify','return.verify')),
 PRIMARY KEY(actor_id,location_id,permission)
);
CREATE TABLE IF NOT EXISTS aimoc_execution_v1.driver_checklist_items (
 id text PRIMARY KEY,
 label text NOT NULL,
 stage text NOT NULL,
 active boolean NOT NULL DEFAULT true
);
CREATE TABLE IF NOT EXISTS aimoc_execution_v1.driver_checklist_reports (
 trip_id text NOT NULL REFERENCES aimoc_execution_v1.trips(id),
 item_id text NOT NULL REFERENCES aimoc_execution_v1.driver_checklist_items(id),
 driver_id text NOT NULL,
 status text NOT NULL CHECK(status IN ('DONE','ISSUE')),
 note text,
 reported_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(trip_id,item_id)
);
CREATE TABLE IF NOT EXISTS aimoc_execution_v1.inventory_accounts (
 location_id text NOT NULL,
 sku_id text NOT NULL,
 on_hand_t numeric(18,6) NOT NULL DEFAULT 0 CHECK (on_hand_t>=0),
 reserved_t numeric(18,6) NOT NULL DEFAULT 0 CHECK (reserved_t>=0 AND reserved_t<=on_hand_t),
 PRIMARY KEY(location_id,sku_id)
);
-- Per-trip reservation allocation, locked and consumed atomically on departure.
CREATE TABLE IF NOT EXISTS aimoc_execution_v1.trip_reservation_allocations (
 trip_id text PRIMARY KEY REFERENCES aimoc_execution_v1.trips(id),
 reservation_id text NOT NULL REFERENCES aimoc_execution_v1.inventory_reservations(id),
 reserved_t numeric(18,6) NOT NULL CHECK(reserved_t>0),
 consumed_t numeric(18,6) NOT NULL DEFAULT 0 CHECK(consumed_t>=0 AND consumed_t<=reserved_t)
);
CREATE TABLE IF NOT EXISTS aimoc_execution_v1.cargo_custody (
 trip_id text PRIMARY KEY REFERENCES aimoc_execution_v1.trips(id),
 source_location_id text NOT NULL,
 destination_location_id text NOT NULL,
 sku_id text NOT NULL,
 shipped_t numeric(18,6) NOT NULL CHECK(shipped_t>0),
 received_t numeric(18,6) NOT NULL DEFAULT 0 CHECK(received_t>=0 AND received_t<=shipped_t),
 status text NOT NULL CHECK(status IN ('IN_TRANSIT','ARRIVED','PARTIAL','RECEIVED','DISPUTED')),
 CHECK (source_location_id<>destination_location_id)
);
CREATE TABLE IF NOT EXISTS aimoc_execution_v1.inventory_journal (
 id text PRIMARY KEY,
 trip_id text NOT NULL REFERENCES aimoc_execution_v1.trips(id),
 location_id text NOT NULL,
 sku_id text NOT NULL,
 movement_type text NOT NULL CHECK(movement_type IN ('SOURCE_DEPARTURE','DESTINATION_RECEIPT','ADJUSTMENT_REVERSAL')),
 delta_on_hand_t numeric(18,6) NOT NULL,
 occurred_at timestamptz NOT NULL DEFAULT now(),
 reference_event_id text NOT NULL,
 UNIQUE(reference_event_id)
);
ALTER TABLE aimoc_execution_v1.receipts ADD COLUMN IF NOT EXISTS received_t numeric(18,6);
ALTER TABLE aimoc_execution_v1.receipts ADD COLUMN IF NOT EXISTS destination_location_id text;
ALTER TABLE aimoc_execution_v1.receipts ADD COLUMN IF NOT EXISTS discrepancy_resolution text;
-- Receipt quantity is actual custody received, not planned.
ALTER TABLE aimoc_execution_v1.receipts ADD CONSTRAINT receipt_nonnegative_quantity CHECK (received_t IS NULL OR received_t>=0);
CREATE TABLE IF NOT EXISTS aimoc_execution_v1.integration_outbox (
 id text PRIMARY KEY,
 aggregate_id text NOT NULL,
 event_type text NOT NULL,
 payload jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 published_at timestamptz
);
CREATE INDEX IF NOT EXISTS integration_outbox_pending_idx ON aimoc_execution_v1.integration_outbox(created_at) WHERE published_at IS NULL;
