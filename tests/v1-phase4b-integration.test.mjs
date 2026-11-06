import test from 'node:test';
import assert from 'node:assert/strict';
import {createEmbeddedDatabase} from '../server/database.mjs';
import {createIsolatedExecutionSchema,startMarineTrip,finalizeMarineUnload,verifyMarineTripReturn} from '../server/v1/execution-staging.mjs';
import {extendIsolatedExecutionSchema} from '../server/v1/phase4b-schema.mjs';
import {signWeighbridgePayload,ingestSignedWeighbridgeEvent,reconcilePendingWeighbridgeEvents} from '../server/v1/phase4b-weighbridge.mjs';
import {reserveDispatchInventory,confirmTripLoading,departVerifiedTrip,confirmTripArrival,verifyDestinationReceipt} from '../server/v1/phase4b-inventory.mjs';
import {getDriverActiveTrip,getDriverTripHistory,reportDriverChecklist,reportDriverReturnStart,
  recordIndependentReturnEvidence} from '../server/v1/phase4b-driver.mjs';

const secret='TEST-ONLY-weighbridge-32bytes-not-for-production';
const sourceSecrets={'WB-TEST':secret};
const now=Date.now();
const iso=offset=>new Date(now+offset).toISOString();
const wb=(tripId,truckId,type,id,weight_t,offset=0)=>({
  source_system:'WB-TEST',external_event_id:id,event_type:type,trip_id:tripId,
  truck_id:truckId,weighbridge_id:'WB-UNIT-1',occurred_at:iso(offset),
  ...(weight_t===undefined?{}:{weight_t}),
});
const signed=(body,sourceSystem='WB-TEST')=>{
  const rawBody=JSON.stringify(body),timestamp=iso(0);
  return {sourceSystem,timestamp,rawBody,
    signature:signWeighbridgePayload({timestamp,rawBody,secret}),sourceSecrets,now};
};

test('Phase 4B integrated staging: real-event-shaped weighing, custody, Driver roles and Marine Option B',async t=>{
 const db=await createEmbeddedDatabase();
 const query=(sql,args=[])=>db.query(sql,args);
 try{
  await createIsolatedExecutionSchema(db);
  await extendIsolatedExecutionSchema(db);
  await query(`INSERT INTO aimoc_execution_v1.dispatches
    (id,mode,status,voyage_id,source_stockpile_id,destination_location_id,sku_id,planned_quantity_t)
    VALUES('marine-1','MARINE','PLANNED','voyage-1','source-1','jetty-1','sku-1',80)`);
  await query(`INSERT INTO aimoc_execution_v1.trips
    (id,dispatch_id,sequence_no,status,truck_id,driver_id,planned_quantity_t)
    VALUES('trip-1','marine-1',1,'QUEUED','truck-1','driver-1',40),
          ('trip-2','marine-1',2,'QUEUED','truck-2','driver-2',40)`);
  await query(`INSERT INTO aimoc_execution_v1.marine_gates(dispatch_id) VALUES('marine-1')`);
  await query(`INSERT INTO aimoc_execution_v1.inventory_accounts(location_id,sku_id,on_hand_t,reserved_t)
    VALUES('source-1','sku-1',100,0),('jetty-1','sku-1',0,0)`);
  await query(`INSERT INTO aimoc_execution_v1.weighbridge_sources(source_system,active,authorized_weighbridge_id)
    VALUES('WB-TEST',true,'WB-UNIT-1')`);
  await query(`INSERT INTO aimoc_execution_v1.fleet_vehicle_specs(truck_id,payload_limit_t)
    VALUES('truck-1',48),('truck-2',48)`);
  await query(`INSERT INTO aimoc_execution_v1.driver_profiles(id,external_user_id,display_name)
    VALUES('driver-1','user-driver-1','Driver UAT 1'),('driver-2','user-driver-2','Driver UAT 2')`);
  await query(`INSERT INTO aimoc_execution_v1.operator_permissions(actor_id,location_id,permission)
    VALUES('source-op','source-1','stockpile.loading.confirm'),
          ('source-op','source-1','stockpile.departure.confirm'),
          ('receiver','jetty-1','receiving.verify'),
          ('return-verifier','source-1','return.verify')`);
  await query(`INSERT INTO aimoc_execution_v1.driver_checklist_items(id,label,stage)
    VALUES('check-1','Report checked tyres','START_AUTHORIZED')`);

  await t.test('reserve does not reduce on-hand, but prevents over-allocation',async()=>{
    const reserved=await reserveDispatchInventory(db,{actorId:'admin',idempotencyKey:'reserve-marine-1',dispatchId:'marine-1'});
    assert.equal(reserved.status,'READY');
    assert.equal(reserved.inventory_on_hand_unchanged,true);
    assert.equal((await query(`SELECT on_hand_t,reserved_t FROM aimoc_execution_v1.inventory_accounts
      WHERE location_id='source-1'`)).rows[0].on_hand_t,'100.000000');
    assert.equal((await query(`SELECT reserved_t FROM aimoc_execution_v1.inventory_accounts
      WHERE location_id='source-1'`)).rows[0].reserved_t,'80.000000');
    const retry=await reserveDispatchInventory(db,{actorId:'admin',idempotencyKey:'reserve-marine-1',dispatchId:'marine-1'});
    assert.equal(retry.replayed,true);
  });
  await t.test('Driver sees only own assignment, cannot forge cargo verification',async()=>{
    await assert.rejects(()=>getDriverActiveTrip(db,{actor:{id:'user-driver-1',role:'ADMIN'}}),e=>e.code==='DRIVER_ROLE_REQUIRED');
    assert.equal((await getDriverActiveTrip(db,{actor:{id:'fake-user',role:'DRIVER'}})).data_status,'PENDING_DRIVER_VERIFICATION');
    await startMarineTrip(db,{actorId:'admin',idempotencyKey:'start-t1',tripId:'trip-1'});
    const own=await getDriverActiveTrip(db,{actor:{id:'user-driver-1',role:'DRIVER'}});
    assert.equal(own.trip.id,'trip-1');
    assert.equal(own.trip.independently_verified_unload,null);
    const other=await getDriverActiveTrip(db,{actor:{id:'user-driver-2',role:'DRIVER'}});
    assert.equal(other.data_status,'READY');
    assert.equal(other.trip.id,'trip-2');
    assert.equal(other.trip.status,'QUEUED');
    await assert.rejects(()=>reportDriverChecklist(db,{actor:{id:'user-driver-2',role:'DRIVER'},
      tripId:'trip-1',itemId:'check-1',status:'DONE'}),e=>e.code==='DRIVER_TRIP_FORBIDDEN');
    const response=await reportDriverChecklist(db,{actor:{id:'user-driver-1',role:'DRIVER'},
      tripId:'trip-1',itemId:'check-1',status:'DONE'});
    assert.equal(response.evidence_authority,'DRIVER_SELF_REPORT');
    assert.equal(response.unloading_verified,false);
    assert.equal(response.truck_available,false);
  });
  await t.test('reject invalid signature, wrong source and duplicate event payload conflicts',async()=>{
    const body=wb('trip-1','truck-1','QR_SCANNED','qr-1');
    await assert.rejects(()=>ingestSignedWeighbridgeEvent(db,{...signed(body),signature:'0'.repeat(64)}),
      e=>e.code==='WEIGHBRIDGE_INVALID_SIGNATURE');
    await assert.rejects(()=>ingestSignedWeighbridgeEvent(db,{...signed(body),timestamp:iso(-900000)}),
      e=>e.code==='WEIGHBRIDGE_SIGNATURE_EXPIRED');
    const accepted=await ingestSignedWeighbridgeEvent(db,signed(body));
    assert.equal(accepted.status,'ACCEPTED');
    const retry=await ingestSignedWeighbridgeEvent(db,signed(body));
    assert.equal(retry.replayed,true);
    const changed={...body,truck_id:'wrong-truck'};
    await assert.rejects(()=>ingestSignedWeighbridgeEvent(db,signed(changed)),e=>e.code==='WEIGHBRIDGE_DUPLICATE_CONFLICT');
    const count=(await query('SELECT count(*)::int AS c FROM aimoc_execution_v1.weighbridge_inbox')).rows[0].c;
    assert.equal(count,1);
  });
  await t.test('tare verified separately from QR and loading can only be confirmed by assigned Stockpile operator',async()=>{
    const tare=await ingestSignedWeighbridgeEvent(db,signed(wb('trip-1','truck-1','TARE_RECORDED','tare-1','12.000000',1000)));
    assert.equal(tare.status,'ACCEPTED');
    assert.equal((await query(`SELECT status,tare_t FROM aimoc_execution_v1.trips WHERE id='trip-1'`)).rows[0].status,'TARE_CONFIRMED');
    await assert.rejects(()=>confirmTripLoading(db,{actorId:'unscoped',idempotencyKey:'loading-bad',tripId:'trip-1'}),e=>e.code==='FORBIDDEN_SCOPE');
    const loading=await confirmTripLoading(db,{actorId:'source-op',idempotencyKey:'loading-correct',tripId:'trip-1'});
    assert.equal(loading.status,'LOADING');
  });
  await t.test('gross minus tare becomes verified net; departure debits actual stock and creates custody',async()=>{
    const invalidGross=await ingestSignedWeighbridgeEvent(db,signed(wb('trip-1','truck-1','GROSS_RECORDED','gross-bad','10.000000',2000)));
    assert.equal(invalidGross.status,'REJECTED');
    assert.equal(invalidGross.failure_code,'WEIGHBRIDGE_INVALID_NET');
    const gross=await ingestSignedWeighbridgeEvent(db,signed(wb('trip-1','truck-1','GROSS_RECORDED','gross-1','52.000000',3000)));
    assert.equal(gross.status,'ACCEPTED');
    const weighed=(await query(`SELECT actual_net_t,status FROM aimoc_execution_v1.trips WHERE id='trip-1'`)).rows[0];
    assert.equal(weighed.actual_net_t,'40.000000');
    await assert.rejects(()=>departVerifiedTrip(db,{actorId:'receiver',idempotencyKey:'bad-depart',tripId:'trip-1'}),e=>e.code==='FORBIDDEN_SCOPE');
    const departure=await departVerifiedTrip(db,{actorId:'source-op',idempotencyKey:'actual-depart',tripId:'trip-1'});
    assert.equal(departure.status,'IN_TRANSIT');
    const source=(await query(`SELECT * FROM aimoc_execution_v1.inventory_accounts WHERE location_id='source-1'`)).rows[0];
    assert.equal(source.on_hand_t,'60.000000');assert.equal(source.reserved_t,'40.000000');
    const cargo=(await query(`SELECT * FROM aimoc_execution_v1.cargo_custody WHERE trip_id='trip-1'`)).rows[0];
    assert.equal(cargo.shipped_t,'40.000000');assert.equal(cargo.status,'IN_TRANSIT');
    const retry=await departVerifiedTrip(db,{actorId:'source-op',idempotencyKey:'actual-depart',tripId:'trip-1'});
    assert.equal(retry.replayed,true);
    assert.equal((await query(`SELECT count(*)::int AS c FROM aimoc_execution_v1.inventory_journal`)).rows[0].c,1);
  });
  await t.test('receiver-signed partial custody never releases marine sequence',async()=>{
    await assert.rejects(()=>confirmTripArrival(db,{actorId:'source-op',idempotencyKey:'arrival-wrong',tripId:'trip-1'}),e=>e.code==='FORBIDDEN_SCOPE');
    await confirmTripArrival(db,{actorId:'receiver',idempotencyKey:'arrival-correct',tripId:'trip-1'});
    await assert.rejects(()=>verifyDestinationReceipt(db,{actorId:'source-op',idempotencyKey:'rcv-source',tripId:'trip-1',receivedT:'10.000000',externalReceiptId:'rcpt-bad'}),e=>e.code==='FORBIDDEN_SCOPE');
    const partial=await verifyDestinationReceipt(db,{actorId:'receiver',idempotencyKey:'receipt-partial',tripId:'trip-1',receivedT:'15.000000',externalReceiptId:'rcpt-1'});
    assert.equal(partial.final,false);assert.equal(partial.remaining_t,'25.000000');
    await assert.rejects(()=>finalizeMarineUnload(db,{actorId:'receiver',idempotencyKey:'release-too-early',tripId:'trip-1'}),e=>e.code==='CARGO_NOT_SETTLED');
    const locked=(await query(`SELECT active_trip_id FROM aimoc_execution_v1.marine_gates WHERE dispatch_id='marine-1'`)).rows[0];
    assert.equal(locked.active_trip_id,'trip-1');
  });
  await t.test('full verified receiving unlocks trip 2, not truck 1',async()=>{
    const final=await verifyDestinationReceipt(db,{actorId:'receiver',idempotencyKey:'receipt-final',tripId:'trip-1',receivedT:'25.000000',externalReceiptId:'rcpt-2'});
    assert.equal(final.final,true);
    const destination=(await query(`SELECT on_hand_t FROM aimoc_execution_v1.inventory_accounts WHERE location_id='jetty-1'`)).rows[0];
    assert.equal(destination.on_hand_t,'40.000000');
    await assert.rejects(()=>query(`UPDATE aimoc_execution_v1.receipts
      SET received_t=100 WHERE source_event_id='rcpt-2'`),e=>e.code==='P0001');
    await assert.rejects(()=>query(`DELETE FROM aimoc_execution_v1.unload_settlements
      WHERE trip_id='trip-1'`),e=>e.code==='P0001');
    const release=await finalizeMarineUnload(db,{actorId:'receiver',idempotencyKey:'unload-release',tripId:'trip-1'});
    assert.equal(release.sequence_released,1);
    const claim=(await query(`SELECT released_at FROM aimoc_execution_v1.resource_claims WHERE trip_id='trip-1'`)).rows[0];
    assert.equal(claim.released_at,null);
    const next=await startMarineTrip(db,{actorId:'admin',idempotencyKey:'start-t2',tripId:'trip-2'});
    assert.equal(next.status,'START_AUTHORIZED');
    await assert.rejects(()=>reportDriverReturnStart(db,{actor:{id:'user-driver-2',role:'DRIVER'},tripId:'trip-1'}),e=>e.code==='DRIVER_TRIP_FORBIDDEN');
  });
  await t.test('Driver can report return but cannot independently free truck',async()=>{
    const returning=await reportDriverReturnStart(db,{actor:{id:'user-driver-1',role:'DRIVER'},tripId:'trip-1'});
    assert.equal(returning.status,'RETURNING');
    assert.equal(returning.truck_available,false);
    await assert.rejects(()=>recordIndependentReturnEvidence(db,{actorId:'driver-1',tripId:'trip-1',sourceEventId:'return-test-1',vehicleReady:true}),e=>e.code==='SELF_VERIFICATION_FORBIDDEN');
    await assert.rejects(()=>recordIndependentReturnEvidence(db,{actorId:'user-driver-1',tripId:'trip-1',sourceEventId:'return-test-user',vehicleReady:true}),e=>e.code==='SELF_VERIFICATION_FORBIDDEN');
    await assert.rejects(()=>recordIndependentReturnEvidence(db,{actorId:'unscoped',tripId:'trip-1',sourceEventId:'return-test-1',vehicleReady:true}),e=>e.code==='RETURN_VERIFIER_FORBIDDEN');
    await recordIndependentReturnEvidence(db,{actorId:'return-verifier',tripId:'trip-1',sourceEventId:'return-test-1',vehicleReady:true});
    const finished=await verifyMarineTripReturn(db,{actorId:'return-verifier',idempotencyKey:'verify-return-t1',tripId:'trip-1'});
    assert.equal(finished.resource_claim_released,true);
    const history=await getDriverTripHistory(db,{actor:{id:'user-driver-1',role:'DRIVER'}});
    assert.equal(history.items.length,1);assert.equal(history.items[0].status,'RETURNED_AVAILABLE');
  });
  await t.test('append-only journal balances and outbox events have distinct provenance',async()=>{
    const movements=(await query('SELECT movement_type,delta_on_hand_t FROM aimoc_execution_v1.inventory_journal ORDER BY occurred_at,id')).rows;
    assert.equal(movements.length,3);
    const sumChange=movements.reduce((a,m)=>a+Number(m.delta_on_hand_t),0);
    assert.equal(sumChange,0);
    assert.equal(movements.filter(x=>x.movement_type==='SOURCE_DEPARTURE').length,1);
    assert.equal(movements.filter(x=>x.movement_type==='DESTINATION_RECEIPT').length,2);
    const outbox=(await query(`SELECT count(*)::int AS c FROM aimoc_execution_v1.integration_outbox`)).rows[0].c;
    assert.ok(outbox>=8);
  });
 }finally{await db.close();}
});
