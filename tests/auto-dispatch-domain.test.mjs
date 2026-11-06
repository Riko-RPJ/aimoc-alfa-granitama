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
 const assigned=s.trips.filter(t=>open(t)&&t.truckId);
 for(const field of ['truckId','assignedDriverUserId'])for(const value of new Set(assigned.map(t=>t[field]))){
  const tasks=assigned.filter(t=>t[field]===value);
  assert.equal(new Set(tasks.map(t=>t.dispatchId)).size,1,'A resource may claim only one unfinished dispatch');
  assert.equal(new Set(tasks.map(t=>field==='truckId'?t.assignedDriverUserId:t.truckId)).size,1,'A serial claim keeps one truck/Driver pair');
  assert.ok(tasks.filter(t=>t.startedAt||!['queued','waiting_truck'].includes(t.status)).length<=1,'At most one trip executes per resource');
 }
 for(const t of assigned){const truck=s.trucks.find(x=>x.id===t.truckId);assert.ok(t.volumeM3<=truck.bedM3+0.00001);assert.ok(t.tonnageT<=truck.payloadLimitT+0.00001);}
}
function finish(s,identifier){
 const t=s.trips.find(x=>x.id===identifier),driver=drivers.find(d=>d.id===t.assignedDriverUserId),stock={id:'stock-user',role:'stock',crusherIds:[t.crusherId]},receiver=t.transferMode==='LAND'?{id:'destination-stock',role:'stock',crusherIds:[t.destinationCrusherId]}:{id:'jetty-user',role:'jetty',jettyIds:[t.jettyId]};
 if(!t.qrScannedAt)act(s,'trip.qr',{tripId:t.id});
 if(!t.weighingEvents.some(e=>e.type==='TARE'))act(s,'trip.tare',{tripId:t.id,weightT:20},stock);
 act(s,'trip.start',{tripId:t.id},driver);act(s,'trip.loading',{tripId:t.id},stock);act(s,'trip.gross',{tripId:t.id,weightT:20+t.tonnageT},stock);act(s,'trip.depart',{tripId:t.id},stock);act(s,'trip.arrive',{tripId:t.id},receiver);act(s,'trip.receive',{tripId:t.id},receiver);
 const waitingBefore=s.trips.filter(x=>x.status==='waiting_truck').map(x=>x.id);
 for(const identifier of waitingBefore)assert.equal(s.trips.find(x=>x.id===identifier).truckId,null,'Receipt must not release assigned fleet');
 act(s,'trip.return_start',{tripId:t.id},driver);unique(s);
 return act(s,'trip.return',{tripId:t.id},stock);
}

test('automatic capacity allocation shares a stockpile across concurrent dispatches without double assigning trucks',()=>{
 const s=fixture(),a=request(s,60);const first=act(s,'request.plan',{requestId:a});
 assert.equal(first.autoAssignedTripIds.length,s.trips.length);unique(s);
 assert.equal(new Set(s.trips.map(t=>t.truckId)).size,2);assert.equal(s.trips.reduce((sum,t)=>sum+t.tonnageT,0),60);
 assert.equal(s.trips.filter(t=>t.status==='waiting_truck').length,0);
 assert.ok(integratedView(s,admin,opts).fleet.every(t=>t.status==='allocated'));
 const b=request(s,40);act(s,'request.plan',{requestId:b});unique(s);
 assert.equal(s.dispatches.length,2);assert.ok(s.trips.every(t=>t.stockpileId==='stock-1-3'));
 assert.equal(s.stockpiles.find(p=>p.id==='stock-1-3').reservedM3,50);assert.equal(s.vessels[0].reservedT,100);
 assert.ok(s.trips.filter(t=>t.requestId===b).every(t=>t.status==='waiting_truck'&&!t.truckId),'Another dispatch cannot borrow either claimed truck');
 const ownQueue=s.trips.filter(t=>t.requestId===a&&t.truckId==='truck-2').sort((x,y)=>x.sequence-y.sequence);
 for(const [index,task]of ownQueue.entries()){
  finish(s,task.id);unique(s);
  if(index<ownQueue.length-1)assert.ok(s.trips.filter(t=>t.requestId===b).every(t=>!t.truckId));
 }
 assert.ok(s.trips.some(t=>t.requestId===a&&t.truckId==='truck-1'&&open(t)),'The other truck still has prior dispatch work');
 assert.ok(s.trips.some(t=>t.requestId===b&&t.truckId==='truck-2'),'Own final return releases the resource without waiting for the other truck');
 for(let guard=0;s.trips.some(open)&&guard<30;guard++){const task=s.trips.find(t=>open(t)&&t.truckId);assert.ok(task);finish(s,task.id);unique(s);}
 assert.ok(s.trips.every(t=>t.status==='returned'));assert.ok(s.requests.every(r=>r.status==='completed'));
 assert.equal(s.stockpiles.find(p=>p.id==='stock-1-3').onHandM3,50);assert.equal(s.stockpiles.find(p=>p.id==='stock-1-3').reservedM3,0);assert.equal(s.vessels[0].loadedT,100);assert.equal(s.vessels[0].reservedT,0);
 assert.equal(s.erpOutbox.length,s.trips.length*2);assert.equal(s.inventoryLedger.length,s.trips.length*2);
});

test('one 40t truck owns two preassigned serial trips and remains allocated between them',()=>{
 const s=fixture();s.trucks=s.trucks.slice(0,1);Object.assign(s.trucks[0],{bedM3:30,payloadLimitT:40});
 const requestId=request(s,80);act(s,'request.plan',{requestId});
 const [first,next]=s.trips.filter(t=>t.status==='queued').sort((a,b)=>a.sequence-b.sequence);
 assert.equal(first.tonnageT,40);assert.equal(next.tonnageT,40);assert.equal(next.truckId,'truck-1');assert.equal(next.assignedDriverUserId,drivers[0].id);
 assert.equal(integratedView(s,admin,opts).fleet[0].status,'allocated');
 assert.throws(()=>act(s,'trip.start',{tripId:next.id},drivers[0]),e=>e.code==='QUEUE_ORDER');
 act(s,'trip.qr',{tripId:next.id});act(s,'trip.tare',{tripId:next.id,weightT:20},{id:'stock-prescan',role:'stock',crusherIds:[next.crusherId]});
 assert.equal(integratedView(s,admin,opts).fleet[0].status,'allocated','QR/tare pre-scan is not active execution');
 finish(s,first.id);assert.equal(s.trips.find(t=>t.id===next.id).truckId,'truck-1');unique(s);
 assert.equal(integratedView(s,admin,opts).fleet[0].status,'allocated');
 finish(s,next.id);assert.equal(s.requests.find(r=>r.id===requestId).status,'completed');
 assert.equal(integratedView(s,admin,opts).fleet[0].status,'available');
});

test('waiting cargo can reserve stock without any free Driver; allocator resumes automatically when one becomes active',()=>{
 const s=fixture(),empty={drivers:[]};const requestId=request(s,60,empty);const result=act(s,'request.plan',{requestId},admin,empty);
 assert.equal(result.autoAssignedTripIds.length,0);assert.equal(result.autoDispatch.waitingT,60);assert.ok(s.trips.every(t=>t.status==='waiting_truck'&&!t.truckId));
 const allocated=allocateAutomaticDispatch(s,opts,admin);assert.equal(allocated.assignedTripIds.length,s.trips.length);assert.equal(new Set(s.trips.map(t=>t.truckId)).size,2);assert.ok(s.trips.every(t=>t.status==='queued'));unique(s);
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
 assert.equal(migration.detachedTripIds.length,12);assert.equal(migration.assignedTripIds.length,12);assert.equal(s.trips.filter(t=>t.status==='waiting_truck').length,0);unique(s);
 for(const old of before.trips){const t=s.trips.find(x=>x.id===old.id);assert.equal(t.tonnageT,old.tonnageT);assert.equal(t.volumeM3,old.volumeM3);assert.equal(t.assignmentHistory.length,1);assert.equal(t.assignmentHistory[0].truckId,old.truckId);}
 for(const key of ['stockpiles','vessels','inventoryLedger','erpOutbox'])assert.deepEqual(s[key],before[key]);
 assert.equal(upgradeToAutomaticDispatch(s,opts,admin).replayed,true);unique(s);
});

test('cutover retains queued evidence and refuses overlapping proof instead of deleting it',()=>{
 const s=oldQueues();s.trips[0].qrScannedAt=new Date().toISOString();s.trips[0].weighingEvents=[{id:'old-pending-tare',type:'TARE',weightT:20,status:'PENDING'}];const proof=structuredClone(s.trips[0]);
 upgradeToAutomaticDispatch(s,opts,admin);assert.deepEqual(s.trips[0],proof);unique(s);
 const conflicting=oldQueues();Object.assign(conflicting.trips[0],{status:'start_pending',startedAt:'2026-11-07T00:00:00Z'});Object.assign(conflicting.trips[2],{status:'loading',startedAt:'2026-11-07T00:00:01Z'});const before=structuredClone(conflicting);
 assert.throws(()=>upgradeToAutomaticDispatch(conflicting,opts,admin),e=>e.code==='AUTO_DISPATCH_REVIEW_REQUIRED');assert.deepEqual(conflicting,before);
 const eventOnly=oldQueues();eventOnly.events.push({id:'retained-old-qr',entityId:eventOnly.trips[0].id,type:'trip.qr'});const historical=structuredClone(eventOnly.trips[0]);upgradeToAutomaticDispatch(eventOnly,opts,admin);assert.deepEqual(eventOnly.trips[0],historical);unique(eventOnly);
});

test('guarded allocation rehearsal expands old waiting cargo without rewriting an in-transit trip or accounting proof',()=>{
 const s=fixture();s.trucks=s.trucks.slice(0,1);Object.assign(s.trucks[0],{bedM3:30,payloadLimitT:40});
 const requestId=request(s,120);act(s,'request.plan',{requestId});
 const [first,...tail]=s.trips.filter(t=>t.requestId===requestId).sort((a,b)=>a.sequence-b.sequence);
 const stock={id:'proof-origin',role:'stock',crusherIds:[first.crusherId]};
 act(s,'trip.qr',{tripId:first.id});act(s,'trip.tare',{tripId:first.id,weightT:20},stock);
 act(s,'trip.start',{tripId:first.id},drivers[0]);act(s,'trip.loading',{tripId:first.id},stock);
 act(s,'trip.gross',{tripId:first.id,weightT:60},stock);act(s,'trip.depart',{tripId:first.id},stock);
 assert.equal(s.trips.find(t=>t.id===first.id).status,'in_transit');
 // Reconstruct the old automatic representation in this isolated fixture:
 // one actual 40t execution, followed by one unassigned 80t cargo row.
 const pending={...structuredClone(tail[0]),status:'waiting_truck',tonnageT:80,
  volumeM3:tail.reduce((sum,t)=>sum+t.volumeM3,0),truckId:null,assignedDriverUserId:null,assignedDriverName:null,
  assignmentHold:'NO_AVAILABLE_TRUCK',assignedAt:null,estimatedStartAt:null,estimatedReturnAt:null};
 const removed=new Set(tail.map(t=>t.id));s.trips=s.trips.filter(t=>!removed.has(t.id));s.trips.push(pending);
 s.dispatches.find(d=>d.id===first.dispatchId).tripIds=[first.id,pending.id];
 s.events=s.events.filter(e=>!removed.has(e.entityId));
 s.automaticDispatchUpgrade={version:1,actorId:admin.id,detachedTripIds:[],beforeSha256:'synthetic-original-cutover-proof'};
 const before=structuredClone(s),original=s.trips.find(t=>t.id===first.id);
 const result=allocateAutomaticDispatch(s,opts,admin);
 assert.deepEqual(s.trips.find(t=>t.id===first.id),original,'Actual execution and all QR/weight evidence stay byte-for-byte identical');
 for(const key of ['stockpiles','vessels','inventoryLedger','erpOutbox','automaticDispatchUpgrade'])assert.deepEqual(s[key],before[key],key+' must not change during assignment-only upgrade');
 assert.deepEqual(s.events.slice(0,before.events.length),before.events,'Prior audit events remain intact');
 const future=s.trips.filter(t=>t.dispatchId===first.dispatchId&&t.status==='queued');
 assert.equal(future.length,2);assert.ok(future.some(t=>t.id===pending.id),'Canonical old waiting ID is retained');
 assert.equal(result.assignedTripIds.length,2);assert.ok(future.every(t=>t.truckId===first.truckId&&t.assignedDriverUserId===first.assignedDriverUserId));
 assert.equal(s.trips.reduce((sum,t)=>sum+t.tonnageT,0),120);close(s.trips.reduce((sum,t)=>sum+t.volumeM3,0),60);
 assert.equal(integratedView(s,admin,opts).fleet[0].status,'busy');unique(s);
});
