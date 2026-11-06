import {createHmac,createHash,randomUUID,timingSafeEqual} from 'node:crypto';
import {verifyWeighbridgeSourceReadiness} from './phase4e-weighbridge-config.mjs';

const fail=(code,message,status=409)=>{throw Object.assign(new Error(message),{code,status});};
const one=async(c,sql,values=[]) => (await c.query(sql,values)).rows[0];
const hash=x=>createHash('sha256').update(x).digest('hex');

/** External HMAC calculated over timestamp + newline + unmodified request bytes. */
export function signWeighbridgePayload({timestamp,rawBody,secret}) {
  return createHmac('sha256',secret).update(timestamp+'\n'+rawBody).digest('hex');
}
const validIso=x=>typeof x==='string' && Number.isFinite(Date.parse(x)) && /Z$|[+-]\d{2}:\d{2}$/.test(x);
const weight=x=>{
  if(typeof x!=='string' || !/^(0|[1-9]\d{0,8})(\.\d{1,6})?$/.test(x))
    fail('INVALID_WEIGHT','Weight must be an exact nonnegative decimal string (tonnes)',400);
  return x;
};
const types=new Set(['QR_SCANNED','TARE_RECORDED','GROSS_RECORDED']);

export function authenticateWeighbridgeRequest({sourceSystem,timestamp,signature,rawBody,sourceSecrets,now=Date.now()}){
  if(typeof sourceSystem!=='string'||!sourceSystem||typeof timestamp!=='string'||typeof rawBody!=='string'||
     typeof signature!=='string'||!/^[a-f0-9]{64}$/i.test(signature))
    fail('WEIGHBRIDGE_AUTH_REQUIRED','Signed weighbridge identity required',401);
  if(!validIso(timestamp)||Math.abs(now-Date.parse(timestamp))>5*60*1000)
    fail('WEIGHBRIDGE_SIGNATURE_EXPIRED','Signed request timestamp outside five-minute window',401);
  const secret=sourceSecrets?.[sourceSystem];
  if(typeof secret!=='string'||secret.length<24)
    fail('WEIGHBRIDGE_SOURCE_UNKNOWN','Source is not provisioned',401);
  const expected=signWeighbridgePayload({timestamp,rawBody,secret});
  if(!timingSafeEqual(Buffer.from(signature,'hex'),Buffer.from(expected,'hex')))
    fail('WEIGHBRIDGE_INVALID_SIGNATURE','Signature mismatch',401);
}

/** Apply signed, recorded event only when its state dependencies and source ordering hold. */
async function validateTripAssignment(c,trip){
  const assignmentTable=await one(c,"SELECT to_regclass('aimoc_execution_v1.trip_driver_assignments') AS oid");
  if(!assignmentTable?.oid)return;
  const assignment=await one(c,`SELECT a.assignment_id FROM aimoc_execution_v1.trip_driver_assignments a
    JOIN aimoc_execution_v1.driver_profiles p ON p.id=a.driver_id AND p.active=true
    JOIN aimoc_execution_v1.fleet_vehicle_specs v ON v.truck_id=a.truck_id AND v.active=true
    WHERE a.trip_id=$1 AND a.driver_id=$2 AND a.truck_id=$3 AND a.status='ASSIGNED'`,
    [trip.id,trip.driver_id,trip.truck_id]);
  if(!assignment)fail('WEIGHBRIDGE_ASSIGNMENT_INVALID','Trip has no valid Driver and truck assignment',403);
  const identityTable=await one(c,"SELECT to_regclass('aimoc_execution_v1.driver_identity_bindings') AS oid");
  if(identityTable?.oid){
    const binding=await one(c,`SELECT b.status,b.verified_at FROM aimoc_execution_v1.driver_identity_bindings b
      JOIN aimoc_execution_v1.driver_profiles p ON p.id=b.driver_id AND p.external_user_id=b.user_id
      WHERE b.driver_id=$1 AND b.status='ACTIVE' AND b.verified_at IS NOT NULL AND p.active=true`,
      [trip.driver_id]);
    if(!binding)fail('WEIGHBRIDGE_ASSIGNMENT_INVALID','Driver identity is not independently verified',403);
  }
}
async function tryApply(c,e){
  const t=await one(c,'SELECT * FROM aimoc_execution_v1.trips WHERE id=$1 FOR UPDATE',[e.trip_id]);
  if(!t||t.truck_id!==e.truck_id)fail('WEIGHBRIDGE_TRIP_MISMATCH','Truck and trip correlation do not match');
  if(e.event_type==='QR_SCANNED'){
    if(t.status!=='START_AUTHORIZED')return false;
    if(t.qr_event_id)fail('QR_ALREADY_BOUND','Trip already has a QR identity event');
    await c.query('UPDATE aimoc_execution_v1.trips SET qr_event_id=$1 WHERE id=$2',[e.id,t.id]);
    return true;
  }
  if(e.event_type==='TARE_RECORDED'){
    if(t.status!=='START_AUTHORIZED'||!t.qr_event_id)return false;
    const qr=await one(c,'SELECT occurred_at FROM aimoc_execution_v1.weighbridge_inbox WHERE id=$1 AND processing_status=\'ACCEPTED\'',[t.qr_event_id]);
    if(!qr||Date.parse(e.occurred_at)<Date.parse(qr.occurred_at))fail('WEIGHBRIDGE_EVENT_ORDER','TARE predates QR identification');
    await c.query(`UPDATE aimoc_execution_v1.trips SET status='TARE_CONFIRMED',tare_t=$1 WHERE id=$2`,[e.weight_t,t.id]);
    return true;
  }
  if(e.event_type==='GROSS_RECORDED'){
    if(t.status!=='LOADING'||t.tare_t===null)return false;
    const tare=await one(c,`SELECT occurred_at FROM aimoc_execution_v1.weighbridge_inbox
      WHERE trip_id=$1 AND event_type='TARE_RECORDED' AND processing_status='ACCEPTED'
      ORDER BY occurred_at DESC LIMIT 1`,[t.id]);
    if(!tare||Date.parse(e.occurred_at)<Date.parse(tare.occurred_at))fail('WEIGHBRIDGE_EVENT_ORDER','GROSS predates TARE');
    const gross=Number(e.weight_t),empty=Number(t.tare_t);
    if(gross<=empty)fail('WEIGHBRIDGE_INVALID_NET','Gross must be strictly larger than tare');
    const net=Math.round((gross-empty)*1e6)/1e6;
    const spec=await one(c,'SELECT payload_limit_t,active FROM aimoc_execution_v1.fleet_vehicle_specs WHERE truck_id=$1',[t.truck_id]);
    if(!spec?.active)fail('TRUCK_SPEC_MISSING','Active approved vehicle specification required');
    if(net>Number(spec.payload_limit_t)+0.000001)
      fail('TRUCK_PAYLOAD_EXCEEDED','Verified net weight exceeds approved truck payload limit');
    if(net>Number(t.planned_quantity_t)+0.000001)
      fail('LOAD_EXCEEDS_RESERVATION','Verified net weight exceeds allocated trip quantity');
    await c.query(`UPDATE aimoc_execution_v1.trips
      SET status='GROSS_CONFIRMED',gross_t=$1,actual_net_t=$2 WHERE id=$3`,
      [e.weight_t,net.toFixed(6),t.id]);
    return true;
  }
  return false;
}

export async function ingestSignedWeighbridgeEvent(db,{sourceSystem,timestamp,signature,rawBody,sourceSecrets,now}){
  authenticateWeighbridgeRequest({sourceSystem,timestamp,signature,rawBody,sourceSecrets,now});
  if(Buffer.byteLength(rawBody)>32768)fail('WEIGHBRIDGE_PAYLOAD_TOO_LARGE','Event exceeds 32 KiB',413);
  let payload;
  try{payload=JSON.parse(rawBody);}catch{fail('INVALID_JSON','Invalid weighbridge JSON',400);}
  const required=['external_event_id','event_type','trip_id','truck_id','weighbridge_id','occurred_at'];
  if(!payload||typeof payload!=='object'||Array.isArray(payload)||
     required.some(k=>typeof payload[k]!=='string'||!payload[k]||payload[k].length>120)||
     !types.has(payload.event_type)||!validIso(payload.occurred_at)||
     payload.source_system!==sourceSystem)
    fail('INVALID_WEIGHBRIDGE_EVENT','Malformed event or mismatched source',400);
  if((payload.event_type==='QR_SCANNED'&&payload.weight_t!==undefined)||
     (payload.event_type!=='QR_SCANNED'&&payload.weight_t===undefined))
    fail('INVALID_WEIGHBRIDGE_EVENT','QR is identity only; weight must accompany TARE/GROSS',400);
  if(payload.weight_t!==undefined)weight(payload.weight_t);
  if(Date.parse(payload.occurred_at)>Date.now()+5*60*1000)
    fail('WEIGHBRIDGE_FUTURE_EVENT','Future event timestamp',400);
  const digest=hash(rawBody);
  return db.transaction(async c=>{
    const source=await one(c,'SELECT * FROM aimoc_execution_v1.weighbridge_sources WHERE source_system=$1',[sourceSystem]);
    if(!source?.active||source.authorized_weighbridge_id!==payload.weighbridge_id)
      fail('WEIGHBRIDGE_SOURCE_FORBIDDEN','Weighbridge source unauthorized',403);
    await verifyWeighbridgeSourceReadiness(c,{sourceSystem});
    const previous=await one(c,'SELECT * FROM aimoc_execution_v1.weighbridge_inbox WHERE source_system=$1 AND external_event_id=$2 FOR UPDATE',[sourceSystem,payload.external_event_id]);
    if(previous){
      if(previous.payload_sha256!==digest)fail('WEIGHBRIDGE_DUPLICATE_CONFLICT','Same external event id with different payload');
      return {event_id:previous.id,status:previous.processing_status,replayed:true};
    }
    const trip=await one(c,'SELECT * FROM aimoc_execution_v1.trips WHERE id=$1 FOR UPDATE',[payload.trip_id]);
    if(!trip)fail('WEIGHBRIDGE_TRIP_MISMATCH','Unknown trip or assigned truck mismatch',422);
    let rejectionCode=trip.truck_id!==payload.truck_id?'WEIGHBRIDGE_TRIP_MISMATCH':null;
    if(!rejectionCode){
      try{await validateTripAssignment(c,trip);}
      catch(error){
        if(!Number.isInteger(error?.status)||error.status<400||error.status>=500)throw error;
        rejectionCode=error.code||'WEIGHBRIDGE_ASSIGNMENT_INVALID';
      }
    }
    const id=randomUUID();
    await c.query(`INSERT INTO aimoc_execution_v1.weighbridge_inbox
      (id,source_system,external_event_id,event_type,trip_id,truck_id,weighbridge_id,weight_t,occurred_at,payload_sha256,processing_status,failure_code)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [id,sourceSystem,payload.external_event_id,payload.event_type,payload.trip_id,payload.truck_id,
        payload.weighbridge_id,payload.weight_t??null,payload.occurred_at,digest,
        rejectionCode?'REJECTED':'PENDING',rejectionCode]);
    if(rejectionCode){
      await c.query(`INSERT INTO aimoc_execution_v1.integration_outbox(id,aggregate_id,event_type,payload)
        VALUES($1,$2,'WEIGHBRIDGE_EVENT_INGESTED',$3::jsonb)`,
       [randomUUID(),trip.id,JSON.stringify({source_system:sourceSystem,external_event_id:payload.external_event_id,
         processing_status:'REJECTED',failure_code:rejectionCode})]);
      return {event_id:id,status:'REJECTED',failure_code:rejectionCode,replayed:false};
    }
    const e={...payload,id,weight_t:payload.weight_t??null};
    let applied=false,failureCode=null;
    try{applied=await tryApply(c,e);}
    catch(error){
      if(!Number.isInteger(error?.status)||error.status<400||error.status>=500)throw error;
      failureCode=error.code||'WEIGHBRIDGE_EVENT_INVALID';
      await c.query(`UPDATE aimoc_execution_v1.weighbridge_inbox
        SET processing_status='REJECTED',failure_code=$1 WHERE id=$2`,[failureCode,id]);
    }
    if(applied)await c.query(`UPDATE aimoc_execution_v1.weighbridge_inbox SET processing_status='ACCEPTED' WHERE id=$1`,[id]);
    await c.query(`INSERT INTO aimoc_execution_v1.integration_outbox(id,aggregate_id,event_type,payload)
      VALUES($1,$2,$3,$4::jsonb)`,[randomUUID(),trip.id,'WEIGHBRIDGE_EVENT_INGESTED',
        JSON.stringify({source_system:sourceSystem,external_event_id:payload.external_event_id,
          processing_status:failureCode?'REJECTED':applied?'ACCEPTED':'PENDING',failure_code:failureCode})]);
    return {event_id:id,status:failureCode?'REJECTED':applied?'ACCEPTED':'PENDING',
      failure_code:failureCode,replayed:false};
  });
}

/** A valid signed event may arrive early and remain PENDING; never invent missing events. */
export async function reconcilePendingWeighbridgeEvents(db,{tripId}){
  return db.transaction(async c=>{
    const pending=(await c.query(`SELECT * FROM aimoc_execution_v1.weighbridge_inbox
      WHERE trip_id=$1 AND processing_status='PENDING' ORDER BY occurred_at,id FOR UPDATE`,[tripId])).rows;
    let processed=0,rejected=0;
    for(const e of pending){
      let applied=false;
      try{applied=await tryApply(c,e);}
      catch(error){
        if(!Number.isInteger(error?.status)||error.status<400||error.status>=500)throw error;
        await c.query(`UPDATE aimoc_execution_v1.weighbridge_inbox
          SET processing_status='REJECTED',failure_code=$1 WHERE id=$2`,[error.code||'WEIGHBRIDGE_EVENT_INVALID',e.id]);
        rejected++;
      }
      if(applied){await c.query(`UPDATE aimoc_execution_v1.weighbridge_inbox SET processing_status='ACCEPTED' WHERE id=$1`,[e.id]);processed++;}
    }
    return {trip_id:tripId,processed,rejected,remaining:pending.length-processed-rejected};
  });
}
