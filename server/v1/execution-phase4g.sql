-- Phase 4G: unified operational reference contract. STAGING-ONLY extension.
-- Apply explicitly AFTER Phase4B, do not run from legacy or production startup.
-- Locations in this schema are independently provisioned REFERENCES, not an
-- implicit mirror of legacy location drafts or synthetic production GPS.
CREATE TABLE IF NOT EXISTS aimoc_execution_v1.crusher_location_refs (
 crusher_id text PRIMARY KEY,
 crusher_name text NOT NULL,
 source_stockpile_id text NOT NULL,
 zone text,
 status text NOT NULL CHECK(status IN ('DRAFT','ACTIVE','SUSPENDED')),
 UNIQUE(crusher_id,source_stockpile_id)
);
CREATE TABLE IF NOT EXISTS aimoc_execution_v1.loading_point_refs (
 loading_point_id text PRIMARY KEY,
 crusher_id text NOT NULL REFERENCES aimoc_execution_v1.crusher_location_refs(crusher_id),
 loading_point_name text NOT NULL,
 latitude double precision,
 longitude double precision,
 verification_status text NOT NULL CHECK(verification_status IN ('UNVERIFIED','PENDING_REVIEW','VERIFIED','SUSPENDED')),
 verification_evidence_ref text,
 verified_by text,
 verified_at timestamptz,
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 CHECK ((latitude IS NULL AND longitude IS NULL) OR
        (latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180)),
 CHECK ((latitude IS NULL)=(longitude IS NULL)),
 CHECK (verification_status<>'VERIFIED' OR
  (latitude IS NOT NULL AND longitude IS NOT NULL AND
   verification_evidence_ref IS NOT NULL AND verified_by IS NOT NULL AND verified_at IS NOT NULL)),
 UNIQUE(loading_point_id,crusher_id)
);
CREATE TABLE IF NOT EXISTS aimoc_execution_v1.dispatch_loading_assignments (
 dispatch_id text PRIMARY KEY REFERENCES aimoc_execution_v1.dispatches(id),
 crusher_id text NOT NULL,
 loading_point_id text NOT NULL,
 source_stockpile_id text NOT NULL,
 loading_point_version integer NOT NULL CHECK(loading_point_version>0),
 assigned_by text NOT NULL,
 assigned_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(crusher_id,source_stockpile_id)
  REFERENCES aimoc_execution_v1.crusher_location_refs(crusher_id,source_stockpile_id),
 FOREIGN KEY(loading_point_id,crusher_id)
  REFERENCES aimoc_execution_v1.loading_point_refs(loading_point_id,crusher_id)
);
CREATE TABLE IF NOT EXISTS aimoc_execution_v1.trip_driver_assignments (
 assignment_id text PRIMARY KEY,
 trip_id text NOT NULL UNIQUE REFERENCES aimoc_execution_v1.trips(id),
 driver_id text NOT NULL REFERENCES aimoc_execution_v1.driver_profiles(id),
 truck_id text NOT NULL REFERENCES aimoc_execution_v1.fleet_vehicle_specs(truck_id),
 assigned_by text NOT NULL,
 assigned_at timestamptz NOT NULL DEFAULT now(),
 status text NOT NULL CHECK(status IN ('ASSIGNED','REVOKED'))
);
-- Composite FKs also prevent direct SQL or a future service from pairing
-- the correct IDs to the WRONG dispatch, stockpile, driver or truck.
ALTER TABLE aimoc_execution_v1.dispatches ADD CONSTRAINT unified_dispatch_stockpile_pair
 UNIQUE(id,source_stockpile_id);
ALTER TABLE aimoc_execution_v1.trips ADD CONSTRAINT unified_trip_driver_truck_pair
 UNIQUE(id,driver_id,truck_id);
ALTER TABLE aimoc_execution_v1.dispatch_loading_assignments
 ADD CONSTRAINT unified_dispatch_source_fk FOREIGN KEY(dispatch_id,source_stockpile_id)
 REFERENCES aimoc_execution_v1.dispatches(id,source_stockpile_id);
ALTER TABLE aimoc_execution_v1.trip_driver_assignments
 ADD CONSTRAINT unified_trip_identity_fk FOREIGN KEY(trip_id,driver_id,truck_id)
 REFERENCES aimoc_execution_v1.trips(id,driver_id,truck_id)
 DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE aimoc_execution_v1.trips ADD CONSTRAINT unified_trip_driver_reference
 FOREIGN KEY(driver_id) REFERENCES aimoc_execution_v1.driver_profiles(id);
ALTER TABLE aimoc_execution_v1.trips ADD CONSTRAINT unified_trip_truck_reference
 FOREIGN KEY(truck_id) REFERENCES aimoc_execution_v1.fleet_vehicle_specs(truck_id);
ALTER TABLE aimoc_execution_v1.dispatches ADD CONSTRAINT unified_dispatch_inventory_source
 FOREIGN KEY(source_stockpile_id,sku_id)
 REFERENCES aimoc_execution_v1.inventory_accounts(location_id,sku_id);
ALTER TABLE aimoc_execution_v1.inventory_reservations ADD CONSTRAINT unified_reservation_inventory_source
 FOREIGN KEY(source_stockpile_id,sku_id)
 REFERENCES aimoc_execution_v1.inventory_accounts(location_id,sku_id);
