import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createEmbeddedDatabase} from '../server/database.mjs';
import {createIsolatedExecutionSchema,startLandTrip} from '../server/v1/execution-staging.mjs';
import {extendIsolatedExecutionSchema} from '../server/v1/phase4b-schema.mjs';
import {extendUnifiedOperationalSchema} from '../server/v1/phase4g-schema.mjs';
import {extendPhase4E} from '../server/v1/phase4e-schema.mjs';
import {prepareOpeningBalance,approveOpeningBalance} from '../server/v1/phase4e-inventory-reconciliation.mjs';
import {assignDispatchLoadingPoint,bindTripDriverAssignment,getUnifiedTripContext,auditUnifiedOperationalIntegrity} from '../server/v1/unified-operational-contract.mjs';
import {reserveDispatchInventory} from '../server/v1/phase4b-inventory.mjs';
import {stagingV1} from '../server/v1/staging-api.mjs';
import {normalizeDriverTrip} from '../src/services/driver-workspace-adapter.js';

test('Phase 4G: one authoritative ID graph across dispatch, trip, inventory, Driver, crusher and loading point',async t=>{
 const db=await createEmbeddedDatabase();
 const q=(sql,v=[])=>db.query(sql,v);
 try{
  await createIsolatedExecutionSchema(db);
  await extendIsolatedExecutionSchema(db);
  await extendUnifiedOperationalSchema(db);
  await extendPhase4E(db);
  await q("INSERT INTO aimoc_execution_v1.inventory_accounts(location_id,sku_id,on_hand_t) VALUES('stock-uat','sku-uat',0),('other-stock','sku-uat',0)");
  await q("INSERT INTO aimoc_execution_v1.driver_profiles(id,external_user_id,display_name) VALUES('driver-uat','user-uat-driver','Driver UAT')");
  await q(`INSERT INTO aimoc_execution_v1.driver_identity_bindings
   (driver_id,user_id,credential_authority,identity_evidence_ref,provisioned_by,verified_by,verified_at,status)
   VALUES('driver-uat','user-uat-driver','idp:qa','evidence:driver-uat','qa-provisioner','qa-verifier',now(),'ACTIVE')`);
  await q("INSERT INTO aimoc_execution_v1.fleet_vehicle_specs(truck_id,payload_limit_t) VALUES('truck-uat',50)");
  await q("INSERT INTO aimoc_execution_v1.crusher_location_refs(crusher_id,crusher_name,source_stockpile_id,zone,status) VALUES('crusher-uat','Crusher QA','stock-uat','Zona UAT','ACTIVE'),('other-crusher','Other Crusher','other-stock','Other','ACTIVE')");
  await q("INSERT INTO aimoc_execution_v1.loading_point_refs(loading_point_id,crusher_id,loading_point_name,verification_status) VALUES('point-uat','crusher-uat','Loading QA','UNVERIFIED'),('other-point','other-crusher','Wrong Point','UNVERIFIED')");
  await q("INSERT INTO aimoc_execution_v1.dispatches(id,mode,status,source_stockpile_id,destination_location_id,sku_id,planned_quantity_t) VALUES('dispatch-uat','LAND','PLANNED','stock-uat','customer-uat','sku-uat',40)");
  await q("INSERT INTO aimoc_execution_v1.trips(id,dispatch_id,sequence_no,status,truck_id,driver_id,planned_quantity_t) VALUES('trip-uat','dispatch-uat',1,'QUEUED','truck-uat','driver-uat',40)");
  await q(`INSERT INTO aimoc_execution_v1.operator_permissions(actor_id,location_id,permission)
   VALUES('qa-preparer','stock-uat','stockpile.loading.confirm'),('qa-preparer','other-stock','stockpile.loading.confirm'),
    ('qa-approver','stock-uat','stockpile.departure.confirm'),('qa-approver','other-stock','stockpile.departure.confirm')`);
  for(const [locationId,ref] of [['stock-uat','qa-open-stock'],['other-stock','qa-open-other']]){
   const opening=await prepareOpeningBalance(db,{actorId:'qa-preparer',locationId,skuId:'sku-uat',
    measuredT:'100.000000',measurementRef:ref,measuredAt:new Date().toISOString(),
    evidenceDigest:createHash('sha256').update('isolated phase4g '+locationId).digest('hex')});
   await approveOpeningBalance(db,{actorId:'qa-approver',reconciliationId:opening.reconciliation_id});
  }
  const admin={id:'admin-uat',role:'admin',crusherIds:[],jettyIds:[]};
  const stock={id:'stock-uat-user',role:'stock',crusherIds:['stock-uat'],jettyIds:[]};
  const driver={id:'user-uat-driver',role:'driver'};
  const otherDriver={id:'unassigned-driver',role:'driver'};
  const req={headers:{'idempotency-key':'unified-uat-key-0001'}};
  const post=(actor,path,body={},key='idempotency-uat-default')=>stagingV1({
   db,actor,req:{headers:{'idempotency-key':key}},path,method:'POST',body
  });

  await t.test('foreign keys reject non-existent Driver, truck and stock account',async()=>{
   await assert.rejects(()=>q("INSERT INTO aimoc_execution_v1.trips(id,dispatch_id,sequence_no,status,truck_id,driver_id,planned_quantity_t) VALUES('bad-trip','dispatch-uat',2,'QUEUED','truck-uat','not-real',1)"),e=>e.code==='23503');
   await assert.rejects(()=>q("INSERT INTO aimoc_execution_v1.dispatches(id,mode,status,source_stockpile_id,destination_location_id,sku_id,planned_quantity_t) VALUES('bad-dispatch','LAND','PLANNED','missing-stock','cust','sku-uat',1)"),e=>e.code==='23503');
  });
  await t.test('staging Admin cannot assign a point from a different crusher or stockpile',async()=>{
   await assert.rejects(()=>post(admin,'/api/v1/dispatches/dispatch-uat/assign-loading-point',
    {crusher_id:'other-crusher',loading_point_id:'other-point'},'assignment-cross-stock'),e=>e.code==='CRUSHER_STOCKPILE_MISMATCH');
   await assert.rejects(()=>post(admin,'/api/v1/dispatches/dispatch-uat/assign-loading-point',
    {crusher_id:'crusher-uat',loading_point_id:'other-point'},'assignment-cross-crusher'),e=>e.code==='LOADING_POINT_CRUSHER_MISMATCH');
   await assert.rejects(()=>post(stock,'/api/v1/dispatches/dispatch-uat/assign-loading-point',
    {crusher_id:'crusher-uat',loading_point_id:'point-uat'},'stock-not-admin'),e=>e.code==='FORBIDDEN_SCOPE');
  });
  await t.test('reservation refuses missing location and Driver binding',async()=>{
   await assert.rejects(()=>reserveDispatchInventory(db,{actorId:'admin-uat',idempotencyKey:'reserve-need-binding',dispatchId:'dispatch-uat'}),e=>e.code==='LOADING_POINT_ASSIGNMENT_REQUIRED');
   const a=await post(admin,'/api/v1/dispatches/dispatch-uat/assign-loading-point',{crusher_id:'crusher-uat',loading_point_id:'point-uat'},'assign-point');
   assert.equal(a.data.loading_point_id,'point-uat');
   assert.equal(a.data.location_status,'UNVERIFIED');
   await assert.rejects(()=>reserveDispatchInventory(db,{actorId:'admin-uat',idempotencyKey:'reserve-need-driver',dispatchId:'dispatch-uat'}),e=>e.code==='DRIVER_ASSIGNMENT_REQUIRED');
   const locationReplay=await post(admin,'/api/v1/dispatches/dispatch-uat/assign-loading-point',{crusher_id:'crusher-uat',loading_point_id:'point-uat'},'assign-point');
   assert.equal(locationReplay.data.replayed,true);
   await assert.rejects(()=>post(admin,'/api/v1/dispatches/dispatch-uat/assign-loading-point',
    {crusher_id:'other-crusher',loading_point_id:'other-point'},'assign-point'),e=>e.code==='IDEMPOTENCY_KEY_REUSED');
   await assert.rejects(()=>q("INSERT INTO aimoc_execution_v1.dispatch_loading_assignments(dispatch_id,crusher_id,loading_point_id,source_stockpile_id,loading_point_version,assigned_by) VALUES('dispatch-uat','crusher-uat','point-uat','other-stock',1,'fake')"),e=>e.code==='23505');
   const b=await post(admin,'/api/v1/trips/trip-uat/assign-driver',{assignment_id:'assignment-uat',driver_id:'driver-uat'},'assign-driver');
   assert.equal(b.data.assignment_id,'assignment-uat');
   const driverReplay=await post(admin,'/api/v1/trips/trip-uat/assign-driver',{assignment_id:'assignment-uat',driver_id:'driver-uat'},'assign-driver');
   assert.equal(driverReplay.data.replayed,true);
   await assert.rejects(()=>post(admin,'/api/v1/trips/trip-uat/assign-driver',
    {assignment_id:'different-assignment',driver_id:'driver-uat'},'assign-driver'),e=>e.code==='IDEMPOTENCY_KEY_REUSED');
   await assert.rejects(()=>q("UPDATE aimoc_execution_v1.trip_driver_assignments SET driver_id='missing-driver' WHERE trip_id='trip-uat'"),e=>e.code==='23503');

   const r=await post(admin,'/api/v1/dispatches/dispatch-uat/reserve',{},'reserve-uat-valid');
   assert.equal(r.data.status,'READY');
  });
  await t.test('all three roles read consistent operational IDs and inventory figures',async()=>{
   const started=await post(admin,'/api/v1/trips/trip-uat/start',{},'start-uat-valid');
   assert.equal(started.data.status,'START_AUTHORIZED');
   const a=await stagingV1({db,actor:admin,req,path:'/api/v1/trips/trip-uat',method:'GET'});
   const s=await stagingV1({db,actor:stock,req,path:'/api/v1/trips/trip-uat',method:'GET'});
   const dr=await stagingV1({db,actor:driver,req,path:'/api/v1/trips/trip-uat',method:'GET'});
   const self=await stagingV1({db,actor:driver,req,path:'/api/v1/driver/me/active-trip',method:'GET'});
   for(const agent of [a,s,dr]){
    const x=agent.data;
    assert.equal(x.trip_id,'trip-uat');assert.equal(x.dispatch_id,'dispatch-uat');
    assert.equal(x.assignment_id,'assignment-uat');
    assert.equal(x.driver_id,'driver-uat');assert.equal(x.truck_id,'truck-uat');
    assert.equal(x.inventory.location_id,'stock-uat');
    assert.equal(x.inventory.reserved_t,agent===dr?null:'40.000000');
    assert.equal(x.inventory.reservation_status,'ACTIVE');
    assert.equal(x.crusher_destination.crusher_id,'crusher-uat');
    assert.equal(x.crusher_destination.loading_point.id,'point-uat');
    assert.equal(x.crusher_destination.latitude,null);
    assert.equal(x.crusher_destination.location_status,'UNVERIFIED');
    assert.equal(x.contract_integrity.navigation_enabled,false);
   }
   assert.equal(self.data.trip.crusher_destination.loading_point.id,'point-uat');
   assert.equal(self.data.trip.inventory.reserved_t,null);
   assert.equal(self.data.trip.inventory.on_hand_t,null);
   assert.equal(self.data.trip.inventory.trip_reserved_t,'40.000000');
   assert.equal(dr.data.stock_balance_visibility,'REDACTED_FOR_DRIVER');

   assert.equal(normalizeDriverTrip(self.data.trip).crusherDestination.verified,false);
   assert.equal((await auditUnifiedOperationalIntegrity(db)).status,'PASS');
   await assert.rejects(()=>stagingV1({db,actor:otherDriver,req,path:'/api/v1/trips/trip-uat',method:'GET'}),e=>e.code==='FORBIDDEN_SCOPE');
  });
  await t.test('source master revision mismatch invalidates location contract, never silently substitutes coordinates',async()=>{
   await q("UPDATE aimoc_execution_v1.loading_point_refs SET version=version+1 WHERE loading_point_id='point-uat'");
   const context=await getUnifiedTripContext(db,{tripId:'trip-uat'});
   assert.equal(context.crusher_destination.location_status,'STALE_MASTER');
   assert.equal(context.crusher_destination.latitude,null);
   const audit=await auditUnifiedOperationalIntegrity(db);
   assert.equal(audit.status,'BLOCKED');
   assert.ok(audit.issues.some(x=>x.code==='CRUSHER_ASSIGNMENT_VALID'));
  });
 }finally{await db.close();}
});
