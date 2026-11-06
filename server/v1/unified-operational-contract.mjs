import {createHash,randomUUID} from 'node:crypto';
const fail=(code,message,status=409)=>{throw Object.assign(new Error(message),{code,status});};
const one=async(db,sql,params=[])=> (await db.query(sql,params)).rows[0];
const id=x=>typeof x==='string'&&/^[a-zA-Z0-9_-]{1,120}$/.test(x);
async function assignmentReceipt(c,{actorId,key,command,payload},execute){
 if(key==null)return execute(); // Only explicitly isolated internal tests may omit key.
 if(!id(key)||key.length<6)fail('IDEMPOTENCY_REQUIRED','Valid command key is required',400);
 await c.query('INSERT INTO aimoc_execution_v1.idempotency_locks(actor_id,idempotency_key) VALUES($1,$2) ON CONFLICT DO NOTHING',[actorId,key]);
 await c.query('SELECT 1 FROM aimoc_execution_v1.idempotency_locks WHERE actor_id=$1 AND idempotency_key=$2 FOR UPDATE',[actorId,key]);
 const digest=createHash('sha256').update(JSON.stringify([command,payload])).digest('hex');
 const old=await one(c,'SELECT command_hash,result FROM aimoc_execution_v1.command_receipts WHERE actor_id=$1 AND idempotency_key=$2 FOR UPDATE',[actorId,key]);
 if(old){
  if(old.command_hash!==digest)fail('IDEMPOTENCY_KEY_REUSED','Key used for a different command or payload');
  return {...old.result,replayed:true};
 }
 const result=await execute();
 await c.query('INSERT INTO aimoc_execution_v1.command_receipts(actor_id,idempotency_key,command_hash,result) VALUES($1,$2,$3,$4::jsonb)',
  [actorId,key,digest,JSON.stringify(result)]);
 return result;
}


/** Explicitly bind a planned dispatch to one of its stockpile's loading points. */
export async function assignDispatchLoadingPoint(db,{actorId,dispatchId,crusherId,loadingPointId,idempotencyKey=null}={}){
 if(!id(actorId)||!id(dispatchId)||!id(crusherId)||!id(loadingPointId))
   fail('LOCATION_ASSIGNMENT_INVALID','Identifiers are required',400);
 return db.transaction(async c=>assignmentReceipt(c,{actorId,key:idempotencyKey,command:'assign-loading-point',payload:{dispatchId,crusherId,loadingPointId}},async()=>{
  const dispatch=await one(c,'SELECT * FROM aimoc_execution_v1.dispatches WHERE id=$1 FOR UPDATE',[dispatchId]);
  if(!dispatch)fail('DISPATCH_NOT_FOUND','Dispatch not found',404);
  if(dispatch.status!=='PLANNED')fail('DISPATCH_ASSIGNMENT_LOCKED','Location may change only while planned');
  const reserved=await one(c,'SELECT 1 AS found FROM aimoc_execution_v1.inventory_reservations WHERE dispatch_id=$1',[dispatchId]);
  if(reserved)fail('DISPATCH_ALREADY_RESERVED','Reservation already exists');
  const crusher=await one(c,'SELECT * FROM aimoc_execution_v1.crusher_location_refs WHERE crusher_id=$1',[crusherId]);
  if(!crusher||crusher.status!=='ACTIVE'||crusher.source_stockpile_id!==dispatch.source_stockpile_id)
    fail('CRUSHER_STOCKPILE_MISMATCH','Crusher does not belong to dispatch source');
  const point=await one(c,'SELECT * FROM aimoc_execution_v1.loading_point_refs WHERE loading_point_id=$1',[loadingPointId]);
  if(!point||point.crusher_id!==crusherId||point.verification_status==='SUSPENDED')
    fail('LOADING_POINT_CRUSHER_MISMATCH','Loading point does not belong to active crusher');
  const current=await one(c,'SELECT * FROM aimoc_execution_v1.dispatch_loading_assignments WHERE dispatch_id=$1 FOR UPDATE',[dispatchId]);
  if(current && current.crusher_id===crusherId&&current.loading_point_id===loadingPointId&&
    current.loading_point_version===point.version)
    return {dispatch_id:dispatchId,crusher_id:crusherId,loading_point_id:loadingPointId,
      loading_point_version:point.version,location_status:point.verification_status,replayed:true};
  await c.query(`INSERT INTO aimoc_execution_v1.dispatch_loading_assignments
     (dispatch_id,crusher_id,loading_point_id,source_stockpile_id,loading_point_version,assigned_by)
     VALUES($1,$2,$3,$4,$5,$6)
     ON CONFLICT(dispatch_id) DO UPDATE SET
      crusher_id=EXCLUDED.crusher_id,loading_point_id=EXCLUDED.loading_point_id,
      source_stockpile_id=EXCLUDED.source_stockpile_id,
      loading_point_version=EXCLUDED.loading_point_version,
      assigned_by=EXCLUDED.assigned_by,assigned_at=now()`,
   [dispatchId,crusherId,loadingPointId,dispatch.source_stockpile_id,point.version,actorId]);
  return {dispatch_id:dispatchId,crusher_id:crusherId,loading_point_id:loadingPointId,
    loading_point_version:point.version,location_status:point.verification_status,replayed:false};
 }));
}

/** Persist a stable trip+driver+truck assignment before operational start. */
export async function bindTripDriverAssignment(db,{actorId,tripId,assignmentId,driverId=null,requireVerified=false,idempotencyKey=null}={}){
 if(!id(actorId)||!id(tripId)||!id(assignmentId))
   fail('DRIVER_ASSIGNMENT_INVALID','Explicit assignment ID, Trip and actor required',400);
 if(driverId!==null&&!id(driverId))fail('DRIVER_ASSIGNMENT_INVALID','Explicit Driver ID required',400);
 return db.transaction(async c=>assignmentReceipt(c,{actorId,key:idempotencyKey,command:'assign-driver',payload:{tripId,assignmentId,driverId}},async()=>{
  const trip=await one(c,'SELECT * FROM aimoc_execution_v1.trips WHERE id=$1 FOR UPDATE',[tripId]);
  if(!trip)fail('TRIP_NOT_FOUND','Trip not found',404);
  if(trip.status!=='QUEUED')fail('TRIP_ASSIGNMENT_LOCKED','Trip already started');
  const selectedDriverId=driverId??trip.driver_id;
  const driver=await one(c,'SELECT id,external_user_id FROM aimoc_execution_v1.driver_profiles WHERE id=$1 AND active=true FOR UPDATE',[selectedDriverId]);
  const truck=await one(c,'SELECT truck_id FROM aimoc_execution_v1.fleet_vehicle_specs WHERE truck_id=$1 AND active=true FOR UPDATE',[trip.truck_id]);
  if(!driver||!truck)fail('DRIVER_TRUCK_NOT_ACTIVE','Active authoritative references required');
  if(requireVerified){
   const binding=await one(c,`SELECT status,verified_at FROM aimoc_execution_v1.driver_identity_bindings
     WHERE driver_id=$1 AND user_id=$2`,[selectedDriverId,driver.external_user_id]);
   if(binding?.status!=='ACTIVE'||!binding.verified_at)
    fail('PENDING_DRIVER_VERIFICATION','Independently verified Driver identity required',409);
  }
  const activeClaim=await one(c,`SELECT id FROM aimoc_execution_v1.resource_claims
    WHERE released_at IS NULL AND (truck_id=$1 OR driver_id=$2) AND trip_id<>$3 LIMIT 1`,
   [trip.truck_id,selectedDriverId,tripId]);
  if(activeClaim)fail('DRIVER_TRUCK_BUSY','Truck or Driver has a conflicting active trip',409);
  const existingDriverTask=await one(c,`SELECT a.trip_id FROM aimoc_execution_v1.trip_driver_assignments a
    JOIN aimoc_execution_v1.trips t ON t.id=a.trip_id
    WHERE a.driver_id=$1 AND a.status='ASSIGNED' AND a.trip_id<>$2
      AND t.status NOT IN ('RETURNED_AVAILABLE','CANCELLED') LIMIT 1`,[selectedDriverId,tripId]);
  if(existingDriverTask)fail('DRIVER_ALREADY_ASSIGNED','Driver has another unclosed assignment',409);
  const existing=await one(c,'SELECT * FROM aimoc_execution_v1.trip_driver_assignments WHERE trip_id=$1',[tripId]);
  if(existing){
   if(existing.driver_id===selectedDriverId&&existing.assignment_id===assignmentId&&
      existing.truck_id===trip.truck_id&&existing.status==='ASSIGNED')
    return {assignment_id:assignmentId,trip_id:tripId,driver_id:selectedDriverId,truck_id:trip.truck_id,replayed:true};
   if(existing.status!=='ASSIGNED')
     fail('DRIVER_ASSIGNMENT_CONFLICT','Existing assignment identity or references differ');
   const evidence=await one(c,'SELECT 1 AS found FROM aimoc_execution_v1.weighbridge_inbox WHERE trip_id=$1 LIMIT 1',[tripId]);
   if(trip.qr_event_id||trip.tare_t!==null||evidence)
    fail('TRIP_ASSIGNMENT_LOCKED','Assignment cannot change after weighbridge evidence exists');
   await c.query('SET CONSTRAINTS aimoc_execution_v1.unified_trip_identity_fk DEFERRED');
   await c.query('UPDATE aimoc_execution_v1.trips SET driver_id=$1 WHERE id=$2',[selectedDriverId,tripId]);
   await c.query(`UPDATE aimoc_execution_v1.trip_driver_assignments
     SET assignment_id=$1,driver_id=$2,assigned_by=$3,assigned_at=now()
     WHERE trip_id=$4`,[assignmentId,selectedDriverId,actorId,tripId]);
   await c.query(`INSERT INTO aimoc_execution_v1.integration_outbox(id,aggregate_id,event_type,payload)
     VALUES($1,$2,'TRIP_DRIVER_REASSIGNED',$3::jsonb)`,
    [randomUUID(),tripId,JSON.stringify({previous_driver_id:existing.driver_id,driver_id:selectedDriverId,
      truck_id:trip.truck_id,assignment_id:assignmentId,assigned_by:actorId})]);
   return {assignment_id:assignmentId,trip_id:tripId,driver_id:selectedDriverId,truck_id:trip.truck_id,replayed:false};
  }
  if(selectedDriverId!==trip.driver_id){
   await c.query('SET CONSTRAINTS aimoc_execution_v1.unified_trip_identity_fk DEFERRED');
   await c.query('UPDATE aimoc_execution_v1.trips SET driver_id=$1 WHERE id=$2',[selectedDriverId,tripId]);
  }
  await c.query('INSERT INTO aimoc_execution_v1.trip_driver_assignments(assignment_id,trip_id,driver_id,truck_id,assigned_by,status) VALUES($1,$2,$3,$4,$5,$6)',
    [assignmentId,tripId,selectedDriverId,trip.truck_id,actorId,'ASSIGNED']);
  return {assignment_id:assignmentId,trip_id:tripId,driver_id:selectedDriverId,truck_id:trip.truck_id,replayed:false};
 }));
}

/**
 * One source-of-truth projection per trip, shared by Admin, Stockpile and
 * owning Driver. Never infer zero physical stock or verified GPS.
 */
export async function getUnifiedTripContext(db,{tripId}={}){
 if(!id(tripId))fail('TRIP_ID_INVALID','Valid Trip ID required',400);
 const t=await one(db,`SELECT t.*,d.mode,d.status AS dispatch_status,d.source_stockpile_id,
  d.destination_location_id,d.sku_id,d.planned_quantity_t AS dispatch_planned_quantity_t
  FROM aimoc_execution_v1.trips t JOIN aimoc_execution_v1.dispatches d ON d.id=t.dispatch_id
  WHERE t.id=$1`,[tripId]);
 if(!t)fail('TRIP_NOT_FOUND','Trip not found',404);
 const bindingTable=await one(db,"SELECT to_regclass('aimoc_execution_v1.driver_identity_bindings') AS oid");
 const [profile,account,reservation,link,assignment,tareEvent,binding]=await Promise.all([
  one(db,'SELECT id,external_user_id,display_name,active FROM aimoc_execution_v1.driver_profiles WHERE id=$1',[t.driver_id]),
  one(db,'SELECT location_id,sku_id,on_hand_t,reserved_t FROM aimoc_execution_v1.inventory_accounts WHERE location_id=$1 AND sku_id=$2',
   [t.source_stockpile_id,t.sku_id]),
  one(db,`SELECT a.reservation_id,a.reserved_t AS trip_reserved_t,a.consumed_t,r.status AS reservation_status
   FROM aimoc_execution_v1.trip_reservation_allocations a
   JOIN aimoc_execution_v1.inventory_reservations r ON r.id=a.reservation_id AND r.dispatch_id=$2
   WHERE a.trip_id=$1`,[t.id,t.dispatch_id]),
  one(db,`SELECT a.*,p.loading_point_name,p.latitude,p.longitude,
    p.version AS current_point_version,p.verification_status,p.verification_evidence_ref,
    c.crusher_name,c.zone,c.status AS crusher_status
   FROM aimoc_execution_v1.dispatch_loading_assignments a
   JOIN aimoc_execution_v1.crusher_location_refs c ON c.crusher_id=a.crusher_id
   JOIN aimoc_execution_v1.loading_point_refs p ON p.loading_point_id=a.loading_point_id AND p.crusher_id=a.crusher_id
   WHERE a.dispatch_id=$1`,[t.dispatch_id]),
  one(db,'SELECT assignment_id,driver_id,truck_id,status FROM aimoc_execution_v1.trip_driver_assignments WHERE trip_id=$1',[t.id]),
  one(db,`SELECT id,processing_status,failure_code FROM aimoc_execution_v1.weighbridge_inbox
   WHERE trip_id=$1 AND event_type='TARE_RECORDED' ORDER BY occurred_at DESC,authenticated_at DESC LIMIT 1`,[t.id]),
  bindingTable?.oid?one(db,`SELECT b.status,b.verified_at FROM aimoc_execution_v1.driver_identity_bindings b
   JOIN aimoc_execution_v1.driver_profiles p ON p.id=b.driver_id AND p.external_user_id=b.user_id
   WHERE b.driver_id=$1`,[t.driver_id]):null

 ]);
 const compatible=link&&link.source_stockpile_id===t.source_stockpile_id&&
  link.current_point_version===link.loading_point_version&&link.crusher_status==='ACTIVE';
 const verified=!!compatible&&link.verification_status==='VERIFIED';
 const location_status=!link?'NOT_ASSIGNED':!compatible?'STALE_MASTER':link.verification_status;
 const dest=link?{
  crusher_id:link.crusher_id,crusher_name:link.crusher_name,zone:link.zone,
  loading_point:{id:link.loading_point_id,name:link.loading_point_name,
    version:link.loading_point_version},
  latitude:verified?link.latitude:null,
  longitude:verified?link.longitude:null,
  location_status,verification_source:verified?'SITE_APPROVED':null,
  access_notes:null
 }:null;
 const identityVerified=bindingTable?.oid
  ?binding?.status==='ACTIVE'&&!!binding.verified_at
  :profile?.active===true;
 const tareStatus=tareEvent?.processing_status==='ACCEPTED'?'TARE_RECEIVED':
  tareEvent?.processing_status==='REJECTED'?'TARE_INVALID':'TARE_PENDING';
 return {
  schema_version:'1.0',trip_id:t.id,dispatch_id:t.dispatch_id,
  assignment_id:assignment?.assignment_id??null,driver_id:t.driver_id,truck_id:t.truck_id,
  driver_user_id:identityVerified?profile?.external_user_id??null:null,
  mode:t.mode,status:t.status,dispatch_status:t.dispatch_status,
  source_stockpile_id:t.source_stockpile_id,destination_location_id:t.destination_location_id,
  sku_id:t.sku_id,planned_quantity_t:String(t.planned_quantity_t),
  tare_t:t.tare_t===null?null:String(t.tare_t),gross_t:t.gross_t===null?null:String(t.gross_t),
  actual_net_t:t.actual_net_t===null?null:String(t.actual_net_t),
  started_at:t.started_at??null,unloaded_verified_at:t.unloaded_verified_at??null,
  returned_available_at:t.returned_available_at??null,
  assignment_status:assignment?.status==='ASSIGNED'&&identityVerified?'ASSIGNED':
   assignment?.status==='ASSIGNED'?'PENDING_DRIVER_VERIFICATION':'NO_ASSIGNMENT',
  tare_status:tareStatus,tare_event_id:tareEvent?.id??null,
  tare_failure_code:tareEvent?.failure_code??null,
  wim_status:tareEvent?'CONNECTED':'WIM_NOT_CONNECTED',
  driver_assignment:profile?{driver_id:profile.id,user_id:profile.external_user_id,
   display_name:profile.display_name,active:profile.active}:null,
  inventory:account?{location_id:account.location_id,sku_id:account.sku_id,
   on_hand_t:String(account.on_hand_t),reserved_t:String(account.reserved_t),
   available_t:(Number(account.on_hand_t)-Number(account.reserved_t)).toFixed(6),
   reservation_id:reservation?.reservation_id??null,
   trip_reserved_t:reservation?.trip_reserved_t==null?null:String(reservation.trip_reserved_t),
   consumed_t:reservation?.consumed_t==null?null:String(reservation.consumed_t),
   reservation_status:reservation?.reservation_status??null
  }:null,
  crusher_destination:dest,
  contract_integrity:{
   trip_dispatch_link:true,
   driver_ref_valid:!!profile&&profile.active===true,driver_assignment_valid:!!assignment&&assignment.driver_id===t.driver_id&&assignment.truck_id===t.truck_id&&assignment.status==='ASSIGNED'&&identityVerified,inventory_source_valid:!!account,
   trip_reservation_valid:(!!reservation&&Number(reservation.trip_reserved_t)>=Number(t.planned_quantity_t))||t.dispatch_status==='PLANNED',
   crusher_assignment_valid:!!compatible,
   location_verified:verified,
   navigation_enabled:false
  }
 };
}

/** Owning Driver may see assigned cargo, never global stockpile totals. */
export function projectUnifiedTripForDriver(context){
 if(!context||typeof context!=='object')return context;
 const inventory=context.inventory?{
  location_id:context.inventory.location_id,sku_id:context.inventory.sku_id,
  reservation_id:context.inventory.reservation_id,
  trip_reserved_t:context.inventory.trip_reserved_t,
  consumed_t:context.inventory.consumed_t,
  reservation_status:context.inventory.reservation_status,
  on_hand_t:null,reserved_t:null,available_t:null
 }:null;
 return {...context,inventory,stock_balance_visibility:'REDACTED_FOR_DRIVER'};
}

/** Dispatch aggregate is a projection of the SAME linked Trip DTO records. */
export async function getUnifiedDispatchContext(db,{dispatchId}={}){
 if(!id(dispatchId))fail('DISPATCH_ID_INVALID','Valid dispatch ID required',400);
 const dispatch=await one(db,'SELECT * FROM aimoc_execution_v1.dispatches WHERE id=$1',[dispatchId]);
 if(!dispatch)fail('DISPATCH_NOT_FOUND','Dispatch not found',404);
 const rows=(await db.query('SELECT id FROM aimoc_execution_v1.trips WHERE dispatch_id=$1 ORDER BY sequence_no',[dispatchId])).rows;
 const trips=await Promise.all(rows.map(r=>getUnifiedTripContext(db,{tripId:r.id})));
 const stock=await one(db,'SELECT location_id,sku_id,on_hand_t,reserved_t FROM aimoc_execution_v1.inventory_accounts WHERE location_id=$1 AND sku_id=$2',
  [dispatch.source_stockpile_id,dispatch.sku_id]);
 return {
  schema_version:'1.0',dispatch_id:dispatch.id,mode:dispatch.mode,status:dispatch.status,
  source_stockpile_id:dispatch.source_stockpile_id,destination_location_id:dispatch.destination_location_id,
  sku_id:dispatch.sku_id,planned_quantity_t:String(dispatch.planned_quantity_t),
  inventory:stock?{
   location_id:stock.location_id,sku_id:stock.sku_id,
   on_hand_t:String(stock.on_hand_t),reserved_t:String(stock.reserved_t),
   available_t:(Number(stock.on_hand_t)-Number(stock.reserved_t)).toFixed(6)
  }:null,
  trips,trip_count:trips.length,
  contract_integrity:{every_trip_linked:trips.every(t=>t.dispatch_id===dispatch.id&&
   t.source_stockpile_id===dispatch.source_stockpile_id&&t.sku_id===dispatch.sku_id),
   all_assignments_valid:trips.length>0&&trips.every(t=>t.contract_integrity.driver_assignment_valid&&
    t.contract_integrity.crusher_assignment_valid)}
 };
}

/** Audit data without rewriting or silently replacing source references. */
export async function auditUnifiedOperationalIntegrity(db){
 const tripIds=(await db.query('SELECT id FROM aimoc_execution_v1.trips ORDER BY id')).rows.map(x=>x.id);
 const issues=[];
 for(const tripId of tripIds){
  const t=await getUnifiedTripContext(db,{tripId});
  for(const [key,valid] of Object.entries(t.contract_integrity)){
   if(key==='location_verified'||key==='navigation_enabled')continue;
   if(!valid)issues.push({trip_id:tripId,code:key.toUpperCase()});
  }
 }
 const dispatches=(await db.query('SELECT id,source_stockpile_id,sku_id,status FROM aimoc_execution_v1.dispatches ORDER BY id')).rows;
 for(const d of dispatches){
   const links=await db.query('SELECT id FROM aimoc_execution_v1.trips WHERE dispatch_id=$1',[d.id]);
   const location=await one(db,'SELECT dispatch_id FROM aimoc_execution_v1.dispatch_loading_assignments WHERE dispatch_id=$1',[d.id]);
   const inventory=await one(db,'SELECT location_id FROM aimoc_execution_v1.inventory_accounts WHERE location_id=$1 AND sku_id=$2',[d.source_stockpile_id,d.sku_id]);
   if(!links.rows.length)issues.push({dispatch_id:d.id,code:'DISPATCH_WITHOUT_TRIPS'});
   if(!location)issues.push({dispatch_id:d.id,code:'CRUSHER_ASSIGNMENT_MISSING'});
   if(!inventory)issues.push({dispatch_id:d.id,code:'INVENTORY_SOURCE_MISSING'});
 }
 const orphans=(await db.query(`SELECT a.dispatch_id FROM aimoc_execution_v1.dispatch_loading_assignments a
  JOIN aimoc_execution_v1.dispatches d ON d.id=a.dispatch_id
  WHERE a.source_stockpile_id<>d.source_stockpile_id`)).rows;
 for(const r of orphans)issues.push({dispatch_id:r.dispatch_id,code:'DISPATCH_SOURCE_MISMATCH'});
 return {status:issues.length?'BLOCKED':'PASS',trips_checked:tripIds.length,dispatches_checked:dispatches.length,issues};
}
