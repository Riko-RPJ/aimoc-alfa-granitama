import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createSeed} from '../server/seed.mjs';
import {applyIntegratedAction,integratedView} from '../server/integrated-demo-domain.mjs';
import {generateQuarryFlowReplay} from '../scripts/generate-quarry-flow-replay.mjs';
import {quarryResourceReadiness} from '../src/features/quarry-cilegon/quarry-readiness.mjs';
import {buildAssignmentQr} from '../src/features/integrated/assignment-qr.mjs';

const admin={id:'parallel-admin',role:'admin'};
const jetty={id:'parallel-jetty',role:'jetty',jettyIds:['jetty-1']};
const sum=(rows,key)=>rows.reduce((total,row)=>total+(row[key]||0),0);
const near=(actual,expected)=>assert.ok(Math.abs(actual-expected)<0.000003,`${actual} != ${expected}`);

function fixture({tonnes=360,density=1.5,stock=[600,600],extraBin=false,driverCount=4}={}){
 const state=createSeed(),drivers=Array.from({length:driverCount},(_,i)=>({id:`parallel-driver-${i+1}`,username:`parallel${i+1}`,role:'driver',active:true})),options={drivers};
 state.trucks=state.trucks.slice(0,4).map(truck=>({...truck,bedM3:30,payloadLimitT:45}));
 state.products.find(product=>product.id==='split-12').densityTPerM3=density;
 for(const pile of state.stockpiles.filter(pile=>pile.skuId==='split-12'))pile.onHandM3=stock[Number(pile.crusherId.slice(-1))-1];
 if(extraBin){const original=state.stockpiles.find(row=>row.skuId==='split-12'&&row.crusherId==='crusher-1');original.onHandM3=30;state.stockpiles.push({...original,id:'stock-extra-c1',code:'SP-C1-EXTRA',onHandM3:stock[0]-30});}
 const act=(action,payload,actor=admin)=>applyIntegratedAction(state,action,payload,actor,options);
 act('quarry.config.save',{model:'STATIC_WIM',enabled:true});
 const requestId=act('request.create',{transferMode:'MARINE',destinationLocationId:state.stockpileLocations[0].id,jettyId:'jetty-1',vesselId:'vessel-1',lines:[{skuId:'split-12',quantity:tonnes,unit:'t'}]}).requestId;
 act('request.plan',{requestId});
 const trip=id=>state.trips.find(row=>row.id===id),trips=()=>state.trips.filter(row=>row.requestId===requestId);
 const source=id=>({id:'parallel-stock-'+trip(id).crusherId,role:'stock',crusherIds:[trip(id).crusherId]});
 const projected=(id,actor=admin)=>integratedView(state,actor,options).trips.find(row=>row.id===id);
 const gatePayload=(id,purpose,extra={})=>({tripId:id,truckId:trip(id).truckId,laneId:purpose==='EXIT'?'lane-2':purpose==='RETURN'?'lane-3':'lane-1',direction:purpose==='EXIT'?'OUT':'IN',purpose,qrValue:projected(id).quarry.dispatchPass.value,externalEventId:randomUUID(),...extra});
 const gate=(id,purpose,extra={})=>act('quarry.gate.scan',gatePayload(id,purpose,extra),source(id));
 const reject=(fn,code)=>{const before=structuredClone(state);assert.throws(fn,error=>!code||error.code===code);assert.deepEqual(state,before,'Rejected operation must roll back every source, vessel, event and receipt');};
 return{state,drivers,options,act,requestId,trip,trips,source,projected,gatePayload,gate,reject};
}

test('four Driver/truck pairs run from two crushers concurrently, serialize their second trip and finish without phantom receipt or reservation',()=>{
 const f=fixture(),planned=f.trips(),dispatch=f.state.dispatches[0],initialStock=structuredClone(f.state.stockpiles);
 assert.equal(dispatch.sourceAllocationMode,'BALANCED_CRUSHERS');assert.equal(planned.length,8);
 assert.equal(new Set(planned.map(row=>row.truckId)).size,4);assert.equal(new Set(planned.map(row=>row.assignedDriverUserId)).size,4);
 assert.ok(planned.every(row=>row.workflow==='QUARRY_CILEGON'&&row.skuId==='split-12'&&row.jettyId==='jetty-1'&&row.vesselId==='vessel-1'));
 assert.equal(dispatch.allocations.length,2);dispatch.allocations.forEach(row=>near(row.tonnageT,180));
 near(f.state.vessels[0].reservedT,360);near(sum(f.state.stockpiles,'reservedM3'),240);
 const queues=f.state.trucks.map(truck=>planned.filter(row=>row.truckId===truck.id).sort((a,b)=>a.sequence-b.sequence));
 queues.forEach(queue=>assert.equal(queue.length,2));
 const first=queues.map(queue=>queue[0]);assert.equal(new Set(first.map(row=>row.crusherId)).size,2);
 assert.equal(first.filter(row=>row.crusherId==='crusher-1').length,2);assert.equal(first.filter(row=>row.crusherId==='crusher-2').length,2);
 assert.notEqual(first[0].crusherId,first[1].crusherId);assert.notEqual(first[2].crusherId,first[3].crusherId);
 const passes=queues.map(queue=>f.projected(queue[0].id).quarry.dispatchPass.value);
 for(const [index,queue]of queues.entries()){
  assert.equal(f.projected(queue[1].id).quarry.dispatchPass.value,passes[index]);
  f.reject(()=>f.gate(queue[1].id,'ENTRY',{laneId:'lane-3'}));
 }
 for(const round of [0,1]){
  const batch=queues.map(queue=>queue[round]),beforeEntry=structuredClone(f.state.stockpiles);
  for(const row of batch){
   const projected=f.projected(row.id,f.source(row.id));assert.ok(projected.quarry.allowedPurposes.includes('ENTRY'));
   assert.equal(f.projected(row.id,jetty).quarry.allowedPurposes.length,0);
   const ownDriver=f.drivers.find(driver=>driver.id===row.assignedDriverUserId),driverTrip=f.projected(row.id,ownDriver);
   assert.equal(driverTrip.driverScan.canScan,false);assert.equal(driverTrip.driverScan.phase,'QUARRY_WORKFLOW');
   f.reject(()=>f.act('trip.driver_scan',{tripId:row.id,expectedStage:2,externalEventId:randomUUID(),qrValue:passes[queues.findIndex(queue=>queue[round].id===row.id)],confirmations:{materialReceived:true,truckReturned:true}},ownDriver));
   f.gate(row.id,'ENTRY',round?{laneId:'lane-3'}:{weightT:15});
  }
  assert.equal(f.trips().filter(row=>row.status==='ready_to_load').length,4,'All four sources are entered before any loading starts');
  assert.deepEqual(f.state.stockpiles,beforeEntry,'Entry cannot consume or reserve inventory again');
  for(const row of batch){assert.ok(f.projected(row.id,f.source(row.id)).allowedActions.includes('trip.loading'));f.act('trip.loading',{tripId:row.id},f.source(row.id));}
  for(const row of batch){
   const payload=f.gatePayload(row.id,'EXIT',{weightT:15+f.trip(row.id).tonnageT});
   f.act('quarry.gate.scan',payload,f.source(row.id));const after=structuredClone(f.state);
   assert.equal(f.act('quarry.gate.scan',payload,f.source(row.id)).replayed,true);assert.deepEqual(f.state,after);
  }
  assert.equal(f.trips().filter(row=>row.status==='in_transit').length,4);
  near(f.state.vessels[0].loadedT,round*180);near(f.state.vessels[0].reservedT,360-round*180);
  for(const row of batch){
   f.reject(()=>f.gate(row.id,'RETURN'),'JETTY_RECEIPT_REQUIRED');
   assert.ok(f.projected(row.id,jetty).allowedActions.includes('trip.arrive'));f.act('trip.arrive',{tripId:row.id},jetty);
  }
  for(const row of batch){
   assert.ok(f.projected(row.id,jetty).allowedActions.includes('trip.receive'));f.act('trip.receive',{tripId:row.id},jetty);
   f.reject(()=>f.act('trip.receive',{tripId:row.id},jetty),'INVALID_TRANSITION');
  }
  near(f.state.vessels[0].loadedT,(round+1)*180);near(f.state.vessels[0].reservedT,180-round*180);
  const beforeReturn=structuredClone({stock:f.state.stockpiles,vessels:f.state.vessels,ledger:f.state.inventoryLedger,outbox:f.state.erpOutbox});
  for(const row of batch)f.gate(row.id,'RETURN');
  assert.deepEqual({stock:f.state.stockpiles,vessels:f.state.vessels,ledger:f.state.inventoryLedger,outbox:f.state.erpOutbox},beforeReturn,'Return records custody only; it cannot create a second material receipt');
  if(round===0)assert.ok(integratedView(f.state,admin,f.options).fleet.every(row=>row.status==='allocated'&&row.serialTripsRemaining===1));
 }
 for(const [index,queue]of queues.entries()){
  const firstTare=f.trip(queue[0].id).weighingEvents.find(row=>row.type==='TARE'),repeat=f.trip(queue[1].id).weighingEvents.find(row=>row.type==='TARE');
  assert.equal(repeat.measurementKind,'DISPATCH_TARE_REUSE');assert.equal(repeat.originalTareEventId,firstTare.id);
  assert.equal(f.projected(queue[1].id).quarry.dispatchPass.value,passes[index]);
 }
 for(const row of f.trips()){
  assert.equal(row.status,'returned');assert.equal(f.state.inventoryLedger.filter(entry=>entry.referenceId===row.id).length,2);
  assert.equal(f.state.erpOutbox.filter(entry=>entry.entityId===row.id).length,2);
  assert.ok(row.receiptCode);assert.equal(f.projected(row.id,jetty).allowedActions.includes('trip.receive'),false);
  assert.deepEqual(f.projected(row.id).quarry.allowedPurposes,[]);
 }
 near(sum(initialStock,'onHandM3')-sum(f.state.stockpiles,'onHandM3'),240);
 near(sum(f.state.stockpiles,'reservedM3'),0);near(f.state.vessels[0].loadedT,360);near(f.state.vessels[0].reservedT,0);
 assert.equal(f.state.requests[0].status,'completed');assert.equal(f.state.requests[0].deliveredT,360);
 assert.ok(integratedView(f.state,admin,f.options).fleet.every(row=>row.status==='available'&&row.bindingStatus==='NONE'&&!row.dispatchId&&!row.activeTripId&&!row.nextTripId));
});

test('balanced crusher planning conserves scarce source and fractional SKU units without duplicate reservations',()=>{
 const f=fixture({tonnes:149.999999,density:1.37,stock:[1.111111,500]}),dispatch=f.state.dispatches[0],trips=f.trips();
 assert.equal(dispatch.allocations.length,2);near(dispatch.allocations.find(row=>row.crusherId==='crusher-1').volumeM3,1.111111);
 near(sum(dispatch.allocations,'tonnageT'),149.999999);near(sum(trips,'tonnageT'),149.999999);
 near(sum(dispatch.allocations,'volumeM3'),sum(trips,'volumeM3'));near(sum(trips,'volumeM3'),f.state.requests[0].lines[0].volumeM3);near(sum(f.state.stockpiles,'reservedM3'),dispatch.volumeM3);
 const planned=structuredClone(f.state);f.reject(()=>f.act('request.plan',{requestId:f.requestId}),'ALREADY_PLANNED');assert.deepEqual(f.state,planned);
 for(const stock of f.state.stockpiles)assert.ok(stock.reservedM3<=stock.onHandM3+0.000001);
 const before=sum(f.state.stockpiles,'onHandM3');
 while(f.trips().some(row=>row.status!=='returned')){
  const next=f.trips().find(row=>f.projected(row.id).quarry.allowedPurposes.includes('ENTRY'));assert.ok(next,'At least one serial queue can progress');
  f.gate(next.id,'ENTRY',f.projected(next.id).quarry.canReuseTare?{laneId:'lane-3'}:{weightT:15});
  f.act('trip.loading',{tripId:next.id},f.source(next.id));f.gate(next.id,'EXIT',{weightT:15+f.trip(next.id).tonnageT});
  f.act('trip.arrive',{tripId:next.id},jetty);f.act('trip.receive',{tripId:next.id},jetty);f.gate(next.id,'RETURN');
 }
 near(before-sum(f.state.stockpiles,'onHandM3'),dispatch.volumeM3);near(f.state.vessels[0].loadedT,149.999999);
 near(f.state.vessels[0].reservedT,0);near(sum(f.state.stockpiles,'reservedM3'),0);
});

test('multiple bins at one crusher share that crusher budget and cannot steal the other crusher’s concurrent fleet',()=>{
 const f=fixture({extraBin:true,stock:[120,600]}),allocations=f.state.dispatches[0].allocations;
 assert.equal(allocations.length,3);near(sum(allocations.filter(row=>row.crusherId==='crusher-1'),'tonnageT'),180);near(sum(allocations.filter(row=>row.crusherId==='crusher-2'),'tonnageT'),180);
 near(allocations.find(row=>row.stockpileId==='stock-1-3').volumeM3,30);
 const first=f.state.trucks.map(truck=>f.trips().filter(row=>row.truckId===truck.id).sort((a,b)=>a.sequence-b.sequence)[0]);
 assert.equal(first.filter(row=>row.crusherId==='crusher-1').length,2);assert.equal(first.filter(row=>row.crusherId==='crusher-2').length,2);
 assert.notEqual(first[0].crusherId,first[1].crusherId);assert.notEqual(first[2].crusherId,first[3].crusherId);
 near(sum(f.trips(),'tonnageT'),360);near(sum(f.trips(),'volumeM3'),240);near(sum(f.state.stockpiles,'reservedM3'),240);
});

test('one eligible Driver/truck pair or a single full load keeps the established single-source plan',()=>{
 for(const options of [{tonnes:90,driverCount:1},{tonnes:40,driverCount:1},{tonnes:45,driverCount:4}]){
  const f=fixture(options),dispatch=f.state.dispatches[0];
  assert.notEqual(dispatch.sourceAllocationMode,'BALANCED_CRUSHERS');assert.equal(dispatch.allocations.length,1);
  assert.equal(new Set(f.trips().map(row=>row.crusherId)).size,1);
  assert.equal(f.trips().length,Math.ceil(options.tonnes/45));
  near(sum(f.trips(),'tonnageT'),options.tonnes);near(sum(f.state.stockpiles,'reservedM3'),options.tonnes/1.5);
 }
});

test('readiness identifies bound Drivers as the blocker even when ten trucks remain idle',()=>{
 const drivers=[{id:'readiness-driver-a',role:'driver',active:true},{id:'readiness-driver-b',role:'driver',active:true}],legacy=Array.from({length:18},(_,i)=>({id:'legacy-'+i,status:'queued',assignedDriverUserId:drivers[i%2].id}));
 const state={quarryCilegon:{enabled:true},trips:[...legacy,{id:'quarry-waiting',workflow:'QUARRY_CILEGON',status:'waiting_truck',assignedDriverUserId:null}],fleet:Array.from({length:12},(_,i)=>({id:'truck-'+i,status:i<2?'allocated':'available'})),requests:[{workflow:'QUARRY_CILEGON'}]};
 assert.deepEqual(quarryResourceReadiness(state,drivers,admin),{workflowEnabled:true,freeTrucks:10,activeDrivers:2,freeDrivers:0,freePairs:0,openLegacyTrips:18,waitingQuarryTrips:1,quarryRequests:1});
 assert.equal(quarryResourceReadiness(state,[],{role:'stock'}).freeDrivers,null,'A scoped operator must not claim to know the global Driver count');
});

test('the QR renderer accepts the server-issued truck dispatch pass and rejects augmented or incomplete pass data',()=>{
 const f=fixture(),trip=f.trips()[0],value=f.projected(trip.id).quarry.dispatchPass.value,pass=JSON.parse(value),qr=buildAssignmentQr(value);
 assert.equal(qr.ok,true,'Driver, gate reference and public replay must render the actual dispatch pass as QR geometry');assert.ok(qr.matrix.some(row=>row.some(Boolean)));
 for(const change of [{token:'untrusted'},{requestId:'extra-field'},{assignedDriverUserId:null},{truckId:'bad/truck'},{v:2},{type:'https://untrusted.invalid/'}])assert.equal(buildAssignmentQr(JSON.stringify({...pass,...change})).ok,false);
});

test('six small bins at each of four crushers distribute precision remainders without exceeding density tolerance',()=>{
 const state=createSeed(),density=1.65,tonnes=396.000344,drivers=Array.from({length:4},(_,i)=>({id:'precision-driver-'+i,role:'driver',active:true})),options={drivers};
 state.products.find(row=>row.id==='split-12').densityTPerM3=density;
 state.crushers=Array.from({length:4},(_,i)=>({id:'precision-crusher-'+i,code:'CR-P'+i,name:'Precision Crusher '+i,active:true}));
 state.stockpiles=state.crushers.flatMap((crusher,i)=>Array.from({length:6},(_,j)=>({id:`precision-stock-${i}-${j}`,code:`SP-P${i}-${j}`,crusherId:crusher.id,skuId:'split-12',active:true,onHandM3:10.000010,reservedM3:0})));
 state.trucks=state.trucks.slice(0,4).map(row=>({...row,bedM3:30,payloadLimitT:45}));
 const act=(action,payload)=>applyIntegratedAction(state,action,payload,admin,options);
 act('quarry.config.save',{enabled:true,model:'STATIC_WIM'});
 const requestId=act('request.create',{transferMode:'MARINE',destinationLocationId:state.stockpileLocations[0].id,jettyId:'jetty-1',vesselId:'vessel-1',lines:[{skuId:'split-12',quantity:tonnes,unit:'t'}]}).requestId;
 act('request.plan',{requestId});const line=state.requests[0].lines[0],dispatch=state.dispatches[0];
 near(sum(dispatch.allocations,'tonnageT'),tonnes);near(sum(state.trips,'tonnageT'),tonnes);
 near(sum(dispatch.allocations,'volumeM3'),line.volumeM3);near(sum(state.trips,'volumeM3'),line.volumeM3);near(sum(state.stockpiles,'reservedM3'),line.volumeM3);
 assert.equal(dispatch.crusherIds.length,4);
 for(const row of [...dispatch.allocations,...state.trips])assert.ok(Math.abs(row.volumeM3*density-row.tonnageT)<=0.00001,`Density drift on ${row.id||row.stockpileId}: ${row.volumeM3*density-row.tonnageT}`);
 for(const stock of state.stockpiles)assert.ok(stock.reservedM3>=0&&stock.reservedM3<=stock.onHandM3);
});

test('the public animation replay retains actual domain conservation, independent receipts and simultaneous source trips in every frame',()=>{
 const replay=generateQuarryFlowReplay();
 assert.equal(replay.source,'IN_MEMORY_DOMAIN_REPLAY');assert.equal(replay.readOnly,true);assert.equal(replay.productionEvidence,false);assert.equal(replay.trucks.length,4);
 assert.equal(replay.frames.length,52);assert.ok(replay.frames.every((frame,index)=>index===0||frame.at>replay.frames[index-1].at));
 let parallel=false;
 for(const frame of replay.frames){
  const state=frame.state,trips=state.trips,received=trips.filter(row=>row.receivedAt),departed=trips.filter(row=>row.departedAt);
  near(state.vessels[0].loadedT,sum(received,'tonnageT'));
  near(sum(state.stockpiles,'onHandM3')+sum(departed,'volumeM3'),2000);
  near(sum(state.stockpiles,'reservedM3'),sum(trips.filter(row=>!row.departedAt),'volumeM3'));
  near(state.vessels[0].reservedT,sum(trips.filter(row=>!row.receivedAt),'tonnageT'));
  assert.equal(state.inventoryLedger.length,departed.length+received.length);assert.equal(state.erpOutbox.length,departed.length+received.length);
  for(const truck of replay.trucks){
   const queue=trips.filter(row=>row.truckId===truck.id),active=queue.filter(row=>!['queued','returned'].includes(row.status));assert.ok(active.length<=1);
   for(const row of queue.filter(row=>row.returnedAt))assert.ok(row.receivedAt&&row.receiptCode,'A return frame always has earlier independent destination receipt');
  }
  const moving=trips.filter(row=>row.status==='in_transit');if(moving.length===4&&new Set(moving.map(row=>row.crusherId)).size===2)parallel=true;
 }
 assert.equal(parallel,true);const final=replay.frames.at(-1).state;
 assert.equal(final.vessels[0].loadedT,360);assert.ok(final.fleet.every(row=>row.status==='available'));
 assert.ok(final.trips.every(row=>row.status==='returned'&&!row.allowedActions.includes('trip.receive')&&row.quarry.allowedPurposes.length===0));
});

test('a newly activated Cilegon request preserves completed Alfa trip history, its QR and movement evidence',()=>{
 const state=createSeed(),driver={id:'historical-driver',role:'driver',active:true},options={drivers:[driver]},act=(action,payload,actor=admin)=>applyIntegratedAction(state,action,payload,actor,options);
 state.trucks=state.trucks.slice(0,1).map(row=>({...row,bedM3:30,payloadLimitT:45}));
 const create=()=>act('request.create',{transferMode:'MARINE',destinationLocationId:state.stockpileLocations[0].id,jettyId:'jetty-1',vesselId:'vessel-1',lines:[{skuId:'split-12',quantity:45,unit:'t'}]}).requestId;
 const oldRequest=create();act('request.plan',{requestId:oldRequest});const id=state.trips[0].id,source={id:'history-stock',role:'stock',crusherIds:[state.trips[0].crusherId]};
 act('trip.qr',{tripId:id});act('trip.start',{tripId:id},driver);act('trip.tare',{tripId:id,weightT:15},source);act('trip.loading',{tripId:id},source);act('trip.gross',{tripId:id,weightT:60},source);act('trip.depart',{tripId:id},source);act('trip.arrive',{tripId:id},jetty);act('trip.receive',{tripId:id},jetty);act('trip.return_start',{tripId:id},driver);act('trip.return',{tripId:id},source);
 const before=structuredClone({trip:state.trips[0],ledger:state.inventoryLedger,outbox:state.erpOutbox});
 act('quarry.config.save',{enabled:true,model:'WIM_WIM'});const next=create();act('request.plan',{requestId:next});
 assert.deepEqual(state.trips.find(row=>row.id===id),before.trip);assert.equal(before.trip.workflow,undefined);
 assert.deepEqual(state.inventoryLedger,before.ledger);assert.deepEqual(state.erpOutbox,before.outbox);
 assert.ok(state.trips.filter(row=>row.requestId===next).every(row=>row.workflow==='QUARRY_CILEGON'));
});
