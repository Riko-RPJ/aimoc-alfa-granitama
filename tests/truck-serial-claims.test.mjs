import test from 'node:test';
import assert from 'node:assert/strict';
import {createSeed} from '../server/seed.mjs';
import {applyIntegratedAction,integratedView} from '../server/integrated-demo-domain.mjs';
import {allocateAutomaticDispatch,truckAvailability} from '../server/automatic-dispatch.mjs';

const admin={id:'serial-admin',role:'admin'};
const driver={id:'serial-driver',username:'serial.driver',role:'driver',active:true};
const otherDriver={id:'serial-driver-2',username:'serial.driver2',role:'driver',active:true};
const options={drivers:[driver]};
function fixture(){
 const state=createSeed();state.trucks=state.trucks.slice(0,1).map(t=>({...t,bedM3:30,payloadLimitT:40}));
 const act=(action,payload,actor=admin)=>applyIntegratedAction(state,action,payload,actor,options);
 const plan=(tonnes=120,skuId='split-12')=>{
  const requestId=act('request.create',{transferMode:'MARINE',destinationLocationId:state.stockpileLocations[0].id,jettyId:'jetty-1',vesselId:'vessel-1',lines:[{skuId,quantity:tonnes,unit:'t'}]}).requestId;
  return act('request.plan',{requestId});
 };
 const finish=(tripId)=>{
  const trip=state.trips.find(t=>t.id===tripId);
  if(!trip.qrScannedAt)act('trip.qr',{tripId});
  if(!trip.weighingEvents.some(e=>e.type==='TARE'))act('trip.tare',{tripId,weightT:15});
  if(trip.status==='queued')act('trip.start',{tripId},driver);
  act('trip.loading',{tripId});act('trip.gross',{tripId,weightT:15+trip.tonnageT});
  for(const action of ['depart','arrive','receive'])act('trip.'+action,{tripId});
  act('trip.return_start',{tripId},driver);return act('trip.return',{tripId});
 };
 return{state,act,plan,finish};
}

test('one available truck claims all serial trips in A; B waits until that truck finishes its own final return',()=>{
 const{state,act,plan,finish}=fixture();
 const a=plan(120),aTrips=state.trips.filter(t=>t.dispatchId===a.dispatchIds[0]).sort((x,y)=>x.sequence-y.sequence);
 assert.equal(aTrips.length,3);assert.ok(aTrips.every(t=>t.status==='queued'&&t.truckId==='truck-1'&&t.assignedDriverUserId===driver.id));
 assert.equal(a.autoDispatch.allocationMode,'AUTOMATIC_SERIAL');assert.equal(a.autoDispatch.assignedTruckCount,1);
 let fleet=integratedView(state,admin,options).fleet[0];
 assert.equal(fleet.status,'allocated');assert.equal(fleet.queuedTrips,3);assert.equal(fleet.serialTripsRemaining,3);assert.equal(fleet.dispatchId,a.dispatchIds[0]);
 const b=plan(40,'split-23'),waitingB=state.trips.find(t=>t.dispatchId===b.dispatchIds[0]);
 assert.equal(waitingB.status,'waiting_truck');assert.equal(waitingB.truckId,null);
 const lastId=aTrips[2].id,firstId=aTrips[0].id;
 // Authorized pre-scan is evidence only; it neither starts a future task nor
 // permits a second execution, and must not relabel a queued claim as Busy.
 act('trip.qr',{tripId:lastId});act('trip.tare',{tripId:lastId,weightT:15});
 assert.equal(integratedView(state,admin,options).fleet[0].status,'allocated');
 assert.throws(()=>act('trip.start',{tripId:lastId},driver),e=>e.code==='QUEUE_ORDER');
 act('trip.start',{tripId:firstId},driver);
 assert.equal(integratedView(state,admin,options).fleet[0].status,'busy');
 assert.throws(()=>act('trip.start',{tripId:aTrips[1].id},driver),e=>e.code==='TRUCK_OR_DRIVER_BUSY');
 for(let n=0;n<aTrips.length;n++){
  finish(aTrips[n].id);
  fleet=integratedView(state,admin,options).fleet[0];
  assert.equal(fleet.status,'allocated');
  if(n<2){assert.equal(fleet.dispatchId,a.dispatchIds[0]);assert.equal(fleet.serialTripsRemaining,2-n);assert.equal(state.trips.find(t=>t.id===waitingB.id).status,'waiting_truck');}
 }
 assert.equal(fleet.dispatchId,b.dispatchIds[0]);assert.equal(fleet.serialTripsRemaining,1);
 assert.equal(state.trips.find(t=>t.id===waitingB.id).status,'queued');
 assert.equal(state.requests.find(r=>r.id===a.requestId).status,'completed');
 assert.equal(state.vessels[0].loadedT,120);assert.equal(state.vessels[0].reservedT,40);
 finish(waitingB.id);
 fleet=integratedView(state,admin,options).fleet[0];
 assert.equal(fleet.status,'available');assert.equal(fleet.dispatchId,null);assert.equal(fleet.serialTripsRemaining,0);
});

test('eligible pool excludes inactive and legacy-held trucks and needs an active free Driver',()=>{
 const{state,plan}=fixture();
 state.trucks=[{...state.trucks[0],id:'inactive',code:'DT-001',active:false},{...state.trucks[0],id:'legacy-held',code:'DT-002'},{...state.trucks[0],id:'free',code:'DT-003',payloadLimitT:20}];
 state.trips.push({id:'legacy-hold',truckId:'legacy-held',status:'queued',source:'LEGACY',sequence:1});
 const planned=plan(50),assigned=state.trips.filter(t=>t.dispatchId===planned.dispatchIds[0]);
 assert.equal(assigned.length,3);assert.ok(assigned.every(t=>t.truckId==='free'&&t.assignedDriverUserId===driver.id));
 const fleet=integratedView(state,admin,options).fleet;
 assert.equal(fleet.find(t=>t.id==='inactive').status,'unavailable');
 assert.equal(fleet.find(t=>t.id==='legacy-held').bindingStatus,'LEGACY_HOLD');
 assert.equal(fleet.find(t=>t.id==='free').status,'allocated');
 const noDriver=fixture();
 const requestId=noDriver.act('request.create',{transferMode:'MARINE',destinationLocationId:noDriver.state.stockpileLocations[0].id,jettyId:'jetty-1',vesselId:'vessel-1',lines:[{skuId:'split-12',quantity:20,unit:'t'}]}).requestId;
 applyIntegratedAction(noDriver.state,'request.plan',{requestId},admin,{drivers:[{...driver,active:false}]});
 assert.ok(noDriver.state.trips.every(t=>t.status==='waiting_truck'&&t.truckId===null));
});

test('conflicting dispatch/Driver claims and double execution hold atomically rather than silently rebinding',()=>{
 for(const corrupt of [
  (state,a,b)=>{state.trips.find(t=>t.id===a.tripIds[1]).dispatchId=b.dispatchIds[0];},
  (state,a)=>{state.trips.find(t=>t.id===a.tripIds[1]).assignedDriverUserId=otherDriver.id;},
  (state,a)=>{for(const id of a.tripIds.slice(0,2))Object.assign(state.trips.find(t=>t.id===id),{status:'loading',startedAt:new Date().toISOString()});},
 ]){
  const{state,plan,act}=fixture(),a=plan(120),b=plan(20,'split-23');corrupt(state,a,b);
  const before=structuredClone(state);
  assert.throws(()=>allocateAutomaticDispatch(state,{drivers:[driver,otherDriver]},admin),e=>e.code==='AUTO_DISPATCH_REVIEW_REQUIRED');
  assert.deepEqual(state,before);
  const queued=state.trips.find(t=>t.dispatchId===a.dispatchIds[0]&&t.status==='queued');
  if(queued)assert.throws(()=>act('trip.start',{tripId:queued.id},driver),e=>e.code==='AUTO_DISPATCH_REVIEW_REQUIRED');
  assert.deepEqual(state,before);
 }
});

test('safe allocation of old waiting cargo preserves every existing nonwaiting proof row and exact balances',()=>{
 const{state,act,plan}=fixture(),a=plan(120);
 const all=state.trips.filter(t=>t.dispatchId===a.dispatchIds[0]).sort((x,y)=>x.sequence-y.sequence),first=all[0],pending=all[1];
 // Explicit version-1 synthetic snapshot: only the first task was assigned;
 // the rest of the same reserved cargo awaited allocation as a stable row.
 Object.assign(pending,{tonnageT:80,volumeM3:Math.round((all[1].volumeM3+all[2].volumeM3)*1e6)/1e6,status:'waiting_truck',truckId:null,assignedDriverUserId:null,assignedDriverName:null,estimatedStartAt:null,estimatedReturnAt:null});
 state.trips=state.trips.filter(t=>t.id!==all[2].id);state.dispatches[0].tripIds=state.dispatches[0].tripIds.filter(id=>id!==all[2].id);
 state.automaticDispatchUpgrade={version:1,at:'2026-11-07T00:00:00.000Z',actorId:admin.id};
 act('trip.qr',{tripId:first.id});act('trip.tare',{tripId:first.id,weightT:15});
 const before=structuredClone(state),sumBefore=state.trips.reduce((s,t)=>s+t.tonnageT,0),volumeBefore=Math.round(state.trips.reduce((s,t)=>s+t.volumeM3,0)*1e6)/1e6;
 const result=allocateAutomaticDispatch(state,options,admin);
 assert.equal(result.autoAssignedTripIds.length,2);
 assert.deepEqual(state.trips.find(t=>t.id===first.id),before.trips.find(t=>t.id===first.id));
 assert.deepEqual(state.automaticDispatchUpgrade,before.automaticDispatchUpgrade);
 for(const key of ['stockpiles','vessels','inventoryLedger','erpOutbox'])assert.deepEqual(state[key],before[key]);
 assert.deepEqual(state.events.slice(0,before.events.length),before.events);
 assert.equal(state.trips.reduce((s,t)=>s+t.tonnageT,0),sumBefore);
 assert.equal(Math.round(state.trips.reduce((s,t)=>s+t.volumeM3,0)*1e6)/1e6,volumeBefore);
 assert.equal(state.trips.find(t=>t.id===pending.id).status,'queued','first pending ID becomes a genuine assigned serial trip');
 assert.ok(state.trips.every(t=>t.truckId==='truck-1'&&t.assignedDriverUserId===driver.id&&t.status==='queued'));
 assert.equal(truckAvailability(state,state.trucks[0]).status,'allocated');
});

test('global fleet binding remains truthful while scoped actors cannot see another dispatch or task IDs',()=>{
 const{state,plan}=fixture(),a=plan(120);
 const actual=state.trips.find(t=>t.dispatchId===a.dispatchIds[0]);
 const actor={id:'unrelated-stock',role:'stock',crusherIds:[actual.crusherId==='crusher-1'?'crusher-2':'crusher-1']};
 const fleet=integratedView(state,actor,options).fleet[0];
 assert.equal(fleet.status,'allocated');assert.equal(fleet.serialTripsRemaining,3);
 assert.equal(fleet.dispatchId,null);assert.deepEqual(fleet.dispatchIds,[]);assert.equal(fleet.nextTripId,null);
 const malformed={...actual,status:'start_pending',startedAt:undefined,qrScannedAt:new Date().toISOString()};
 const compatible={...state,trips:[malformed]};
 assert.equal(truckAvailability(compatible,compatible.trucks[0]).status,'allocated');
 assert.equal(truckAvailability(compatible,compatible.trucks[0]).activeTripId,null);
});

test('an interleaved other-dispatch waiting head cannot starve pending cargo belonging to the held pair',()=>{
 const{state,plan}=fixture(),a=plan(120),b=plan(20,'split-23');
 const aTrips=state.trips.filter(t=>t.dispatchId===a.dispatchIds[0]).sort((x,y)=>x.sequence-y.sequence);
 for(const task of aTrips.slice(1))Object.assign(task,{status:'waiting_truck',truckId:null,assignedDriverUserId:null,assignedDriverName:null,estimatedStartAt:null,estimatedReturnAt:null});
 const blocked=state.trips.find(t=>t.dispatchId===b.dispatchIds[0]);blocked.queueSequence=0;
 const preserved=structuredClone(aTrips[0]),before=structuredClone(state);
 allocateAutomaticDispatch(state,options,admin);
 assert.equal(state.trips.find(t=>t.id===blocked.id).status,'waiting_truck');
 assert.ok(state.trips.filter(t=>t.dispatchId===a.dispatchIds[0]).every(t=>t.status==='queued'&&t.truckId==='truck-1'));
 assert.deepEqual(state.trips.find(t=>t.id===preserved.id),preserved);
 for(const key of ['stockpiles','vessels','inventoryLedger','erpOutbox'])assert.deepEqual(state[key],before[key]);
});
