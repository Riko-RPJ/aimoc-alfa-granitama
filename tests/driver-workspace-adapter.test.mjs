import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDriverStagingAdapter,createDriverDemoAdapter,interpretDriverEnvelope,
  normalizeDriverTrip,DRIVER_SOURCE,DRIVER_DEMO_SCENARIOS
} from '../src/services/driver-workspace-adapter.js';

const ok=(data,status=200)=>({ok:status>=200&&status<300,status,json:async()=>data});
const envelope=(resource,data,state='READY')=>({
 schema_version:'1.0',resource,source:'V1_STAGING',
 data_status:state,as_of:'2026-11-06T10:00:00Z',data
});
test('Driver adapter reads real staging endpoints, preserving unknown weighing rather than zero',async()=>{
 const requests=[];
 const fetchImpl=async(path,options)=>{
  requests.push({path,method:options.method,credentials:options.credentials});
  if(path.endsWith('active-trip'))return ok(envelope('driver_active_trip',{
   data_status:'READY',trip:{id:'t01',dispatch_id:'d01',truck_id:'truck01',status:'IN_TRANSIT',
    actual_net_t:null,source_stockpile_id:'stock1',destination_location_id:'jetty1',
    assignment_status:'ASSIGNED',tare_status:'TARE_RECEIVED',wim_status:'CONNECTED'}}));
  if(path.endsWith('/me/trips'))return ok(envelope('driver_history',{data_status:'READY',items:[
   {id:'t00',dispatch_id:'d00',status:'RETURNED_AVAILABLE',returned_available_at:'2026-11-04T11:00:00Z'}
  ]}));
  if(path.endsWith('/trips/t01'))return ok(envelope('trip',{trip_id:'t01',dispatch_id:'d01',status:'IN_TRANSIT',
   truck_id:'truck01',actual_net_t:null}));
  throw new Error('Unexpected path: '+path);
 };
 const adapter=createDriverStagingAdapter({fetchImpl});
 const active=await adapter.getActiveTrip();
 assert.equal(active.trip.id,'t01');
 assert.equal(active.trip.actualNetT,null);
 assert.equal(active.trip.sourceLocation,'stock1');
 assert.equal(active.trip.assignmentStatus,'ASSIGNED');
 assert.equal(active.trip.tareStatus,'TARE_RECEIVED');
 assert.equal(active.trip.wimStatus,'CONNECTED');
 const history=await adapter.getHistory();
 assert.equal(history.items[0].status,'RETURNED_AVAILABLE');
 assert.equal((await adapter.getTripDetail('t01')).trip.actualNetT,null);
 assert.equal(requests.length,3);
 assert.ok(requests.every(r=>r.credentials==='same-origin'&&r.method==='GET'));
});
test('Driver adapter distinguishes no operational integration, empty assignment, and forbidden',async()=>{
 const noIntegration=createDriverStagingAdapter({fetchImpl:async()=>ok({
   schema_version:'1.0',resource:'driver_trip',source:'NOT_INTEGRATED',
   data_status:'NOT_INTEGRATED',data:null,reason:'Driver operational integration pending'
 })});
 const unavailable=await noIntegration.getActiveTrip();
 assert.equal(unavailable.state,'NOT_INTEGRATED');
 assert.equal(unavailable.trip,null);
 const none=createDriverStagingAdapter({fetchImpl:async()=>ok(envelope('driver_active_trip',{data_status:'EMPTY',trip:null},'EMPTY'))});
 assert.equal((await none.getActiveTrip()).state,'EMPTY');
 const unassigned=createDriverStagingAdapter({fetchImpl:async()=>ok(envelope('driver_active_trip',{
   data_status:'NO_ASSIGNMENT',trip:null},'NO_ASSIGNMENT'))});
 assert.equal((await unassigned.getActiveTrip()).state,'NO_ASSIGNMENT');
 const pendingIdentity=createDriverStagingAdapter({fetchImpl:async()=>ok(envelope('driver_active_trip',{
   data_status:'PENDING_DRIVER_VERIFICATION',trip:null},'PENDING_DRIVER_VERIFICATION'))});
 assert.equal((await pendingIdentity.getActiveTrip()).state,'PENDING_DRIVER_VERIFICATION');
 const unauthorized=createDriverStagingAdapter({fetchImpl:async()=>ok({error:'FORBIDDEN_SCOPE',message:'Denied'},403)});
 await assert.rejects(()=>unauthorized.getActiveTrip(),e=>e.code==='FORBIDDEN_SCOPE'&&e.status===403);
 const bad=createDriverStagingAdapter({fetchImpl:async()=>ok({items:[{id:'t01'}]})});
 await assert.rejects(()=>bad.getActiveTrip(),e=>e.code==='CONTRACT_MISMATCH');
});
test('Driver staging writes require CSRF + stable request ID, use only self-scoped endpoints',async()=>{
 const calls=[];
 const fetchImpl=async(path,options)=>{
  calls.push({path,...options});
  if(path.endsWith('/checklist'))return ok(envelope('driver_checklist',{status:'DONE',unloading_verified:false}));
  if(path.endsWith('/return-start'))return ok(envelope('driver_return',{status:'RETURNING',truck_available:false}));
  throw new Error('Unexpected '+path);
 };
 const missing=createDriverStagingAdapter({fetchImpl});
 await assert.rejects(()=>missing.submitChecklist({tripId:'t1',itemId:'item1',status:'DONE'}),e=>e.code==='CSRF_REQUIRED');
 assert.equal(calls.length,0);
 const adapter=createDriverStagingAdapter({fetchImpl,csrf:'csrf-staging'});
 const checked=await adapter.submitChecklist({tripId:'t1',itemId:'item1',status:'DONE',requestId:'test-item-001'});
 assert.equal(checked.unloading_verified,false);
 const returned=await adapter.reportReturnStart({tripId:'t1',requestId:'test-return-001'});
 assert.equal(returned.truck_available,false);
 assert.equal(calls.length,2);
 assert.equal(calls[0].path,'/api/v1/trips/t1/checklist');
 assert.equal(calls[0].headers['Idempotency-Key'],'test-item-001');
 assert.equal(calls[0].headers['X-CSRF-Token'],'csrf-staging');
 assert.equal(JSON.parse(calls[0].body).item_id,'item1');
 assert.equal(calls[1].path,'/api/v1/trips/t1/return-start');
 assert.equal(calls[1].headers['Idempotency-Key'],'test-return-001');
 assert.equal(calls[1].credentials,'same-origin');
 await assert.rejects(()=>adapter.getTripDetail('../anything'),e=>e.code==='INVALID_TRIP_ID');
});
test('UAT simulation is opt-in and mutable only within ephemeral demo adapter',async()=>{
 const empty=createDriverDemoAdapter({scenario:DRIVER_DEMO_SCENARIOS.EMPTY});
 assert.equal((await empty.getActiveTrip()).state,'EMPTY');
 assert.equal((await empty.getHistory()).items.length,2);
 const first=createDriverDemoAdapter();
 assert.equal(first.source,DRIVER_SOURCE.UAT_SIMULATION);
 const trip=(await first.getActiveTrip()).trip;
 assert.equal(trip.id,'UAT-TRIP-0024');
 assert.equal(trip.actualNetT,null);
 const checked=await first.submitChecklist({tripId:trip.id,itemId:'vehicle-inspection',status:'DONE'});
 assert.equal(checked.evidence_authority,'UAT_SIMULATED_SELF_REPORT');
 assert.equal(checked.unloading_verified,false);
 assert.equal((await first.getActiveTrip()).trip.checklist[0].status,'DONE');
 await assert.rejects(()=>first.reportReturnStart({tripId:trip.id}),e=>e.code==='UAT_RETURN_NOT_READY');
 const second=createDriverDemoAdapter();
 assert.equal((await second.getActiveTrip()).trip.checklist.length,0);
 const ready=createDriverDemoAdapter({scenario:DRIVER_DEMO_SCENARIOS.RETURN_READY});
 const report=await ready.reportReturnStart({tripId:trip.id});
 assert.equal(report.truck_available,false);
 assert.equal((await ready.getActiveTrip()).trip.status,'RETURNING');
 assert.equal((await ready.getHistory()).items.length,2);
});
test('numeric placeholders remain nullable when unknown',()=>{
 const trip=normalizeDriverTrip({trip_id:'trip1',status:'START_AUTHORIZED',gross_t:null,
   actual_net_t:null,planned_quantity_t:null});
 assert.equal(trip.actualNetT,null);
 assert.equal(trip.plannedT,null);
 assert.equal(interpretDriverEnvelope({schema_version:'1.0',source:'V1_STAGING',
   resource:'driver_active_trip',data_status:'NOT_INTEGRATED',data:null}).trip,null);
});
