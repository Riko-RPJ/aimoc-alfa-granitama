import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createEmbeddedDatabase} from '../server/database.mjs';
import {createIsolatedExecutionSchema} from '../server/v1/execution-staging.mjs';
import {extendIsolatedExecutionSchema} from '../server/v1/phase4b-schema.mjs';
import {extendExecutionPhase4D} from '../server/v1/phase4d-schema.mjs';
import {extendPhase4E} from '../server/v1/phase4e-schema.mjs';
import {prepareOpeningBalance,approveOpeningBalance,auditInventoryIntegrity} from '../server/v1/phase4e-inventory-reconciliation.mjs';
import {proposeDriverBinding,verifyDriverBinding,revokeDriverBinding} from '../server/v1/phase4e-driver-identity.mjs';
import {getDriverActiveTrip} from '../server/v1/phase4b-driver.mjs';
import {proposeWeighbridgeSource,approveWeighbridgeSource} from '../server/v1/phase4e-weighbridge-config.mjs';
import {ingestSignedWeighbridgeEvent,signWeighbridgePayload} from '../server/v1/phase4b-weighbridge.mjs';

test('Phase 4E integrity gates require independent proofs; no legacy m3 conversion',async t=>{
 const db=await createEmbeddedDatabase();
 const q=(sql,v=[])=>db.query(sql,v);
 try{
  await createIsolatedExecutionSchema(db);await extendIsolatedExecutionSchema(db);
  await extendExecutionPhase4D(db);await extendPhase4E(db);
  await q("INSERT INTO aimoc_execution_v1.inventory_accounts(location_id,sku_id) VALUES('source','sku')");
  await q("INSERT INTO aimoc_execution_v1.operator_permissions(actor_id,location_id,permission) VALUES('stock-preparer','source','stockpile.loading.confirm'),('stock-approver','source','stockpile.departure.confirm')");
  await t.test('measured tonnes need independent approval; no unaudited opening',async()=>{
   const initial=await auditInventoryIntegrity(db);
   assert.equal(initial.result,'BLOCKED');
   assert.equal(initial.issues[0].code,'VERIFIED_OPENING_MISSING');
   await assert.rejects(()=>prepareOpeningBalance(db,{actorId:'stock-preparer',locationId:'source',skuId:'sku',
     measuredT:'250',measurementRef:'measurement-001',measuredAt:new Date().toISOString()}),e=>e.code==='INVALID_VERIFIED_OPENING_EVIDENCE');
   const evidenceDigest=createHash('sha256').update('UAT proof, not field evidence').digest('hex');
   const pending=await prepareOpeningBalance(db,{actorId:'stock-preparer',locationId:'source',skuId:'sku',measuredT:'250.000000',
     measurementRef:'measurement-001',measuredAt:new Date().toISOString(),evidenceDigest});
   assert.equal(pending.on_hand_unchanged,true);
   const still=(await q("SELECT on_hand_t FROM aimoc_execution_v1.inventory_accounts WHERE location_id='source'")).rows[0];
   assert.equal(still.on_hand_t,'0.000000');
   await assert.rejects(()=>approveOpeningBalance(db,{actorId:'stock-preparer',reconciliationId:pending.reconciliation_id}),e=>e.code==='SELF_APPROVAL_FORBIDDEN');
   const accepted=await approveOpeningBalance(db,{actorId:'stock-approver',reconciliationId:pending.reconciliation_id});
   assert.equal(accepted.status,'APPROVED');
   const result=await auditInventoryIntegrity(db);assert.equal(result.result,'PASS');
   await assert.rejects(()=>q("UPDATE aimoc_execution_v1.inventory_opening_reconciliations SET measured_t=999 WHERE id=$1",[pending.reconciliation_id]),e=>e.code==='P0001');

   assert.equal((await q("SELECT on_hand_t FROM aimoc_execution_v1.inventory_accounts WHERE location_id='source'")).rows[0].on_hand_t,'250.000000');
   await assert.rejects(()=>prepareOpeningBalance(db,{actorId:'stock-preparer',locationId:'source',skuId:'sku',measuredT:'30.000000',
     measurementRef:'measurement-002',measuredAt:new Date().toISOString(),evidenceDigest}),e=>e.code==='OPENING_ACCOUNT_NOT_EMPTY');
   await q("UPDATE aimoc_execution_v1.inventory_accounts SET on_hand_t=200 WHERE location_id='source'");
   const discrepancy=await auditInventoryIntegrity(db);
   assert.equal(discrepancy.result,'BLOCKED');assert.equal(discrepancy.issues[0].code,'INVENTORY_JOURNAL_MISMATCH');
  });
  await t.test('Driver access blocked until independent binding, then revocable',async()=>{
   await q("INSERT INTO aimoc_execution_v1.driver_profiles(id,external_user_id,display_name) VALUES('driver1','user-driver-1','QA Driver')");
   assert.equal((await getDriverActiveTrip(db,{actor:{id:'user-driver-1',role:'DRIVER'}})).data_status,'PENDING_DRIVER_VERIFICATION');
   await proposeDriverBinding(db,{actorId:'admin-provisioner',driverId:'driver1',userId:'user-driver-1',
     credentialAuthority:'idp-local-UAT',identityEvidenceRef:'id-proof-001'});
   await assert.rejects(()=>verifyDriverBinding(db,{actorId:'admin-provisioner',driverId:'driver1',verifiedIdentityRef:'id-proof-001'}),e=>e.code==='DRIVER_SELF_APPROVAL_FORBIDDEN');
   await assert.rejects(()=>verifyDriverBinding(db,{actorId:'admin-validator',driverId:'driver1',verifiedIdentityRef:'wrong-proof'}),e=>e.code==='IDENTITY_EVIDENCE_MISMATCH');
   await verifyDriverBinding(db,{actorId:'admin-validator',driverId:'driver1',verifiedIdentityRef:'id-proof-001'});
   const active=await getDriverActiveTrip(db,{actor:{id:'user-driver-1',role:'DRIVER'}});
   assert.equal(active.data_status,'NO_ASSIGNMENT');
   await revokeDriverBinding(db,{actorId:'admin-validator',driverId:'driver1'});
   await assert.rejects(()=>q("UPDATE aimoc_execution_v1.driver_identity_bindings SET user_id='someone-else' WHERE driver_id='driver1'"),e=>e.code==='P0001');

   assert.equal((await getDriverActiveTrip(db,{actor:{id:'user-driver-1',role:'DRIVER'}})).data_status,'PENDING_DRIVER_VERIFICATION');
  });
  await t.test('HMAC alone cannot bypass pending vendor contract',async()=>{
   await q("INSERT INTO aimoc_execution_v1.weighbridge_sources(source_system,active,authorized_weighbridge_id) VALUES('WB-1',true,'BRIDGE-1')");
   const secret='FAKE-UAT-only-long-secret-not-for-live';
   const body=JSON.stringify({source_system:'WB-1',external_event_id:'event1',event_type:'QR_SCANNED',
     trip_id:'absent',truck_id:'truck',weighbridge_id:'BRIDGE-1',occurred_at:new Date().toISOString()});
   const timestamp=new Date().toISOString();
   const req={sourceSystem:'WB-1',timestamp,rawBody:body,signature:signWeighbridgePayload({timestamp,rawBody:body,secret}),sourceSecrets:{'WB-1':secret}};
   await assert.rejects(()=>ingestSignedWeighbridgeEvent(db,req),e=>e.code==='WEIGHBRIDGE_VENDOR_NOT_APPROVED');
   await proposeWeighbridgeSource(db,{actorId:'vendor-provisioner',sourceSystem:'WB-1',protocolVersion:'AIMOC_WIM_EVENT_V1',
     credentialRef:'vault:qa-device-key',vendorContractRef:'contract:UAT-not-real'});
   await assert.rejects(()=>ingestSignedWeighbridgeEvent(db,req),e=>e.code==='WEIGHBRIDGE_VENDOR_NOT_APPROVED');
   await assert.rejects(()=>approveWeighbridgeSource(db,{actorId:'vendor-provisioner',sourceSystem:'WB-1'}),e=>e.code==='WEIGHBRIDGE_SELF_APPROVAL_FORBIDDEN');
   const approved=await approveWeighbridgeSource(db,{actorId:'it-approver',sourceSystem:'WB-1'});
   assert.equal(approved.vendor_hardware_verified,false);
   await assert.rejects(()=>q("UPDATE aimoc_execution_v1.integration_source_config SET vendor_contract_ref='forged' WHERE source_system='WB-1'"),e=>e.code==='P0001');

   await assert.rejects(()=>ingestSignedWeighbridgeEvent(db,req),e=>e.code==='WEIGHBRIDGE_TRIP_MISMATCH');
  });
 }finally{await db.close();}
});
