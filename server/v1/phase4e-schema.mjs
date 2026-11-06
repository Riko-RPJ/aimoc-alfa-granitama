import {readFile} from 'node:fs/promises';
/** Explicitly opt-in isolated staging extension; never imported by startup. */
export async function extendPhase4E(db){
 const sql=await readFile(new URL('./execution-phase4e.sql',import.meta.url),'utf8');
 for(const statement of sql.split(';').map(x=>x.trim()).filter(Boolean)) await db.query(statement);
 await db.query(`CREATE OR REPLACE FUNCTION aimoc_execution_v1.protect_approval_evidence()
   RETURNS trigger AS $$
   BEGIN
     IF TG_OP='DELETE' THEN
       RAISE EXCEPTION 'Approval evidence may not be deleted';
     END IF;
     IF TG_TABLE_NAME='inventory_opening_reconciliations' THEN
       IF OLD.status='APPROVED' THEN
         RAISE EXCEPTION 'Approved opening evidence is immutable';
       END IF;
     ELSIF TG_TABLE_NAME='driver_identity_bindings' THEN
       IF OLD.status='REVOKED' THEN
         RAISE EXCEPTION 'Revoked identity evidence immutable';
       END IF;
       IF OLD.status='ACTIVE' AND (NEW.status<>'REVOKED' OR
         OLD.driver_id IS DISTINCT FROM NEW.driver_id OR
         OLD.user_id IS DISTINCT FROM NEW.user_id OR
         OLD.identity_evidence_ref IS DISTINCT FROM NEW.identity_evidence_ref OR
         OLD.credential_authority IS DISTINCT FROM NEW.credential_authority) THEN
         RAISE EXCEPTION 'Active identity may only be revoked';
       END IF;
     ELSIF TG_TABLE_NAME='integration_source_config' THEN
       IF OLD.status IN ('APPROVED','REVOKED') THEN
         RAISE EXCEPTION 'Approved vendor configuration is immutable';
       END IF;
     END IF;
     RETURN NEW;
   END;
   $$ LANGUAGE plpgsql`);
 for(const table of ['inventory_opening_reconciliations','driver_identity_bindings','integration_source_config']){
   await db.query(`DROP TRIGGER IF EXISTS protected_approvals ON aimoc_execution_v1.${table}`);
   await db.query(`CREATE TRIGGER protected_approvals BEFORE UPDATE OR DELETE ON aimoc_execution_v1.${table}
     FOR EACH ROW EXECUTE FUNCTION aimoc_execution_v1.protect_approval_evidence()`);
 }

}
