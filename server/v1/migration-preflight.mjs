/**
 * Read-only cutover analysis of legacy JSONB. Does NOT generate fake tonnes,
 * inferred verified evidence or automatically backfill business identities.
 */
const rows=(source,key)=>Array.isArray(source?.[key])?source[key]:[];
const mark=(id,level,message,count)=>({id,level,message,count});
export function inspectLegacyMigration({state,revision,updatedAt}={}){
 if(!state||typeof state!=='object'||!Number.isInteger(Number(revision)))
   throw Object.assign(new Error('Legacy operation snapshot and revision required'),{code:'INVALID_LEGACY_SNAPSHOT'});
 const inventory=rows(state,'stockpiles'),dispatches=rows(state,'dispatches'),
  trips=rows(state,'trips'),requests=rows(state,'requests'),
  measures=rows(state,'measurements'),audit=rows(state,'events'),
  products=rows(state,'products'),crushers=rows(state,'crushers'),
  jetties=rows(state,'jetties'),trucks=rows(state,'trucks');
 const blocking=[];
 const items=[
  mark('MIG-001','BLOCKING','Legacy source inventory is m3 and cannot be automatically promoted to verified tonnes',inventory.length),
  mark('MIG-002','BLOCKING','Historical dispatch mode, destination allocation and voyage cannot be inferred from legacy serial truck queue',dispatches.length),
  mark('MIG-003','BLOCKING','QR/TARE/GROSS and independent final receiving proof require external-source verification',trips.length),
  mark('MIG-004','BLOCKING','Driver profile, assignment and return evidence require authoritative identity mapping',trucks.length),
  mark('MIG-005','BLOCKING','Jetty custody is not proof of downstream voyage final destination stock receipt',jetties.length),
  mark('MIG-006','ACTION','Audit and integration outbox require event-by-event provenance reconciliation',audit.length),
  mark('MIG-007','ACTION','Existing reservations and transfer request allocations require immutable reconciliation',requests.length),
 ];
 blocking.push(...items.filter(x=>x.level==='BLOCKING'));
 const referenceIssues=[];
 const productIds=new Set(products.map(x=>x.id)),crusherIds=new Set(crushers.map(x=>x.id));
 for(const stock of inventory){
  if(stock.skuId&&!productIds.has(stock.skuId))referenceIssues.push({kind:'UNKNOWN_SKU',id:stock.id});
  if(stock.crusherId&&!crusherIds.has(stock.crusherId))referenceIssues.push({kind:'UNKNOWN_CRUSHER',id:stock.id});
 }
 for(const trip of trips){
  if(trip.truckId&&!trucks.some(x=>x.id===trip.truckId))referenceIssues.push({kind:'UNKNOWN_TRUCK',id:trip.id});
 }
 const duplicates={};
 for(const name of ['trips','dispatches','requests','stockpiles']){
  const seen=new Set();
  duplicates[name]=rows(state,name).filter(x=>{if(!x.id)return true;
   if(seen.has(x.id))return true;seen.add(x.id);return false;}).map(x=>x.id??null);
 }
 return {
  report_version:'1.0',source:'LEGACY_READ_ONLY',legacy_revision:Number(revision),
  legacy_updated_at:updatedAt??null,
  production_ready:false,automated_backfill_authorized:false,
  counts:{products:products.length,crushers:crushers.length,jetties:jetties.length,trucks:trucks.length,
   stockpiles:inventory.length,requests:requests.length,dispatches:dispatches.length,trips:trips.length,
   measurements:measures.length,audit_events:audit.length},
  findings:items,blocking_count:blocking.length,
  referential_issues:referenceIssues,duplicate_identity_issues:duplicates,
  reconciliation_required:[
   'Confirm source physical stock as verified tonnage with actual measurement and signed approval',
   'Map every historical dispatch to LAND or MARINE and explicit destination allocations',
   'Confirm unique per-dispatch trip sequence and voyage reference where MARINE',
   'Bind real Driver IDs and truck payload masters to current assignments',
   'Reconcile every verified weight, receipt, source departure and return event',
   'Prove jetty custody is separate from final barge voyage destination settlement',
   'Approve deviation/shortfall thresholds, backfill policy and rollback runbook',
  ],
 };
}
export async function analyzeLegacyDatabase(db){
 const q=await db.query('SELECT document,revision,updated_at FROM aimoc_alfa_ops.operation WHERE id=1');
 if(!q.rows.length)throw Object.assign(new Error('Operation not initialized'),{code:'LEGACY_NOT_INITIALIZED'});
 const source=q.rows[0];
 return inspectLegacyMigration({state:source.document,revision:source.revision,updatedAt:source.updated_at});
}
