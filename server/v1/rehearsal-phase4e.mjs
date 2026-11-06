import {createHash} from 'node:crypto';
import {createDatabase} from '../database.mjs';
import {createIsolatedExecutionSchema} from './execution-staging.mjs';
import {extendIsolatedExecutionSchema} from './phase4b-schema.mjs';
import {extendExecutionPhase4D} from './phase4d-schema.mjs';
import {extendPhase4E} from './phase4e-schema.mjs';
import {prepareOpeningBalance,approveOpeningBalance,auditInventoryIntegrity} from './phase4e-inventory-reconciliation.mjs';
import {proposeDriverBinding,verifyDriverBinding} from './phase4e-driver-identity.mjs';
import {proposeWeighbridgeSource,approveWeighbridgeSource} from './phase4e-weighbridge-config.mjs';

export async function runPhase4ERehearsal(databaseName){
 if(process.env.DATABASE_URL||!/^aimoc_rehearsal_[0-9a-f]{12}$/.test(databaseName||''))
  throw Error('LOCAL_EPHEMERAL_REHEARSAL_ONLY');
 const db=createDatabase('postgresql:///'+databaseName+'?host=/tmp');
 try{
  await createIsolatedExecutionSchema(db);
  await extendIsolatedExecutionSchema(db);
  await extendExecutionPhase4D(db);
  await extendPhase4E(db);
  const q=(sql,args=[])=>db.query(sql,args);
  await q("INSERT INTO aimoc_execution_v1.inventory_accounts(location_id,sku_id) VALUES('source1','sku1')");
  await q("INSERT INTO aimoc_execution_v1.operator_permissions(actor_id,location_id,permission) VALUES('preparer','source1','stockpile.loading.confirm'),('approver','source1','stockpile.departure.confirm')");
  const pending=await prepareOpeningBalance(db,{actorId:'preparer',locationId:'source1',skuId:'sku1',measuredT:'100.000000',
    measurementRef:'UAT-measurement-001',measuredAt:new Date().toISOString(),
    evidenceDigest:createHash('sha256').update('synthetic, not real measurement').digest('hex')});
  await approveOpeningBalance(db,{actorId:'approver',reconciliationId:pending.reconciliation_id});
  const integrity=await auditInventoryIntegrity(db);
  if(integrity.result!=='PASS')throw Error('OPENING_INTEGRITY_FAILED');
  let immutable=false;
  try{await q("UPDATE aimoc_execution_v1.inventory_opening_reconciliations SET measured_t=200 WHERE id=$1",[pending.reconciliation_id]);}
  catch(e){immutable=e.code==='P0001';}
  if(!immutable)throw Error('OPENING_EVIDENCE_NOT_IMMUTABLE');
  await q("INSERT INTO aimoc_execution_v1.driver_profiles(id,external_user_id,display_name) VALUES('driver1','user-1','QA Driver')");
  await proposeDriverBinding(db,{actorId:'it-provisioner',driverId:'driver1',userId:'user-1',
    credentialAuthority:'idp-staging',identityEvidenceRef:'proof-identity-1'});
  await verifyDriverBinding(db,{actorId:'it-verifier',driverId:'driver1',verifiedIdentityRef:'proof-identity-1'});
  await q("INSERT INTO aimoc_execution_v1.weighbridge_sources(source_system,active,authorized_weighbridge_id) VALUES('WB-QA',true,'BRIDGE-QA')");
  await proposeWeighbridgeSource(db,{actorId:'vendor-provisioner',sourceSystem:'WB-QA',protocolVersion:'AIMOC_WIM_EVENT_V1',
    credentialRef:'vault:staging-only',vendorContractRef:'contract:synthetic-not-live'});
  await approveWeighbridgeSource(db,{actorId:'it-verifier',sourceSystem:'WB-QA'});
  const accounts=(await q("SELECT on_hand_t,reserved_t FROM aimoc_execution_v1.inventory_accounts WHERE location_id='source1'")).rows[0];
  const t=(await q("SELECT count(*)::int AS n FROM pg_trigger WHERE tgname='protected_approvals' AND NOT tgisinternal")).rows[0].n;
  return {database:'temporary',postgresql:true,inventoryIntegrity:integrity.result,
    onHandT:accounts.on_hand_t,reservedT:accounts.reserved_t,approvedEvidenceImmutable:immutable,
    driverBindings:(await q("SELECT count(*)::int AS n FROM aimoc_execution_v1.driver_identity_bindings WHERE status='ACTIVE'")).rows[0].n,
    approvedWeighbridgeProfiles:(await q("SELECT count(*)::int AS n FROM aimoc_execution_v1.integration_source_config WHERE status='APPROVED'")).rows[0].n,
    approvalProtectionTriggers:t};
 } finally{await db.close();}
}
