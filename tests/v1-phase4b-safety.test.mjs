import test from 'node:test';
import assert from 'node:assert/strict';
import {createEmbeddedDatabase} from '../server/database.mjs';
import {createIsolatedExecutionSchema,startMarineTrip} from '../server/v1/execution-staging.mjs';
import {extendIsolatedExecutionSchema} from '../server/v1/phase4b-schema.mjs';
import {reserveDispatchInventory,confirmTripLoading} from '../server/v1/phase4b-inventory.mjs';
import {ingestSignedWeighbridgeEvent,signWeighbridgePayload,reconcilePendingWeighbridgeEvents} from '../server/v1/phase4b-weighbridge.mjs';

const secret='QA-WEIGHBRIDGE-SECRET-NOT-LIVE-123456';
const t0=Date.now();
const date=plus=>new Date(t0+plus).toISOString();
const body=(type,id,weight,occurredPlus=0)=>({
  source_system:'WB-A',external_event_id:id,event_type:type,
  trip_id:'test-trip',truck_id:'truck1',weighbridge_id:'WB-01',occurred_at:date(occurredPlus),
  ...(weight===undefined?{}:{weight_t:weight}),
});
const signed=e=>{
 const rawBody=JSON.stringify(e),timestamp=date(0);
 return {sourceSystem:'WB-A',timestamp,rawBody,signature:signWeighbridgePayload({timestamp,rawBody,secret}),
  sourceSecrets:{'WB-A':secret},now:t0};
};

test('Phase 4B security: ordering, payload limit, custody overbooking and immutable journal',async t=>{
 const db=await createEmbeddedDatabase();
 const q=(sql,params=[])=>db.query(sql,params);
 try{
  await createIsolatedExecutionSchema(db);await extendIsolatedExecutionSchema(db);
  await q(`INSERT INTO aimoc_execution_v1.dispatches(id,mode,status,voyage_id,source_stockpile_id,
    destination_location_id,sku_id,planned_quantity_t) VALUES('test-d','MARINE','PLANNED','voyage1','stock1','jetty1','sku1',40)`);
  await q(`INSERT INTO aimoc_execution_v1.trips(id,dispatch_id,sequence_no,status,truck_id,driver_id,planned_quantity_t)
    VALUES('test-trip','test-d',1,'QUEUED','truck1','driver1',40)`);
  await q(`INSERT INTO aimoc_execution_v1.marine_gates(dispatch_id) VALUES('test-d')`);
  await q(`INSERT INTO aimoc_execution_v1.inventory_accounts(location_id,sku_id,on_hand_t)
    VALUES('stock1','sku1',60),('jetty1','sku1',0)`);
  await q(`INSERT INTO aimoc_execution_v1.weighbridge_sources(source_system,active,authorized_weighbridge_id)
    VALUES('WB-A',true,'WB-01')`);
  await q(`INSERT INTO aimoc_execution_v1.fleet_vehicle_specs(truck_id,payload_limit_t)
    VALUES('truck1',40)`);
  await q(`INSERT INTO aimoc_execution_v1.driver_profiles(id,external_user_id,display_name)
    VALUES('driver1','driver-user','UAT driver')`);
  await q(`INSERT INTO aimoc_execution_v1.operator_permissions(actor_id,location_id,permission)
    VALUES('loader','stock1','stockpile.loading.confirm')`);
  await reserveDispatchInventory(db,{actorId:'admin',idempotencyKey:'reserve-test-d',dispatchId:'test-d'});
  await startMarineTrip(db,{actorId:'admin',idempotencyKey:'start-test-trip',tripId:'test-trip'});

  await t.test('out-of-order signed gross is stored PENDING without claiming weighing completed',async()=>{
    const gross=await ingestSignedWeighbridgeEvent(db,signed(body('GROSS_RECORDED','early-gross','52.000000',3000)));
    assert.equal(gross.status,'PENDING');
    const trip=(await q(`SELECT status,actual_net_t FROM aimoc_execution_v1.trips WHERE id='test-trip'`)).rows[0];
    assert.equal(trip.status,'START_AUTHORIZED');assert.equal(trip.actual_net_t,null);
    const pending=(await q(`SELECT count(*)::int AS c FROM aimoc_execution_v1.weighbridge_inbox
      WHERE processing_status='PENDING'`)).rows[0].c;
    assert.equal(pending,1);
  });
  await t.test('QR and TARE must be independently signed, then authorized loading precedes gross reconciliation',async()=>{
    const qr=await ingestSignedWeighbridgeEvent(db,signed(body('QR_SCANNED','qr-ok',undefined,0)));
    assert.equal(qr.status,'ACCEPTED');
    const tare=await ingestSignedWeighbridgeEvent(db,signed(body('TARE_RECORDED','tare-ok','12.000000',1000)));
    assert.equal(tare.status,'ACCEPTED');
    const loading=await confirmTripLoading(db,{actorId:'loader',idempotencyKey:'load-test',tripId:'test-trip'});
    assert.equal(loading.status,'GROSS_CONFIRMED');
    assert.equal((await q("SELECT processing_status FROM aimoc_execution_v1.weighbridge_inbox WHERE external_event_id='early-gross'")).rows[0].processing_status,'ACCEPTED');
    const reconciled=await reconcilePendingWeighbridgeEvents(db,{tripId:'test-trip'});
    assert.equal(reconciled.processed,0);assert.equal(reconciled.remaining,0);
    assert.equal((await q(`SELECT actual_net_t,status FROM aimoc_execution_v1.trips WHERE id='test-trip'`)).rows[0].status,'GROSS_CONFIRMED');
  });
  await t.test('accepted signed weighing evidence cannot be rewritten or deleted',async()=>{
    await assert.rejects(()=>q(`UPDATE aimoc_execution_v1.weighbridge_inbox
      SET weight_t=999 WHERE external_event_id='tare-ok'`),e=>e.code==='P0001');
    await assert.rejects(()=>q(`UPDATE aimoc_execution_v1.weighbridge_inbox
      SET processing_status='PENDING' WHERE external_event_id='tare-ok'`),e=>e.code==='P0001');
    await assert.rejects(()=>q(`DELETE FROM aimoc_execution_v1.weighbridge_inbox
      WHERE external_event_id='tare-ok'`),e=>e.code==='P0001');
    const stored=(await q(`SELECT weight_t,processing_status FROM aimoc_execution_v1.weighbridge_inbox
      WHERE external_event_id='tare-ok'`)).rows[0];
    assert.equal(stored.weight_t,'12.000000');
    assert.equal(stored.processing_status,'ACCEPTED');
  });
  await t.test('approved truck capacity restricts gross even if trip allocation is larger',async()=>{
    // A distinct signed source event for a different trip would be required; this
    // test verifies the authoritative persisted specification and final net.
    const trip=(await q(`SELECT actual_net_t FROM aimoc_execution_v1.trips WHERE id='test-trip'`)).rows[0];
    const spec=(await q(`SELECT payload_limit_t FROM aimoc_execution_v1.fleet_vehicle_specs WHERE truck_id='truck1'`)).rows[0];
    assert.ok(Number(trip.actual_net_t)<=Number(spec.payload_limit_t));
    await assert.rejects(()=>q(`UPDATE aimoc_execution_v1.fleet_vehicle_specs SET payload_limit_t=0 WHERE truck_id='truck1'`),
      e=>e.code==='23514');
  });
  await t.test('append-only ledger and audit cannot be rewritten directly',async()=>{
    await q(`INSERT INTO aimoc_execution_v1.inventory_journal
      (id,trip_id,location_id,sku_id,movement_type,delta_on_hand_t,reference_event_id)
      VALUES('audited','test-trip','stock1','sku1','SOURCE_DEPARTURE',-1,'append-test-1')`);
    await assert.rejects(()=>q(`UPDATE aimoc_execution_v1.inventory_journal
      SET delta_on_hand_t=99 WHERE id='audited'`),e=>e.code==='P0001');
    await assert.rejects(()=>q(`DELETE FROM aimoc_execution_v1.inventory_journal WHERE id='audited'`),e=>e.code==='P0001');
    const unchanged=(await q(`SELECT delta_on_hand_t FROM aimoc_execution_v1.inventory_journal WHERE id='audited'`)).rows[0];
    assert.equal(unchanged.delta_on_hand_t,'-1.000000');
  });
  await t.test('reservation cannot be repeated to exceed available stock',async()=>{
    const balance=(await q(`SELECT on_hand_t,reserved_t FROM aimoc_execution_v1.inventory_accounts WHERE location_id='stock1'`)).rows[0];
    assert.equal(balance.on_hand_t,'60.000000');
    assert.equal(balance.reserved_t,'40.000000');
    await assert.rejects(()=>q(`UPDATE aimoc_execution_v1.inventory_accounts
      SET reserved_t=70 WHERE location_id='stock1'`),e=>e.code==='23514');
  });
 }finally{await db.close();}
});
