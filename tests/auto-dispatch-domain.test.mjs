import test from 'node:test';
import assert from 'node:assert/strict';
import {createSeed} from '../server/seed.mjs';
import {applyIntegratedAction,integratedView,allocateAutomaticDispatch,upgradeToAutomaticDispatch} from '../server/integrated-demo-domain.mjs';

const admin={id:'automatic-admin',role:'admin'};
const drivers=[{id:'automatic-driver-1',username:'driver1',role:'driver',active:true},{id:'automatic-driver-2',username:'driver2',role:'driver',active:true}];
const opts={drivers};
const open=t=>!['returned','cancelled'].includes(t.status);
const close=(a,b)=>assert.ok(Math.abs(a-b)<0.00002,`${a} != ${b}`);
function fixture(){
 const s=createSeed();s.products.find(p=>p.id==='split-12').densityTPerM3=2;
 for(const pile of s.stockpiles.filter(x=>x.skuId==='split-12'))pile.onHandM3=pile.crusherId==='crusher-1'?100:0;
 s.trucks=s.trucks.slice(0,2);Object.assign(s.trucks[0],{bedM3:10,payloadLimitT:10});Object.assign(s.trucks[1],{bedM3:10,payloadLimitT:30});
 return s;
}
const act=(s,a,p,u=admin,o=opts)=>applyIntegratedAction(s,a,a==='request.create'?{destinationLocationId:'stockpile-location-crusher-2',...p}:p,u,o);
function request(s,tonnes=60,o=opts){return act(s,'request.create',{transferMode:'MARINE',jettyId:'jetty-1',vesselId:'vessel-1',lines:[{skuId:'split-12',quantity:tonnes,unit:'t'}]},admin,o).entityId;}
function unique(s){
 const assigned=s.trips.filter(t=>open(t)&&t.truckId),truckIds=assigned.map(t=>t.truckId),driverIds=assigned.map(t=>t.assignedDriverUserId);
 assert.equal(new Set(truckIds).size,truckIds.length);assert.equal(new Set(driverIds).size,driverIds.length);
 for(const t of assigned){const truck=s.trucks.find(x=>x.id===t.truckId);assert.ok(t.volumeM3<=truck.bedM3+0.00001);assert.ok(t.tonnageT<=truck.payloadLimitT+0.00001);}
}
function finish(s,identifier){
 const t=s.trips.find(x=>x.id===identifier),driver=drivers.find(d=>d.id===t.assignedDriverUserId),stock={id:'stock-user',role:'stock',crusherIds:[t.crusherId]},receiver=t.transferMode==='LAND'?{id:'destination-stock',role:'stock',crusherIds:[t.destinationCrusherId]}:{id:'jetty-user',role:'jetty',jettyIds:[t.jettyId]};
 act(s,'trip.qr',{tripId:t.id});act(s,'trip.tare',{tripId:t.id,weightT:20},stock);act(s,'trip.start',{tripId:t.id},driver);act(s,'trip.loading',{tripId:t.id},stock);act(s,'trip.gross',{tripId:t.id,weightT:20+t.tonnageT},stock);act(s,'trip.depart',{tripId:t.id},stock);act(s,'trip.arrive',{tripId:t.id},receiver);act(s,'trip.receive',{tripId:t.id},receiver);
 const waitingBefore=s.trips.filter(x=>x.status==='waiting_truck').map(x=>x.id);
 for(const identifier of waitingBefore)assert.equal(s.trips.find(x=>x.id===identifier).truckId,null,'Receipt must not release assigned fleet');
 act(s,'trip.return_start',{tripId:t.id},driver);unique(s);
 return act(s,'trip.return',{tripId:t.id},stock);
}

test('automatic capacity allocation shares a stockpile across concurrent dispatches without double assigning trucks',()=>{
 const s=fixture(),a=request(s,60);const first=act(s,'request.plan',{requestId:a});
 assert.equal(first.autoAssignedTripIds.length,2);unique(s);
 assert.deepEqual(s.trips.filter(t=>t.truckId).map(t=>t.tonnageT).sort((x,y)=>x-y),[10,20]);
 assert.equal(s.trips.filter(t=>t.status==='waiting_truck').length,1);
 const b=request(s,40);act(s,'request.plan',{requestId:b});unique(s);
 assert.equal(s.dispatches.length,2);assert.ok(s.trips.every(t=>t.stockpileId==='stock-1-3'));
 assert.equal(s.stockpiles.find(p=>p.id==='stock-1-3').reservedM3,50);assert.equal(s.vessels[0].reservedT,100);
 const older=s.trips.find(t=>t.requestId===a&&t.status==='waiting_truck').id;
 const returned=finish(s,s.trips.find(t=>t.requestId===a&&t.truckId==='truck-2').id);
 assert.ok(returned.autoAssignedTripIds.includes(older));assert.equal(s.trips.find(t=>t.id===older).requestId,a);unique(s);
 for(let guard=0;s.trips.some(open)&&guard<30;guard++){const task=s.trips.find(t=>open(t)&&t.truckId);assert.ok(task);finish(s,task.id);unique(s);}
 assert.ok(s.trips.every(t=>t.status==='returned'));assert.ok(s.requests.every(r=>r.status==='completed'));
 assert.equal(s.stockpiles.find(p=>p.id==='stock-1-3').onHandM3,50);assert.equal(s.stockpiles.find(p=>p.id==='stock-1-3').reservedM3,0);assert.equal(s.vessels[0].loadedT,100);assert.equal(s.vessels[0].reservedT,0);
 assert.equal(s.erpOutbox.length,s.trips.length*2);assert.equal(s.inventoryLedger.length,s.trips.length*2);
});

test('one 40t truck is allocated again only after verified return, never preassigned to the backlog',()=>{
 const s=fixture();s.trucks=s.trucks.slice(0,1);Object.assign(s.trucks[0],{bedM3:30,payloadLimitT:40});
 const requestId=request(s,80);act(s,'request.plan',{requestId});
 const first=s.trips.find(t=>t.status==='queued'),waiting=s.trips.find(t=>t.status==='waiting_truck');
 assert.equal(first.tonnageT,40);assert.equal(waiting.tonnageT,40);assert.equal(waiting.truckId,null);assert.equal(waiting.assignedDriverUserId,null);
 assert.deepEqual(integratedView(s,admin,opts).trips.find(t=>t.id===waiting.id).allowedActions,[]);
 assert.throws(()=>act(s,'trip.qr',{tripId:waiting.id}),e=>e.code==='WAITING_FOR_TRUCK');
 assert.throws(()=>act(s,'trip.start',{tripId:waiting.id},drivers[0]),e=>e.status===403);
 const result=finish(s,first.id);assert.deepEqual(result.autoAssignedTripIds,[waiting.id]);assert.equal(s.trips.find(t=>t.id===waiting.id).truckId,'truck-1');unique(s);
 finish(s,waiting.id);assert.equal(s.requests.find(r=>r.id===requestId).status,'completed');
});

test('waiting cargo can reserve stock without any free Driver; allocator resumes automatically when one becomes active',()=>{
 const s=fixture(),empty={drivers:[]};const requestId=request(s,60,empty);const result=act(s,'request.plan',{requestId},admin,empty);
 assert.equal(result.autoAssignedTripIds.length,0);assert.equal(result.autoDispatch.waitingT,60);assert.ok(s.trips.every(t=>t.status==='waiting_truck'&&!t.truckId));
 const allocated=allocateAutomaticDispatch(s,opts,admin);assert.equal(allocated.assignedTripIds.length,2);unique(s);
});

test('manual assignment is rejected and insufficient shared SKU stock rolls the whole plan back',()=>{
 const s=fixture(),id=request(s,150);const before=structuredClone(s);
 assert.throws(()=>act(s,'request.plan',{requestId:id,assignments:[]}),e=>e.code==='MANUAL_ASSIGNMENT_NOT_ALLOWED'&&e.status===400);assert.deepEqual(s,before);
 act(s,'request.plan',{requestId:id});const second=request(s,100),reserved=structuredClone(s);
 assert.throws(()=>act(s,'request.plan',{requestId:second}),e=>e.code==='INSUFFICIENT_STOCK');assert.deepEqual(s,reserved);unique(s);
});

test('fractional volume splits conserve exact reserved m3 across repeatedly reused trucks',()=>{
 const s=fixture();s.products.find(p=>p.id==='split-12').densityTPerM3=1.5;s.trucks=s.trucks.slice(0,1);Object.assign(s.trucks[0],{bedM3:30,payloadLimitT:40});
 s.stockpiles.find(p=>p.id==='stock-1-3').onHandM3=53.333333;
 const requestId=request(s,80);act(s,'request.plan',{requestId});assert.equal(s.stockpiles.find(p=>p.id==='stock-1-3').reservedM3,53.333333);
 finish(s,s.trips.find(t=>t.truckId).id);finish(s,s.trips.find(t=>open(t)&&t.truckId).id);
 assert.equal(s.stockpiles.find(p=>p.id==='stock-1-3').onHandM3,0);assert.equal(s.stockpiles.find(p=>p.id==='stock-1-3').reservedM3,0);close(s.trips.reduce((sum,t)=>sum+t.volumeM3,0),53.333333);assert.equal(s.vessels[0].loadedT,80);
});

function oldQueues(){
 const s=fixture();s.products.find(p=>p.id==='split-12').densityTPerM3=1.5;s.stockpiles.find(p=>p.id==='stock-1-3').onHandM3=1000;s.trucks.forEach(t=>Object.assign(t,{bedM3:30,payloadLimitT:40}));
 const id=request(s,480);act(s,'request.plan',{requestId:id});const template=structuredClone(s.trips[0]);let rest=320;
 s.trips=Array.from({length:12},(_,i)=>{const volumeM3=i===11?Math.round(rest*1e6)/1e6:26.666667;rest-=volumeM3;return {...structuredClone(template),id:'old-trip-'+i,code:'RIT-'+String(i+1).padStart(5,'0'),sequence:i+1,queueSequence:undefined,tonnageT:40,volumeM3,status:'queued',truckId:s.trucks[i%2].id,assignedDriverUserId:drivers[i%2].id,assignmentMode:undefined,weighingEvents:[]};});
 s.dispatches[0].tripIds=s.trips.map(t=>t.id);return s;
}

test('cutover preserves the IDs, quantities and balances of twelve unexecuted repeated old assignments',()=>{
 const s=oldQueues(),before=structuredClone(s);const migration=upgradeToAutomaticDispatch(s,opts,admin);
 assert.equal(migration.detachedTripIds.length,12);assert.equal(migration.assignedTripIds.length,2);assert.equal(s.trips.filter(t=>t.status==='waiting_truck').length,10);unique(s);
 for(const old of before.trips){const t=s.trips.find(x=>x.id===old.id);assert.equal(t.tonnageT,old.tonnageT);assert.equal(t.volumeM3,old.volumeM3);assert.equal(t.assignmentHistory.length,1);assert.equal(t.assignmentHistory[0].truckId,old.truckId);}
 for(const key of ['stockpiles','vessels','inventoryLedger','erpOutbox'])assert.deepEqual(s[key],before[key]);
 assert.equal(upgradeToAutomaticDispatch(s,opts,admin).replayed,true);unique(s);
});

test('cutover retains queued evidence and refuses overlapping proof instead of deleting it',()=>{
 const s=oldQueues();s.trips[0].qrScannedAt=new Date().toISOString();s.trips[0].weighingEvents=[{id:'old-pending-tare',type:'TARE',weightT:20,status:'PENDING'}];const proof=structuredClone(s.trips[0]);
 upgradeToAutomaticDispatch(s,opts,admin);assert.deepEqual(s.trips[0],proof);unique(s);
 const conflicting=oldQueues();conflicting.trips[0].qrScannedAt='2026-11-07T00:00:00Z';conflicting.trips[2].qrScannedAt='2026-11-07T00:00:01Z';const before=structuredClone(conflicting);
 assert.throws(()=>upgradeToAutomaticDispatch(conflicting,opts,admin),e=>e.code==='AUTO_DISPATCH_REVIEW_REQUIRED');assert.deepEqual(conflicting,before);
 const eventOnly=oldQueues();eventOnly.events.push({id:'retained-old-qr',entityId:eventOnly.trips[0].id,type:'trip.qr'});const historical=structuredClone(eventOnly.trips[0]);upgradeToAutomaticDispatch(eventOnly,opts,admin);assert.deepEqual(eventOnly.trips[0],historical);unique(eventOnly);
});
