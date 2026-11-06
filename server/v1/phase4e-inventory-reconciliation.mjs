import {randomUUID} from 'node:crypto';
const fail=(code,msg,status=409)=>{throw Object.assign(new Error(msg),{code,status});};
const read=async(c,sql,v=[]) => (await c.query(sql,v)).rows[0];
const decimal=v=>typeof v==='string'&&/^(0|[1-9]\d{0,9})(\.\d{1,6})?$/.test(v);
const ref=v=>typeof v==='string'&&/^[a-zA-Z0-9:_./-]{6,160}$/.test(v);
const digest=v=>typeof v==='string'&&/^[0-9a-f]{64}$/i.test(v);
const stamp=v=>typeof v==='string'&&!Number.isNaN(Date.parse(v))&&(/Z$|[+-]\d{2}:\d{2}$/.test(v));
const permitted=async(c,actor,location,permission)=>{
 const p=await read(c,'SELECT 1 AS ok FROM aimoc_execution_v1.operator_permissions WHERE actor_id=$1 AND location_id=$2 AND permission=$3',[actor,location,permission]);
 if(!p)fail('FORBIDDEN_SCOPE','Location-scoped authority required',403);
};
/** Exact measured tonnes only: no automatic m3->tonne conversion. */
export async function prepareOpeningBalance(db,{actorId,locationId,skuId,measuredT,measurementRef,measuredAt,evidenceDigest}={}){
 if(!actorId||!locationId||!skuId||!decimal(measuredT)||!ref(measurementRef)||!stamp(measuredAt)||!digest(evidenceDigest))
  fail('INVALID_VERIFIED_OPENING_EVIDENCE','Source ID, mass, timestamp and evidence SHA-256 required',400);
 if(Date.parse(measuredAt)>Date.now()+300000)fail('FUTURE_MEASUREMENT','Opening evidence cannot be from the future',400);
 return db.transaction(async c=>{
  await permitted(c,actorId,locationId,'stockpile.loading.confirm');
  const a=await read(c,'SELECT * FROM aimoc_execution_v1.inventory_accounts WHERE location_id=$1 AND sku_id=$2 FOR UPDATE',[locationId,skuId]);
  if(!a)fail('OPENING_ACCOUNT_MISSING','Opening account must be provisioned');
  if(Number(a.on_hand_t)!==0||Number(a.reserved_t)!==0)fail('OPENING_ACCOUNT_NOT_EMPTY','Opening cannot overwrite stock');
  const moves=await read(c,'SELECT count(*)::int AS c FROM aimoc_execution_v1.inventory_journal WHERE location_id=$1 AND sku_id=$2',[locationId,skuId]);
  if(moves.c!==0)fail('OPENING_ACCOUNT_HAS_JOURNAL','Account has historical movements');
  const previous=await read(c,'SELECT id FROM aimoc_execution_v1.inventory_opening_reconciliations WHERE location_id=$1 AND sku_id=$2',[locationId,skuId]);
  if(previous)fail('OPENING_ALREADY_PROPOSED','Reconciliation already exists');
  const id=randomUUID();
  await c.query("INSERT INTO aimoc_execution_v1.inventory_opening_reconciliations(id,location_id,sku_id,measured_t,measurement_ref,measured_at,evidence_digest,prepared_by,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'PENDING')",
   [id,locationId,skuId,measuredT,measurementRef,measuredAt,evidenceDigest.toLowerCase(),actorId]);
  return {reconciliation_id:id,status:'PENDING',on_hand_unchanged:true,quantity_unit:'t'};
 });
}
export async function approveOpeningBalance(db,{actorId,reconciliationId}={}){
 if(!actorId||!reconciliationId)fail('OPENING_RECONCILIATION_REQUIRED','Actor and ID required',400);
 return db.transaction(async c=>{
  const r=await read(c,'SELECT * FROM aimoc_execution_v1.inventory_opening_reconciliations WHERE id=$1 FOR UPDATE',[reconciliationId]);
  if(!r||r.status!=='PENDING')fail('OPENING_NOT_PENDING','Pending reconciliation required');
  if(r.prepared_by===actorId)fail('SELF_APPROVAL_FORBIDDEN','Independent approval required',403);
  await permitted(c,actorId,r.location_id,'stockpile.departure.confirm');
  const a=await read(c,'SELECT * FROM aimoc_execution_v1.inventory_accounts WHERE location_id=$1 AND sku_id=$2 FOR UPDATE',[r.location_id,r.sku_id]);
  if(!a||Number(a.on_hand_t)!==0||Number(a.reserved_t)!==0)fail('OPENING_ACCOUNT_NOT_EMPTY','Account no longer empty');
  const journal=await read(c,'SELECT count(*)::int AS c FROM aimoc_execution_v1.inventory_journal WHERE location_id=$1 AND sku_id=$2',[r.location_id,r.sku_id]);
  if(journal.c!==0)fail('OPENING_ACCOUNT_HAS_JOURNAL','Intervening movements');
  await c.query('UPDATE aimoc_execution_v1.inventory_accounts SET on_hand_t=$1 WHERE location_id=$2 AND sku_id=$3',[r.measured_t,r.location_id,r.sku_id]);
  await c.query("UPDATE aimoc_execution_v1.inventory_opening_reconciliations SET status='APPROVED',approved_by=$1,approved_at=now() WHERE id=$2",[actorId,r.id]);
  await c.query("INSERT INTO aimoc_execution_v1.integration_outbox(id,aggregate_id,event_type,payload) VALUES($1,$2,'INVENTORY_OPENING_APPROVED',$3::jsonb)",
    [randomUUID(),r.id,JSON.stringify({location_id:r.location_id,sku_id:r.sku_id,opening_t:r.measured_t,measurement_ref:r.measurement_ref,evidence_sha256:r.evidence_digest,prepared_by:r.prepared_by,approved_by:actorId})]);
  return {reconciliation_id:r.id,status:'APPROVED',opening_t:r.measured_t,source:'INDEPENDENTLY_APPROVED_MEASUREMENT'};
 });
}
export async function auditInventoryIntegrity(db){
 const accounts=(await db.query('SELECT location_id,sku_id,on_hand_t,reserved_t FROM aimoc_execution_v1.inventory_accounts')).rows;
 const issues=[];
 for(const a of accounts){
  const openings=(await db.query("SELECT * FROM aimoc_execution_v1.inventory_opening_reconciliations WHERE location_id=$1 AND sku_id=$2 AND status='APPROVED'",[a.location_id,a.sku_id])).rows;
  if(openings.length!==1){issues.push({location_id:a.location_id,sku_id:a.sku_id,code:'VERIFIED_OPENING_MISSING'});continue;}
  const journal=(await db.query('SELECT delta_on_hand_t FROM aimoc_execution_v1.inventory_journal WHERE location_id=$1 AND sku_id=$2',[a.location_id,a.sku_id])).rows;
  const expected=Math.round((Number(openings[0].measured_t)+journal.reduce((s,x)=>s+Number(x.delta_on_hand_t),0))*1e6)/1e6;
  if(Math.abs(expected-Number(a.on_hand_t))>1e-6)issues.push({location_id:a.location_id,sku_id:a.sku_id,code:'INVENTORY_JOURNAL_MISMATCH',expected_t:expected,actual_t:a.on_hand_t});
  if(Number(a.reserved_t)>Number(a.on_hand_t)||Number(a.reserved_t)<0)issues.push({location_id:a.location_id,sku_id:a.sku_id,code:'INVALID_RESERVATION'});
 }
 return {result:issues.length?'BLOCKED':'PASS',accounts:accounts.length,issues};
}
