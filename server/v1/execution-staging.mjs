import {readFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {reconcilePendingWeighbridgeEventsInTransaction} from './phase4b-weighbridge.mjs';
import {requireFleetQueueTurn} from './fleet-queue.mjs';
import {refreshDispatchProgress} from './dispatch-progress.mjs';

const fail=(code,message,status=409)=>{throw Object.assign(new Error(message),{status,code});};
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const row=async (c,sql,args=[]) => (await c.query(sql,args)).rows[0];

export async function createIsolatedExecutionSchema(db){
  // Only call on an explicitly chosen staging/test DB. Never called by production startup.
  const sql=await readFile(new URL('./execution-staging.sql',import.meta.url),'utf8');
  // PGlite requires one prepared statement at a time. This migration only
  // contains DDL and no semicolon-bearing procedural blocks.
  for(const statement of sql.split(';').map(x=>x.trim()).filter(Boolean)) await db.query(statement);
}

async function once(c,{actorId,idempotencyKey,command,payload},execute){
  if(typeof actorId!=='string'||!actorId||typeof idempotencyKey!=='string'||!idempotencyKey||idempotencyKey.length>120)
    fail('INVALID_IDEMPOTENCY','Actor and idempotency key required',400);
  await c.query('INSERT INTO aimoc_execution_v1.idempotency_locks(actor_id,idempotency_key) VALUES($1,$2) ON CONFLICT DO NOTHING',[actorId,idempotencyKey]);
  await c.query('SELECT 1 FROM aimoc_execution_v1.idempotency_locks WHERE actor_id=$1 AND idempotency_key=$2 FOR UPDATE',[actorId,idempotencyKey]);
  const h=digest([command,payload]);
  const old=await row(c,'SELECT command_hash,result FROM aimoc_execution_v1.command_receipts WHERE actor_id=$1 AND idempotency_key=$2 FOR UPDATE',[actorId,idempotencyKey]);
  if(old){
    if(old.command_hash!==h)fail('IDEMPOTENCY_KEY_REUSED','Key already used with a different command');
    return {...old.result,replayed:true};
  }
  const result=await execute();
  await c.query('INSERT INTO aimoc_execution_v1.command_receipts(actor_id,idempotency_key,command_hash,result) VALUES($1,$2,$3,$4::jsonb)',[actorId,idempotencyKey,h,JSON.stringify(result)]);
  return result;
}

/**
 * Marine Option B retains its per-dispatch unload gate. Distinct trucks may
 * proceed after predecessor unload; queued jobs sharing its truck/Driver must
 * also wait for independently verified return, including across dispatches.
 */
export async function startMarineTrip(db,{actorId,idempotencyKey,tripId}){
  return db.transaction(async c=>once(c,{actorId,idempotencyKey,command:'startMarineTrip',payload:{tripId}},async()=>{
    // Lock trip and parent sequence gate in a stable order.
    const t0=await row(c,'SELECT dispatch_id FROM aimoc_execution_v1.trips WHERE id=$1',[tripId]);
    if(!t0)fail('TRIP_NOT_FOUND','Trip not found',404);
    const d=await row(c,'SELECT * FROM aimoc_execution_v1.dispatches WHERE id=$1 FOR UPDATE',[t0.dispatch_id]);
    const gate=await row(c,'SELECT * FROM aimoc_execution_v1.marine_gates WHERE dispatch_id=$1 FOR UPDATE',[d.id]);
    const t=await row(c,'SELECT * FROM aimoc_execution_v1.trips WHERE id=$1 FOR UPDATE',[tripId]);
    if(d.mode!=='MARINE'||!d.voyage_id||!['READY','ACTIVE'].includes(d.status))fail('DISPATCH_NOT_READY','Marine dispatch not executable');
    const voyageSchema=await row(c,"SELECT to_regclass('aimoc_execution_v1.voyage_capacity') AS oid");
    if(voyageSchema?.oid){
      const voyage=await row(c,'SELECT status FROM aimoc_execution_v1.voyage_capacity WHERE voyage_id=$1',[d.voyage_id]);
      const allocation=await row(c,'SELECT allocated_t FROM aimoc_execution_v1.voyage_dispatch_allocations WHERE dispatch_id=$1 AND voyage_id=$2',[d.id,d.voyage_id]);
      const window=await row(c,'SELECT * FROM aimoc_execution_v1.jetty_windows WHERE id=$1',[d.jetty_window_id]);
      if(!voyage||voyage.status!=='READY'||!allocation||Number(allocation.allocated_t)!==Number(d.planned_quantity_t))
        fail('VOYAGE_NOT_READY','Approved voyage and dispatch allocation are required');
      if(!window||window.voyage_id!==d.voyage_id||window.jetty_id!==d.destination_location_id||window.status!=='READY')
        fail('JETTY_SLOT_NOT_READY','Approved jetty window is required');
    }
    if(!gate)fail('SEQUENCE_GATE_MISSING','Gate missing');
    if(gate.active_trip_id)fail('SEQUENCE_GATE_BUSY','Pre-unload trip still owns gate');
    if(t.status!=='QUEUED')fail('INVALID_TRIP_STATE','Trip must be queued');
    if(t.sequence_no!==gate.last_released_sequence_no+1)fail('SEQUENCE_OUT_OF_SYNC','Trip not next in dispatch sequence');
    if(t.sequence_no>1){
      const prior=await row(c,'SELECT * FROM aimoc_execution_v1.trips WHERE dispatch_id=$1 AND sequence_no=$2 FOR UPDATE',[d.id,t.sequence_no-1]);
      if(!prior||!prior.unloaded_verified_at)fail('PREVIOUS_TRIP_NOT_UNLOADED','Previous trip final unload not verified');
      const settled=await row(c,`SELECT s.id FROM aimoc_execution_v1.unload_settlements s
        JOIN aimoc_execution_v1.receipts r ON r.id=s.receipt_id AND r.trip_id=s.trip_id
        WHERE s.trip_id=$1 AND s.status='VERIFIED' AND s.verified_at IS NOT NULL
          AND r.status='VERIFIED' AND r.verified_at IS NOT NULL`,[prior.id]);
      if(!settled)fail('PREVIOUS_TRIP_NOT_UNLOADED','Receipt and final settlement proof required');
    }
    const reserved=await row(c,`SELECT COALESCE(SUM(reserved_t),0) AS reserved_t FROM aimoc_execution_v1.inventory_reservations
      WHERE dispatch_id=$1 AND source_stockpile_id=$2 AND sku_id=$3 AND status='ACTIVE'`,[d.id,d.source_stockpile_id,d.sku_id]);
    if(Number(reserved?.reserved_t)<Number(t.planned_quantity_t))
      fail('STOCK_NOT_RESERVED','Active material reservation required');
    const profileTable=await row(c,"SELECT to_regclass('aimoc_execution_v1.driver_profiles') AS oid");
    if(profileTable?.oid){
      const driver=await row(c,'SELECT id,external_user_id FROM aimoc_execution_v1.driver_profiles WHERE id=$1 AND active=true',[t.driver_id]);
      const vehicle=await row(c,'SELECT truck_id,payload_limit_t FROM aimoc_execution_v1.fleet_vehicle_specs WHERE truck_id=$1 AND active=true',[t.truck_id]);
      if(!driver)fail('DRIVER_NOT_LINKED','Active Driver profile required');
      const identityTable=await row(c,"SELECT to_regclass('aimoc_execution_v1.driver_identity_bindings') AS oid");
      if(identityTable?.oid){
        const identity=await row(c,"SELECT status,verified_at FROM aimoc_execution_v1.driver_identity_bindings WHERE driver_id=$1 AND user_id=$2",[t.driver_id,driver?.external_user_id]);
        if(identity?.status!=='ACTIVE'||!identity.verified_at)
          fail('DRIVER_IDENTITY_UNVERIFIED','Independent Driver identity verification required');
      }

      if(!vehicle)fail('TRUCK_SPEC_MISSING','Active vehicle master required');
      if(Number(t.planned_quantity_t)>Number(vehicle.payload_limit_t))
        fail('TRUCK_PAYLOAD_EXCEEDED','Planned trip exceeds truck capacity');
    }
    await requireFleetQueueTurn(c,t);
    const claimed=await row(c,'SELECT id FROM aimoc_execution_v1.resource_claims WHERE released_at IS NULL AND (truck_id=$1 OR driver_id=$2) LIMIT 1',[t.truck_id,t.driver_id]);
    if(claimed)fail('RESOURCE_BUSY','Truck or driver already claimed');
    await c.query('INSERT INTO aimoc_execution_v1.resource_claims(id,trip_id,truck_id,driver_id) VALUES ($1,$2,$3,$4)',
      [randomUUID(),t.id,t.truck_id,t.driver_id]);
    await c.query(`UPDATE aimoc_execution_v1.trips SET status='START_AUTHORIZED',started_at=now() WHERE id=$1`,[t.id]);
    await c.query('UPDATE aimoc_execution_v1.marine_gates SET active_trip_id=$1,version=version+1 WHERE dispatch_id=$2',[t.id,d.id]);
    if(d.status==='READY')await c.query(`UPDATE aimoc_execution_v1.dispatches SET status='ACTIVE' WHERE id=$1`,[d.id]);
    await c.query('INSERT INTO aimoc_execution_v1.operational_events(id,trip_id,event_type,actor_id) VALUES($1,$2,$3,$4)',[randomUUID(),t.id,'TRIP_START_AUTHORIZED',actorId]);
    await reconcilePendingWeighbridgeEventsInTransaction(c,{tripId:t.id});
    const current=await row(c,'SELECT status FROM aimoc_execution_v1.trips WHERE id=$1',[t.id]);
    return {trip_id:t.id,status:current.status,dispatch_id:d.id,sequence_gate_occupied:true};
  }));
}

/** Requires independently verified receiving evidence, not a Driver report. */
export async function finalizeMarineUnload(db,{actorId,idempotencyKey,tripId}){
  return db.transaction(async c=>once(c,{actorId,idempotencyKey,command:'finalizeMarineUnload',payload:{tripId}},async()=>{
    const t0=await row(c,'SELECT dispatch_id FROM aimoc_execution_v1.trips WHERE id=$1',[tripId]);
    if(!t0)fail('TRIP_NOT_FOUND','Trip not found',404);
    const d=await row(c,'SELECT * FROM aimoc_execution_v1.dispatches WHERE id=$1 FOR UPDATE',[t0.dispatch_id]);
    const gate=await row(c,'SELECT * FROM aimoc_execution_v1.marine_gates WHERE dispatch_id=$1 FOR UPDATE',[d.id]);
    const trip=await row(c,'SELECT * FROM aimoc_execution_v1.trips WHERE id=$1 FOR UPDATE',[tripId]);
    const custodyTable=await row(c,"SELECT to_regclass('aimoc_execution_v1.cargo_custody') AS oid");
    if(custodyTable?.oid){
      const custody=await row(c,'SELECT * FROM aimoc_execution_v1.cargo_custody WHERE trip_id=$1 FOR UPDATE',[trip.id]);
      if(!custody||custody.status!=='RECEIVED'||Number(custody.shipped_t)!==Number(custody.received_t))
        fail('CARGO_NOT_SETTLED','Verified full destination custody required');
      const permitted=await row(c,`SELECT 1 AS ok FROM aimoc_execution_v1.operator_permissions
        WHERE actor_id=$1 AND location_id=$2 AND permission='receiving.verify'`,[actorId,custody.destination_location_id]);
      if(!permitted)fail('RECEIVER_NOT_AUTHORIZED','Actor lacks receiving permission',403);
    }
    if(!gate||gate.active_trip_id!==trip.id)fail('SEQUENCE_GATE_MISMATCH','Trip is not the current gate owner');
    if(trip.status!=='ARRIVED')fail('TRIP_NOT_ARRIVED','Trip must arrive first');
    const evidence=await row(c,`SELECT s.id FROM aimoc_execution_v1.unload_settlements s
      JOIN aimoc_execution_v1.receipts r ON r.id=s.receipt_id AND r.trip_id=s.trip_id
      WHERE s.trip_id=$1 AND s.status='VERIFIED' AND s.verified_at IS NOT NULL
        AND s.authorized_actor_id=$2 AND r.receiving_actor_id=$2
        AND r.status='VERIFIED' AND r.verified_at IS NOT NULL`,[trip.id,actorId]);
    if(!evidence)fail('UNLOAD_NOT_FINAL','Authorized verified receipt and settlement required');
    await c.query(`UPDATE aimoc_execution_v1.trips SET status='UNLOADED_VERIFIED',unloaded_verified_at=now() WHERE id=$1`,[trip.id]);
    await c.query('UPDATE aimoc_execution_v1.marine_gates SET active_trip_id=NULL,last_released_sequence_no=$1,version=version+1 WHERE dispatch_id=$2',[trip.sequence_no,d.id]);
    await c.query('INSERT INTO aimoc_execution_v1.operational_events(id,trip_id,event_type,actor_id) VALUES($1,$2,$3,$4)',[randomUUID(),trip.id,'TRIP_UNLOADED_VERIFIED',actorId]);
    const dispatchStatus=await refreshDispatchProgress(c,d.id);
    return {trip_id:trip.id,status:'UNLOADED_VERIFIED',sequence_released:trip.sequence_no,truck_still_claimed:true,dispatch_status:dispatchStatus};
  }));
}

/** Return is a separate milestone; only then release occupied truck/driver. */
export async function verifyMarineTripReturn(db,{actorId,idempotencyKey,tripId}){
  return db.transaction(async c=>once(c,{actorId,idempotencyKey,command:'verifyMarineTripReturn',payload:{tripId}},async()=>{
    const t0=await row(c,'SELECT dispatch_id FROM aimoc_execution_v1.trips WHERE id=$1',[tripId]);
    if(!t0)fail('TRIP_NOT_FOUND','Trip not found',404);
    await c.query('SELECT id FROM aimoc_execution_v1.dispatches WHERE id=$1 FOR UPDATE',[t0.dispatch_id]);
    const trip=await row(c,'SELECT * FROM aimoc_execution_v1.trips WHERE id=$1 FOR UPDATE',[tripId]);
    if(!['UNLOADED_VERIFIED','RETURNING'].includes(trip.status)||!trip.unloaded_verified_at)
      fail('TRIP_NOT_RETURNING','Verified unloading is required before return');
    const v=await row(c,'SELECT * FROM aimoc_execution_v1.return_verifications WHERE trip_id=$1',[tripId]);
    if(!v||v.authorized_actor_id!==actorId||!v.vehicle_ready)fail('RETURN_NOT_VERIFIED','Independent ready-to-reassign return proof required');
    const permissionTable=await row(c,"SELECT to_regclass('aimoc_execution_v1.operator_permissions') AS oid");
    if(permissionTable?.oid){
      const d=await row(c,'SELECT source_stockpile_id FROM aimoc_execution_v1.dispatches WHERE id=$1',[trip.dispatch_id]);
      const allowed=await row(c,`SELECT 1 AS ok FROM aimoc_execution_v1.operator_permissions
        WHERE actor_id=$1 AND location_id=$2 AND permission='return.verify'`,[actorId,d.source_stockpile_id]);
      if(!allowed)fail('RETURN_VERIFIER_FORBIDDEN','Actor lacks return permission',403);
    }

    const claim=await row(c,'SELECT * FROM aimoc_execution_v1.resource_claims WHERE trip_id=$1 AND released_at IS NULL FOR UPDATE',[tripId]);
    if(!claim)fail('CLAIM_NOT_FOUND','Active resource occupancy missing');
    await c.query('UPDATE aimoc_execution_v1.resource_claims SET released_at=now() WHERE id=$1',[claim.id]);
    await c.query(`UPDATE aimoc_execution_v1.trips SET status='RETURNED_AVAILABLE',returned_available_at=now() WHERE id=$1`,[trip.id]);
    await c.query('INSERT INTO aimoc_execution_v1.operational_events(id,trip_id,event_type,actor_id) VALUES($1,$2,$3,$4)',[randomUUID(),trip.id,'TRIP_RETURNED_AVAILABLE',actorId]);
    const dispatchStatus=await refreshDispatchProgress(c,trip.dispatch_id);
    return {trip_id:trip.id,status:'RETURNED_AVAILABLE',resource_claim_released:true,dispatch_status:dispatchStatus};
  }));
}

/**
 * Land trips share dispatch/inventory state, but never require a marine gate.
 * This is still a staging-only service: not wired to publicly callable v1 writes.
 */
export async function startLandTrip(db,{actorId,idempotencyKey,tripId}){
  return db.transaction(async c=>once(c,{actorId,idempotencyKey,command:'startLandTrip',payload:{tripId}},async()=>{
    const t0=await row(c,'SELECT dispatch_id FROM aimoc_execution_v1.trips WHERE id=$1',[tripId]);
    if(!t0)fail('TRIP_NOT_FOUND','Trip not found',404);
    const dispatch=await row(c,'SELECT * FROM aimoc_execution_v1.dispatches WHERE id=$1 FOR UPDATE',[t0.dispatch_id]);
    const trip=await row(c,'SELECT * FROM aimoc_execution_v1.trips WHERE id=$1 FOR UPDATE',[tripId]);
    if(dispatch.mode!=='LAND'||dispatch.voyage_id||!['READY','ACTIVE'].includes(dispatch.status))
      fail('DISPATCH_NOT_READY','Valid land dispatch required');
    if(trip.status!=='QUEUED')fail('INVALID_TRIP_STATE','Only queued trips can start');
    const reserved=await row(c,`SELECT COALESCE(SUM(reserved_t),0) AS reserved_t
      FROM aimoc_execution_v1.inventory_reservations WHERE dispatch_id=$1
      AND source_stockpile_id=$2 AND sku_id=$3 AND status='ACTIVE'`,
      [dispatch.id,dispatch.source_stockpile_id,dispatch.sku_id]);
    if(Number(reserved?.reserved_t)<Number(trip.planned_quantity_t))
      fail('STOCK_NOT_RESERVED','Active stock reservation required');
    const profileTable=await row(c,"SELECT to_regclass('aimoc_execution_v1.driver_profiles') AS oid");
    if(profileTable?.oid){
      const driver=await row(c,'SELECT id,external_user_id FROM aimoc_execution_v1.driver_profiles WHERE id=$1 AND active=true',[trip.driver_id]);
      const vehicle=await row(c,'SELECT truck_id,payload_limit_t FROM aimoc_execution_v1.fleet_vehicle_specs WHERE truck_id=$1 AND active=true',[trip.truck_id]);
      if(!driver)fail('DRIVER_NOT_LINKED','Active Driver profile required');
      const identityTable=await row(c,"SELECT to_regclass('aimoc_execution_v1.driver_identity_bindings') AS oid");
      if(identityTable?.oid){
        const identity=await row(c,"SELECT status,verified_at FROM aimoc_execution_v1.driver_identity_bindings WHERE driver_id=$1 AND user_id=$2",[trip.driver_id,driver?.external_user_id]);
        if(identity?.status!=='ACTIVE'||!identity.verified_at)
          fail('DRIVER_IDENTITY_UNVERIFIED','Independent Driver identity verification required');
      }

      if(!vehicle)fail('TRUCK_SPEC_MISSING','Active vehicle master required');
      if(Number(trip.planned_quantity_t)>Number(vehicle.payload_limit_t))
        fail('TRUCK_PAYLOAD_EXCEEDED','Planned cargo above payload');
    }
    await requireFleetQueueTurn(c,trip);
    const claim=await row(c,`SELECT id FROM aimoc_execution_v1.resource_claims
      WHERE released_at IS NULL AND (truck_id=$1 OR driver_id=$2) LIMIT 1`,[trip.truck_id,trip.driver_id]);
    if(claim)fail('RESOURCE_BUSY','Truck or driver busy');
    await c.query('INSERT INTO aimoc_execution_v1.resource_claims(id,trip_id,truck_id,driver_id) VALUES($1,$2,$3,$4)',
      [randomUUID(),trip.id,trip.truck_id,trip.driver_id]);
    await c.query(`UPDATE aimoc_execution_v1.trips SET status='START_AUTHORIZED',started_at=now() WHERE id=$1`,[trip.id]);
    if(dispatch.status==='READY')await c.query(`UPDATE aimoc_execution_v1.dispatches SET status='ACTIVE' WHERE id=$1`,[dispatch.id]);
    await c.query('INSERT INTO aimoc_execution_v1.operational_events(id,trip_id,event_type,actor_id) VALUES($1,$2,$3,$4)',
      [randomUUID(),trip.id,'LAND_TRIP_START_AUTHORIZED',actorId]);
    await reconcilePendingWeighbridgeEventsInTransaction(c,{tripId:trip.id});
    const current=await row(c,'SELECT status FROM aimoc_execution_v1.trips WHERE id=$1',[trip.id]);
    return {trip_id:trip.id,status:current.status,dispatch_id:dispatch.id,mode:'LAND'};
  }));
}
