-- Phase 4E integrity controls. Isolated staging only.
CREATE TABLE IF NOT EXISTS aimoc_execution_v1.inventory_opening_reconciliations (
 id text PRIMARY KEY,
 location_id text NOT NULL,
 sku_id text NOT NULL,
 measured_t numeric(18,6) NOT NULL CHECK(measured_t>=0),
 measurement_ref text NOT NULL UNIQUE,
 measured_at timestamptz NOT NULL,
 evidence_digest text NOT NULL CHECK(length(evidence_digest)=64),
 prepared_by text NOT NULL,
 prepared_at timestamptz NOT NULL DEFAULT now(),
 approved_by text,
 approved_at timestamptz,
 status text NOT NULL CHECK(status IN ('PENDING','APPROVED','REJECTED')),
 UNIQUE(location_id,sku_id),
 CHECK ((status='APPROVED' AND approved_by IS NOT NULL AND approved_at IS NOT NULL)
    OR (status<>'APPROVED' AND approved_at IS NULL))
);
CREATE TABLE IF NOT EXISTS aimoc_execution_v1.driver_identity_bindings (
 driver_id text PRIMARY KEY REFERENCES aimoc_execution_v1.driver_profiles(id),
 user_id text NOT NULL UNIQUE,
 credential_authority text NOT NULL,
 identity_evidence_ref text NOT NULL UNIQUE,
 provisioned_by text NOT NULL,
 verified_by text,
 verified_at timestamptz,
 status text NOT NULL CHECK(status IN ('PENDING','ACTIVE','REVOKED')),
 CHECK ((status='ACTIVE' AND verified_by IS NOT NULL AND verified_at IS NOT NULL)
 OR (status<>'ACTIVE'))
);
CREATE TABLE IF NOT EXISTS aimoc_execution_v1.integration_source_config (
 source_system text PRIMARY KEY REFERENCES aimoc_execution_v1.weighbridge_sources(source_system),
 protocol_version text NOT NULL,
 credential_ref text NOT NULL,
 vendor_contract_ref text NOT NULL,
 proposed_by text NOT NULL,
 approved_by text,
 approved_at timestamptz,
 status text NOT NULL CHECK(status IN ('DRAFT','APPROVED','REVOKED')),
 CHECK (status<>'APPROVED' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL))
);
