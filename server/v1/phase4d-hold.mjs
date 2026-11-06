import {randomUUID,createHash} from 'node:crypto';

const fail=(code,message,status=409)=>{throw Object.assign(new Error(message),{code,status});};
const one=async (db,sql,args=[])=> (await db.query(sql,args)).rows[0];
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function runCommand(c,{actorId,idempotencyKey,command,tripId,notes},callback){
 if(typeof actorId!=='string'||!actorId||typeof idempotencyKey!=='string'||idempotencyKey.length<6)
   fail('IDEMPOTENCY_REQUIRED','Actor and key required',400);
 await c.query('INSERT INTO aimoc_execution_v1.idempotency_locks(actor_id,idempotency_key) VALUES($1,$2) ON CONFLICT DO NOTHING',[actorId,idempotencyKey]);
 await c.query('SELECT 1 FROM aimoc_execution_v1.idempotency_locks WHERE actor_id=$1 AND idempotency_key=$2 FOR UPDATE',[actorId,idempotencyKey]);
 const h=digest([command,tripId,notes]);
 const p=await one(c,'SELECT command_hash,result FROM aimoc_execution_v1.command_receipts WHERE actor_id=$1 AND idempotency_key=$2 FOR UPDATE',[actorId,idempotencyKey]);
 if(p){
   if(p.command_hash!==h)fail('IDEMPOTENCY_KEY_REUSED','Key already used',409);
   return {...p.result,replayed:true};
 }
 const result=await callback();
 await c.query('INSERT INTO aimoc_execution_v1.command_receipts(actor_id,idempotency_key,command_hash,result) VALUES($1,$2,$3,$4::jsonb)',
   [actorId,idempotencyKey,h,JSON.stringify(result)]);
 return result;
}
/** HOLD keeps gate and resources occupied. No automatic release/skip. */
export async function holdTrip(db,{actorId,idempotencyKey,tripId,reason}){
 if(typeof reason!=='string'||reason.trim().length<8||reason.length>300)
   fail('INVALID_HOLD_REASON','Reason must be 8–300 characters',400);
 return db.transaction(c=>runCommand(c,{actorId,idempotencyKey,command:'hold-trip',tripId,notes:reason},async()=>{
   const t0=await one(c,'SELECT dispatch_id FROM aimoc_execution_v1.trips WHERE id=$1',[tripId]);
   if(!t0)fail('TRIP_NOT_FOUND','Trip not found',404);
   const d=await one(c,'SELECT * FROM aimoc_execution_v1.dispatches WHERE id=$1 FOR UPDATE',[t0.dispatch_id]);
   const t=await one(c,'SELECT * FROM aimoc_execution_v1.trips WHERE id=$1 FOR UPDATE',[tripId]);
   if(!['START_AUTHORIZED','TARE_CONFIRMED','LOADING','GROSS_CONFIRMED','IN_TRANSIT','ARRIVED','UNLOADED_VERIFIED','RETURNING'].includes(t.status))
     fail('TRIP_NOT_HOLDABLE','Trip not in an active operational state');
   const holdId=randomUUID();
   await c.query("UPDATE aimoc_execution_v1.trips SET pre_hold_status=status,status='ON_HOLD',hold_reason=$2 WHERE id=$1",[tripId,reason.trim()]);
   await c.query('INSERT INTO aimoc_execution_v1.trip_holds(id,trip_id,opened_by,reason,previous_status) VALUES($1,$2,$3,$4,$5)',
      [holdId,tripId,actorId,reason.trim(),t.status]);
   await c.query('INSERT INTO aimoc_execution_v1.operational_events(id,trip_id,event_type,actor_id,payload) VALUES($1,$2,$3,$4,$5::jsonb)',
      [randomUUID(),tripId,'TRIP_ON_HOLD',actorId,JSON.stringify({reason:reason.trim(),previous_status:t.status})]);
   // Gate active_trip_id, inventory accounts and occupancy intentionally unchanged.
   return {trip_id:tripId,status:'ON_HOLD',previous_status:t.status,sequence_released:false,resources_released:false};
 }));
}
/** Clear HOLD only with explicit second-actor approval; previous operational state restored, no gate release. */
export async function resolveTripHold(db,{actorId,idempotencyKey,tripId,resolutionNote}){
 if(typeof resolutionNote!=='string'||resolutionNote.trim().length<8||resolutionNote.length>300)
   fail('INVALID_RESOLUTION_NOTE','Resolution note must be 8–300 characters',400);
 return db.transaction(c=>runCommand(c,{actorId,idempotencyKey,command:'resolve-trip-hold',tripId,notes:resolutionNote},async()=>{
   const t0=await one(c,'SELECT dispatch_id FROM aimoc_execution_v1.trips WHERE id=$1',[tripId]);
   if(!t0)fail('TRIP_NOT_FOUND','Trip not found',404);
   const d=await one(c,'SELECT * FROM aimoc_execution_v1.dispatches WHERE id=$1 FOR UPDATE',[t0.dispatch_id]);
   const t=await one(c,'SELECT * FROM aimoc_execution_v1.trips WHERE id=$1 FOR UPDATE',[tripId]);
   if(t.status!=='ON_HOLD'||!t.pre_hold_status)fail('TRIP_NOT_ON_HOLD','No active hold');
   const h=await one(c,'SELECT * FROM aimoc_execution_v1.trip_holds WHERE trip_id=$1 AND resolved_at IS NULL FOR UPDATE',[tripId]);
   if(!h)fail('HOLD_NOT_FOUND','Active hold proof missing');
   if(h.opened_by===actorId)fail('HOLD_SELF_APPROVAL_FORBIDDEN','Hold author cannot approve own recovery',403);
   if(d.mode==='MARINE'&&!['UNLOADED_VERIFIED','RETURNING'].includes(t.pre_hold_status)){
     const gate=await one(c,'SELECT active_trip_id FROM aimoc_execution_v1.marine_gates WHERE dispatch_id=$1 FOR UPDATE',[d.id]);
     if(gate?.active_trip_id!==tripId)fail('SEQUENCE_GATE_MISMATCH','Gate must remain occupied for held trip');
   }
   await c.query('UPDATE aimoc_execution_v1.trip_holds SET resolved_at=now(),resolved_by=$2,resolution_note=$3 WHERE id=$1',[h.id,actorId,resolutionNote.trim()]);
   await c.query('UPDATE aimoc_execution_v1.trips SET status=$2,pre_hold_status=NULL,hold_reason=NULL WHERE id=$1',[tripId,t.pre_hold_status]);
   await c.query('INSERT INTO aimoc_execution_v1.operational_events(id,trip_id,event_type,actor_id,payload) VALUES($1,$2,$3,$4,$5::jsonb)',
      [randomUUID(),tripId,'TRIP_HOLD_RESOLVED',actorId,JSON.stringify({returned_to_status:t.pre_hold_status,hold_id:h.id})]);
   return {trip_id:tripId,status:t.pre_hold_status,sequence_released:false,resources_released:false};
 }));
}
