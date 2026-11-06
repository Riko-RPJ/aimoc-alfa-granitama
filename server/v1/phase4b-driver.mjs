import {randomUUID,createHash} from 'node:crypto';
const fail=(code,message,status=403)=>{throw Object.assign(new Error(message),{code,status});};
const one=async(c,sql,params=[]) => (await c.query(sql,params)).rows[0];
const fingerprint=payload=>createHash('sha256').update(JSON.stringify(payload)).digest('hex');
async function driverCommand(c,actorId,key,action,payload,callback) {
  if(!key)return callback(); // Only internal pre-4C service tests use this path.
  await c.query('INSERT INTO aimoc_execution_v1.idempotency_locks(actor_id,idempotency_key) VALUES($1,$2) ON CONFLICT DO NOTHING',[actorId,key]);
  await c.query('SELECT 1 FROM aimoc_execution_v1.idempotency_locks WHERE actor_id=$1 AND idempotency_key=$2 FOR UPDATE',[actorId,key]);
  const hash=fingerprint([action,payload]);
  const previous=await one(c,'SELECT result,command_hash FROM aimoc_execution_v1.command_receipts WHERE actor_id=$1 AND idempotency_key=$2 FOR UPDATE',[actorId,key]);
  if(previous){
    if(previous.command_hash!==hash)fail('IDEMPOTENCY_KEY_REUSED','Key cannot be reused with changed command',409);
    return {...previous.result,replayed:true};
  }
  const result=await callback();
  await c.query('INSERT INTO aimoc_execution_v1.command_receipts(actor_id,idempotency_key,command_hash,result) VALUES($1,$2,$3,$4::jsonb)',
    [actorId,key,hash,JSON.stringify(result)]);
  return result;
}

async function requireDriver(c,actor){
  if(!actor?.id||actor.role!=='DRIVER')fail('DRIVER_ROLE_REQUIRED','Authenticated Driver role required');
  const driver=await one(c,'SELECT * FROM aimoc_execution_v1.driver_profiles WHERE external_user_id=$1 AND active=true',[actor.id]);
  if(!driver)fail('DRIVER_NOT_LINKED','No active linked Driver profile');
  const table=await one(c,"SELECT to_regclass('aimoc_execution_v1.driver_identity_bindings') AS oid");
  if(table?.oid){
    const binding=await one(c,"SELECT status,verified_at FROM aimoc_execution_v1.driver_identity_bindings WHERE driver_id=$1 AND user_id=$2",[driver.id,actor.id]);
    if(binding?.status!=='ACTIVE'||!binding.verified_at)
      fail('DRIVER_IDENTITY_UNVERIFIED','Authenticated Driver must have independently verified active identity',403);
  }

  return driver;
}
async function assignedTrip(c,driverId,tripId){
  const trip=await one(c,'SELECT * FROM aimoc_execution_v1.trips WHERE id=$1 FOR UPDATE',[tripId]);
  if(!trip||trip.driver_id!==driverId)fail('DRIVER_TRIP_FORBIDDEN','Trip not assigned to this Driver',403);
  const assignmentTable=await one(c,"SELECT to_regclass('aimoc_execution_v1.trip_driver_assignments') AS oid");
  if(assignmentTable?.oid){
    const assignment=await one(c,`SELECT 1 AS assigned FROM aimoc_execution_v1.trip_driver_assignments
      WHERE trip_id=$1 AND driver_id=$2 AND truck_id=$3 AND status='ASSIGNED'`,[tripId,driverId,trip.truck_id]);
    if(!assignment)fail('DRIVER_TRIP_FORBIDDEN','Trip assignment is no longer active for this Driver',403);
  }
  return trip;
}
const allowedStages=new Set(['START_AUTHORIZED','TARE_CONFIRMED','LOADING','GROSS_CONFIRMED','IN_TRANSIT','ARRIVED','UNLOADED_VERIFIED','RETURNING']);
const checklistStages=new Set([...allowedStages,'QUEUED']);
export async function getDriverActiveTrip(db,{actor}){
  if(!actor?.id||actor.role!=='DRIVER')fail('DRIVER_ROLE_REQUIRED','Authenticated Driver role required');
  const driver=await one(db,'SELECT * FROM aimoc_execution_v1.driver_profiles WHERE external_user_id=$1 AND active=true',[actor.id]);
  if(!driver)return {data_status:'PENDING_DRIVER_VERIFICATION',trip:null};
  const identityTable=await one(db,"SELECT to_regclass('aimoc_execution_v1.driver_identity_bindings') AS oid");
  if(identityTable?.oid){
    const binding=await one(db,`SELECT status,verified_at FROM aimoc_execution_v1.driver_identity_bindings
      WHERE driver_id=$1 AND user_id=$2`,[driver.id,actor.id]);
    if(binding?.status!=='ACTIVE'||!binding.verified_at)
      return {data_status:'PENDING_DRIVER_VERIFICATION',trip:null};
  }
  const assignmentTable=await one(db,"SELECT to_regclass('aimoc_execution_v1.trip_driver_assignments') AS oid");
  const assignmentJoin=assignmentTable?.oid
    ?`JOIN aimoc_execution_v1.trip_driver_assignments a ON a.trip_id=t.id AND a.driver_id=t.driver_id
       AND a.truck_id=t.truck_id AND a.status='ASSIGNED'`
    :'';
  const rows=(await db.query(`SELECT t.id,t.dispatch_id,t.status,t.truck_id,t.driver_id,t.started_at,
    d.source_stockpile_id,d.destination_location_id,d.mode
    FROM aimoc_execution_v1.trips t JOIN aimoc_execution_v1.dispatches d ON d.id=t.dispatch_id
    ${assignmentJoin}
    WHERE t.driver_id=$1 AND t.status IN ('QUEUED','START_AUTHORIZED','TARE_CONFIRMED','LOADING','GROSS_CONFIRMED',
      'IN_TRANSIT','ARRIVED','UNLOADED_VERIFIED','RETURNING','ON_HOLD')
    ORDER BY CASE WHEN t.status='QUEUED' THEN 1 ELSE 0 END,
      ${assignmentTable?.oid?'a.assigned_at,':''}t.dispatch_id,t.sequence_no,t.id LIMIT 2`,[driver.id])).rows;
  if(rows.filter(t=>t.status!=='QUEUED').length>1)
    fail('DRIVER_DOUBLE_ASSIGNMENT','Driver has multiple executing trips',409);
  if(!rows.length)return {data_status:'NO_ASSIGNMENT',trip:null};
  const trip=rows[0];
  const reports=(await db.query('SELECT item_id,status,reported_at FROM aimoc_execution_v1.driver_checklist_reports WHERE trip_id=$1 AND driver_id=$2',[trip.id,driver.id])).rows;
  const tare=await one(db,`SELECT id,processing_status,failure_code FROM aimoc_execution_v1.weighbridge_inbox
    WHERE trip_id=$1 AND event_type='TARE_RECORDED' ORDER BY occurred_at DESC,authenticated_at DESC LIMIT 1`,[trip.id]);
  return {data_status:'READY',trip:{...trip,driver_user_id:actor.id,
    assignment_id:assignmentTable?.oid
      ?(await one(db,"SELECT assignment_id FROM aimoc_execution_v1.trip_driver_assignments WHERE trip_id=$1 AND status='ASSIGNED'",[trip.id]))?.assignment_id??null
      :null,
    assignment_status:'ASSIGNED',tare_status:tare?.processing_status==='ACCEPTED'?'TARE_RECEIVED':
      tare?.processing_status==='REJECTED'?'TARE_INVALID':'TARE_PENDING',
    tare_event_id:tare?.id??null,tare_failure_code:tare?.failure_code??null,
    wim_status:tare?'CONNECTED':'WIM_NOT_CONNECTED',checklist_reports:reports,
    // Explicitly unavailable; not to be inferred from Driver self-report.
    independently_verified_unload:null,return_verification:null}};
}
export async function getDriverTripHistory(db,{actor}){
  const driver=await requireDriver(db,actor);
  const rows=(await db.query(`SELECT id,dispatch_id,truck_id,status,started_at,returned_available_at
    FROM aimoc_execution_v1.trips WHERE driver_id=$1 AND status IN ('RETURNED_AVAILABLE','CANCELLED')
    ORDER BY started_at DESC NULLS LAST LIMIT 100`,[driver.id])).rows;
  return {data_status:rows.length?'READY':'EMPTY',items:rows};
}
export async function reportDriverChecklist(db,{actor,tripId,itemId,status,note=null,idempotencyKey=null}){
  if(!['DONE','ISSUE'].includes(status))fail('INVALID_CHECKLIST','Checklist status invalid',400);
  if(note!==null&&(typeof note!=='string'||note.length>500))fail('INVALID_CHECKLIST_NOTE','Note too long',400);
  return db.transaction(async c=>driverCommand(c,actor.id,idempotencyKey,'driver-checklist',{tripId,itemId,status,note},async()=>{
    const driver=await requireDriver(c,actor);
    const t=await assignedTrip(c,driver.id,tripId);
    if(!checklistStages.has(t.status))fail('TRIP_NOT_ACTIVE','Driver cannot modify an inactive trip',409);
    const item=await one(c,'SELECT id FROM aimoc_execution_v1.driver_checklist_items WHERE id=$1 AND active=true',[itemId]);
    if(!item)fail('CHECKLIST_ITEM_NOT_FOUND','Checklist item unavailable',404);
    await c.query(`INSERT INTO aimoc_execution_v1.driver_checklist_reports(trip_id,item_id,driver_id,status,note)
      VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(trip_id,item_id) DO UPDATE SET status=EXCLUDED.status,note=EXCLUDED.note,reported_at=now()`,
      [tripId,itemId,driver.id,status,note]);
    await c.query(`INSERT INTO aimoc_execution_v1.integration_outbox(id,aggregate_id,event_type,payload)
      VALUES($1,$2,'DRIVER_CHECKLIST_REPORTED',$3::jsonb)`,[randomUUID(),tripId,
        JSON.stringify({driver_id:driver.id,item_id:itemId,status,source:'DRIVER_SELF_REPORT'})]);
    return {trip_id:tripId,item_id:itemId,status,evidence_authority:'DRIVER_SELF_REPORT',
      unloading_verified:false,truck_available:false};
  }));
}
export async function reportDriverReturnStart(db,{actor,tripId,idempotencyKey=null}){
  return db.transaction(async c=>driverCommand(c,actor.id,idempotencyKey,'driver-return-start',{tripId},async()=>{
    const driver=await requireDriver(c,actor);
    const trip=await assignedTrip(c,driver.id,tripId);
    if(!trip)fail('DRIVER_TRIP_FORBIDDEN','Trip not assigned',403);
    if(trip.status!=='UNLOADED_VERIFIED'||!trip.unloaded_verified_at)
      fail('UNLOAD_NOT_VERIFIED','Driver cannot start return before verified unloading',409);
    await c.query(`UPDATE aimoc_execution_v1.trips SET status='RETURNING',return_started_at=now() WHERE id=$1`,[tripId]);
    await c.query(`INSERT INTO aimoc_execution_v1.integration_outbox(id,aggregate_id,event_type,payload)
      VALUES($1,$2,'DRIVER_RETURN_REPORTED',$3::jsonb)`,[randomUUID(),tripId,
        JSON.stringify({driver_id:driver.id,source:'DRIVER_SELF_REPORT',vehicle_released:false})]);
    return {trip_id:tripId,status:'RETURNING',truck_available:false};
  }));
}
export async function recordIndependentReturnEvidence(db,{actorId,tripId,sourceEventId,vehicleReady}){
  if(typeof actorId!=='string'||typeof sourceEventId!=='string'||sourceEventId.length<3)
    fail('RETURN_EVIDENCE_INVALID','Verifying identity and source event required',400);
  return db.transaction(async c=>{
    const trip=await one(c,'SELECT * FROM aimoc_execution_v1.trips WHERE id=$1 FOR UPDATE',[tripId]);
    if(!trip||!['UNLOADED_VERIFIED','RETURNING'].includes(trip.status)||!trip.unloaded_verified_at)
      fail('TRIP_NOT_RETURNING','Unloading evidence required before return',409);
    const driver=await one(c,'SELECT external_user_id FROM aimoc_execution_v1.driver_profiles WHERE id=$1',[trip.driver_id]);
    if(actorId===trip.driver_id||actorId===driver?.external_user_id)
      fail('SELF_VERIFICATION_FORBIDDEN','Driver cannot independently verify own return',403);
    const d=await one(c,'SELECT source_stockpile_id FROM aimoc_execution_v1.dispatches WHERE id=$1',[trip.dispatch_id]);
    const permitted=await one(c,`SELECT 1 AS ok FROM aimoc_execution_v1.operator_permissions
      WHERE actor_id=$1 AND location_id=$2 AND permission='return.verify'`,[actorId,d.source_stockpile_id]);
    if(!permitted)fail('RETURN_VERIFIER_FORBIDDEN','Return verification scope required',403);
    if(vehicleReady!==true)fail('VEHICLE_NOT_READY','Vehicle requires maintenance/hold',409);
    const existing=await one(c,'SELECT id,source_event_id FROM aimoc_execution_v1.return_verifications WHERE trip_id=$1',[tripId]);
    if(existing){
      if(existing.source_event_id===sourceEventId)return {trip_id:tripId,verified:true,replayed:true};
      fail('RETURN_ALREADY_VERIFIED','Another return event already recorded',409);
    }
    await c.query(`INSERT INTO aimoc_execution_v1.return_verifications(id,trip_id,verified_at,authorized_actor_id,vehicle_ready,source_event_id)
      VALUES($1,$2,now(),$3,true,$4)`,[randomUUID(),tripId,actorId,sourceEventId]);
    return {trip_id:tripId,verified:true,truck_available:false};
  });
}
