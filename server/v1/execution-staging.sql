-- AIMOC Phase 4: isolated V1 execution staging schema.
-- This file is NEVER imported by server/database.mjs, server/schema.sql,
-- scripts/local.mjs, or production startup. Apply only to an authorized staging DB.
CREATE SCHEMA IF NOT EXISTS aimoc_execution_v1;

CREATE TABLE IF NOT EXISTS aimoc_execution_v1.dispatches (
  id text PRIMARY KEY,
  mode text NOT NULL CHECK (mode IN ('MARINE','LAND')),
  status text NOT NULL CHECK (status IN ('PLANNED','READY','ACTIVE','ON_HOLD','DELIVERY_COMPLETED','CLOSED','CANCELLED')),
  voyage_id text,
  source_stockpile_id text NOT NULL,
  sku_id text NOT NULL,
  planned_quantity_t numeric(18,6) NOT NULL CHECK (planned_quantity_t>0),
  CHECK ((mode='MARINE' AND voyage_id IS NOT NULL) OR (mode='LAND' AND voyage_id IS NULL))
);
CREATE TABLE IF NOT EXISTS aimoc_execution_v1.trips (
  id text PRIMARY KEY,
  dispatch_id text NOT NULL REFERENCES aimoc_execution_v1.dispatches(id),
  sequence_no integer NOT NULL CHECK (sequence_no>0),
  status text NOT NULL CHECK (status IN ('QUEUED','START_AUTHORIZED','TARE_CONFIRMED','LOADING','GROSS_CONFIRMED','IN_TRANSIT','ARRIVED','UNLOADED_VERIFIED','RETURNING','RETURNED_AVAILABLE','ON_HOLD','CANCELLED')),
  truck_id text NOT NULL,
  driver_id text NOT NULL,
  planned_quantity_t numeric(18,6) NOT NULL CHECK (planned_quantity_t>0),
  started_at timestamptz,
  unloaded_verified_at timestamptz,
  returned_available_at timestamptz,
  UNIQUE(dispatch_id,sequence_no),
  UNIQUE(dispatch_id,id)
);
CREATE TABLE IF NOT EXISTS aimoc_execution_v1.marine_gates (
  dispatch_id text PRIMARY KEY REFERENCES aimoc_execution_v1.dispatches(id),
  active_trip_id text,
  last_released_sequence_no integer NOT NULL DEFAULT 0 CHECK (last_released_sequence_no>=0),
  version bigint NOT NULL DEFAULT 0,
  FOREIGN KEY(dispatch_id,active_trip_id)
    REFERENCES aimoc_execution_v1.trips(dispatch_id,id)
);
CREATE UNIQUE INDEX IF NOT EXISTS execution_gate_active_trip_unique
  ON aimoc_execution_v1.marine_gates(active_trip_id) WHERE active_trip_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS aimoc_execution_v1.inventory_reservations (
  id text PRIMARY KEY,
  dispatch_id text NOT NULL REFERENCES aimoc_execution_v1.dispatches(id),
  source_stockpile_id text NOT NULL,
  sku_id text NOT NULL,
  reserved_t numeric(18,6) NOT NULL CHECK (reserved_t>0),
  status text NOT NULL CHECK (status IN ('ACTIVE','CONSUMED','RELEASED'))
);
CREATE TABLE IF NOT EXISTS aimoc_execution_v1.resource_claims (
  id text PRIMARY KEY,
  trip_id text NOT NULL UNIQUE REFERENCES aimoc_execution_v1.trips(id),
  truck_id text NOT NULL,
  driver_id text NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  CHECK (released_at IS NULL OR released_at>=claimed_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS execution_one_active_truck
  ON aimoc_execution_v1.resource_claims(truck_id) WHERE released_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS execution_one_active_driver
  ON aimoc_execution_v1.resource_claims(driver_id) WHERE released_at IS NULL;
CREATE TABLE IF NOT EXISTS aimoc_execution_v1.receipts (
  id text PRIMARY KEY,
  trip_id text NOT NULL REFERENCES aimoc_execution_v1.trips(id),
  status text NOT NULL CHECK (status IN ('PENDING','VERIFIED','DISPUTED','REVERSED')),
  receiving_actor_id text NOT NULL,
  verified_at timestamptz,
  source_event_id text NOT NULL UNIQUE,
  CHECK (status<>'VERIFIED' OR verified_at IS NOT NULL)
);
CREATE TABLE IF NOT EXISTS aimoc_execution_v1.unload_settlements (
  id text PRIMARY KEY,
  trip_id text NOT NULL UNIQUE REFERENCES aimoc_execution_v1.trips(id),
  receipt_id text NOT NULL REFERENCES aimoc_execution_v1.receipts(id),
  status text NOT NULL CHECK (status IN ('PENDING','VERIFIED','DISPUTED')),
  verified_at timestamptz,
  authorized_actor_id text,
  CHECK (status<>'VERIFIED' OR (verified_at IS NOT NULL AND authorized_actor_id IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS aimoc_execution_v1.return_verifications (
  id text PRIMARY KEY,
  trip_id text NOT NULL UNIQUE REFERENCES aimoc_execution_v1.trips(id),
  verified_at timestamptz NOT NULL,
  authorized_actor_id text NOT NULL,
  vehicle_ready boolean NOT NULL,
  source_event_id text NOT NULL UNIQUE
);
-- Dedicated lock row guarantees concurrent retries on the SAME key serialize
-- before the receipt lookup, on real multi-client PostgreSQL as well as PGlite.
CREATE TABLE IF NOT EXISTS aimoc_execution_v1.idempotency_locks (
  actor_id text NOT NULL,
  idempotency_key text NOT NULL,
  PRIMARY KEY(actor_id,idempotency_key)
);
CREATE TABLE IF NOT EXISTS aimoc_execution_v1.command_receipts (
  actor_id text NOT NULL,
  idempotency_key text NOT NULL,
  command_hash text NOT NULL,
  result jsonb NOT NULL,
  PRIMARY KEY(actor_id,idempotency_key)
);
CREATE TABLE IF NOT EXISTS aimoc_execution_v1.operational_events (
  id text PRIMARY KEY,
  trip_id text NOT NULL REFERENCES aimoc_execution_v1.trips(id),
  event_type text NOT NULL,
  actor_id text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb
);
