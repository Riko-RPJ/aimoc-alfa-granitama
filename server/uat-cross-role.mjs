import {randomUUID,createHash} from 'node:crypto';
import {createAutomaticTareEvent} from './uat-wim-tare-simulator.mjs';
import {calculateLoadingCapacity} from './uat-wim-tare-calculation.mjs';

const fail=(status,code,message)=>{throw Object.assign(new Error(message),{status,code});};
const one=async(c,sql,a=[])=>(await c.query(sql,a)).rows[0];
const numeric=s=>typeof s==='string'&&/^(0|[1-9]\d{0,5})(\.\d{1,6})?$/.test(s);
export const UAT_STAGES=['ASSIGNED','START_AUTHORIZED','DRIVER_ACCEPTED','TARE_SIMULATED','LOADING_CONFIRMED','GROSS_SIMULATED','IN_TRANSIT','ARRIVED','RECEIVED','RETURNING','RETURNED_AVAILABLE'];
const workflow={
 start:['ASSIGNED','START_AUTHORIZED','admin'],accept:['START_AUTHORIZED','DRIVER_ACCEPTED','driver'],
 tare:['DRIVER_ACCEPTED','TARE_SIMULATED','admin'],loading:['TARE_SIMULATED','LOADING_CONFIRMED','stock'],
 gross:['LOADING_CONFIRMED','GROSS_SIMULATED','admin'],depart:['GROSS_SIMULATED','IN_TRANSIT','stock'],
 arrive:['IN_TRANSIT','ARRIVED','stock'],receive:['ARRIVED','RECEIVED','stock'],
 return_start:['RECEIVED','RETURNING','driver'],verify_return:['RETURNING','RETURNED_AVAILABLE','stock']
};
const systemActor={id:'uat-auto-tare',role:'system'};
const audit=(tx,dispatchId,actor,action,payload)=>tx.query(
 'INSERT INTO uat_events(id,dispatch_id,actor_id,actor_role,action,payload) VALUES($1,$2,$3,$4,$5,$6::jsonb)',
 [randomUUID(),dispatchId,actor.id,actor.role,action,JSON.stringify(payload)]
);

export async function initUat(db){
 await db.query("CREATE TABLE IF NOT EXISTS uat_dispatches (id text PRIMARY KEY, created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), source_location text NOT NULL, destination_location text NOT NULL, driver_user_id text NOT NULL, driver_label text NOT NULL, truck_id text NOT NULL, material text NOT NULL, planned_t numeric(18,6) NOT NULL CHECK(planned_t>0), simulated_tare_t numeric(18,6), simulated_gross_t numeric(18,6), status text NOT NULL DEFAULT 'ASSIGNED', updated_at timestamptz NOT NULL DEFAULT now())");
 await db.query('ALTER TABLE uat_dispatches ADD COLUMN IF NOT EXISTS assignment_revision integer NOT NULL DEFAULT 1');
 await db.query('ALTER TABLE uat_dispatches ADD COLUMN IF NOT EXISTS loading_capacity jsonb');
 await db.query("CREATE TABLE IF NOT EXISTS uat_events (id text PRIMARY KEY, dispatch_id text NOT NULL REFERENCES uat_dispatches(id), actor_id text NOT NULL, actor_role text NOT NULL, action text NOT NULL, source text NOT NULL DEFAULT 'UAT_SIMULATED', payload jsonb NOT NULL DEFAULT '{}'::jsonb, occurred_at timestamptz NOT NULL DEFAULT now())");
 await db.query('CREATE TABLE IF NOT EXISTS uat_command_receipts (actor_id text NOT NULL, request_key text NOT NULL, digest text NOT NULL, result jsonb NOT NULL, PRIMARY KEY(actor_id,request_key))');
 await db.query("CREATE TABLE IF NOT EXISTS uat_truck_profiles (truck_id text PRIMARY KEY CHECK(truck_id LIKE 'UAT-%'), simulated_tare_t numeric(18,6) NOT NULL CHECK(simulated_tare_t>0), approved_gvw_t numeric(18,6) NOT NULL CHECK(approved_gvw_t>0), approved_payload_t numeric(18,6) NOT NULL CHECK(approved_payload_t>0), revision integer NOT NULL CHECK(revision>0), enabled boolean NOT NULL, scenario text NOT NULL CHECK(scenario IN ('SUCCESS','DELAYED','DUPLICATE','INVALID','FAILURE')), delay_ms integer NOT NULL DEFAULT 0 CHECK(delay_ms>=0 AND delay_ms<=300000), authority text NOT NULL CHECK(authority='UAT_SIMULATED_CONFIG'), updated_at timestamptz NOT NULL DEFAULT now())");
 await db.query("CREATE TABLE IF NOT EXISTS uat_tare_jobs (id text PRIMARY KEY, trip_id text NOT NULL REFERENCES uat_dispatches(id), assignment_revision integer NOT NULL, truck_id text NOT NULL, profile_revision integer, correlation_id text NOT NULL UNIQUE, status text NOT NULL CHECK(status IN ('TARE_PENDING','TARE_RECEIVED','TARE_INVALID','TARE_FAILED')), attempts integer NOT NULL DEFAULT 0, requested_at timestamptz NOT NULL DEFAULT now(), next_attempt_at timestamptz, last_error_code text, completed_at timestamptz, external_event_id text, event_digest text, event_payload jsonb, UNIQUE(trip_id,assignment_revision))");
}

export async function saveUatTruckProfile(db,p){
 const weights=['simulated_tare_t','approved_gvw_t','approved_payload_t'];
 if(!p||!/^UAT-[A-Za-z0-9_-]{3,40}$/.test(p.truck_id||'')||!weights.every(k=>numeric(p[k])&&Number(p[k])>0)||!Number.isInteger(p.revision)||p.revision<1||typeof p.enabled!=='boolean'||!['SUCCESS','DELAYED','DUPLICATE','INVALID','FAILURE'].includes(p.scenario)||!Number.isInteger(p.delay_ms)||p.delay_ms<0||p.delay_ms>300000||p.authority!=='UAT_SIMULATED_CONFIG') fail(422,'UAT_TARE_PROFILE_INVALID','Explicit UAT truck profile is invalid');
 await db.query("INSERT INTO uat_truck_profiles(truck_id,simulated_tare_t,approved_gvw_t,approved_payload_t,revision,enabled,scenario,delay_ms,authority) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(truck_id) DO UPDATE SET simulated_tare_t=excluded.simulated_tare_t,approved_gvw_t=excluded.approved_gvw_t,approved_payload_t=excluded.approved_payload_t,revision=excluded.revision,enabled=excluded.enabled,scenario=excluded.scenario,delay_ms=excluded.delay_ms,authority=excluded.authority,updated_at=now()",[p.truck_id,p.simulated_tare_t,p.approved_gvw_t,p.approved_payload_t,p.revision,p.enabled,p.scenario,p.delay_ms,p.authority]);
}

const visible=(actor,d)=>actor.role==='admin'||(actor.role==='driver'&&actor.id===d.driver_user_id)||(actor.role==='stock'&&(actor.crusherIds||[]).some(id=>id===d.source_location||id===d.destination_location));
const project=d=>({
 id:d.id,status:d.status,driverUserId:d.driver_user_id,driverLabel:d.driver_label,truckId:d.truck_id,
 sourceLocation:d.source_location,destinationLocation:d.destination_location,material:d.material,plannedT:d.planned_t,
 simulatedTareT:d.simulated_tare_t,simulatedGrossT:d.simulated_gross_t,
 simulatedNetT:d.simulated_gross_t!==null&&d.simulated_tare_t!==null?String((Number(d.simulated_gross_t)-Number(d.simulated_tare_t)).toFixed(6)):null,
 tareSimulation:d.tare_status?{status:d.tare_status,mode:'AUTOMATIC',source:'UAT_SIMULATED',correlationId:d.correlation_id,assignmentRevision:d.assignment_revision,profileRevision:d.profile_revision,attempts:d.attempts,nextAttemptAt:d.next_attempt_at,lastErrorCode:d.last_error_code,completedAt:d.completed_at,verified:false}:null,
 loadingCapacity:d.loading_capacity,createdAt:d.created_at,updatedAt:d.updated_at,authority:'UAT_SIMULATED',inventoryPosted:false,weighbridgeVerified:false
});
export async function uatContext(db,identityDb,actor){
 if(!['admin','stock','driver'].includes(actor.role))fail(403,'ROLE_FORBIDDEN','UAT workspace role unsupported');
 const rows=(await db.query('SELECT d.*,j.status tare_status,j.correlation_id,j.profile_revision,j.attempts,j.next_attempt_at,j.last_error_code,j.completed_at FROM uat_dispatches d LEFT JOIN uat_tare_jobs j ON j.trip_id=d.id AND j.assignment_revision=d.assignment_revision ORDER BY d.created_at DESC,d.id DESC')).rows;
 const jobs=rows.filter(x=>visible(actor,x)).map(project);
 const events=jobs.length?(await db.query('SELECT * FROM uat_events WHERE dispatch_id=ANY($1::text[]) ORDER BY occurred_at,id',[jobs.map(x=>x.id)])).rows.map(e=>({id:e.id,tripId:e.dispatch_id,action:e.action,role:e.actor_role,at:e.occurred_at,source:e.source,payload:e.payload})):[];
 const drivers=actor.role==='admin'?(await identityDb.query("SELECT id,username,display_name FROM aimoc_alfa_ops.users WHERE role='driver' AND active=true ORDER BY username")).rows.map(x=>({id:x.id,username:x.username,label:x.display_name})):[];
 return {mode:'CROSS_ROLE_UAT',source:'UAT_SIMULATED',jobs,events,drivers,locations:actor.role==='admin'?['crusher-1','crusher-2']:actor.crusherIds||[],permissions:{stockScope:actor.crusherIds||[]},productionInventoryAffected:false,realDeviceEvidence:false};
}

async function command(db,{actor,key,operation,payload,execute}){
 if(typeof key!=='string'||!/^[A-Za-z0-9_-]{8,120}$/.test(key))fail(400,'IDEMPOTENCY_REQUIRED','Idempotency-Key required');
 const digest=createHash('sha256').update(JSON.stringify({operation,payload})).digest('hex');
 return db.transaction(async tx=>{
  const existing=await one(tx,'SELECT * FROM uat_command_receipts WHERE actor_id=$1 AND request_key=$2',[actor.id,key]);
  if(existing){if(existing.digest!==digest)fail(409,'IDEMPOTENCY_CONFLICT','Key reused for different request');return {...existing.result,replayed:true};}
  const result=await execute(tx);
  await tx.query('INSERT INTO uat_command_receipts(actor_id,request_key,digest,result) VALUES($1,$2,$3,$4::jsonb)',[actor.id,key,digest,JSON.stringify(result)]);
  return result;
 });
}

const outcomeCode=(outcome,fallback)=>outcome.errorCode||outcome.code||outcome.reason||fallback;
export async function processAutomaticTare(db,tripId,{now=new Date()}={}){
 return db.transaction(async tx=>{
  const d=await one(tx,'SELECT * FROM uat_dispatches WHERE id=$1 FOR UPDATE',[tripId]);
  if(!d)fail(404,'TRIP_NOT_FOUND','Trip not found');
  const j=await one(tx,'SELECT * FROM uat_tare_jobs WHERE trip_id=$1 AND assignment_revision=$2 FOR UPDATE',[tripId,d.assignment_revision]);
  if(!j)fail(409,'UAT_TARE_JOB_MISSING','Automatic Tare job missing');
  if(['TARE_RECEIVED','TARE_INVALID'].includes(j.status))return {id:tripId,status:d.status,tareStatus:j.status,replayed:true};
  const profile=await one(tx,'SELECT * FROM uat_truck_profiles WHERE truck_id=$1 AND enabled=true',[j.truck_id]);
  const attempt=Number(j.attempts)+1;
  if(!profile){
   await tx.query("UPDATE uat_tare_jobs SET status='TARE_FAILED',attempts=$2,last_error_code='UAT_TARE_PROFILE_MISSING',next_attempt_at=NULL WHERE id=$1",[j.id,attempt]);
   await audit(tx,d.id,systemActor,'TARE_AUTO_FAILED',{correlationId:j.correlation_id,assignmentRevision:j.assignment_revision,attempt,errorCode:'UAT_TARE_PROFILE_MISSING',verified:false});
   return {id:tripId,status:d.status,tareStatus:'TARE_FAILED',errorCode:'UAT_TARE_PROFILE_MISSING'};
  }
  if(d.truck_id!==j.truck_id||Number(d.assignment_revision)!==Number(j.assignment_revision)||(j.profile_revision!==null&&Number(profile.revision)!==Number(j.profile_revision))){
   await tx.query("UPDATE uat_tare_jobs SET status='TARE_INVALID',attempts=$2,last_error_code='STALE_ASSIGNMENT',completed_at=$3 WHERE id=$1",[j.id,attempt,now]);
   await audit(tx,d.id,systemActor,'TARE_AUTO_INVALID',{correlationId:j.correlation_id,assignmentRevision:j.assignment_revision,attempt,errorCode:'STALE_ASSIGNMENT',verified:false});
   return {id:tripId,status:d.status,tareStatus:'TARE_INVALID',errorCode:'STALE_ASSIGNMENT'};
  }
  let outcome;
  const normalized={...profile,simulated_tare_t:String(profile.simulated_tare_t),approved_gvw_t:String(profile.approved_gvw_t),approved_payload_t:String(profile.approved_payload_t),revision:Number(profile.revision),delay_ms:Number(profile.delay_ms)};
  try{
   outcome=createAutomaticTareEvent({assignment:{assignmentId:d.id,assignmentRevision:Number(d.assignment_revision),tripId:d.id,truckId:d.truck_id,assignedAt:new Date(d.created_at).toISOString()},profile:normalized,attempt,requestedAt:new Date(now).toISOString()});
  }catch(e){outcome={kind:e.code==='UAT_TARE_PROFILE_INVALID'?'INVALID':'FAILURE',code:e.code||'UAT_TARE_PROCESSING_FAILED'};}
  if(outcome.kind!=='EVENT'){
   const invalid=outcome.kind==='INVALID',delayed=outcome.kind==='DELAYED';
   const status=invalid?'TARE_INVALID':delayed?'TARE_PENDING':'TARE_FAILED';
   const code=outcomeCode(outcome,delayed?'UAT_TARE_DELAYED':invalid?'UAT_TARE_PROFILE_INVALID':'UAT_TARE_DELIVERY_FAILED');
   const next=delayed?new Date(outcome.availableAt):new Date(new Date(now).getTime()+1000);
   await tx.query('UPDATE uat_tare_jobs SET status=$2,profile_revision=$3,attempts=$4,last_error_code=$5,next_attempt_at=$6,completed_at=$7 WHERE id=$1',[j.id,status,profile.revision,attempt,code,invalid?null:next,invalid?now:null]);
   await audit(tx,d.id,systemActor,invalid?'TARE_AUTO_INVALID':delayed?'TARE_AUTO_PENDING':'TARE_AUTO_FAILED',{correlationId:j.correlation_id,assignmentRevision:j.assignment_revision,profileRevision:profile.revision,scenario:profile.scenario,attempt,errorCode:code,verified:false});
   return {id:tripId,status:d.status,tareStatus:status,errorCode:code};
  }
  const received=outcome.event;
  const digest=createHash('sha256').update(JSON.stringify(received)).digest('hex');
  const stale=received.tripId!==d.id||received.truckId!==d.truck_id||Number(received.assignmentRevision)!==Number(d.assignment_revision)||Number(received.profileRevision)!==Number(profile.revision)||received.source!=='UAT_SIMULATED'||received.verified!==false;
  if(stale){
   await tx.query("UPDATE uat_tare_jobs SET status='TARE_INVALID',attempts=$2,last_error_code='STALE_ASSIGNMENT',completed_at=$3 WHERE id=$1",[j.id,attempt,now]);
   await audit(tx,d.id,systemActor,'TARE_AUTO_INVALID',{correlationId:j.correlation_id,attempt,errorCode:'STALE_ASSIGNMENT',verified:false});
   return {id:tripId,status:d.status,tareStatus:'TARE_INVALID',errorCode:'STALE_ASSIGNMENT'};
  }
  if(j.external_event_id&&(j.external_event_id!==received.externalEventId||j.event_digest!==digest)){
   await tx.query("UPDATE uat_tare_jobs SET status='TARE_INVALID',attempts=$2,last_error_code='DUPLICATE_EVENT_CONFLICT',completed_at=$3 WHERE id=$1",[j.id,attempt,now]);
   await audit(tx,d.id,systemActor,'TARE_AUTO_INVALID',{correlationId:j.correlation_id,attempt,errorCode:'DUPLICATE_EVENT_CONFLICT',verified:false});
   return {id:tripId,status:d.status,tareStatus:'TARE_INVALID',errorCode:'DUPLICATE_EVENT_CONFLICT'};
  }
  await tx.query("UPDATE uat_tare_jobs SET status='TARE_PENDING',profile_revision=$2,attempts=$3,last_error_code=NULL,next_attempt_at=NULL,external_event_id=$4,event_digest=$5,event_payload=$6::jsonb WHERE id=$1",[j.id,profile.revision,attempt,received.externalEventId,digest,JSON.stringify(received)]);
  if(d.status!=='DRIVER_ACCEPTED'){
   await audit(tx,d.id,systemActor,'TARE_AUTO_PENDING',{correlationId:j.correlation_id,assignmentRevision:j.assignment_revision,profileRevision:profile.revision,scenario:profile.scenario,attempt,verified:false});
   return {id:tripId,status:d.status,tareStatus:'TARE_PENDING'};
  }
  let capacity;
  try{capacity=calculateLoadingCapacity({approvedGvwT:String(profile.approved_gvw_t),tareT:received.weightT,approvedPayloadT:String(profile.approved_payload_t),remainingPlannedT:String(d.planned_t)});}
  catch(e){
   await tx.query("UPDATE uat_tare_jobs SET status='TARE_INVALID',attempts=$2,last_error_code=$3,completed_at=$4 WHERE id=$1",[j.id,attempt,e.code||'UAT_TARE_PROFILE_INVALID',now]);
   await audit(tx,d.id,systemActor,'TARE_AUTO_INVALID',{correlationId:j.correlation_id,attempt,errorCode:e.code||'UAT_TARE_PROFILE_INVALID',verified:false});
   return {id:tripId,status:d.status,tareStatus:'TARE_INVALID',errorCode:e.code||'UAT_TARE_PROFILE_INVALID'};
  }
  await tx.query("UPDATE uat_dispatches SET simulated_tare_t=$2,status='TARE_SIMULATED',loading_capacity=$3::jsonb,updated_at=$4 WHERE id=$1",[d.id,received.weightT,JSON.stringify(capacity),now]);
  await tx.query("UPDATE uat_tare_jobs SET status='TARE_RECEIVED',completed_at=$2,last_error_code=NULL,next_attempt_at=NULL WHERE id=$1",[j.id,now]);
  await audit(tx,d.id,systemActor,'TARE_AUTO_RECEIVED',{correlationId:j.correlation_id,assignmentRevision:j.assignment_revision,profileRevision:profile.revision,scenario:profile.scenario,attempt,simulatedTareT:received.weightT,externalEventId:received.externalEventId,verified:false});
  return {id:tripId,status:'TARE_SIMULATED',tareStatus:'TARE_RECEIVED',authority:'UAT_SIMULATED',inventoryPosted:false,realWeighbridgeEvidence:false};
 });
}

export async function createUatDispatch(db,identityDb,{actor,key,body}){
 if(actor.role!=='admin')fail(403,'ROLE_FORBIDDEN','Admin required');
 const {sourceLocation,destinationLocation,driverUserId,truckId,material,plannedT}=body||{};
 if(!['crusher-1','crusher-2'].includes(sourceLocation)||!['crusher-1','crusher-2'].includes(destinationLocation)||sourceLocation===destinationLocation)fail(400,'INVALID_UAT_ROUTE','Choose separate UAT source and destination');
 if(typeof material!=='string'||!/^.{2,80}$/.test(material)||typeof truckId!=='string'||!/^UAT-[A-Za-z0-9_-]{3,40}$/.test(truckId)||!numeric(plannedT)||Number(plannedT)<=0)fail(400,'INVALID_UAT_DISPATCH','Material, UAT truck and positive simulated tonnes required');
 const driver=await one(identityDb.query?identityDb:db,"SELECT id,display_name FROM aimoc_alfa_ops.users WHERE id=$1 AND role='driver' AND active=true",[driverUserId]);
 if(!driver)fail(400,'INVALID_DRIVER','Active local Driver account required');
 const payload={sourceLocation,destinationLocation,driverUserId,truckId,material,plannedT};
 const result=await command(db,{actor,key,operation:'create',payload,execute:async tx=>{
  const taken=await one(tx,"SELECT id FROM uat_dispatches WHERE status<>'RETURNED_AVAILABLE' AND (truck_id=$1 OR driver_user_id=$2) LIMIT 1",[truckId,driverUserId]);
  if(taken)fail(409,'RESOURCE_CLAIMED','Driver or truck already has open UAT trip');
  const id='uat-'+randomUUID(),correlationId=`auto-tare:${id}:1`;
  const profile=await one(tx,'SELECT revision FROM uat_truck_profiles WHERE truck_id=$1 AND enabled=true',[truckId]);
  await tx.query('INSERT INTO uat_dispatches(id,created_by,source_location,destination_location,driver_user_id,driver_label,truck_id,material,planned_t) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[id,actor.id,sourceLocation,destinationLocation,driver.id,driver.display_name,truckId,material,plannedT]);
  await tx.query("INSERT INTO uat_tare_jobs(id,trip_id,assignment_revision,truck_id,profile_revision,correlation_id,status) VALUES($1,$2,1,$3,$4,$5,'TARE_PENDING')",[randomUUID(),id,truckId,profile?.revision??null,correlationId]);
  await audit(tx,id,actor,'DISPATCH_CREATED',payload);
  await audit(tx,id,systemActor,'TARE_AUTO_REQUESTED',{correlationId,assignmentRevision:1,profileRevision:profile?.revision??null,verified:false});
  return {id,status:'ASSIGNED',tareStatus:'TARE_PENDING',authority:'UAT_SIMULATED'};
 }});
 if(result.replayed)return result;
 const processed=await processAutomaticTare(db,result.id);
 return {...result,status:processed.status,tareStatus:processed.tareStatus};
}

export async function advanceUat(db,{actor,key,tripId,body}){
 const action=body?.action;
 if(action==='tare_auto'){
  if(actor.role!=='admin')fail(403,'ROLE_FORBIDDEN','Admin required');
  const accepted=await command(db,{actor,key,operation:tripId,payload:{action},execute:async()=>({id:tripId,accepted:true})});
  if(accepted.replayed)return accepted;
  return processAutomaticTare(db,tripId);
 }
 if(!workflow[action]&&action!=='checklist')fail(400,'UNKNOWN_UAT_ACTION','Unsupported UAT action');
 const requiredRole=action==='checklist'?'driver':workflow[action][2];
 if(actor.role!==requiredRole)fail(403,'ROLE_FORBIDDEN','Action not permitted for role');
 const payload={action,simulatedT:body?.simulatedT??null,note:body?.note??null};
 const result=await command(db,{actor,key,operation:tripId,payload,execute:async tx=>{
  const d=await one(tx,'SELECT * FROM uat_dispatches WHERE id=$1 FOR UPDATE',[tripId]);
  if(!d||!visible(actor,d))fail(404,'TRIP_NOT_FOUND','Trip is not visible');
  if(actor.role==='driver'&&d.driver_user_id!==actor.id)fail(403,'NOT_ASSIGNED','Driver not assigned');
  if(actor.role==='stock'){
   const location=['loading','depart','verify_return'].includes(action)?d.source_location:d.destination_location;
   if(!(actor.crusherIds||[]).includes(location))fail(403,'LOCATION_SCOPE_DENIED','Wrong Stockpile location');
  }
  if(action==='checklist'){
   if(!['DRIVER_ACCEPTED','TARE_SIMULATED','LOADING_CONFIRMED','GROSS_SIMULATED','IN_TRANSIT','ARRIVED','RECEIVED'].includes(d.status))fail(409,'CHECKLIST_STAGE_INVALID','Checklist not allowed in this state');
   if(typeof body.note!=='string'||body.note.trim().length<3||body.note.length>200)fail(400,'CHECKLIST_NOTE_REQUIRED','Supply checklist note');
   await audit(tx,d.id,actor,'DRIVER_CHECKLIST',{note:body.note,verified:false});
   return {id:tripId,status:d.status,checklist:true,authority:'DRIVER_SELF_REPORT_UAT'};
  }
  const [expected,next]=workflow[action];
  if(d.status!==expected)fail(409,'INVALID_SEQUENCE','Expected '+expected+', actual '+d.status);
  if(action==='tare'||action==='gross'){
   if(!numeric(body.simulatedT))fail(400,'SIMULATED_WEIGHT_REQUIRED','Numeric simulated tonnes required');
   if(action==='gross'&&(Number(body.simulatedT)<=Number(d.simulated_tare_t)||Number(body.simulatedT)-Number(d.simulated_tare_t)>Number(d.planned_t)))fail(409,'SIMULATED_WEIGHT_INVALID','Simulated net must be positive and within planned capacity');
   await tx.query('UPDATE uat_dispatches SET '+(action==='tare'?'simulated_tare_t':'simulated_gross_t')+'=$2 WHERE id=$1',[tripId,body.simulatedT]);
  }
  await tx.query('UPDATE uat_dispatches SET status=$2,updated_at=now() WHERE id=$1',[tripId,next]);
  await audit(tx,d.id,actor,action.toUpperCase(),{next,simulatedT:body.simulatedT??null,source:'UAT_SIMULATED'});
  return {id:tripId,status:next,authority:'UAT_SIMULATED',inventoryPosted:false,realWeighbridgeEvidence:false};
 }});
 if(action==='start'||action==='accept'){
  const reconciled=await processAutomaticTare(db,tripId);
  return {...result,status:reconciled.status,tareStatus:reconciled.tareStatus};
 }
 return result;
}
