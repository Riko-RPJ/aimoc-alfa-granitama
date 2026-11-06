const fail=(code,message,status=409)=>{throw Object.assign(new Error(message),{code,status});};
const one=async(db,sql,args=[])=> (await db.query(sql,args)).rows[0];
const sourceId=x=>typeof x==='string'&&/^[A-Za-z0-9._:-]{3,120}$/.test(x);
const evidence=x=>typeof x==='string'&&/^[A-Za-z0-9:._/-]{6,160}$/.test(x);
/**
 * Protocol profile is a target interface, NOT proof a real vendor has agreed.
 * Actual secret remains in managed secret store, referenced by credentialRef.
 */
export async function proposeWeighbridgeSource(db,{actorId,sourceSystem,protocolVersion,credentialRef,vendorContractRef}={}){
 if(!actorId||!sourceId(sourceSystem)||protocolVersion!=='AIMOC_WIM_EVENT_V1'||!evidence(credentialRef)||!evidence(vendorContractRef))
  fail('WEIGHBRIDGE_VENDOR_CONTRACT_REQUIRED','Protocol, managed secret reference and vendor proof required',400);
 return db.transaction(async c=>{
  const source=await one(c,'SELECT * FROM aimoc_execution_v1.weighbridge_sources WHERE source_system=$1 FOR UPDATE',[sourceSystem]);
  if(!source)fail('WEIGHBRIDGE_SOURCE_MISSING','Device must be provisioned');
  const previous=await one(c,'SELECT source_system FROM aimoc_execution_v1.integration_source_config WHERE source_system=$1',[sourceSystem]);
  if(previous)fail('WEIGHBRIDGE_CONFIG_EXISTS','Device has a configured lifecycle');
  await c.query("INSERT INTO aimoc_execution_v1.integration_source_config(source_system,protocol_version,credential_ref,vendor_contract_ref,proposed_by,status) VALUES($1,$2,$3,$4,$5,'DRAFT')",
   [sourceSystem,protocolVersion,credentialRef,vendorContractRef,actorId]);
  return {source_system:sourceSystem,status:'DRAFT',accepted_for_ingestion:false};
 });
}
export async function approveWeighbridgeSource(db,{actorId,sourceSystem}={}){
 if(!actorId||!sourceSystem)fail('APPROVAL_REQUIRED','Authorized operator and source required',400);
 return db.transaction(async c=>{
  const source=await one(c,'SELECT * FROM aimoc_execution_v1.integration_source_config WHERE source_system=$1 FOR UPDATE',[sourceSystem]);
  if(!source||source.status!=='DRAFT')fail('WEIGHBRIDGE_CONFIG_NOT_DRAFT','Draft approval required');
  if(source.proposed_by===actorId)fail('WEIGHBRIDGE_SELF_APPROVAL_FORBIDDEN','An independent reviewer must approve vendor source',403);
  await c.query("UPDATE aimoc_execution_v1.integration_source_config SET status='APPROVED',approved_by=$1,approved_at=now() WHERE source_system=$2",[actorId,sourceSystem]);
  return {source_system:sourceSystem,status:'APPROVED',vendor_hardware_verified:false};
 });
}
/** Preconditions that must hold even if signed HMAC is technically valid. */
export async function verifyWeighbridgeSourceReadiness(c,{sourceSystem}){
 const table=await one(c,"SELECT to_regclass('aimoc_execution_v1.integration_source_config') AS oid");
 if(!table?.oid)return {mode:'PHASE4B_COMPATIBILITY'};
 const source=await one(c,'SELECT * FROM aimoc_execution_v1.integration_source_config WHERE source_system=$1',[sourceSystem]);
 if(!source||source.status!=='APPROVED'||!source.approved_at||source.protocol_version!=='AIMOC_WIM_EVENT_V1')
  fail('WEIGHBRIDGE_VENDOR_NOT_APPROVED','Vendor protocol and managed key reference must be approved',403);
 return {mode:'APPROVED_STAGING_CONTRACT',credential_ref:source.credential_ref};
}
