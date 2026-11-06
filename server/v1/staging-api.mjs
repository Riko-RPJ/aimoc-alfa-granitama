import {reserveDispatchInventory,confirmTripLoading,departVerifiedTrip,confirmTripArrival,verifyDestinationReceipt} from './phase4b-inventory.mjs';
import {startMarineTrip,startLandTrip,finalizeMarineUnload,verifyMarineTripReturn} from './execution-staging.mjs';
import {reportDriverChecklist,reportDriverReturnStart,recordIndependentReturnEvidence,getDriverActiveTrip,getDriverTripHistory} from './phase4b-driver.mjs';
import {authenticateWeighbridgeRequest,ingestSignedWeighbridgeEvent} from './phase4b-weighbridge.mjs';
import {holdTrip,resolveTripHold} from './phase4d-hold.mjs';
import {assignDispatchLoadingPoint,bindTripDriverAssignment,getUnifiedTripContext,getUnifiedDispatchContext,projectUnifiedTripForDriver} from './unified-operational-contract.mjs';
import {createUnifiedDispatch} from './phase4h-cross-role.mjs';

const reject=(status,code,message)=>{throw Object.assign(new Error(message),{status,code});};
const validId=x=>typeof x==='string'&&/^[A-Za-z0-9_-]{1,120}$/.test(x);
const required=(x,label)=>{if(!validId(x))reject(400,'VALIDATION_ERROR',label+' required');return x;};
const envelope=(resource,data,status='READY')=>({schema_version:'1.0',resource,source:'V1_STAGING',data_status:status,as_of:new Date().toISOString(),data});
const role=(actor,roles)=>{if(!roles.includes(actor?.role))reject(403,'FORBIDDEN_SCOPE','Role not authorized');};
const commandKey=headers=>{const k=headers['idempotency-key'];if(!validId(k)||k.length<6)reject(400,'IDEMPOTENCY_REQUIRED','Idempotency-Key required');return k;};
const only=(body,names)=>{
 if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(x=>!names.includes(x)))
  reject(400,'INVALID_COMMAND_BODY','Unexpected command fields');
};
const one=async(db,sql,args=[])=> (await db.query(sql,args)).rows[0];
async function unifiedEnabled(db){
 const row=await one(db,"SELECT to_regclass('aimoc_execution_v1.dispatch_loading_assignments') AS name");
 return !!row?.name;
}
async function driverIdentityEnabled(db){
 const row=await one(db,"SELECT to_regclass('aimoc_execution_v1.driver_identity_bindings') AS name");
 return !!row?.name;
}

async function scope(db,actor,tripId,kind){
 const trip=await one(db,'SELECT t.*,d.source_stockpile_id,d.destination_location_id FROM aimoc_execution_v1.trips t JOIN aimoc_execution_v1.dispatches d ON d.id=t.dispatch_id WHERE t.id=$1',[tripId]);
 if(!trip)reject(404,'TRIP_NOT_FOUND','Trip not found');
 if(actor.role==='admin')return trip;
 const destination=kind==='receive';
 if(actor.role==='stock'&&!((destination?actor.jettyIds:actor.crusherIds)||[]).includes(destination?trip.destination_location_id:trip.source_stockpile_id))
  reject(403,'FORBIDDEN_SCOPE','Outside assigned location scope');
 if(actor.role==='jetty'&&(!destination||!(actor.jettyIds||[]).includes(trip.destination_location_id)))
  reject(403,'FORBIDDEN_SCOPE','Jetty actor outside receiving scope');
 if(!['admin','stock','jetty'].includes(actor.role))reject(403,'FORBIDDEN_SCOPE','Operator role required');
 return trip;
}
/** Staging-only command adapter. Not imported by the legacy application handler. */
export async function stagingV1({db,actor,req,path,method,body={},rawBody,sourceSecrets}){
 if(!db)throw Error('STAGING_DATABASE_REQUIRED');
 if(method==='POST'&&path==='/api/v1/integrations/weighbridge/events'){
   if(actor)reject(403,'M2M_ONLY','Machine identity required');
   const h=req.headers;
   authenticateWeighbridgeRequest({sourceSystem:h['x-aimoc-source'],timestamp:h['x-aimoc-timestamp'],
    signature:h['x-aimoc-signature'],rawBody,sourceSecrets});
   if(!await unifiedEnabled(db)||!await driverIdentityEnabled(db))
    reject(501,'WEIGHBRIDGE_NOT_INTEGRATED','Verified trip assignment contract is not installed');
   return envelope('weighbridge_ingest',await ingestSignedWeighbridgeEvent(db,{
     sourceSystem:h['x-aimoc-source'],timestamp:h['x-aimoc-timestamp'],
     signature:h['x-aimoc-signature'],rawBody,sourceSecrets
   }));
 }
 if(!actor)reject(401,'AUTH_REQUIRED','Session required');
 if(method==='GET'&&path==='/api/v1/driver/me/active-trip'){
   role(actor,['driver']);
   if(!await unifiedEnabled(db))return envelope('driver_active_trip',null,'NOT_INTEGRATED');
   if(!await driverIdentityEnabled(db))return envelope('driver_active_trip',null,'PENDING_DRIVER_VERIFICATION');
   const out=await getDriverActiveTrip(db,{actor:{id:actor.id,role:'DRIVER'}});
   if(out.data_status==='READY'&&out.trip&&await unifiedEnabled(db)){
     const projection=await getUnifiedTripContext(db,{tripId:out.trip.id});
     out.trip={...out.trip,...projectUnifiedTripForDriver(projection),checklist_reports:out.trip.checklist_reports};
   }
   return envelope('driver_active_trip',out,out.data_status);
 }
 if(method==='GET'&&path==='/api/v1/driver/me/trips'){
   role(actor,['driver']);
   if(!await unifiedEnabled(db))return envelope('driver_history',null,'NOT_INTEGRATED');
   if(!await driverIdentityEnabled(db))return envelope('driver_history',null,'PENDING_DRIVER_VERIFICATION');
   const out=await getDriverTripHistory(db,{actor:{id:actor.id,role:'DRIVER'}});
   if(out.data_status==='READY'&&await unifiedEnabled(db)){
     out.items=await Promise.all(out.items.map(async item=>({...item,...projectUnifiedTripForDriver(await getUnifiedTripContext(db,{tripId:item.id}))})));
   }
   return envelope('driver_history',out,out.data_status);
 }
 const dispatchContext=/^\/api\/v1\/dispatches\/([^/]+)\/operational-context$/.exec(path);
 if(method==='GET'&&dispatchContext){
   role(actor,['admin','stock']);
   if(!await unifiedEnabled(db))reject(501,'UNIFIED_CONTRACT_NOT_INSTALLED','Unified staging schema missing');
   const context=await getUnifiedDispatchContext(db,{dispatchId:required(dispatchContext[1],'dispatchId')});
   if(actor.role==='stock'&&!(actor.crusherIds||[]).includes(context.source_stockpile_id))
     reject(403,'FORBIDDEN_SCOPE','Outside source stockpile scope');
   return envelope('dispatch_operational_context',context);
 }
 if(method==='GET'&&path==='/api/v1/dispatches'){
   role(actor,['admin','stock']);
   if(!await unifiedEnabled(db))reject(501,'UNIFIED_CONTRACT_NOT_INSTALLED','Unified staging schema missing');
   const scoped=actor.role==='stock'?(actor.crusherIds||[]):null;
   const ids=actor.role==='admin'
    ?(await db.query('SELECT id FROM aimoc_execution_v1.dispatches ORDER BY id LIMIT 100')).rows
    :(scoped.length?(await db.query('SELECT id FROM aimoc_execution_v1.dispatches WHERE source_stockpile_id=ANY($1::text[]) ORDER BY id LIMIT 100',[scoped])).rows:[]);
   const items=await Promise.all(ids.map(x=>getUnifiedDispatchContext(db,{dispatchId:x.id})));
   return envelope('dispatch_list',{items,next_cursor:null,limit:100},items.length?'READY':'EMPTY');
 }
 if(method==='GET'&&path==='/api/v1/dispatch/planning-options'){
   role(actor,['admin']);
   if(!await unifiedEnabled(db))reject(501,'UNIFIED_CONTRACT_NOT_INSTALLED','Normalized execution schema missing.');
   if(!await driverIdentityEnabled(db))reject(501,'DRIVER_IDENTITY_NOT_INTEGRATED','Verified Driver source missing.');
   const opening=await one(db,"SELECT to_regclass('aimoc_execution_v1.inventory_opening_reconciliations') AS oid");
   if(!opening?.oid)reject(501,'INVENTORY_RECONCILIATION_NOT_INTEGRATED','Approved opening balance service is missing.');
   const [stock,crusher,points,trucks,drivers]=await Promise.all([
    db.query(`SELECT a.location_id,a.sku_id,a.on_hand_t,a.reserved_t
     FROM aimoc_execution_v1.inventory_accounts a
     JOIN aimoc_execution_v1.inventory_opening_reconciliations o
     ON o.location_id=a.location_id AND o.sku_id=a.sku_id AND o.status='APPROVED'
     WHERE a.on_hand_t>a.reserved_t ORDER BY a.location_id,a.sku_id`),
    db.query(`SELECT crusher_id,crusher_name,source_stockpile_id,zone
     FROM aimoc_execution_v1.crusher_location_refs WHERE status='ACTIVE' ORDER BY crusher_name`),
    db.query(`SELECT loading_point_id,crusher_id,loading_point_name,verification_status
     FROM aimoc_execution_v1.loading_point_refs WHERE verification_status<>'SUSPENDED' ORDER BY loading_point_name`),
    db.query(`SELECT f.truck_id,f.payload_limit_t,
     NOT EXISTS (SELECT 1 FROM aimoc_execution_v1.resource_claims c
       WHERE c.truck_id=f.truck_id AND c.released_at IS NULL) AS available_now,
     (SELECT count(*)::int FROM aimoc_execution_v1.trip_driver_assignments a
      JOIN aimoc_execution_v1.trips t ON t.id=a.trip_id
      WHERE a.truck_id=f.truck_id AND a.status='ASSIGNED'
      AND t.status='QUEUED') AS queued_trips
     FROM aimoc_execution_v1.fleet_vehicle_specs f WHERE f.active=true
     ORDER BY f.truck_id`),
    db.query(`SELECT p.id AS driver_id,p.display_name,
     NOT EXISTS (SELECT 1 FROM aimoc_execution_v1.resource_claims c
       WHERE c.driver_id=p.id AND c.released_at IS NULL) AS available_now,
     (SELECT count(*)::int FROM aimoc_execution_v1.trip_driver_assignments a
       JOIN aimoc_execution_v1.trips t ON t.id=a.trip_id
       WHERE a.driver_id=p.id AND a.status='ASSIGNED' AND t.status='QUEUED') AS queued_trips
     FROM aimoc_execution_v1.driver_profiles p
     JOIN aimoc_execution_v1.driver_identity_bindings b ON b.driver_id=p.id
      AND b.user_id=p.external_user_id AND b.status='ACTIVE' AND b.verified_at IS NOT NULL
     WHERE p.active=true
     ORDER BY p.display_name,p.id`)
   ]);
   const optional=async(table,sql)=> {
    const found=await one(db,'SELECT to_regclass($1) AS name',[table]);
    return found?.name?(await db.query(sql)).rows:[];
   };
   const [voyages,windows]=await Promise.all([
    optional('aimoc_execution_v1.voyage_capacity',`SELECT voyage_id,capacity_t,reserved_t FROM aimoc_execution_v1.voyage_capacity WHERE status='READY' ORDER BY voyage_id`),
    optional('aimoc_execution_v1.jetty_windows',`SELECT id,voyage_id,jetty_id,starts_at,ends_at FROM aimoc_execution_v1.jetty_windows WHERE status='READY' AND ends_at>now() ORDER BY starts_at`)
   ]);
   const options={accounts:stock.rows,crushers:crusher.rows,loading_points:points.rows,
    trucks:trucks.rows,drivers:drivers.rows,voyages,jetty_windows:windows,
    requirements:{
     inventory_approved:stock.rows.length>0,active_crusher:crusher.rows.length>0,
     loading_point_available:points.rows.length>0,eligible_truck:trucks.rows.length>0,
     independently_verified_driver:drivers.rows.length>0,
     operational_wim_connected:false,
     legacy_request_crosswalk_approved:false
    }};
   return envelope('dispatch_planning_options',options,
     Object.entries(options.requirements).slice(0,5).every(([,v])=>v)?'READY':'EMPTY');
 }
 if(method==='GET'&&path==='/api/v1/drivers/assignable'){
   role(actor,['admin']);
   const identityTable=await one(db,"SELECT to_regclass('aimoc_execution_v1.driver_identity_bindings') AS oid");
   if(!identityTable?.oid)reject(501,'DRIVER_IDENTITY_NOT_INTEGRATED','Verified Driver identity source is not provisioned');
   const items=(await db.query(`SELECT p.id AS driver_id,p.display_name,p.external_user_id AS driver_user_id,
    NOT EXISTS (SELECT 1 FROM aimoc_execution_v1.resource_claims c
      WHERE c.driver_id=p.id AND c.released_at IS NULL) AS available_now
    FROM aimoc_execution_v1.driver_profiles p
    JOIN aimoc_execution_v1.driver_identity_bindings b ON b.driver_id=p.id
      AND b.user_id=p.external_user_id AND b.status='ACTIVE' AND b.verified_at IS NOT NULL
    WHERE p.active=true
    ORDER BY p.display_name,p.id LIMIT 200`)).rows;
   return envelope('assignable_drivers',{items},items.length?'READY':'EMPTY');
 }
 if(method==='GET'&&path==='/api/v1/trips'){
   role(actor,['admin','stock','jetty']);
   if(!await unifiedEnabled(db))reject(501,'UNIFIED_CONTRACT_NOT_INSTALLED','Unified staging schema missing');
   const scoped=actor.role==='stock'?(actor.crusherIds||[]):actor.role==='jetty'?(actor.jettyIds||[]):null;
   const ids=actor.role==='admin'
    ?(await db.query('SELECT id FROM aimoc_execution_v1.trips ORDER BY started_at DESC NULLS LAST,id LIMIT 100')).rows
    :(scoped.length?(await db.query(`SELECT t.id FROM aimoc_execution_v1.trips t
      JOIN aimoc_execution_v1.dispatches d ON d.id=t.dispatch_id
      WHERE ${actor.role==='jetty'?'d.destination_location_id':'d.source_stockpile_id'}=ANY($1::text[])
      ORDER BY t.started_at DESC NULLS LAST,t.id LIMIT 100`,[scoped])).rows:[]);
   const items=await Promise.all(ids.map(x=>getUnifiedTripContext(db,{tripId:x.id})));
   return envelope('trip_monitoring',{items,next_cursor:null,limit:100},items.length?'READY':'EMPTY');
 }
 if(method==='GET'&&path==='/api/v1/stockpile/me/pickups'){
   role(actor,['stock']);
   if(!await unifiedEnabled(db))reject(501,'UNIFIED_CONTRACT_NOT_INSTALLED','Unified staging schema missing');
   const locations=actor.crusherIds||[];
   const ids=locations.length?(await db.query(`SELECT t.id FROM aimoc_execution_v1.trips t
    JOIN aimoc_execution_v1.dispatches d ON d.id=t.dispatch_id
    WHERE d.source_stockpile_id=ANY($1::text[]) AND t.status IN
     ('QUEUED','START_AUTHORIZED','TARE_CONFIRMED','LOADING','GROSS_CONFIRMED','IN_TRANSIT')
    ORDER BY t.started_at DESC NULLS LAST,t.id LIMIT 100`,[locations])).rows:[];
   const items=await Promise.all(ids.map(x=>getUnifiedTripContext(db,{tripId:x.id})));
   return envelope('stockpile_pickup_queue',{items,
    accept_pickup_precondition:'TARE_CONFIRMED',next_cursor:null,limit:100},
    items.length?'READY':'EMPTY');
 }
 const detail=/^\/api\/v1\/trips\/([^/]+)$/.exec(path);
 if(method==='GET'&&detail){
   const tripId=required(detail[1],'tripId');
   const trip=await one(db,'SELECT * FROM aimoc_execution_v1.trips WHERE id=$1',[tripId]);
   if(!trip)reject(404,'TRIP_NOT_FOUND','Trip not found');
   if(actor.role==='driver'){
     if(!await unifiedEnabled(db))reject(501,'NOT_INTEGRATED','Driver operational contract is not installed');
     if(!await driverIdentityEnabled(db))reject(403,'PENDING_DRIVER_VERIFICATION','Verified Driver identity source is not provisioned');
     const p=await one(db,'SELECT id FROM aimoc_execution_v1.driver_profiles WHERE external_user_id=$1 AND active=true',[actor.id]);
     if(p?.id!==trip.driver_id)reject(403,'FORBIDDEN_SCOPE','Not assigned to Driver');
     const identityTable=await one(db,"SELECT to_regclass('aimoc_execution_v1.driver_identity_bindings') AS oid");
     if(identityTable?.oid){
       const verified=await one(db,"SELECT status,verified_at FROM aimoc_execution_v1.driver_identity_bindings WHERE driver_id=$1 AND user_id=$2",[trip.driver_id,actor.id]);
       if(verified?.status!=='ACTIVE'||!verified.verified_at)
         reject(403,'DRIVER_IDENTITY_UNVERIFIED','Independently verified Driver identity required');
     }
       const assignment=await one(db,`SELECT 1 AS assigned FROM aimoc_execution_v1.trip_driver_assignments
         WHERE trip_id=$1 AND driver_id=$2 AND truck_id=$3 AND status='ASSIGNED'`,[tripId,p.id,trip.truck_id]);
       if(!assignment)reject(403,'FORBIDDEN_SCOPE','Trip assignment is no longer active for this Driver');

   }else await scope(db,actor,tripId,actor.role==='jetty'?'receive':'source');
   if(await unifiedEnabled(db)){const context=await getUnifiedTripContext(db,{tripId});return envelope('trip',actor.role==='driver'?projectUnifiedTripForDriver(context):context);}
   return envelope('trip',{trip_id:trip.id,dispatch_id:trip.dispatch_id,status:trip.status,truck_id:trip.truck_id,
     tare_t:trip.tare_t??null,gross_t:trip.gross_t??null,actual_net_t:trip.actual_net_t??null,
     unloaded_verified_at:trip.unloaded_verified_at??null,returned_available_at:trip.returned_available_at??null});
 }
 if(method!=='POST')return null;
 const key=commandKey(req.headers);
 if(path==='/api/v1/dispatches'){
   role(actor,['admin']);
   if(!await unifiedEnabled(db))reject(501,'UNIFIED_CONTRACT_NOT_INSTALLED','Unified staging schema missing');
   if(!await driverIdentityEnabled(db))reject(501,'DRIVER_IDENTITY_NOT_INTEGRATED','Verified Driver identity source is not provisioned');
   if(!await driverIdentityEnabled(db))reject(409,'PENDING_DRIVER_VERIFICATION','Verified Driver identity binding required.');
   const opening=await one(db,"SELECT to_regclass('aimoc_execution_v1.inventory_opening_reconciliations') AS oid");
   if(!opening?.oid)reject(409,'INVENTORY_RECONCILIATION_REQUIRED','Approved inventory opening evidence required.');
   return envelope('dispatch_created',await createUnifiedDispatch(db,{actorId:actor.id,idempotencyKey:key,body}));
 }

 const assignLocation=/^\/api\/v1\/dispatches\/([^/]+)\/assign-loading-point$/.exec(path);
 if(assignLocation){
   role(actor,['admin']);only(body,['crusher_id','loading_point_id']);
   if(!await unifiedEnabled(db))reject(501,'UNIFIED_CONTRACT_NOT_INSTALLED','Unified staging schema missing');
   return envelope('dispatch_loading_assignment',await assignDispatchLoadingPoint(db,{
    actorId:actor.id,idempotencyKey:key,dispatchId:required(assignLocation[1],'dispatchId'),
    crusherId:required(body.crusher_id,'crusher_id'),
    loadingPointId:required(body.loading_point_id,'loading_point_id')}));
 }
 const assignDriver=/^\/api\/v1\/trips\/([^/]+)\/assign-driver$/.exec(path);
 if(assignDriver){
   role(actor,['admin']);only(body,['assignment_id','driver_id']);
   if(!await unifiedEnabled(db))reject(501,'UNIFIED_CONTRACT_NOT_INSTALLED','Unified staging schema missing');
   if(!await driverIdentityEnabled(db))reject(501,'DRIVER_IDENTITY_NOT_INTEGRATED','Verified Driver identity source is not provisioned');
   return envelope('trip_driver_assignment',await bindTripDriverAssignment(db,{
    actorId:actor.id,idempotencyKey:key,tripId:required(assignDriver[1],'tripId'),
    assignmentId:required(body.assignment_id,'assignment_id'),
    driverId:required(body.driver_id,'driver_id'),
    requireVerified:true}));
 }

 const reservation=/^\/api\/v1\/dispatches\/([^/]+)\/reserve$/.exec(path);
 if(reservation){
   role(actor,['admin']);only(body,[]);
   return envelope('dispatch_reservation',await reserveDispatchInventory(db,{actorId:actor.id,idempotencyKey:key,dispatchId:required(reservation[1],'dispatchId')}));
 }
 const match=/^\/api\/v1\/trips\/([^/]+)\/([a-z-]+)$/.exec(path);
 if(!match)return null;
 const tripId=required(match[1],'tripId'),action=match[2],base={actorId:actor.id,idempotencyKey:key,tripId};
 if(action==='hold'){
   role(actor,['admin']);only(body,['reason']);
   return envelope('trip_hold',await holdTrip(db,{...base,reason:body.reason}));
 }
 if(action==='resolve-hold'){
   role(actor,['admin']);only(body,['resolution_note']);
   return envelope('trip_hold_recovery',await resolveTripHold(db,{...base,resolutionNote:body.resolution_note}));
 }
 if(action==='start'){
   role(actor,['admin']);only(body,[]);
   const row=await one(db,'SELECT d.mode FROM aimoc_execution_v1.trips t JOIN aimoc_execution_v1.dispatches d ON d.id=t.dispatch_id WHERE t.id=$1',[tripId]);
   if(!row)reject(404,'TRIP_NOT_FOUND','Trip not found');
   if(await unifiedEnabled(db)){
    if(!await driverIdentityEnabled(db))reject(409,'PENDING_DRIVER_VERIFICATION','Verified Driver identity source is not provisioned');
    const context=await getUnifiedTripContext(db,{tripId});
    if(!context.contract_integrity.driver_assignment_valid)
     reject(409,'PENDING_DRIVER_VERIFICATION','Verified Driver assignment is required before trip start');
   }
   return envelope('trip_start',await (row.mode==='MARINE'?startMarineTrip:startLandTrip)(db,base));
 }
 if(action==='accept-pickup'){
   role(actor,['stock']);await scope(db,actor,tripId,'source');only(body,[]);
   return envelope('stockpile_pickup_acceptance',await confirmTripLoading(db,base));
 }
 if(action==='loading'){
   role(actor,['admin','stock']);await scope(db,actor,tripId,'source');only(body,[]);
   return envelope('loading',await confirmTripLoading(db,base));
 }
 if(action==='depart'){
   role(actor,['admin','stock']);await scope(db,actor,tripId,'source');only(body,[]);
   return envelope('departure',await departVerifiedTrip(db,base));
 }
 if(action==='arrive'){
   role(actor,['admin','stock','jetty']);await scope(db,actor,tripId,'receive');only(body,[]);
   return envelope('arrival',await confirmTripArrival(db,base));
 }
 if(action==='receive'){
   role(actor,['admin','stock','jetty']);await scope(db,actor,tripId,'receive');only(body,['received_t','external_receipt_id']);
   return envelope('receiving',await verifyDestinationReceipt(db,{...base,receivedT:body.received_t,externalReceiptId:body.external_receipt_id}));
 }
 if(action==='finalize-unload'){
   role(actor,['admin','stock','jetty']);await scope(db,actor,tripId,'receive');only(body,[]);
   return envelope('unload',await finalizeMarineUnload(db,base));
 }
 if(action==='checklist'){
   role(actor,['driver']);only(body,['item_id','status','note']);
   return envelope('driver_checklist',await reportDriverChecklist(db,{actor:{id:actor.id,role:'DRIVER'},tripId,
     itemId:body.item_id,status:body.status,note:body.note??null,idempotencyKey:key}));
 }
 if(action==='return-start'){
   role(actor,['driver']);only(body,[]);
   return envelope('driver_return',await reportDriverReturnStart(db,{actor:{id:actor.id,role:'DRIVER'},tripId,idempotencyKey:key}));
 }
 if(action==='verify-return-evidence'){
   role(actor,['admin','stock']);await scope(db,actor,tripId,'source');only(body,['source_event_id','vehicle_ready']);
   return envelope('return_evidence',await recordIndependentReturnEvidence(db,{actorId:actor.id,tripId,
     sourceEventId:body.source_event_id,vehicleReady:body.vehicle_ready}));
 }
 if(action==='complete-return'){
   role(actor,['admin','stock']);await scope(db,actor,tripId,'source');only(body,[]);
   return envelope('return_release',await verifyMarineTripReturn(db,base));
 }
 return null;
}
