import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createEmbeddedDatabase} from '../server/database.mjs';
import {createIsolatedExecutionSchema,startMarineTrip} from '../server/v1/execution-staging.mjs';
import {extendIsolatedExecutionSchema} from '../server/v1/phase4b-schema.mjs';
import {extendExecutionPhase4D} from '../server/v1/phase4d-schema.mjs';
import {extendPhase4E} from '../server/v1/phase4e-schema.mjs';
import {prepareOpeningBalance,approveOpeningBalance,auditInventoryIntegrity} from '../server/v1/phase4e-inventory-reconciliation.mjs';
import {proposeDriverBinding,verifyDriverBinding} from '../server/v1/phase4e-driver-identity.mjs';
import {proposeWeighbridgeSource,approveWeighbridgeSource} from '../server/v1/phase4e-weighbridge-config.mjs';
import {reserveDispatchInventory} from '../server/v1/phase4b-inventory.mjs';
import {ingestSignedWeighbridgeEvent,signWeighbridgePayload} from '../server/v1/phase4b-weighbridge.mjs';
import {stagingV1} from '../server/v1/staging-api.mjs';

test('strict 4E staging integration blocks actions until actual-target evidence gates are approved',async()=>{
 const db=await createEmbeddedDatabase();
 const q=(sql,args=[])=>db.query(sql,args);
 try{
  await createIsolatedExecutionSchema(db);await extendIsolatedExecutionSchema(db);
  await extendExecutionPhase4D(db);await extendPhase4E(db);
  await q("INSERT INTO aimoc_execution_v1.voyage_capacity(voyage_id,capacity_t,status) VALUES('voyage1',60,'READY')");
  await q("INSERT INTO aimoc_execution_v1.jetty_windows(id,voyage_id,jetty_id,starts_at,ends_at,status) VALUES('slot1','voyage1','jetty1',now()-interval '1 hour',now()+interval '1 day','READY')");
  await q("INSERT INTO aimoc_execution_v1.dispatches(id,mode,status,voyage_id,source_stockpile_id,destination_location_id,sku_id,planned_quantity_t,jetty_window_id) VALUES('d1','MARINE','PLANNED','voyage1','stock1','jetty1','sku1',40,'slot1')");
  await q("INSERT INTO aimoc_execution_v1.trips(id,dispatch_id,sequence_no,status,truck_id,driver_id,planned_quantity_t) VALUES('t1','d1',1,'QUEUED','truck1','driver1',40)");
  await q("INSERT INTO aimoc_execution_v1.marine_gates(dispatch_id) VALUES('d1')");
  await q("INSERT INTO aimoc_execution_v1.inventory_accounts(location_id,sku_id) VALUES('stock1','sku1'),('jetty1','sku1')");
  await q("INSERT INTO aimoc_execution_v1.operator_permissions(actor_id,location_id,permission) VALUES('stock-preparer','stock1','stockpile.loading.confirm'),('stock-approver','stock1','stockpile.departure.confirm')");
  await q("INSERT INTO aimoc_execution_v1.driver_profiles(id,external_user_id,display_name) VALUES('driver1','user-driver1','Driver Fixture')");
  await q("INSERT INTO aimoc_execution_v1.fleet_vehicle_specs(truck_id,payload_limit_t) VALUES('truck1',45)");
  await q("INSERT INTO aimoc_execution_v1.weighbridge_sources(source_system,active,authorized_weighbridge_id) VALUES('WB-QA',true,'WB-1')");

  await assert.rejects(()=>reserveDispatchInventory(db,{actorId:'admin',idempotencyKey:'reserve-no-proof',dispatchId:'d1'}),e=>e.code==='VERIFIED_OPENING_MISSING');

  const prepared=await prepareOpeningBalance(db,{actorId:'stock-preparer',locationId:'stock1',skuId:'sku1',measuredT:'100.000000',
    measurementRef:'proof-stock1-001',measuredAt:new Date().toISOString(),evidenceDigest:createHash('sha256').update('synthetic source UAT proof').digest('hex')});
  await approveOpeningBalance(db,{actorId:'stock-approver',reconciliationId:prepared.reconciliation_id});
  await reserveDispatchInventory(db,{actorId:'admin',idempotencyKey:'reserve-with-proof',dispatchId:'d1'});
  const checked=await auditInventoryIntegrity(db);
  assert.equal(checked.issues.filter(x=>x.location_id==='stock1').length,0);
  const stock=(await q("SELECT on_hand_t,reserved_t FROM aimoc_execution_v1.inventory_accounts WHERE location_id='stock1'")).rows[0];
  assert.equal(stock.on_hand_t,'100.000000');
  assert.equal(stock.reserved_t,'40.000000');

  await assert.rejects(()=>startMarineTrip(db,{actorId:'admin',idempotencyKey:'start-without-binding',tripId:'t1'}),e=>e.code==='DRIVER_IDENTITY_UNVERIFIED');
  const ownActor={id:'user-driver1',role:'driver'};
  // This Phase4E-only database intentionally lacks the Phase4G assignment
  // contract, so the Driver DTO must remain NOT_INTEGRATED (fail-closed).
  await assert.rejects(()=>stagingV1({db,actor:ownActor,req:{headers:{}},path:'/api/v1/trips/t1',method:'GET'}),e=>e.code==='NOT_INTEGRATED');
  await proposeDriverBinding(db,{actorId:'identity-provisioner',driverId:'driver1',userId:'user-driver1',
    credentialAuthority:'idp-UAT-identity',identityEvidenceRef:'identity-proof-driver1'});
  await verifyDriverBinding(db,{actorId:'identity-reviewer',driverId:'driver1',verifiedIdentityRef:'identity-proof-driver1'});
  await startMarineTrip(db,{actorId:'admin',idempotencyKey:'start-after-binding',tripId:'t1'});
  // Identity approval enables trip start, but does not bypass missing
  // Phase4G assigned-driver DTO. Positive detail reads are covered by 4G/4H.
  await assert.rejects(()=>stagingV1({db,actor:ownActor,req:{headers:{}},path:'/api/v1/trips/t1',method:'GET'}),e=>e.code==='NOT_INTEGRATED');

  const sourceSecrets={'WB-QA':'UAT-SOURCE-SECRET-WE-NEVER-DEPLOY'};
  const payload=JSON.stringify({source_system:'WB-QA',external_event_id:'qr-event-1',event_type:'QR_SCANNED',
    trip_id:'t1',truck_id:'truck1',weighbridge_id:'WB-1',occurred_at:new Date().toISOString()});
  const timestamp=new Date().toISOString();
  const request={sourceSystem:'WB-QA',timestamp,rawBody:payload,
    signature:signWeighbridgePayload({timestamp,rawBody:payload,secret:sourceSecrets['WB-QA']}),sourceSecrets};
  await assert.rejects(()=>ingestSignedWeighbridgeEvent(db,request),e=>e.code==='WEIGHBRIDGE_VENDOR_NOT_APPROVED');
  await proposeWeighbridgeSource(db,{actorId:'vendor-provisioner',sourceSystem:'WB-QA',protocolVersion:'AIMOC_WIM_EVENT_V1',
    credentialRef:'vault:staging-weighbridge',vendorContractRef:'contract:synthetic-UAT'});
  await approveWeighbridgeSource(db,{actorId:'it-admin',sourceSystem:'WB-QA'});
  const signed=await ingestSignedWeighbridgeEvent(db,request);
  assert.equal(signed.status,'ACCEPTED');
  assert.equal((await q("SELECT status FROM aimoc_execution_v1.trips WHERE id='t1'")).rows[0].status,'START_AUTHORIZED');
 }finally{await db.close();}
});
