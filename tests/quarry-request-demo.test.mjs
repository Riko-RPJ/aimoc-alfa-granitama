import test from 'node:test';
import assert from 'node:assert/strict';
import {createSeed} from '../server/seed.mjs';
import {applyAction} from '../server/domain.mjs';
import {applyIntegratedAction,integratedView} from '../server/integrated-demo-domain.mjs';
import {applyQuarryRequestDemo} from '../server/quarry-request-demo.mjs';
import {quarryDispatchPass} from '../server/quarry-cilegon-domain.mjs';

const admin={id:'request-demo-admin',role:'admin'},stock={id:'request-demo-stock',role:'stock',crusherIds:['crusher-1']},jetty={id:'request-demo-jetty',role:'jetty',jettyIds:['jetty-1']};
const near=(actual,expected)=>assert.ok(Math.abs(actual-expected)<0.000003,`${actual} != ${expected}`);
const total=(rows,key)=>rows.reduce((sum,row)=>sum+(row[key]||0),0);
function fixture(tonnes=96,{legacy=false}={}){
 const state=createSeed(),drivers=[1,2].map(n=>({id:'request-demo-driver-'+n,username:'demo'+n,role:'driver',active:true})),options={drivers};
 state.trucks=state.trucks.slice(0,2).map(row=>({...row,bedM3:32,payloadLimitT:48}));state.stockpiles.forEach(row=>row.onHandM3=0);
 const measurement=applyAction(state,'measurement.create',{stockpileId:'stock-1-5',skuId:'split-35',method:'manual',quantityValue:tonnes/1.5,quantityUnit:'m3',notes:'Synthetic approved request demo source'},stock);applyAction(state,'measurement.approve',{measurementId:measurement.entityId},admin);
 const act=(action,payload,actor=admin)=>applyIntegratedAction(state,action,payload,actor,options);if(!legacy)act('quarry.config.save',{enabled:true,model:'STATIC_WIM'});
 const requestId=act('request.create',{transferMode:'MARINE',destinationLocationId:state.stockpileLocations[0].id,jettyId:'jetty-1',vesselId:'vessel-1',lines:[{skuId:'split-35',quantity:tonnes,unit:'t'}]}).requestId;act('request.plan',{requestId});
 const request=()=>state.requests.find(row=>row.id===requestId),trips=()=>state.trips.filter(row=>row.requestId===requestId),run=(command,extra={},actor=admin)=>applyQuarryRequestDemo(state,{requestId,command,...extra},actor,options);
 const reject=(fn)=>{const before=structuredClone(state);assert.throws(fn);assert.deepEqual(state,before,'Failed runner command must roll back the entire document and run metadata');};
 return{state,drivers,options,act,requestId,request,trips,run,reject};
}
function custody(f){
 const trips=f.trips(),departed=trips.filter(row=>row.departedAt),received=trips.filter(row=>row.receivedAt),returned=trips.filter(row=>row.status==='returned');
 near(f.state.vessels[0].loadedT,total(received,'tonnageT'));near(f.state.vessels[0].reservedT,total(trips.filter(row=>!row.receivedAt),'tonnageT'));
 near(total(f.state.stockpiles,'reservedM3'),total(trips.filter(row=>!row.departedAt),'volumeM3'));
 for(const truck of f.state.trucks){const queue=trips.filter(row=>row.truckId===truck.id).sort((a,b)=>a.sequence-b.sequence);assert.ok(queue.filter(row=>!['queued','returned','cancelled'].includes(row.status)).length<=1,'At most one active trip per pair');for(const [index,row]of queue.entries())if(row.startedAt)assert.ok(queue.slice(0,index).every(previous=>previous.status==='returned'),'A pair remains serial');}
 for(const row of returned)assert.ok(row.receivedAt&&row.receiptCode&&row.returnVerifiedBy,'Return requires an independent receipt');
 assert.equal(f.state.inventoryLedger.filter(row=>trips.some(trip=>trip.id===row.referenceId)).length,departed.length+received.length);
 assert.equal(f.state.erpOutbox.filter(row=>trips.some(trip=>trip.id===row.entityId)).length,departed.length+received.length);
 if(f.request().status==='completed')assert.ok(returned.length===trips.length&&received.length===trips.length,'Request completion requires every delivered and returned trip');
}

test('a local6000t request runs125 serial48t trips on two parallel pairs with independent custody and releases everything once',()=>{
 const f=fixture(6000),initial=structuredClone({stock:f.state.stockpiles,vessels:f.state.vessels,trips:f.trips(),ledger:f.state.inventoryLedger,outbox:f.state.erpOutbox});
 assert.equal(f.trips().length,125);assert.ok(f.trips().every(row=>row.tonnageT===48&&row.volumeM3===32&&row.crusherId==='crusher-1'));
 assert.deepEqual(f.state.trucks.map(truck=>f.trips().filter(row=>row.truckId===truck.id).length),[63,62]);
 f.run('start',{tareT:15});const id=f.request().demoRun.id;assert.equal(f.request().demoRun.status,'running');assert.equal(f.request().demoRun.steps,0);
 assert.deepEqual({stock:f.state.stockpiles,vessels:f.state.vessels,trips:f.trips(),ledger:f.state.inventoryLedger,outbox:f.state.erpOutbox},initial,'Start records intent only');
 f.run('start',{tareT:15});assert.equal(f.request().demoRun.id,id);assert.equal(f.request().demoRun.steps,0);
 f.run('step',{runId:id,rounds:1});assert.equal(f.trips().filter(row=>row.status==='ready_to_load').length,2,'First phase admits both pairs before loading either one');custody(f);
 let fullReceivedBeforeReturn=false,calls=0;
 while(f.request().demoRun.status!=='completed'){
  const open=f.trips().filter(row=>row.status!=='returned').length,result=f.run('step',{runId:id,rounds:open<=1?1:8});assert.ok(result.advancedActions>=0&&result.advancedActions<=16);custody(f);
  if(f.request().deliveredT===6000&&f.trips().some(row=>row.status!=='returned')){fullReceivedBeforeReturn=true;assert.notEqual(f.request().status,'completed');}
  assert.ok(++calls<100,'Bounded runner must finish without cycling forever');
 }
 assert.equal(fullReceivedBeforeReturn,true);assert.equal(f.request().demoRun.steps,750);assert.equal(f.request().status,'completed');assert.equal(f.request().deliveredT,6000);
 near(total(f.state.stockpiles,'onHandM3'),0);near(total(f.state.stockpiles,'reservedM3'),0);near(f.state.vessels[0].loadedT,6000);near(f.state.vessels[0].reservedT,0);
 for(const trip of f.trips()){
  assert.equal(trip.status,'returned');assert.equal(trip.tareT,15);assert.equal(trip.grossT,63);assert.equal(trip.netT,48);assert.equal(trip.quarryGateEvents.length,3);assert.equal(trip.weighingEvents.length,2);
  assert.equal(f.state.inventoryLedger.filter(row=>row.referenceId===trip.id).length,2);assert.equal(f.state.erpOutbox.filter(row=>row.entityId===trip.id).length,2);
  const received=f.state.events.findIndex(event=>event.entityId===trip.id&&event.type==='trip.receive'),returned=f.state.events.findIndex(event=>event.entityId===trip.id&&event.type==='quarry.gate.scan'&&event.scanResult?.purpose==='RETURN');assert.ok(received>=0&&returned>received,'Jetty receipt is a separate event preceding return');
 }
 assert.ok(integratedView(f.state,admin,f.options).fleet.every(row=>row.status==='available'&&row.bindingStatus==='NONE'&&!row.dispatchId&&!row.nextTripId));
 const final=structuredClone(f.state);f.run('step',{runId:id,rounds:8});assert.deepEqual(f.state,final,'A repeated completed step cannot add movements or receipts');
});

test('runner controls are Admin-only, strictly bounded, run-bound and cannot execute while paused',()=>{
 const f=fixture();for(const actor of [stock,jetty,...f.drivers])f.reject(()=>f.run('start',{},actor));
 for(const payload of [{command:'bad'},{command:'start',rounds:1},{command:'start',tareT:0},{command:'start',tareT:-1},{command:'start',tareT:Infinity},{command:'start',extra:'untrusted'}])f.reject(()=>applyQuarryRequestDemo(f.state,{requestId:f.requestId,...payload},admin,f.options));
 f.run('start',{tareT:15});const id=f.request().demoRun.id;
 for(const rounds of [0,9,-1,1.5,'2',null,Infinity])f.reject(()=>f.run('step',{runId:id,rounds}));
 for(const command of ['step','pause','resume'])f.reject(()=>f.run(command,{runId:'wrong-run'}));
 f.run('pause',{runId:id});assert.equal(f.request().demoRun.status,'paused');f.reject(()=>f.run('step',{runId:id,rounds:1}));
 const paused=structuredClone({stock:f.state.stockpiles,trips:f.trips(),vessels:f.state.vessels});f.run('resume',{runId:id});assert.equal(f.request().demoRun.status,'running');assert.deepEqual({stock:f.state.stockpiles,trips:f.trips(),vessels:f.state.vessels},paused);
 f.run('step',{runId:id,rounds:1});assert.equal(f.trips().filter(row=>row.status==='ready_to_load').length,2);
});

test('standard planned dispatch uses the same recorded Driver scans while non-synthetic records remain blocked',()=>{
 const standard=fixture(96,{legacy:true});standard.run('start');const runId=standard.request().demoRun.id;
 standard.run('step',{runId,rounds:1});assert.ok(standard.trips().every(row=>row.status==='ready_to_load'));
 assert.equal(standard.state.events.filter(row=>row.type==='trip.driver_scan'&&row.expectedStage===1).length,2);
 standard.run('step',{runId,rounds:1});assert.ok(standard.trips().every(row=>row.status==='returned'));
 assert.equal(standard.state.events.filter(row=>row.type==='trip.driver_scan'&&row.expectedStage===2).length,2);
 for(const corrupt of [f=>{f.request().synthetic=false;},f=>{f.state.dispatches[0].synthetic=false;},f=>{f.trips()[0].synthetic=false;},f=>{f.request().source='FIELD_VERIFIED';}]){const f=fixture();corrupt(f);f.reject(()=>f.run('start'));}
});

test('wrong source, depleted stock, vessel capacity and unavailable exit direction roll back each whole parallel step',()=>{
 const wrong=fixture();wrong.run('start');const wrongId=wrong.request().demoRun.id;wrong.trips()[0].crusherId='crusher-2';wrong.reject(()=>wrong.run('step',{runId:wrongId,rounds:1}));
 const source=fixture();source.run('start');const sourceId=source.request().demoRun.id;source.run('step',{runId:sourceId,rounds:2});source.state.stockpiles.find(row=>row.id==='stock-1-5').onHandM3=40;source.reject(()=>source.run('step',{runId:sourceId,rounds:1}));assert.ok(source.trips().every(row=>row.status==='loading'));
 const capacity=fixture();capacity.run('start');const capacityId=capacity.request().demoRun.id;capacity.run('step',{runId:capacityId,rounds:4});capacity.state.vessels[0].payloadLimitT=70;capacity.reject(()=>capacity.run('step',{runId:capacityId,rounds:1}));assert.ok(capacity.trips().every(row=>row.status==='arrived'));assert.equal(capacity.state.vessels[0].loadedT,0);
 const lanes=fixture();lanes.run('start');const laneId=lanes.request().demoRun.id;lanes.run('step',{runId:laneId,rounds:2});lanes.act('quarry.config.save',{model:'STATIC_WIM',lanes:[{id:'lane-1',direction:'IN'},{id:'lane-2',direction:'IN'}]});lanes.reject(()=>lanes.run('step',{runId:laneId,rounds:1}));
});

test('a bounded step reports a resource wait without inventing an assignment, receipt or movement',()=>{
 const f=fixture();for(const trip of f.trips())Object.assign(trip,{status:'waiting_truck',truckId:null,assignedDriverUserId:null,assignedDriverName:null});
 f.run('start');const before=structuredClone({trips:f.trips(),stock:f.state.stockpiles,vessels:f.state.vessels,ledger:f.state.inventoryLedger,outbox:f.state.erpOutbox}),result=f.run('step',{runId:f.request().demoRun.id,rounds:8});
 assert.equal(result.waiting,true);assert.equal(result.advancedActions,0);assert.equal(f.request().demoRun.steps,0);assert.notEqual(f.request().demoRun.status,'completed');assert.deepEqual({trips:f.trips(),stock:f.state.stockpiles,vessels:f.state.vessels,ledger:f.state.inventoryLedger,outbox:f.state.erpOutbox},before);
});

test('continuing an already entered trip retains its accepted tare instead of replacing it with the demo default',()=>{
 const f=fixture(),trip=f.trips()[0];f.act('quarry.gate.scan',{tripId:trip.id,truckId:trip.truckId,laneId:'lane-1',direction:'IN',purpose:'ENTRY',qrValue:quarryDispatchPass(trip).value,externalEventId:'manual-tare-before-demo',weightT:17},stock);
 f.run('start',{tareT:15});f.run('step',{runId:f.request().demoRun.id,rounds:8});const finished=f.trips().find(row=>row.id===trip.id);assert.equal(finished.status,'returned');assert.equal(finished.tareT,17);assert.equal(finished.grossT,65);assert.equal(finished.netT,48);assert.equal(finished.quarryGateEvents.filter(row=>row.purpose==='ENTRY').length,1);custody(f);
});
