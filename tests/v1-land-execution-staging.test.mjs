import test from 'node:test';
import assert from 'node:assert/strict';
import {createEmbeddedDatabase} from '../server/database.mjs';
import {createIsolatedExecutionSchema,startLandTrip} from '../server/v1/execution-staging.mjs';

test('staging Land Dispatch starts distinct physical trips independently',async()=>{
 const db=await createEmbeddedDatabase();
 try{
  await createIsolatedExecutionSchema(db);
  const q=(sql,args=[])=>db.query(sql,args);
  await q(`INSERT INTO aimoc_execution_v1.dispatches(id,mode,status,voyage_id,source_stockpile_id,sku_id,planned_quantity_t)
    VALUES('land1','LAND','READY',NULL,'sp1','sku1',120)`);
  await q(`INSERT INTO aimoc_execution_v1.inventory_reservations(id,dispatch_id,source_stockpile_id,sku_id,reserved_t,status)
    VALUES('res','land1','sp1','sku1',120,'ACTIVE')`);
  await q(`INSERT INTO aimoc_execution_v1.trips(id,dispatch_id,sequence_no,status,truck_id,driver_id,planned_quantity_t)
    VALUES('l1','land1',1,'QUEUED','truck1','driver1',40),
          ('l2','land1',2,'QUEUED','truck2','driver2',40),
          ('l3','land1',3,'QUEUED','truck1','driver3',40)`);
  const [first,second]=await Promise.all([
    startLandTrip(db,{actorId:'admin',idempotencyKey:'land-1',tripId:'l1'}),
    startLandTrip(db,{actorId:'admin',idempotencyKey:'land-2',tripId:'l2'}),
  ]);
  assert.equal(first.status,'START_AUTHORIZED');
  assert.equal(second.status,'START_AUTHORIZED');
  const claims=(await q('SELECT count(*)::int AS count FROM aimoc_execution_v1.resource_claims WHERE released_at IS NULL')).rows[0];
  assert.equal(claims.count,2);
  await assert.rejects(()=>startLandTrip(db,{actorId:'admin',idempotencyKey:'land-3',tripId:'l3'}),e=>e.code==='RESOURCE_BUSY');
 } finally {await db.close();}
});
