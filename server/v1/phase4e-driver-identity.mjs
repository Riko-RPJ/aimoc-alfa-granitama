import {randomUUID} from 'node:crypto';
import {reconcilePendingWeighbridgeEventsInTransaction} from './phase4b-weighbridge.mjs';
const fail=(code,message,status=409)=>{throw Object.assign(new Error(message),{code,status});};
const one=async(db,sql,args=[])=> (await db.query(sql,args)).rows[0];
const valid=x=>typeof x==='string'&&/^[A-Za-z0-9:._/-]{6,150}$/.test(x);
/**
 * Binding is PENDING until independently verified against the authoritative
 * identity provider. Caller must NOT infer binding from a test username.
 */
export async function proposeDriverBinding(db,{actorId,driverId,userId,credentialAuthority,identityEvidenceRef}={}){
 if(!actorId||!driverId||!userId||!valid(credentialAuthority)||!valid(identityEvidenceRef))
  fail('IDENTITY_EVIDENCE_REQUIRED','Authoritative identity reference required',400);
 return db.transaction(async c=>{
  const driver=await one(c,'SELECT * FROM aimoc_execution_v1.driver_profiles WHERE id=$1 FOR UPDATE',[driverId]);
  if(!driver?.active||driver.external_user_id!==userId)fail('DRIVER_PROFILE_MISMATCH','Active Driver profile must match identity ID',403);
  const existing=await one(c,'SELECT driver_id FROM aimoc_execution_v1.driver_identity_bindings WHERE driver_id=$1 OR user_id=$2',[driverId,userId]);
  if(existing)fail('DRIVER_IDENTITY_ALREADY_BOUND','Binding cannot be duplicated');
  await c.query("INSERT INTO aimoc_execution_v1.driver_identity_bindings(driver_id,user_id,credential_authority,identity_evidence_ref,provisioned_by,status) VALUES($1,$2,$3,$4,$5,'PENDING')",
    [driverId,userId,credentialAuthority,identityEvidenceRef,actorId]);
  return {driver_id:driverId,status:'PENDING',authenticated_access:false};
 });
}
export async function verifyDriverBinding(db,{actorId,driverId,verifiedIdentityRef}={}){
 if(!actorId||!driverId||!valid(verifiedIdentityRef))fail('IDENTITY_VERIFICATION_REQUIRED','Verified reference required',400);
 return db.transaction(async c=>{
  const b=await one(c,'SELECT * FROM aimoc_execution_v1.driver_identity_bindings WHERE driver_id=$1 FOR UPDATE',[driverId]);
  if(!b||b.status!=='PENDING')fail('DRIVER_BINDING_NOT_PENDING','Pending binding required');
  if(b.provisioned_by===actorId||b.user_id===actorId||b.driver_id===actorId)
    fail('DRIVER_SELF_APPROVAL_FORBIDDEN','Independent identity verifier required',403);
  if(b.identity_evidence_ref!==verifiedIdentityRef)
    fail('IDENTITY_EVIDENCE_MISMATCH','Independent authority evidence reference differs');
  await c.query("UPDATE aimoc_execution_v1.driver_identity_bindings SET status='ACTIVE',verified_by=$1,verified_at=now() WHERE driver_id=$2",[actorId,driverId]);
  const pending=(await c.query(`SELECT DISTINCT t.id FROM aimoc_execution_v1.trips t
    JOIN aimoc_execution_v1.weighbridge_inbox e ON e.trip_id=t.id AND e.processing_status='PENDING'
    WHERE t.driver_id=$1 ORDER BY t.id`,[driverId])).rows;
  for(const trip of pending)await reconcilePendingWeighbridgeEventsInTransaction(c,{tripId:trip.id});
  return {driver_id:driverId,status:'ACTIVE',user_id:b.user_id};
 });
}
export async function revokeDriverBinding(db,{actorId,driverId}={}){
 if(!actorId||!driverId)fail('DRIVER_ID_REQUIRED','Actor and Driver required',400);
 return db.transaction(async c=>{
  const b=await one(c,'SELECT * FROM aimoc_execution_v1.driver_identity_bindings WHERE driver_id=$1 FOR UPDATE',[driverId]);
  if(!b||b.status==='REVOKED')fail('DRIVER_BINDING_NOT_ACTIVE','Binding not active');
  if(actorId===b.user_id||actorId===b.driver_id)fail('DRIVER_SELF_REVOKE_FORBIDDEN','Independent administrator required',403);
  await c.query("UPDATE aimoc_execution_v1.driver_identity_bindings SET status='REVOKED' WHERE driver_id=$1",[driverId]);
  await c.query("UPDATE aimoc_execution_v1.driver_profiles SET active=false WHERE id=$1",[driverId]);
  await c.query("INSERT INTO aimoc_execution_v1.integration_outbox(id,aggregate_id,event_type,payload) VALUES($1,$2,'DRIVER_IDENTITY_REVOKED',$3::jsonb)",
    [randomUUID(),driverId,JSON.stringify({driver_id:driverId,revoked_by:actorId})]);
  return {driver_id:driverId,status:'REVOKED',session_revalidation_required:true};
 });
}
