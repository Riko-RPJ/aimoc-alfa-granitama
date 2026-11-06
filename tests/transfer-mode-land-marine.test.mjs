import test from 'node:test';
import assert from 'node:assert/strict';
import {createSeed,applyAction,previewLandFleetAllocation,publicState} from '../server/domain.mjs';
import {projectV1Read} from '../server/v1/read-model.mjs';
const admin={id:'admin-test',role:'admin'};
const stock={id:'stock-test',role:'stock',crusherIds:['crusher-1']};
const payload={transferMode:'LAND',destinationId:'DEST-LAND-UAT',destination:'Receiving Area UAT',
 lines:[{skuId:'split-12',quantity:18.5,unit:'t'},{skuId:'basecourse',quantity:12,unit:'m3'}]};
test('LAND requests persist without jetty/vessel or inferred density/mass and never enter marine planner',()=>{
 const s=createSeed();
 const result=applyAction(s,'request.create',payload,admin);
 const r=s.requests.find(x=>x.id===result.entityId);
 assert.equal(r.transferMode,'LAND');assert.equal(r.destinationId,'DEST-LAND-UAT');
 assert.equal(r.jettyId,null);assert.equal(r.vesselId,null);
 assert.deepEqual(r.lines.map(x=>x.tonnageT),[null,null]);
 assert.equal(r.planningStatus,'NOT_INTEGRATED');
 assert.equal(s.trips.length,0);assert.equal(s.dispatches.length,0);
 assert.throws(()=>applyAction(s,'request.plan',{requestId:r.id},admin),e=>e.code==='LAND_DISPATCH_NOT_INTEGRATED');
 assert.equal(s.trips.length,0);
});
test('LAND rejects missing destination and requires Admin',()=>{
 const s=createSeed();
 assert.throws(()=>applyAction(s,'request.create',{...payload,destinationId:''},admin));
 assert.throws(()=>applyAction(s,'request.create',{...payload,jettyId:'jetty-1'},admin),e=>e.code==='REQUEST_FIELD_INVALID');
 assert.throws(()=>applyAction(s,'request.create',{...payload,payloadLimitT:99},admin),e=>e.code==='REQUEST_FIELD_INVALID');
 assert.throws(()=>applyAction(s,'request.create',payload,stock),e=>e.status===403);
});
test('LAND fleet preview reads truck master, marks work busy and fails closed on unverified dependencies',()=>{
 const s=createSeed();
 const result=applyAction(s,'request.create',payload,admin);
 const first=previewLandFleetAllocation(s,result.entityId);
 assert.equal(first.status,'PENDING_VERIFICATION');
 assert.equal(first.available_trucks,12);
 assert.equal(first.busy_trucks,0);
 assert.equal(first.trucks[0].truck_id,'truck-1');
 assert.equal(first.trucks[0].payload_limit_t,s.trucks[0].payloadLimitT);
 assert.equal(first.trucks[0].bed_capacity_m3,s.trucks[0].bedM3);
 assert.equal(first.trucks[0].cycle_time_minutes,s.trucks[0].cycleMinutes);
 assert.equal(first.lines[0].effective_capacity_t,null);
 assert.equal(first.lines[0].estimated_trips,null);
 assert.deepEqual(first.recommended_trucks,[]);
 assert.equal(first.estimated_trips,null);
 assert.equal(first.operational_dispatch_enabled,false);
 s.trips.push({id:'busy-trip',truckId:'truck-1',status:'queued'});
 const refreshed=previewLandFleetAllocation(s,result.entityId);
 assert.equal(refreshed.available_trucks,11);
 assert.equal(refreshed.busy_trucks,1);
 assert.equal(refreshed.trucks[0].availability,'BUSY');
});
test('LAND fleet and master v1 contracts preserve request and truck IDs with admin-only preview',()=>{
 const s=createSeed();
 const created=applyAction(s,'request.create',payload,admin);
 const view={state:publicState(s,admin),updatedAt:s.updatedAt};
 const preview=projectV1Read(`/api/v1/transfer-requests/${created.entityId}/fleet-allocation`,view,admin);
 assert.equal(preview.data.request_id,created.entityId);
 assert.equal(preview.data.transfer_mode,'LAND');
 assert.equal(preview.data.status,'PENDING_VERIFICATION');
 assert.equal(preview.data.trucks[0].truck_id,s.trucks[0].id);
 assert.throws(()=>projectV1Read(`/api/v1/transfer-requests/${created.entityId}/fleet-allocation`,view,stock),e=>e.status===403);
 const transfers=projectV1Read('/api/v1/transfer-requests',view,admin);
 assert.equal(transfers.data.items[0].mode,'LAND');
 assert.equal(transfers.data.items[0].destination_id,payload.destinationId);
 const masters=projectV1Read('/api/v1/master-data',view,admin);
 assert.equal(masters.data.trucks[0].truck_id,s.trucks[0].id);
 assert.equal(masters.data.trucks[0].plate_number,s.trucks[0].plate);
 assert.equal(masters.data.trucks[0].cycle_time_minutes,s.trucks[0].cycleMinutes);
 assert.equal(masters.data.skus.find(x=>x.id==='split-12').density_verified,false);
});
test('MARINE remains backwards-compatible and creates regular marine dispatch',()=>{
 const s=createSeed();
 const result=applyAction(s,'request.create',{transferMode:'MARINE',
  jettyId:'jetty-1',vesselId:'vessel-1',destination:'Marunda',
  lines:[{skuId:'split-12',quantity:10,unit:'m3'}]},admin);
 const r=s.requests.find(x=>x.id===result.entityId);
 assert.equal(r.jettyId,'jetty-1');
 const plan=applyAction(s,'request.plan',{requestId:r.id},admin);
 assert.ok(plan.dispatchIds.length>0);
});
