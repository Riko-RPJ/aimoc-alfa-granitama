import test from 'node:test';
import assert from 'node:assert/strict';
import {createEmbeddedDatabase} from '../server/database.mjs';
import {createIsolatedExecutionSchema,startMarineTrip,finalizeMarineUnload,verifyMarineTripReturn} from '../server/v1/execution-staging.mjs';

test('isolated relational execution enforces Marine Option B in PostgreSQL-compatible transactions',async t=>{
 const db=await createEmbeddedDatabase();
 try{
  await createIsolatedExecutionSchema(db);
  const q=(sql,args=[])=>db.query(sql,args);
  await q(`INSERT INTO aimoc_execution_v1.dispatches(id,mode,status,voyage_id,source_stockpile_id,sku_id,planned_quantity_t)
    VALUES('d1','MARINE','READY','voyage1','stock1','sku1',120),
          ('d2','MARINE','READY','voyage1','stock1','sku1',40)`);
  await q(`INSERT INTO aimoc_execution_v1.trips(id,dispatch_id,sequence_no,status,truck_id,driver_id,planned_quantity_t)
    VALUES('t1','d1',1,'QUEUED','truck1','driver1',40),
          ('t2','d1',2,'QUEUED','truck2','driver2',40),
          ('t3','d1',3,'QUEUED','truck3','driver3',40),
          ('t-other','d2',1,'QUEUED','truck1','driver-other',40)`);
  await q(`INSERT INTO aimoc_execution_v1.marine_gates(dispatch_id) VALUES ('d1'),('d2')`);
  await q(`INSERT INTO aimoc_execution_v1.inventory_reservations(id,dispatch_id,source_stockpile_id,sku_id,reserved_t,status)
    VALUES('res1','d1','stock1','sku1',120,'ACTIVE'),
          ('res2','d2','stock1','sku1',40,'ACTIVE')`);

  await t.test('first trip starts atomically; duplicate key replays; next trip cannot start early',async()=>{
    const first=await startMarineTrip(db,{actorId:'admin1',idempotencyKey:'start1',tripId:'t1'});
    assert.equal(first.status,'START_AUTHORIZED');
    const retry=await startMarineTrip(db,{actorId:'admin1',idempotencyKey:'start1',tripId:'t1'});
    assert.equal(retry.replayed,true);
    await assert.rejects(()=>startMarineTrip(db,{actorId:'admin1',idempotencyKey:'start2wrong',tripId:'t2'}),e=>e.code==='SEQUENCE_GATE_BUSY');
    await assert.rejects(()=>startMarineTrip(db,{actorId:'admin1',idempotencyKey:'start1',tripId:'t2'}),e=>e.code==='IDEMPOTENCY_KEY_REUSED');
    await assert.rejects(()=>startMarineTrip(db,{actorId:'admin1',idempotencyKey:'otherdispatch',tripId:'t-other'}),e=>e.code==='RESOURCE_BUSY');
    const claims=await q('SELECT count(*)::int AS count FROM aimoc_execution_v1.resource_claims WHERE released_at IS NULL');
    assert.equal(claims.rows[0].count,1);
  });
  await t.test('partial/unverified and unauthorized unload never releases gate',async()=>{
    // Simulate independent arrival event and receipt entries in UAT only.
    await q(`UPDATE aimoc_execution_v1.trips SET status='ARRIVED' WHERE id='t1'`);
    await q(`INSERT INTO aimoc_execution_v1.receipts(id,trip_id,status,receiving_actor_id,source_event_id)
      VALUES('receipt1','t1','PENDING','receiver1','receipt-test-1')`);
    await q(`INSERT INTO aimoc_execution_v1.unload_settlements(id,trip_id,receipt_id,status)
      VALUES('settle1','t1','receipt1','PENDING')`);
    await assert.rejects(()=>finalizeMarineUnload(db,{actorId:'receiver1',idempotencyKey:'unload-pending',tripId:'t1'}),e=>e.code==='UNLOAD_NOT_FINAL');
    await q(`UPDATE aimoc_execution_v1.receipts SET status='VERIFIED',verified_at=now() WHERE id='receipt1'`);
    await q(`UPDATE aimoc_execution_v1.unload_settlements SET status='VERIFIED',verified_at=now(),authorized_actor_id='receiver1' WHERE id='settle1'`);
    await assert.rejects(()=>finalizeMarineUnload(db,{actorId:'unrelated',idempotencyKey:'wrong-actor',tripId:'t1'}),e=>e.code==='UNLOAD_NOT_FINAL');
    const gate=await q(`SELECT active_trip_id,last_released_sequence_no FROM aimoc_execution_v1.marine_gates WHERE dispatch_id='d1'`);
    assert.equal(gate.rows[0].active_trip_id,'t1');
    assert.equal(gate.rows[0].last_released_sequence_no,0);
  });
  await t.test('final verified unloading releases gate, not truck occupancy',async()=>{
    const release=await finalizeMarineUnload(db,{actorId:'receiver1',idempotencyKey:'unload-final',tripId:'t1'});
    assert.equal(release.sequence_released,1);
    const active=(await q(`SELECT released_at FROM aimoc_execution_v1.resource_claims WHERE trip_id='t1'`)).rows[0];
    assert.equal(active.released_at,null);
    const next=await startMarineTrip(db,{actorId:'admin1',idempotencyKey:'start-t2',tripId:'t2'});
    assert.equal(next.status,'START_AUTHORIZED');
    await assert.rejects(()=>startMarineTrip(db,{actorId:'admin1',idempotencyKey:'t3-early',tripId:'t3'}),e=>e.code==='SEQUENCE_GATE_BUSY');
  });
  await t.test('a hold does not release active sequence gate',async()=>{
    await q(`UPDATE aimoc_execution_v1.trips SET status='ON_HOLD' WHERE id='t2'`);
    await assert.rejects(()=>startMarineTrip(db,{actorId:'admin1',idempotencyKey:'t3-while-hold',tripId:'t3'}),e=>e.code==='SEQUENCE_GATE_BUSY');
    const gate=(await q(`SELECT active_trip_id FROM aimoc_execution_v1.marine_gates WHERE dispatch_id='d1'`)).rows[0];
    assert.equal(gate.active_trip_id,'t2');
  });
  await t.test('return only releases prior truck after independent verification',async()=>{
    await assert.rejects(()=>verifyMarineTripReturn(db,{actorId:'returnVerifier',idempotencyKey:'ret-pending',tripId:'t1'}),e=>e.code==='RETURN_NOT_VERIFIED');
    await q(`INSERT INTO aimoc_execution_v1.return_verifications(id,trip_id,verified_at,authorized_actor_id,vehicle_ready,source_event_id)
      VALUES('ret1','t1',now(),'returnVerifier',true,'return-test-1')`);
    const returned=await verifyMarineTripReturn(db,{actorId:'returnVerifier',idempotencyKey:'ret-final',tripId:'t1'});
    assert.equal(returned.status,'RETURNED_AVAILABLE');
    const resource=(await q(`SELECT released_at FROM aimoc_execution_v1.resource_claims WHERE trip_id='t1'`)).rows[0];
    assert.notEqual(resource.released_at,null);
    const differentDispatch=await startMarineTrip(db,{actorId:'admin1',idempotencyKey:'otherdispatch-ok',tripId:'t-other'});
    assert.equal(differentDispatch.status,'START_AUTHORIZED');
  });
  await t.test('unique constraints stop duplicate claims at DB layer',async()=>{
    await assert.rejects(()=>q(`INSERT INTO aimoc_execution_v1.resource_claims(id,trip_id,truck_id,driver_id)
      VALUES('conflict','t3','truck2','driver3')`),e=>e.code==='23505');
    const events=(await q(`SELECT event_type FROM aimoc_execution_v1.operational_events WHERE trip_id='t1' ORDER BY occurred_at`)).rows;
    assert.equal(events.length,3);
  });
 }finally{await db.close();}
});
