import {readFile} from 'node:fs/promises';

/** Explicitly invoked only by staging tests/deployment scripts after the Phase 4 base schema. */
export async function extendIsolatedExecutionSchema(db) {
  const sql=await readFile(new URL('./execution-phase4b.sql',import.meta.url),'utf8');
  for(const statement of sql.split(';').map(s=>s.trim()).filter(Boolean))await db.query(statement);
  // Separate single prepared statements: PL/pgSQL body contains semicolons.
  await db.query(`CREATE OR REPLACE FUNCTION aimoc_execution_v1.reject_immutable_mutation()
    RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'Immutable AIMOC evidence may not be changed';
      END;
    $$ LANGUAGE plpgsql`);
  await db.query(`CREATE OR REPLACE FUNCTION aimoc_execution_v1.protect_weighbridge_payload()
    RETURNS trigger AS $$
      BEGIN
        IF OLD.source_system IS DISTINCT FROM NEW.source_system
           OR OLD.external_event_id IS DISTINCT FROM NEW.external_event_id
           OR OLD.event_type IS DISTINCT FROM NEW.event_type
           OR OLD.trip_id IS DISTINCT FROM NEW.trip_id
           OR OLD.truck_id IS DISTINCT FROM NEW.truck_id
           OR OLD.weighbridge_id IS DISTINCT FROM NEW.weighbridge_id
           OR OLD.weight_t IS DISTINCT FROM NEW.weight_t
           OR OLD.occurred_at IS DISTINCT FROM NEW.occurred_at
           OR OLD.payload_sha256 IS DISTINCT FROM NEW.payload_sha256
        THEN RAISE EXCEPTION 'Signed weighbridge event is immutable'; END IF;
        IF NOT (OLD.processing_status='PENDING' AND NEW.processing_status IN ('ACCEPTED','REJECTED'))
          THEN RAISE EXCEPTION 'Only pending events may be resolved'; END IF;
        RETURN NEW;
      END;
    $$ LANGUAGE plpgsql`);
  await db.query(`CREATE OR REPLACE FUNCTION aimoc_execution_v1.protect_verified_evidence()
    RETURNS trigger AS $$
      BEGIN
        IF TG_OP='DELETE' OR OLD.status='VERIFIED'
          THEN RAISE EXCEPTION 'Verified evidence cannot be rewritten or deleted'; END IF;
        RETURN NEW;
      END;
    $$ LANGUAGE plpgsql`);
  for(const table of ['inventory_journal','operational_events']){
    await db.query(`DROP TRIGGER IF EXISTS immutable_evidence_guard ON aimoc_execution_v1.${table}`);
    await db.query(`CREATE TRIGGER immutable_evidence_guard
      BEFORE UPDATE OR DELETE ON aimoc_execution_v1.${table}
      FOR EACH ROW EXECUTE FUNCTION aimoc_execution_v1.reject_immutable_mutation()`);
  }

  await db.query(`DROP TRIGGER IF EXISTS signed_payload_guard ON aimoc_execution_v1.weighbridge_inbox`);
  await db.query(`CREATE TRIGGER signed_payload_guard
    BEFORE UPDATE ON aimoc_execution_v1.weighbridge_inbox
    FOR EACH ROW EXECUTE FUNCTION aimoc_execution_v1.protect_weighbridge_payload()`);
  await db.query(`DROP TRIGGER IF EXISTS signed_payload_delete_guard ON aimoc_execution_v1.weighbridge_inbox`);
  await db.query(`CREATE TRIGGER signed_payload_delete_guard
    BEFORE DELETE ON aimoc_execution_v1.weighbridge_inbox
    FOR EACH ROW EXECUTE FUNCTION aimoc_execution_v1.reject_immutable_mutation()`);
  for(const table of ['receipts','unload_settlements']){
    await db.query(`DROP TRIGGER IF EXISTS verified_evidence_guard ON aimoc_execution_v1.${table}`);
    await db.query(`CREATE TRIGGER verified_evidence_guard
      BEFORE UPDATE OR DELETE ON aimoc_execution_v1.${table}
      FOR EACH ROW EXECUTE FUNCTION aimoc_execution_v1.protect_verified_evidence()`);
  }
  await db.query(`DROP TRIGGER IF EXISTS return_immutability_guard ON aimoc_execution_v1.return_verifications`);
  await db.query(`CREATE TRIGGER return_immutability_guard BEFORE UPDATE OR DELETE
    ON aimoc_execution_v1.return_verifications
    FOR EACH ROW EXECUTE FUNCTION aimoc_execution_v1.reject_immutable_mutation()`);
}
