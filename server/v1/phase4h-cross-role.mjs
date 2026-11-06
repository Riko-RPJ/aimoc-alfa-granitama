import {createHash,randomUUID} from 'node:crypto';

const fail=(code,message,status=409)=>{throw Object.assign(new Error(message),{code,status});};
const id=x=>typeof x==='string'&&/^[a-zA-Z0-9_-]{1,120}$/.test(x);
const amount=x=>typeof x==='string'&&/^(0|[1-9]\d{0,9})(?:\.\d{1,6})?$/.test(x);
const scaled=x=>{
 if(!amount(x))fail('TONNAGE_INVALID','Exact positive tonnes decimal string required',400);
 const [a,b='']=x.split('.');
 const n=BigInt(a)*1000000n+BigInt((b+'000000').slice(0,6));
 if(n===0n)fail('TONNAGE_INVALID','Positive tonnes required',400);
 return n;
};
const one=async(db,sql,args=[])=> (await db.query(sql,args)).rows[0];
const keys=(obj,expected)=>{
 if(!obj||typeof obj!=='object'||Array.isArray(obj)||Object.keys(obj).some(k=>!expected.includes(k)))
  fail('INVALID_DISPATCH_DTO','Unexpected or missing dispatch input',400);
};
const shape=x=>{
 keys(x,['dispatch_id','mode','source_stockpile_id','destination_location_id','sku_id',
   'planned_quantity_t','crusher_id','loading_point_id','voyage_id','jetty_window_id','trips']);
 for(const key of ['dispatch_id','source_stockpile_id','destination_location_id','sku_id','crusher_id','loading_point_id']){
  if(!id(x[key]))fail('DISPATCH_REFERENCE_INVALID',key+' must be a stable ID',400);
 }
 if(x.source_stockpile_id===x.destination_location_id)fail('DESTINATION_EQUALS_SOURCE','Source and receiving location differ',400);
 if(!['LAND','MARINE'].includes(x.mode))fail('DISPATCH_MODE_INVALID','LAND or MARINE required',400);
 if(x.mode==='MARINE'&&(!id(x.voyage_id)||!id(x.jetty_window_id))||
    x.mode==='LAND'&&(x.voyage_id!=null||x.jetty_window_id!=null))
  fail('DISPATCH_MODE_FIELDS_INVALID','Voyage fields must match dispatch mode',400);
 const total=scaled(x.planned_quantity_t);
 if(!Array.isArray(x.trips)||x.trips.length<1||x.trips.length>50)
  fail('TRIP_COUNT_INVALID','One to fifty explicit trip assignments required',400);
 const ids=new Set(),assignments=new Set(),drivers=new Set(),trucks=new Set();
 let sum=0n;
 for(const t of x.trips){
  keys(t,['trip_id','assignment_id','sequence_no','driver_id','truck_id','planned_quantity_t']);
  if(![t.trip_id,t.assignment_id,t.driver_id,t.truck_id].every(id))
   fail('TRIP_REFERENCE_INVALID','Trip, assignment, Driver and truck IDs required',400);
  if(ids.has(t.trip_id)||assignments.has(t.assignment_id))fail('DUPLICATE_ASSIGNMENT','Trip and assignment IDs must be unique',400);
  if(drivers.has(t.driver_id)||trucks.has(t.truck_id))fail('DUPLICATE_ASSIGNMENT','Each trip must have a distinct Driver and truck',400);
  ids.add(t.trip_id);assignments.add(t.assignment_id);
  drivers.add(t.driver_id);trucks.add(t.truck_id);
  if(!Number.isInteger(t.sequence_no)||t.sequence_no<1||t.sequence_no>x.trips.length)
   fail('TRIP_SEQUENCE_INVALID','Trip sequence must be contiguous from 1',400);
  sum+=scaled(t.planned_quantity_t);
 }
 if(new Set(x.trips.map(t=>t.sequence_no)).size!==x.trips.length)
  fail('TRIP_SEQUENCE_INVALID','Trip sequence must be unique',400);
 if(sum!==total)fail('TRIP_QUANTITY_MISMATCH','Trip quantities must exactly equal dispatch tonnes',400);
 return x;
};
/**
 * Creates dispatch, trips, Driver assignments and Crusher destination in one
 * atomic staging transaction. No production source data or fake GPS is inferred.
 */
export async function createUnifiedDispatch(db,{actorId,idempotencyKey,body}={}){
 if(!id(actorId)||!id(idempotencyKey)||idempotencyKey.length<6)
  fail('IDEMPOTENCY_REQUIRED','Authorized actor and idempotency key required',400);
 const input=shape(body);
 return db.transaction(async c=>{
  await c.query('INSERT INTO aimoc_execution_v1.idempotency_locks(actor_id,idempotency_key) VALUES($1,$2) ON CONFLICT DO NOTHING',
   [actorId,idempotencyKey]);
  await c.query('SELECT 1 FROM aimoc_execution_v1.idempotency_locks WHERE actor_id=$1 AND idempotency_key=$2 FOR UPDATE',
   [actorId,idempotencyKey]);
  const commandHash=createHash('sha256').update(JSON.stringify(['dispatch-create',input])).digest('hex');
  const prior=await one(c,'SELECT command_hash,result FROM aimoc_execution_v1.command_receipts WHERE actor_id=$1 AND idempotency_key=$2 FOR UPDATE',
   [actorId,idempotencyKey]);
  if(prior){
   if(prior.command_hash!==commandHash)fail('IDEMPOTENCY_KEY_REUSED','Key already used for another request');
   return {...prior.result,replayed:true};
  }
  if(await one(c,'SELECT id FROM aimoc_execution_v1.dispatches WHERE id=$1',[input.dispatch_id]))
   fail('DISPATCH_ALREADY_EXISTS','Dispatch ID already exists');
  const account=await one(c,'SELECT location_id FROM aimoc_execution_v1.inventory_accounts WHERE location_id=$1 AND sku_id=$2',
   [input.source_stockpile_id,input.sku_id]);
  if(!account)fail('SOURCE_INVENTORY_UNKNOWN','Source stock/SKU account not provisioned');
  const crusher=await one(c,'SELECT * FROM aimoc_execution_v1.crusher_location_refs WHERE crusher_id=$1',[input.crusher_id]);
  if(!crusher||crusher.status!=='ACTIVE'||crusher.source_stockpile_id!==input.source_stockpile_id)
   fail('CRUSHER_STOCKPILE_MISMATCH','Crusher and stockpile location identity mismatch');
  const point=await one(c,'SELECT * FROM aimoc_execution_v1.loading_point_refs WHERE loading_point_id=$1',[input.loading_point_id]);
  if(!point||point.crusher_id!==crusher.crusher_id||point.verification_status==='SUSPENDED')
   fail('LOADING_POINT_CRUSHER_MISMATCH','Loading point not a valid member of crusher');
  if(input.mode==='MARINE'){
   const voyage=await one(c,'SELECT status FROM aimoc_execution_v1.voyage_capacity WHERE voyage_id=$1',[input.voyage_id]);
   const slot=await one(c,'SELECT voyage_id,jetty_id,status FROM aimoc_execution_v1.jetty_windows WHERE id=$1',[input.jetty_window_id]);
   if(!voyage||voyage.status!=='READY'||!slot||slot.status!=='READY'||slot.voyage_id!==input.voyage_id||
     slot.jetty_id!==input.destination_location_id)fail('MARINE_SLOT_NOT_READY','Matching authorized voyage and jetty slot required');
  }
  const identityTable=await one(c,"SELECT to_regclass('aimoc_execution_v1.driver_identity_bindings') AS oid");
  const trips=[];
  for(const t of [...input.trips].sort((a,b)=>a.sequence_no-b.sequence_no)){
   const [driver,truck]=await Promise.all([
    one(c,'SELECT id,external_user_id FROM aimoc_execution_v1.driver_profiles WHERE id=$1 AND active=true FOR UPDATE',[t.driver_id]),
    one(c,'SELECT truck_id,payload_limit_t FROM aimoc_execution_v1.fleet_vehicle_specs WHERE truck_id=$1 AND active=true FOR UPDATE',[t.truck_id])
   ]);
   if(!driver||!truck)fail('DRIVER_TRUCK_NOT_ACTIVE','Authoritative active Driver and truck required');
   const existingAssignment=await one(c,`SELECT a.trip_id FROM aimoc_execution_v1.trip_driver_assignments a
    JOIN aimoc_execution_v1.trips active_trip ON active_trip.id=a.trip_id
    WHERE a.driver_id=$1 AND a.status='ASSIGNED'
      AND active_trip.status NOT IN ('RETURNED_AVAILABLE','CANCELLED') LIMIT 1`,[t.driver_id]);
   if(existingAssignment)fail('DRIVER_ALREADY_ASSIGNED','Driver has another unclosed assignment',409);
   const existingTruck=await one(c,`SELECT a.trip_id FROM aimoc_execution_v1.trip_driver_assignments a
    JOIN aimoc_execution_v1.trips t ON t.id=a.trip_id
    WHERE a.truck_id=$1 AND a.status='ASSIGNED'
    AND t.status NOT IN ('RETURNED_AVAILABLE','CANCELLED') LIMIT 1`,[t.truck_id]);
   if(existingTruck)fail('TRUCK_ALREADY_ASSIGNED','Truck has another unclosed assignment',409);
   const claimed=await one(c,`SELECT id FROM aimoc_execution_v1.resource_claims
    WHERE released_at IS NULL AND (truck_id=$1 OR driver_id=$2) LIMIT 1`,
    [t.truck_id,t.driver_id]);
   if(claimed)fail('DRIVER_TRUCK_BUSY','Truck or Driver is occupied by an active trip',409);
   if(identityTable?.oid){
    const binding=await one(c,`SELECT status,verified_at FROM aimoc_execution_v1.driver_identity_bindings
     WHERE driver_id=$1 AND user_id=$2`,[driver.id,driver.external_user_id]);
    if(binding?.status!=='ACTIVE'||!binding.verified_at)
     fail('PENDING_DRIVER_VERIFICATION','Independently verified Driver identity required');
   }
   if(scaled(t.planned_quantity_t)>scaled(String(truck.payload_limit_t)))
    fail('TRUCK_PAYLOAD_EXCEEDED','Trip planned tonnage exceeds the vehicle payload limit');
   trips.push(t);
  }
  if(input.mode==='LAND'){
   await c.query(`INSERT INTO aimoc_execution_v1.dispatches
    (id,mode,status,voyage_id,source_stockpile_id,destination_location_id,sku_id,planned_quantity_t)
    VALUES($1,'LAND','PLANNED',NULL,$2,$3,$4,$5)`,
    [input.dispatch_id,input.source_stockpile_id,input.destination_location_id,input.sku_id,input.planned_quantity_t]);
  }else{
   await c.query(`INSERT INTO aimoc_execution_v1.dispatches
    (id,mode,status,voyage_id,source_stockpile_id,destination_location_id,sku_id,planned_quantity_t,jetty_window_id)
    VALUES($1,'MARINE','PLANNED',$2,$3,$4,$5,$6,$7)`,
    [input.dispatch_id,input.voyage_id,input.source_stockpile_id,input.destination_location_id,
     input.sku_id,input.planned_quantity_t,input.jetty_window_id]);
  }
  if(input.mode==='MARINE')
   await c.query('INSERT INTO aimoc_execution_v1.marine_gates(dispatch_id) VALUES($1)',[input.dispatch_id]);
  await c.query(`INSERT INTO aimoc_execution_v1.dispatch_loading_assignments
   (dispatch_id,crusher_id,loading_point_id,source_stockpile_id,loading_point_version,assigned_by)
   VALUES($1,$2,$3,$4,$5,$6)`,[input.dispatch_id,input.crusher_id,input.loading_point_id,
    input.source_stockpile_id,point.version,actorId]);
  for(const t of trips){
   await c.query(`INSERT INTO aimoc_execution_v1.trips
    (id,dispatch_id,sequence_no,status,truck_id,driver_id,planned_quantity_t)
    VALUES($1,$2,$3,'QUEUED',$4,$5,$6)`,
    [t.trip_id,input.dispatch_id,t.sequence_no,t.truck_id,t.driver_id,t.planned_quantity_t]);
   await c.query(`INSERT INTO aimoc_execution_v1.trip_driver_assignments
    (assignment_id,trip_id,driver_id,truck_id,assigned_by,status)
    VALUES($1,$2,$3,$4,$5,'ASSIGNED')`,
    [t.assignment_id,t.trip_id,t.driver_id,t.truck_id,actorId]);
  }
  const result={dispatch_id:input.dispatch_id,status:'PLANNED',mode:input.mode,
   trip_ids:trips.map(t=>t.trip_id),source_stockpile_id:input.source_stockpile_id,
   sku_id:input.sku_id,crusher_id:input.crusher_id,loading_point_id:input.loading_point_id,
   loading_point_status:point.verification_status,inventory_reserved:false,
   independently_verified_loading:false,synthetic_evidence_accepted:false};
  await c.query('INSERT INTO aimoc_execution_v1.integration_outbox(id,aggregate_id,event_type,payload) VALUES($1,$2,$3,$4::jsonb)',
   [randomUUID(),input.dispatch_id,'DISPATCH_PLANNED',JSON.stringify({dispatch_id:input.dispatch_id,trip_ids:result.trip_ids})]);
  await c.query('INSERT INTO aimoc_execution_v1.command_receipts(actor_id,idempotency_key,command_hash,result) VALUES($1,$2,$3,$4::jsonb)',
   [actorId,idempotencyKey,commandHash,JSON.stringify(result)]);
  return result;
 });
}
