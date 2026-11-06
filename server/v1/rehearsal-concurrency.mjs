import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {createDatabase} from '../database.mjs';
import {createIsolatedExecutionSchema,startMarineTrip} from './execution-staging.mjs';
import {extendIsolatedExecutionSchema} from './phase4b-schema.mjs';
import {extendExecutionPhase4D} from './phase4d-schema.mjs';
import {reserveDispatchInventory} from './phase4b-inventory.mjs';

/**
 * ONLY executes against explicit ephemeral, locally-created rehearsal DB.
 * The caller must create/clean the ephemeral database using the local-socket
 * shell script. An arbitrary DATABASE_URL is rejected.
 */
export async function runConcurrencyRehearsal({databaseName}={}){
 if(process.env.DATABASE_URL)throw Error('REMOTE_DATABASE_URL_NOT_ALLOWED');
 if(!/^aimoc_rehearsal_[a-f0-9]{12}$/.test(databaseName||''))throw Error('REHEARSAL_DB_NAME_REQUIRED');
 const pool=createDatabase('postgresql:///'+databaseName+'?host=/tmp');
 try{
  await createIsolatedExecutionSchema(pool);
  await extendIsolatedExecutionSchema(pool);
  await extendExecutionPhase4D(pool);
  await pool.query("INSERT INTO aimoc_execution_v1.voyage_capacity(voyage_id,capacity_t,reserved_t,status) VALUES('v1',100,80,'READY')");
  await pool.query("INSERT INTO aimoc_execution_v1.jetty_windows(id,voyage_id,jetty_id,starts_at,ends_at,status) VALUES('window-1','v1','j1',now()-interval '1 hour',now()+interval '1 day','READY')");
  await pool.query("INSERT INTO aimoc_execution_v1.dispatches(id,mode,status,voyage_id,source_stockpile_id,destination_location_id,sku_id,planned_quantity_t) VALUES ('d1','MARINE','READY','v1','s1','j1','sku1',80)");
  await pool.query("UPDATE aimoc_execution_v1.dispatches SET jetty_window_id='window-1' WHERE id='d1'");
  await pool.query("INSERT INTO aimoc_execution_v1.voyage_dispatch_allocations(dispatch_id,voyage_id,allocated_t) VALUES('d1','v1',80)");
  await pool.query("INSERT INTO aimoc_execution_v1.trips(id,dispatch_id,sequence_no,status,truck_id,driver_id,planned_quantity_t) VALUES ('t1','d1',1,'QUEUED','truck1','driver1',40),('t2','d1',2,'QUEUED','truck2','driver2',40)");
  await pool.query("INSERT INTO aimoc_execution_v1.marine_gates(dispatch_id) VALUES('d1')");
  await pool.query("INSERT INTO aimoc_execution_v1.inventory_reservations(id,dispatch_id,source_stockpile_id,sku_id,reserved_t,status) VALUES ('reservation','d1','s1','sku1',80,'ACTIVE')");
  await pool.query("INSERT INTO aimoc_execution_v1.driver_profiles(id,external_user_id,display_name) VALUES('driver1','user1','QA Driver 1'),('driver2','user2','QA Driver 2')");
  await pool.query("INSERT INTO aimoc_execution_v1.fleet_vehicle_specs(truck_id,payload_limit_t) VALUES('truck1',45),('truck2',45)");
  const attempts=await Promise.allSettled([
   startMarineTrip(pool,{actorId:'admin-a',idempotencyKey:randomUUID(),tripId:'t1'}),
   startMarineTrip(pool,{actorId:'admin-b',idempotencyKey:randomUUID(),tripId:'t1'})
  ]);
  const fulfilled=attempts.filter(x=>x.status==='fulfilled');
  const refused=attempts.filter(x=>x.status==='rejected');
  if(fulfilled.length!==1||refused.length!==1)throw Error('CONCURRENT_START_NOT_EXCLUSIVE: '+JSON.stringify(attempts));
  const final=(await pool.query("SELECT status FROM aimoc_execution_v1.trips WHERE id='t1'")).rows[0];
  const gate=(await pool.query("SELECT active_trip_id,version FROM aimoc_execution_v1.marine_gates WHERE dispatch_id='d1'")).rows[0];
  const claims=(await pool.query('SELECT count(*)::int AS count FROM aimoc_execution_v1.resource_claims WHERE released_at IS NULL')).rows[0].count;
  const events=(await pool.query("SELECT count(*)::int AS count FROM aimoc_execution_v1.operational_events WHERE event_type='TRIP_START_AUTHORIZED'")).rows[0].count;
  if(final.status!=='START_AUTHORIZED'||gate.active_trip_id!=='t1'||claims!==1||events!==1)throw Error('CONCURRENT_START_INCONSISTENT');
  const pending=await Promise.allSettled([
   startMarineTrip(pool,{actorId:'admin-c',idempotencyKey:randomUUID(),tripId:'t2'}),
   startMarineTrip(pool,{actorId:'admin-d',idempotencyKey:randomUUID(),tripId:'t2'})
  ]);
  if(pending.some(x=>x.status==='fulfilled'))throw Error('GATE_FAILED_TO_BLOCK_NEXT_TRIP');
  // Exactly-once concurrent retries for one idempotency key.
  const sameKey='replay-lock-test';
  const same=await Promise.allSettled([
    startMarineTrip(pool,{actorId:'actor-same',idempotencyKey:sameKey,tripId:'t2'}),
    startMarineTrip(pool,{actorId:'actor-same',idempotencyKey:sameKey,tripId:'t2'})
  ]);
  // The blocked next trip remains blocked; ensure no mutation and no partial receipt.
  if(same.some(x=>x.status==='fulfilled'))throw Error('NEXT_TRIP_IGNORED_GATE');
  await pool.query("INSERT INTO aimoc_execution_v1.dispatches(id,mode,status,voyage_id,source_stockpile_id,destination_location_id,sku_id,planned_quantity_t) VALUES ('d3','LAND','PLANNED',NULL,'s2','dest','sku2',80),('d4','LAND','PLANNED',NULL,'s2','dest','sku2',80)");
  await pool.query("INSERT INTO aimoc_execution_v1.trips(id,dispatch_id,sequence_no,status,truck_id,driver_id,planned_quantity_t) VALUES ('t3','d3',1,'QUEUED','truck3','driver3',80),('t4','d4',1,'QUEUED','truck4','driver4',80)");
  await pool.query("INSERT INTO aimoc_execution_v1.inventory_accounts(location_id,sku_id,on_hand_t,reserved_t) VALUES('s2','sku2',100,0)");
  const concurrentReservations=await Promise.allSettled([
   reserveDispatchInventory(pool,{actorId:'actor3',idempotencyKey:'reserve-d3',dispatchId:'d3'}),
   reserveDispatchInventory(pool,{actorId:'actor4',idempotencyKey:'reserve-d4',dispatchId:'d4'})
  ]);
  if(concurrentReservations.filter(x=>x.status==='fulfilled').length!==1 ||
     concurrentReservations.filter(x=>x.status==='rejected').length!==1)
      throw Error('CONCURRENT_STOCK_OVERSUBSCRIBED');
  const stock=(await pool.query("SELECT on_hand_t,reserved_t FROM aimoc_execution_v1.inventory_accounts WHERE location_id='s2'")).rows[0];
  if(Number(stock.on_hand_t)!==100||Number(stock.reserved_t)!==80)throw Error('STOCK_LEDGER_INVARIANT_FAILED');
  const winning=concurrentReservations[0].status==='fulfilled'?'d3':'d4';
  const replayKey=winning==='d3'?'reserve-d3':'reserve-d4';
  const replayActor=winning==='d3'?'actor3':'actor4';
  const repeated=await Promise.allSettled([
   reserveDispatchInventory(pool,{actorId:replayActor,idempotencyKey:replayKey,dispatchId:winning}),
   reserveDispatchInventory(pool,{actorId:replayActor,idempotencyKey:replayKey,dispatchId:winning})
  ]);
  if(repeated.some(x=>x.status!=='fulfilled'||x.value.replayed!==true))throw Error('CONCURRENT_IDEMPOTENCY_NOT_REPLAYED');
  // Separate dispatches within one shared voyage cannot oversell vessel cargo capacity.
  await pool.query("INSERT INTO aimoc_execution_v1.voyage_capacity(voyage_id,capacity_t,status) VALUES('v2',70,'READY')");
  await pool.query("INSERT INTO aimoc_execution_v1.jetty_windows(id,voyage_id,jetty_id,starts_at,ends_at,status) VALUES('window-v2','v2','jetty2',now()-interval '1 hour',now()+interval '1 day','READY')");
  await pool.query("INSERT INTO aimoc_execution_v1.dispatches(id,mode,status,voyage_id,source_stockpile_id,destination_location_id,sku_id,planned_quantity_t,jetty_window_id) VALUES('d5','MARINE','PLANNED','v2','s3','jetty2','sku3',40,'window-v2'),('d6','MARINE','PLANNED','v2','s3','jetty2','sku3',40,'window-v2')");
  await pool.query("INSERT INTO aimoc_execution_v1.trips(id,dispatch_id,sequence_no,status,truck_id,driver_id,planned_quantity_t) VALUES('t5','d5',1,'QUEUED','truck5','driver5',40),('t6','d6',1,'QUEUED','truck6','driver6',40)");
  await pool.query("INSERT INTO aimoc_execution_v1.marine_gates(dispatch_id) VALUES('d5'),('d6')");
  await pool.query("INSERT INTO aimoc_execution_v1.inventory_accounts(location_id,sku_id,on_hand_t) VALUES('s3','sku3',200)");
  const sharedVoyage=await Promise.allSettled([
    reserveDispatchInventory(pool,{actorId:'admin5',idempotencyKey:'reserve-v2-d5',dispatchId:'d5'}),
    reserveDispatchInventory(pool,{actorId:'admin6',idempotencyKey:'reserve-v2-d6',dispatchId:'d6'})
  ]);
  if(sharedVoyage.filter(x=>x.status==='fulfilled').length!==1||
     sharedVoyage.filter(x=>x.status==='rejected').length!==1||
     sharedVoyage.find(x=>x.status==='rejected').reason.code!=='VOYAGE_CAPACITY_EXCEEDED')
       throw Error('CONCURRENT_VOYAGE_CAPACITY_EXCEEDED');
  const voyage=(await pool.query("SELECT reserved_t FROM aimoc_execution_v1.voyage_capacity WHERE voyage_id='v2'")).rows[0];
  if(Number(voyage.reserved_t)!==40)throw Error('VOYAGE_RESERVED_BALANCE_INVALID');
  return {postgresql:true,db:databaseName,concurrentStart:{accepted:fulfilled.length,rejected:refused.length},
   outcome:final.status,activeGate:gate.active_trip_id,openClaims:claims,events,secondTripBlocked:true,
   rejectedCodes:refused.map(x=>x.reason?.code||'UNSPECIFIED'), stockReservation:{accepted:1,rejected:1,onHand:100,reserved:80}, concurrentIdempotencyReplays:2, sharedVoyage:{accepted:1,rejected:1,capacity:70,reserved:40}};
 }finally{await pool.close();}
}
