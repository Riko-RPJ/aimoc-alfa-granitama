import test from 'node:test';
import assert from 'node:assert/strict';
import {createEmbeddedDatabase} from '../server/database.mjs';
import {createIsolatedExecutionSchema,startMarineTrip} from '../server/v1/execution-staging.mjs';
import {extendIsolatedExecutionSchema} from '../server/v1/phase4b-schema.mjs';
import {extendExecutionPhase4D} from '../server/v1/phase4d-schema.mjs';
import {reserveDispatchInventory} from '../server/v1/phase4b-inventory.mjs';

test('Phase 4D shared voyage capacity is serialized across separate marine dispatches',async()=>{
 const db=await createEmbeddedDatabase();
 try{
  await createIsolatedExecutionSchema(db);await extendIsolatedExecutionSchema(db);await extendExecutionPhase4D(db);
  const q=(sql,params=[])=>db.query(sql,params);
  await q("INSERT INTO aimoc_execution_v1.voyage_capacity(voyage_id,capacity_t,status) VALUES('voyage1',70,'READY')");
  await q("INSERT INTO aimoc_execution_v1.jetty_windows(id,voyage_id,jetty_id,starts_at,ends_at,status) VALUES('window1','voyage1','jetty1',now()-interval '1 hour',now()+interval '1 day','READY')");
  await q("INSERT INTO aimoc_execution_v1.dispatches(id,mode,status,voyage_id,source_stockpile_id,destination_location_id,sku_id,planned_quantity_t,jetty_window_id) VALUES('d1','MARINE','PLANNED','voyage1','stock1','jetty1','sku1',40,'window1'),('d2','MARINE','PLANNED','voyage1','stock1','jetty1','sku1',40,'window1')");
  await q("INSERT INTO aimoc_execution_v1.trips(id,dispatch_id,sequence_no,status,truck_id,driver_id,planned_quantity_t) VALUES('t1','d1',1,'QUEUED','truck1','driver1',40),('t2','d2',1,'QUEUED','truck2','driver2',40)");
  await q("INSERT INTO aimoc_execution_v1.marine_gates(dispatch_id) VALUES('d1'),('d2')");
  await q("INSERT INTO aimoc_execution_v1.inventory_accounts(location_id,sku_id,on_hand_t) VALUES('stock1','sku1',200)");
  await q("INSERT INTO aimoc_execution_v1.driver_profiles(id,external_user_id,display_name) VALUES('driver1','user1','Driver 1'),('driver2','user2','Driver 2')");
  await q("INSERT INTO aimoc_execution_v1.fleet_vehicle_specs(truck_id,payload_limit_t) VALUES('truck1',45),('truck2',45)");
  const outcomes=await Promise.allSettled([
    reserveDispatchInventory(db,{actorId:'admin1',idempotencyKey:'reserve-d1',dispatchId:'d1'}),
    reserveDispatchInventory(db,{actorId:'admin2',idempotencyKey:'reserve-d2',dispatchId:'d2'})
  ]);
  assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);
  assert.equal(outcomes.filter(x=>x.status==='rejected').length,1);
  assert.equal(outcomes.find(x=>x.status==='rejected').reason.code,'VOYAGE_CAPACITY_EXCEEDED');
  const voyage=(await q("SELECT capacity_t,reserved_t FROM aimoc_execution_v1.voyage_capacity WHERE voyage_id='voyage1'")).rows[0];
  assert.equal(voyage.capacity_t,'70.000000');assert.equal(voyage.reserved_t,'40.000000');
  const account=(await q("SELECT on_hand_t,reserved_t FROM aimoc_execution_v1.inventory_accounts WHERE location_id='stock1'")).rows[0];
  assert.equal(account.on_hand_t,'200.000000');assert.equal(account.reserved_t,'40.000000');
  const winner=outcomes[0].status==='fulfilled'?'d1':'d2';
  const trip=winner==='d1'?'t1':'t2';
  await q("UPDATE aimoc_execution_v1.jetty_windows SET status='ON_HOLD' WHERE id='window1'");
  await assert.rejects(()=>startMarineTrip(db,{actorId:'admin',idempotencyKey:'hold-slot',tripId:trip}),e=>e.code==='JETTY_SLOT_NOT_READY');
  await q("UPDATE aimoc_execution_v1.jetty_windows SET status='READY' WHERE id='window1'");
  const authorized=await startMarineTrip(db,{actorId:'admin',idempotencyKey:'valid-slot',tripId:trip});
  assert.equal(authorized.status,'START_AUTHORIZED');
  const gates=(await q("SELECT dispatch_id,active_trip_id FROM aimoc_execution_v1.marine_gates ORDER BY dispatch_id")).rows;
  assert.equal(gates.filter(x=>x.active_trip_id!==null).length,1);
 }finally{await db.close();}
});
