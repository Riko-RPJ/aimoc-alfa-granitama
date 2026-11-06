import test from 'node:test';
import assert from 'node:assert/strict';
import {createEmbeddedDatabase} from '../server/database.mjs';
import {createIsolatedExecutionSchema,startMarineTrip} from '../server/v1/execution-staging.mjs';
import {extendIsolatedExecutionSchema} from '../server/v1/phase4b-schema.mjs';
import {extendExecutionPhase4D} from '../server/v1/phase4d-schema.mjs';
import {holdTrip,resolveTripHold} from '../server/v1/phase4d-hold.mjs';

test('Phase 4D HOLD preserves marine gate, occupancy and requires different recovery approver',async()=>{
 const db=await createEmbeddedDatabase();
 try{
  await createIsolatedExecutionSchema(db);
  await extendIsolatedExecutionSchema(db);
  await extendExecutionPhase4D(db);
  const q=(sql,args=[])=>db.query(sql,args);
  await q("INSERT INTO aimoc_execution_v1.voyage_capacity(voyage_id,capacity_t,reserved_t,status) VALUES('voyage1',100,80,'READY')");
  await q("INSERT INTO aimoc_execution_v1.jetty_windows(id,voyage_id,jetty_id,starts_at,ends_at,status) VALUES('window1','voyage1','jetty1',now()-interval '1 hour',now()+interval '1 day','READY')");
  await q("INSERT INTO aimoc_execution_v1.dispatches(id,mode,status,voyage_id,source_stockpile_id,destination_location_id,sku_id,planned_quantity_t) VALUES('d1','MARINE','READY','voyage1','stock1','jetty1','sku1',80)");
  await q("UPDATE aimoc_execution_v1.dispatches SET jetty_window_id='window1' WHERE id='d1'");
  await q("INSERT INTO aimoc_execution_v1.voyage_dispatch_allocations(dispatch_id,voyage_id,allocated_t) VALUES('d1','voyage1',80)");
  await q("INSERT INTO aimoc_execution_v1.trips(id,dispatch_id,sequence_no,status,truck_id,driver_id,planned_quantity_t) VALUES('t1','d1',1,'QUEUED','truck1','driver1',40),('t2','d1',2,'QUEUED','truck2','driver2',40)");
  await q("INSERT INTO aimoc_execution_v1.marine_gates(dispatch_id) VALUES('d1')");
  await q("INSERT INTO aimoc_execution_v1.inventory_reservations(id,dispatch_id,source_stockpile_id,sku_id,reserved_t,status) VALUES('r1','d1','stock1','sku1',80,'ACTIVE')");
  await q("INSERT INTO aimoc_execution_v1.driver_profiles(id,external_user_id,display_name) VALUES('driver1','user1','Driver one'),('driver2','user2','Driver two')");
  await q("INSERT INTO aimoc_execution_v1.fleet_vehicle_specs(truck_id,payload_limit_t) VALUES('truck1',45),('truck2',45)");
  await startMarineTrip(db,{actorId:'operator-start',idempotencyKey:'start-1',tripId:'t1'});
  const h=await holdTrip(db,{actorId:'supervisor-a',idempotencyKey:'hold-1',tripId:'t1',reason:'Unverified inbound evidence'});
  assert.equal(h.status,'ON_HOLD');
  const repeat=await holdTrip(db,{actorId:'supervisor-a',idempotencyKey:'hold-1',tripId:'t1',reason:'Unverified inbound evidence'});
  assert.equal(repeat.replayed,true);
  const gate=(await q("SELECT active_trip_id,last_released_sequence_no FROM aimoc_execution_v1.marine_gates WHERE dispatch_id='d1'")).rows[0];
  assert.equal(gate.active_trip_id,'t1');
  assert.equal(gate.last_released_sequence_no,0);
  assert.equal((await q("SELECT count(*)::int AS c FROM aimoc_execution_v1.resource_claims WHERE released_at IS NULL")).rows[0].c,1);
  await assert.rejects(()=>startMarineTrip(db,{actorId:'operator-start',idempotencyKey:'start-t2-held',tripId:'t2'}),e=>e.code==='SEQUENCE_GATE_BUSY');
  await assert.rejects(()=>resolveTripHold(db,{actorId:'supervisor-a',idempotencyKey:'resolve-self',tripId:'t1',resolutionNote:'Inspection complete'}),e=>e.code==='HOLD_SELF_APPROVAL_FORBIDDEN');
  const r=await resolveTripHold(db,{actorId:'supervisor-b',idempotencyKey:'resolve-second',tripId:'t1',resolutionNote:'Equipment inspected and signed'});
  assert.equal(r.status,'START_AUTHORIZED');
  assert.equal((await q("SELECT active_trip_id FROM aimoc_execution_v1.marine_gates WHERE dispatch_id='d1'")).rows[0].active_trip_id,'t1');
  assert.equal((await q("SELECT count(*)::int AS c FROM aimoc_execution_v1.resource_claims WHERE released_at IS NULL")).rows[0].c,1);
  const history=(await q('SELECT opened_by,resolved_by FROM aimoc_execution_v1.trip_holds')).rows;
  assert.equal(history.length,1);
  assert.equal(history[0].resolved_by,'supervisor-b');
 }finally{await db.close();}
});
