import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createSeed} from '../server/seed.mjs';
import {applyIntegratedAction,integratedView} from '../server/integrated-demo-domain.mjs';
import {requestDetail} from '../server/request-detail.mjs';

const admin={id:'cilegon-qa-admin',role:'admin'};
const driver={id:'cilegon-qa-driver',username:'qa-a',role:'driver',active:true};
const otherDriver={id:'cilegon-qa-other-driver',username:'qa-b',role:'driver',active:true};
const near=(actual,expected)=>assert.ok(Math.abs(actual-expected)<0.000002,`${actual} differs from ${expected}`);

function fixture(quantity=80){
 const state=createSeed(),options={drivers:[driver,otherDriver]};
 state.trucks=state.trucks.slice(0,1).map(truck=>({...truck,bedM3:30,payloadLimitT:40}));
 state.products.find(product=>product.id==='split-12').densityTPerM3=2;
 for(const pile of state.stockpiles.filter(pile=>pile.skuId==='split-12'))pile.onHandM3=pile.crusherId==='crusher-1'?1000:0;
 const act=(action,payload,actor=admin)=>applyIntegratedAction(state,action,payload,actor,options);
 const create=(amount=quantity,quarry=true)=>{
  const requestId=act(quarry?'quarry.request.create':'request.create',{transferMode:'MARINE',destinationLocationId:state.stockpileLocations[0].id,jettyId:'jetty-1',vesselId:'vessel-1',lines:[{skuId:'split-12',quantity:amount,unit:'t'}]}).requestId;
  act(quarry?'quarry.dispatch.plan':'request.plan',{requestId});return requestId;
 };
 const requestId=create(),lookup=id=>state.trips.find(trip=>trip.id===id);
 const trips=()=>state.trips.filter(trip=>trip.requestId===requestId).sort((a,b)=>a.sequence-b.sequence);
 const source=id=>({id:'qa-stock',role:'stock',crusherIds:[lookup(id).crusherId]});
 const receiver=id=>({id:'qa-jetty',role:'jetty',jettyIds:[lookup(id).jettyId]});
 const qr=id=>requestDetail(state,admin,{requestId:lookup(id).requestId,drivers:options.drivers}).trips.find(trip=>trip.id===id).qr.value;
 const payload=(id,purpose,extra={})=>({tripId:id,truckId:lookup(id).truckId,laneId:purpose==='EXIT'?'lane-2':'lane-1',direction:purpose==='EXIT'?'OUT':'IN',purpose,qrValue:qr(id),externalEventId:randomUUID(),...extra});
 const gate=(id,purpose,extra={},actor=admin)=>act('quarry.gate.scan',payload(id,purpose,extra),actor);
 const enter=id=>gate(id,'ENTRY',{weightT:15});
 const depart=(id,net=lookup(id).tonnageT)=>{act('trip.loading',{tripId:id},source(id));return gate(id,'EXIT',{weightT:15+net});};
 const receive=id=>{act('trip.arrive',{tripId:id},receiver(id));return act('trip.receive',{tripId:id},receiver(id));};
 const back=id=>gate(id,'RETURN',{laneId:'lane-3'});
 const finish=id=>{enter(id);depart(id);receive(id);back(id);};
 const unchangedReject=(fn,message)=>{const before=structuredClone(state);assert.throws(fn,undefined,message);assert.deepEqual(state,before,message+' is atomic');};
 return{state,options,act,create,requestId,trips,lookup,source,receiver,qr,payload,gate,enter,depart,receive,back,finish,unchangedReject};
}

test('Cilegon first entry requires a real simulated tare; QR reads never advance it and unsafe Driver Scan2 is blocked',()=>{
 const f=fixture(40),id=f.trips()[0].id,before=structuredClone(f.state);
 for(let count=0;count<3;count++){f.qr(id);integratedView(f.state,admin,f.options);}
 assert.deepEqual(f.state,before,'Context and QR reads are immutable');
 f.unchangedReject(()=>f.gate(id,'ENTRY',{laneId:'lane-3'}),'QR-only first tare');
 f.unchangedReject(()=>f.gate(id,'ENTRY'),'Scale entry without weight');
 f.unchangedReject(()=>f.act('trip.driver_scan',{tripId:id,expectedStage:2,externalEventId:randomUUID(),qrValue:f.qr(id),confirmations:{materialReceived:true,truckReturned:true}},driver),'Two-scan shortcut');
 f.enter(id);const trip=f.lookup(id);
 assert.equal(trip.status,'ready_to_load');assert.equal(trip.tareT,15);assert.ok(trip.tareEventId);
 assert.equal(trip.weighingEvents.filter(event=>event.type==='TARE').length,1);
 assert.deepEqual(f.state.stockpiles,before.stockpiles);assert.deepEqual(f.state.vessels,before.vessels);
 assert.deepEqual(f.state.inventoryLedger,before.inventoryLedger);assert.deepEqual(f.state.erpOutbox,before.erpOutbox);
});

test('same dispatch carries serial ritase through independent jetty custody and final return before releasing its truck',()=>{
 const f=fixture(),serial=f.trips(),dispatchId=serial[0].dispatchId,waitingRequest=f.create(10),waiting=f.state.trips.find(trip=>trip.requestId===waitingRequest);
 assert.equal(serial.length,2);assert.equal(new Set(serial.map(trip=>trip.id)).size,2);
 assert.ok(serial.every(trip=>trip.truckId==='truck-1'&&trip.dispatchId===dispatchId&&trip.assignedDriverUserId===driver.id));
 assert.equal(waiting.status,'waiting_truck');f.unchangedReject(()=>f.enter(serial[1].id),'Later serial entry');
 const firstId=serial[0].id,secondId=serial[1].id;
 f.enter(firstId);f.depart(firstId);
 assert.equal(f.lookup(firstId).status,'in_transit');assert.equal(f.state.vessels[0].loadedT,0);
 f.unchangedReject(()=>f.back(firstId),'Return before confirmed jetty unload');
 f.unchangedReject(()=>f.gate(secondId,'ENTRY',{laneId:'lane-3'}),'QR reuse before predecessor unload and return');
 f.receive(firstId);assert.equal(f.lookup(firstId).status,'unloaded');assert.equal(f.state.vessels[0].loadedT,40);
 f.unchangedReject(()=>f.gate(secondId,'ENTRY',{laneId:'lane-3'}),'QR reuse before predecessor returns');
 f.back(firstId);assert.equal(f.lookup(waiting.id).status,'waiting_truck');
 const fleet=integratedView(f.state,admin,f.options).fleet[0];assert.equal(fleet.dispatchId,dispatchId);assert.equal(fleet.status,'allocated');
 f.gate(secondId,'ENTRY',{laneId:'lane-3'});assert.equal(f.lookup(secondId).status,'ready_to_load');assert.equal(f.lookup(secondId).tareT,15);
 f.depart(secondId);f.receive(secondId);f.back(secondId);
 assert.equal(f.state.requests.find(request=>request.id===f.requestId).status,'completed');
 assert.equal(f.lookup(waiting.id).status,'queued');assert.equal(f.lookup(waiting.id).assignedDriverUserId,driver.id);
 f.unchangedReject(()=>f.gate(waiting.id,'ENTRY',{laneId:'lane-3'}),'A new dispatch requires its own first tare');
 f.finish(waiting.id);const finalFleet=integratedView(f.state,admin,f.options).fleet[0];
 assert.equal(finalFleet.status,'available');assert.equal(finalFleet.dispatchId,null);
 assert.equal(f.state.vessels[0].loadedT,90);assert.equal(f.state.vessels[0].reservedT,0);
});

test('loaded exit uses measured gross minus accepted tare and books source and vessel custody exactly once',()=>{
 const f=fixture(40),id=f.trips()[0].id,trip=f.lookup(id),pileId=trip.stockpileId;
 const pileBefore=structuredClone(f.state.stockpiles.find(pile=>pile.id===pileId));
 f.enter(id);f.act('trip.loading',{tripId:id},f.source(id));
 const mismatch=f.payload(id,'EXIT',{weightT:50}),beforeMismatch=structuredClone(f.state);
 assert.throws(()=>f.act('quarry.gate.scan',mismatch),error=>error.code==='WEIGHT_RECONCILIATION');
 assert.deepEqual(f.state,beforeMismatch,'35 measured versus 40 planned is held without any reservation or ERP movement');
 const exit=f.payload(id,'EXIT',{weightT:55});f.act('quarry.gate.scan',exit);
 const departed=f.lookup(id);assert.equal(departed.grossT,55);assert.equal(departed.netT,40);assert.equal(departed.status,'in_transit');
 const stock=f.state.stockpiles.find(pile=>pile.id===pileId);near(stock.onHandM3,pileBefore.onHandM3-20);near(stock.reservedM3,0);
 const sourceLedger=f.state.inventoryLedger.filter(row=>row.referenceId===id);assert.equal(sourceLedger.length,1);near(Math.abs(sourceLedger[0].tonnageT),40);
 const departedState=structuredClone(f.state);assert.equal(f.act('quarry.gate.scan',exit).replayed,true);assert.deepEqual(f.state,departedState);
 f.receive(id);const receivedState=structuredClone(f.state);
 assert.equal(f.state.vessels[0].loadedT,40);assert.equal(f.state.vessels[0].reservedT,0);
 near(f.state.requests.find(request=>request.id===f.requestId).deliveredT,40);
 assert.equal(f.state.inventoryLedger.filter(row=>row.referenceId===id).length,2);assert.equal(f.state.erpOutbox.filter(row=>row.entityId===id).length,2);
 f.unchangedReject(()=>f.act('trip.receive',{tripId:id},f.receiver(id)),'Second jetty receipt');
 assert.deepEqual(f.state,receivedState);f.back(id);
 assert.deepEqual(f.state.stockpiles,receivedState.stockpiles);assert.deepEqual(f.state.vessels,receivedState.vessels);
});

test('failed measurements, insufficient inventory and capacity failures roll back the complete exit or receipt',()=>{
 for(const weightT of [0,-1,15,14,Infinity,NaN]){
  const f=fixture(40),id=f.trips()[0].id;f.enter(id);f.act('trip.loading',{tripId:id},f.source(id));
  f.unchangedReject(()=>f.gate(id,'EXIT',{weightT}),'Invalid gross '+String(weightT));
 }
 const shortage=fixture(40),id=shortage.trips()[0].id;shortage.enter(id);shortage.act('trip.loading',{tripId:id},shortage.source(id));
 shortage.state.stockpiles.find(pile=>pile.id===shortage.lookup(id).stockpileId).onHandM3=1;
 shortage.unchangedReject(()=>shortage.gate(id,'EXIT',{weightT:55}),'Depleted source at exit');
 const capacity=fixture(40),capacityId=capacity.trips()[0].id;capacity.enter(capacityId);capacity.depart(capacityId);
 capacity.act('trip.arrive',{tripId:capacityId},capacity.receiver(capacityId));capacity.state.vessels[0].payloadLimitT=39;
 capacity.unchangedReject(()=>capacity.act('trip.receive',{tripId:capacityId},capacity.receiver(capacityId)),'Vessel changed below actual receipt capacity');
});

test('gate identity, exact QR, actor scope and event replay cannot rebind a truck or a ritase',()=>{
 const f=fixture(40),id=f.trips()[0].id,entry=f.payload(id,'ENTRY',{weightT:15});
 for(const [actor,change]of [[admin,{truckId:'truck-other'}],[admin,{qrValue:entry.qrValue+' '}],[admin,{tripId:'trip-missing'}],[otherDriver,{}],[{id:'qa-stock-other',role:'stock',crusherIds:['crusher-2']},{}],[{id:'qa-jetty',role:'jetty',jettyIds:['jetty-1']},{}]]){
  f.unchangedReject(()=>f.act('quarry.gate.scan',{...entry,...change},actor),'Wrong gate identity or actor');
 }
 f.act('quarry.gate.scan',entry);const after=structuredClone(f.state);
 assert.equal(f.act('quarry.gate.scan',entry).replayed,true);assert.deepEqual(f.state,after);
 f.unchangedReject(()=>f.act('quarry.gate.scan',{...entry,weightT:16}),'Event ID reused with changed tare');
 f.unchangedReject(()=>f.act('quarry.gate.scan',{...entry,externalEventId:randomUUID()}),'New first-entry intent after tare');
});

test('changing the model and both lane directions preserves accepted scan snapshots while later scans use the new version',()=>{
 const f=fixture(40),id=f.trips()[0].id;
 f.act('quarry.config.save',{model:'STATIC_WIM'});f.enter(id);
 const entry=structuredClone(f.lookup(id).quarryGateEvents[0]);assert.ok(entry.configVersion);assert.ok(entry.laneSnapshot);
 f.act('trip.loading',{tripId:id},f.source(id));
 f.act('quarry.config.save',{model:'STATIC_STATIC',lanes:[{id:'lane-1',direction:'OUT',active:true},{id:'lane-2',direction:'IN',active:true},{id:'lane-3',direction:'BIDIRECTIONAL',active:true}]});
 assert.deepEqual(f.lookup(id).quarryGateEvents[0],entry);
 f.unchangedReject(()=>f.gate(id,'EXIT',{laneId:'lane-2',weightT:55}),'Direction changed to IN');
 f.gate(id,'EXIT',{laneId:'lane-1',weightT:55});const events=f.lookup(id).quarryGateEvents;
 assert.equal(events.length,2);assert.ok(events[1].configVersion>entry.configVersion);assert.notDeepEqual(events[1].laneSnapshot,entry.laneSnapshot);
 assert.deepEqual(events[0],entry);f.receive(id);f.back(id);
 const before=structuredClone(f.state);
 for(const actor of [driver,f.source(id),f.receiver(id)])assert.throws(()=>f.act('quarry.config.save',{model:'WIM_WIM'},actor));
 assert.deepEqual(f.state,before,'Only Admin can change gate configuration');
});

test('both physical lanes can serve an entry burst then an exit burst, with no opposite admission while a lane points inward',()=>{
 const f=fixture(40),id=f.trips()[0].id;
 f.act('quarry.config.save',{model:'WIM_WIM',lanes:[{id:'lane-1',direction:'IN'},{id:'lane-2',direction:'IN'}]});
 f.enter(id);f.act('trip.loading',{tripId:id},f.source(id));
 f.unchangedReject(()=>f.gate(id,'EXIT',{weightT:55}),'Both lanes inward reject loaded exit');
 const acceptedEntry=structuredClone(f.lookup(id).quarryGateEvents[0]);
 f.state.trips.find(trip=>trip.id===id).quarryScanInProgress={laneId:'lane-1',direction:'IN'};
 f.unchangedReject(()=>f.act('quarry.config.save',{model:'WIM_WIM',lanes:[{id:'lane-1',direction:'OUT'},{id:'lane-2',direction:'OUT'}]}),'Configuration during an in-progress scan');
 delete f.state.trips.find(trip=>trip.id===id).quarryScanInProgress;
 f.act('quarry.config.save',{model:'WIM_WIM',lanes:[{id:'lane-1',direction:'OUT'},{id:'lane-2',direction:'OUT'}]});
 f.gate(id,'EXIT',{weightT:55});assert.deepEqual(f.lookup(id).quarryGateEvents[0],acceptedEntry);
 assert.equal(f.lookup(id).status,'in_transit');
});

test('one stable truck-dispatch pass works across three unique ritase while each reused tare keeps its measurement provenance',()=>{
 const f=fixture(120),serial=f.trips();assert.equal(serial.length,3);
 const projection=id=>integratedView(f.state,admin,f.options).trips.find(trip=>trip.id===id).quarry;
 const pass=projection(serial[0].id).dispatchPass.value;
 assert.ok(serial.every(trip=>projection(trip.id).dispatchPass.value===pass));
 const measurementIds=[];
 for(const [index,trip]of serial.entries()){
  f.gate(trip.id,'ENTRY',{qrValue:pass,...(index?{laneId:'lane-3'}:{weightT:15})});
  const accepted=f.lookup(trip.id);measurementIds.push(accepted.tareEventId);
  assert.equal(accepted.weighingEvents.filter(event=>event.type==='TARE').length,1);
  const tare=accepted.weighingEvents.find(event=>event.id===accepted.tareEventId);
  if(index){assert.equal(tare.measurementKind,'DISPATCH_TARE_REUSE');assert.equal(tare.sourceTripId,serial[index-1].id);assert.equal(tare.originalTareEventId,measurementIds[0]);}
  else assert.equal(tare.measurementKind,'SCALE_SIMULATION');
  f.depart(trip.id);f.receive(trip.id);f.back(trip.id);
 }
 assert.equal(new Set(measurementIds).size,3,'Reused tare references do not reuse the identity of an original reading');
 assert.equal(f.state.vessels[0].loadedT,120);assert.equal(f.state.inventoryLedger.length,6);assert.equal(f.state.erpOutbox.length,6);
 assert.ok(f.state.erpOutbox.every(row=>row.status==='awaiting_configuration'&&row.synthetic===true));
});

test('receipt flags alone and broken ledger or source-tare evidence cannot unlock the QR-only repeat',()=>{
 for(const corrupt of [
  (state,first)=>{state.events=state.events.filter(event=>!(event.type==='trip.receive'&&event.entityId===first.id));},
  (state,first)=>{state.inventoryLedger=state.inventoryLedger.filter(entry=>!(entry.type==='vessel_received'&&entry.referenceId===first.id));},
  (state,first)=>{state.erpOutbox=state.erpOutbox.filter(entry=>!(entry.type==='stock_transfer_received'&&entry.entityId===first.id));},
  (state,first)=>{state.trips.find(trip=>trip.id===first.id).weighingEvents[0].weightT=99;},
  (state,first)=>{state.trips.find(trip=>trip.id===first.id).truckId='truck-unrelated';},
 ]){
  const f=fixture(),[first,second]=f.trips();f.finish(first.id);corrupt(f.state,first);
  f.unchangedReject(()=>f.gate(second.id,'ENTRY',{laneId:'lane-3'}),'Unproven receipt or tare chain');
 }
});

test('explicit activation applies only to newly created requests and preserves earlier Alfa assignments',()=>{
 const f=fixture(40),existingId=f.trips()[0].id;f.finish(existingId);
 const legacyRequest=f.create(10,false),legacy=structuredClone(f.state.trips.find(trip=>trip.requestId===legacyRequest));
 f.act('quarry.config.save',{model:'STATIC_WIM',enabled:true});
 assert.deepEqual(f.lookup(legacy.id),legacy,'Activation does not backfill old assignments');
 const next=f.act('request.create',{transferMode:'MARINE',destinationLocationId:f.state.stockpileLocations[0].id,jettyId:'jetty-1',vesselId:'vessel-1',lines:[{skuId:'split-12',quantity:10,unit:'t'}]});
 f.act('request.plan',{requestId:next.requestId});
 const request=f.state.requests.find(request=>request.id===next.requestId),trip=f.state.trips.find(trip=>trip.requestId===next.requestId),dispatch=f.state.dispatches.find(dispatch=>dispatch.id===trip.dispatchId);
 assert.equal(request.workflow,'QUARRY_CILEGON');assert.equal(dispatch.workflow,'QUARRY_CILEGON');assert.equal(trip.workflow,'QUARRY_CILEGON');
 f.act('quarry.config.save',{model:'STATIC_WIM',enabled:false});assert.equal(f.lookup(trip.id).workflow,'QUARRY_CILEGON','Disabling defaults cannot remove an active workflow guard');
});

test('Cilegon actions do not change the existing Alfa Driver two-scan workflow',()=>{
 const f=fixture(40),id=f.trips()[0].id;f.finish(id);const legacyRequest=f.create(10,false),legacy=f.state.trips.find(trip=>trip.requestId===legacyRequest);
 // The existing workflow requires the complete exact assignment binding.
 const binding={requestId:legacy.requestId,dispatchId:legacy.dispatchId,tripId:legacy.id,truckId:legacy.truckId,sourceStockpileId:legacy.stockpileId,sourceCrusherId:legacy.crusherId,skuId:legacy.skuId,assignedDriverUserId:legacy.assignedDriverUserId};
 f.act('trip.driver_scan',{tripId:legacy.id,expectedStage:1,externalEventId:randomUUID(),qrValue:f.qr(legacy.id),binding},driver);
 assert.equal(f.lookup(legacy.id).status,'ready_to_load');assert.equal(f.lookup(legacy.id).driverScanMode,'TWO_SCAN_PLANNED_DEMO');
 assert.equal(f.lookup(legacy.id).tareT,18);assert.equal(f.lookup(legacy.id).weighingEvents.length,1);assert.equal(f.lookup(legacy.id).weighingEvents[0].measurementKind,'DUMMY_TARE_AFTER_DRIVER_SCAN');
});
