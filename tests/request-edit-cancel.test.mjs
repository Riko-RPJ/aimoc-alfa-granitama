import test from 'node:test';
import assert from 'node:assert/strict';
import {createSeed} from '../server/seed.mjs';
import {applyIntegratedAction,integratedView} from '../server/integrated-demo-domain.mjs';
import {requestLifecycle} from '../server/request-lifecycle.mjs';
import {refreshAutomaticDispatchProgress} from '../server/automatic-dispatch.mjs';

const admin={id:'request-admin',role:'admin'},otherAdmin={id:'request-admin-2',role:'admin'};
const stock={id:'request-stock',role:'stock',crusherIds:['crusher-1','crusher-2']};
const jetty={id:'request-jetty',role:'jetty',jettyIds:['jetty-1']};
const driver={id:'request-driver',role:'driver',active:true};
const options={drivers:[driver]};
const definition=(extra={})=>({transferMode:'MARINE',destinationLocationId:'stockpile-location-crusher-2',jettyId:'jetty-1',vesselId:'vessel-1',lines:[{skuId:'split-12',quantity:60,unit:'t'}],...extra});
const physical=s=>structuredClone(Object.fromEntries(['stockpiles','trucks','vessels','dispatches','trips','inventoryLedger','erpOutbox'].map(key=>[key,s[key]])));
function fixture(){
 const state=createSeed();
 const act=(action,payload,actor=admin)=>applyIntegratedAction(state,action,payload,actor,options);
 const requestId=act('request.create',definition()).requestId;
 const get=()=>state.requests.find(row=>row.id===requestId);
 const update=(extra={},actor=admin)=>act('request.update',{requestId,expectedRequestRevision:get().requestRevision,...definition(),...extra},actor);
 return {state,act,requestId,get,update};
}
const rejectsAtomic=(f,run,code)=>{const before=structuredClone(f.state);assert.throws(run,error=>error.code===code);assert.deepEqual(f.state,before);};

test('create defaults only omitted transport mode to MARINE and rejects explicitly invalid modes without mutation',()=>{
 const f=fixture();
 for(const transferMode of [null,'',false,0])rejectsAtomic(f,()=>f.act('request.create',definition({transferMode})),'TRANSFER_MODE_INVALID');
 const omitted=definition();delete omitted.transferMode;
 const requestId=f.act('request.create',omitted).requestId;
 assert.equal(f.state.requests.find(row=>row.id===requestId).transferMode,'MARINE');
});

test('edit recomputes authoritative units, keeps identity and metadata, audits once without stock, fleet, vessel or ERP movement',()=>{
 const f=fixture(),r=f.get();r.clientMetadata={reference:'retained'};r.customDemoSetting={pace:3};
 const identity=Object.fromEntries(['id','code','createdAt','requestedBy','source','synthetic'].map(key=>[key,r[key]])),before=physical(f.state);
 const createdEvents=f.state.events.filter(row=>row.type==='request.created').length;
 f.update({jettyId:'jetty-2',vesselId:'vessel-3',lines:[{skuId:'basecourse',quantity:30,unit:'m3'},{skuId:'split-12',quantity:20,unit:'t'}]},otherAdmin);
 assert.deepEqual(Object.fromEntries(Object.keys(identity).map(key=>[key,f.get()[key]])),identity);
 assert.deepEqual(f.get().clientMetadata,{reference:'retained'});assert.deepEqual(f.get().customDemoSetting,{pace:3});
 assert.equal(f.get().requestRevision,2);assert.equal(f.get().editedBy,otherAdmin.id);assert.ok(f.get().editedAt);
 assert.equal(f.get().jettyId,'jetty-2');assert.equal(f.get().vesselId,'vessel-3');
 assert.deepEqual(f.get().lines[0],{skuId:'basecourse',quantity:30,unit:'m3',densityTPerM3:1.65,tonnageT:49.5,volumeM3:30});
 assert.equal(f.get().lines[1].volumeM3,13.333333);assert.equal(f.get().remainingT,69.5);
 assert.deepEqual(physical(f.state),before);assert.equal(f.state.requests.length,1);
 assert.equal(f.state.events.filter(row=>row.type==='request.created').length,createdEvents);
 const audit=f.state.events.find(row=>row.type==='request.updated');assert.equal(audit.before.lines[0].quantity,60);assert.equal(audit.after.lines[0].quantity,30);assert.equal(audit.actorId,otherAdmin.id);
 const projected=integratedView(f.state,admin,options).requests[0];assert.equal(projected.canEdit,true);assert.equal(projected.canCancel,true);assert.equal(projected.requestRevision,2);
});

test('target CAS blocks missing, malformed, and stale drafts even if the latest document is polled',()=>{
 const f=fixture();
 for(const expectedRequestRevision of [undefined,null,0,-1,'1',1.5])rejectsAtomic(f,()=>f.update({expectedRequestRevision}),'REQUEST_REVISION_REQUIRED');
 f.update({lines:[{skuId:'split-23',quantity:10,unit:'m3'}]},otherAdmin);
 rejectsAtomic(f,()=>f.update({expectedRequestRevision:1}),'REQUEST_REVISION_CONFLICT');
 rejectsAtomic(f,()=>f.act('request.cancel',{requestId:f.requestId,expectedRequestRevision:1}),'REQUEST_REVISION_CONFLICT');
 assert.equal(f.get().lines[0].skuId,'split-23');assert.equal(f.get().requestRevision,2);
});

test('only Admin can edit or cancel; role-scoped projection never grants these capabilities',()=>{
 const f=fixture();
 for(const actor of [stock,jetty,driver]){
  rejectsAtomic(f,()=>f.update({},actor),'FORBIDDEN');
  rejectsAtomic(f,()=>f.act('request.cancel',{requestId:f.requestId,expectedRequestRevision:1},actor),'FORBIDDEN');
  const projection=requestLifecycle(f.state,f.get(),actor);assert.equal(projection.canEdit,false);assert.equal(projection.canCancel,false);assert.equal(projection.editBlockedReasonEn,'This action is available only to Admin.');
  for(const row of integratedView(f.state,actor,options).requests){assert.equal(row.canEdit,false);assert.equal(row.canCancel,false);}
 }
});

test('invalid SKU, units, amounts, destination, vessel and managed fields fail atomically',()=>{
 const f=fixture();
 const cases=[
  [{lines:[]},'VALIDATION'],[{lines:[{skuId:'unknown',quantity:10,unit:'t'}]},'NOT_FOUND'],
  [{lines:[{skuId:'split-12',quantity:0,unit:'t'}]},'VALIDATION'],[{lines:[{skuId:'split-12',quantity:10,unit:'kg'}]},'VALIDATION'],
  [{lines:[{skuId:'split-12',quantity:10,unit:'t'},{skuId:'split-12',quantity:3,unit:'m3'}]},'VALIDATION'],
  [{lines:[{skuId:'split-12',quantity:10,unit:'t',tonnageT:0}]},'REQUEST_FIELD_INVALID'],
  [{status:'requested'},'REQUEST_FIELD_INVALID'],[{source:'LEGACY'},'REQUEST_FIELD_INVALID'],
  [{destinationLocationId:'missing-location'},'DESTINATION_LOCATION_NOT_FOUND'],
  [{jettyId:'jetty-2',vesselId:'vessel-1'},'VALIDATION']
 ];
 for(const [extra,code] of cases)rejectsAtomic(f,()=>f.update(extra),code);
 f.state.products.find(row=>row.id==='split-12').active=false;rejectsAtomic(f,()=>f.update(),'VALIDATION');
});

test('cancel retains a soft audit record, forbids edit/replan and remains cancelled after unrelated progress aggregation',()=>{
 const f=fixture(),before=physical(f.state),id=f.get().id,code=f.get().code;
 f.act('request.cancel',{requestId:id,expectedRequestRevision:1,reason:'  Wrong destination  '});
 assert.equal(f.state.requests.length,1);assert.equal(f.get().id,id);assert.equal(f.get().code,code);assert.equal(f.get().status,'cancelled');assert.equal(f.get().cancelReason,'Wrong destination');assert.equal(f.get().cancelledBy,admin.id);assert.ok(f.get().cancelledAt);assert.equal(f.get().requestRevision,2);
 assert.deepEqual(physical(f.state),before);assert.equal(f.state.events.filter(row=>row.type==='request.cancelled').length,1);
 for(const action of ['request.update','request.cancel'])rejectsAtomic(f,()=>f.act(action,{...definition(),requestId:id,expectedRequestRevision:2}),'REQUEST_CANCELLED');
 rejectsAtomic(f,()=>f.act('request.plan',{requestId:id}),'REQUEST_CANCELLED');
 refreshAutomaticDispatchProgress(f.state);assert.equal(f.get().deliveryStatus,'cancelled');assert.equal(f.get().remainingT,0);
 const view=integratedView(f.state,admin,options);assert.equal(view.metrics.openRequests,0);assert.equal(view.requests[0].canEdit,false);assert.equal(view.requests[0].requestActionBlockedCode,'REQUEST_CANCELLED');
});

test('no prior planned request is editable, including cancelled linked history or a manually reset requested status',()=>{
 for(const marker of [
  s=>s.requests[0].plannedAt='2026-11-08T00:00:00Z',s=>s.requests[0].plannedBy='old-admin',
  s=>s.requests[0].dispatchId='old-dispatch',s=>s.requests[0].planningStatus='INTEGRATED_DEMO',
  s=>s.requests[0].demoRun={id:'old-run',status:'cancelled'},
  s=>s.dispatches.push({id:'old-dispatch',requestId:s.requests[0].id,status:'cancelled'}),
  s=>s.trips.push({id:'old-trip',requestId:s.requests[0].id,status:'cancelled'}),
  s=>s.events.push({type:'request.planned',entityId:s.requests[0].id})
 ]){
  const f=fixture();marker(f.state);const flags=requestLifecycle(f.state,f.get(),admin);assert.equal(flags.canEdit,false);assert.equal(flags.requestActionBlockedCode,'REQUEST_ALREADY_PLANNED');
  rejectsAtomic(f,()=>f.update(),'REQUEST_ALREADY_PLANNED');rejectsAtomic(f,()=>f.act('request.cancel',{requestId:f.requestId,expectedRequestRevision:1}),'REQUEST_ALREADY_PLANNED');
  rejectsAtomic(f,()=>f.act('request.plan',{requestId:f.requestId}),'REQUEST_ALREADY_PLANNED');
 }
 const f=fixture();f.act('request.plan',{requestId:f.requestId});assert.equal(f.get().requestRevision,2);f.get().status='requested';delete f.get().plannedAt;delete f.get().plannedBy;delete f.get().dispatchId;delete f.get().planningStatus;
 rejectsAtomic(f,()=>f.update(),'REQUEST_ALREADY_PLANNED');
});

test('LAND and MARINE edits rebuild receiver snapshots and Quarry routing while preserving provenance',()=>{
 const f=fixture();f.act('quarry.config.save',{enabled:true,model:'STATIC_WIM'});f.get().workflow='QUARRY_CILEGON';f.get().clientMetadata={evidence:'preserved'};
 const before=physical(f.state);f.update({transferMode:'LAND',jettyId:null,vesselId:null,lines:[{skuId:'split-12',quantity:18,unit:'m3'}]});
 assert.equal(f.get().workflow,undefined);assert.equal(f.get().destinationId,'crusher-2');assert.equal(f.get().destinationLocationSnapshot.id,'stockpile-location-crusher-2');assert.equal(f.get().jettyId,null);assert.equal(f.get().vesselId,null);assert.ok(f.get().lines[0].destinationStockpileId);assert.equal(f.get().lines[0].tonnageT,27);assert.deepEqual(physical(f.state),before);
 const audit=f.state.events.find(row=>row.type==='request.updated');assert.equal(audit.before.workflow,'QUARRY_CILEGON');assert.deepEqual(f.get().clientMetadata,{evidence:'preserved'});
 f.update();assert.equal(f.get().workflow,'QUARRY_CILEGON');assert.equal(f.get().destinationId,null);assert.equal(f.get().lines[0].destinationStockpileId,undefined);assert.deepEqual(physical(f.state),before);
});

test('legacy unplanned requests normalize version one, while malformed versions require review',()=>{
 const f=fixture();delete f.get().requestRevision;assert.equal(integratedView(f.state,admin,options).requests[0].requestRevision,1);f.update({expectedRequestRevision:1});assert.equal(f.get().requestRevision,2);
 f.get().requestRevision='2';rejectsAtomic(f,()=>f.update({expectedRequestRevision:2}),'REQUEST_STATE_REVIEW');
});

test('LAND edit provisions only missing zero-balance receiving bins and rolls all provisioning back on invalid definition',()=>{
 const f=fixture();const location=f.act('master.stockpileLocation.save',{name:'Managed Receiver',address:'Synthetic fixture',transportModes:['LAND']}).locationId;
 const managed=f.state.stockpiles.find(row=>row.stockpileLocationId===location&&row.skuId==='split-12');f.state.stockpiles=f.state.stockpiles.filter(row=>row.id!==managed.id);
 rejectsAtomic(f,()=>f.update({transferMode:'LAND',destinationLocationId:location,jettyId:null,vesselId:null,lines:[{skuId:'split-12',quantity:0,unit:'t'}]}),'VALIDATION');
 const before=physical(f.state);f.update({transferMode:'LAND',destinationLocationId:location,jettyId:null,vesselId:null});
 const target=f.state.stockpiles.find(row=>row.id===f.get().lines[0].destinationStockpileId);assert.equal(target.onHandM3,0);assert.equal(target.reservedM3,0);assert.equal(target.stockpileLocationId,location);
 assert.deepEqual(f.state.stockpiles.filter(row=>row.id!==target.id),before.stockpiles);for(const key of ['trucks','vessels','trips','dispatches','inventoryLedger','erpOutbox'])assert.deepEqual(f.state[key],before[key]);
});
